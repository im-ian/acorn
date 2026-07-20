use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use acorn_transcript::read_tail;
use directories::UserDirs;
use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};

const CODEX_SESSION_SCAN_LIMIT: usize = 20;
const CODEX_SESSION_MAX_ENTRIES: usize = 10_000;
const CODEX_SESSION_MAX_DEPTH: usize = 4;
const CODEX_SESSION_TAIL_BYTES: u64 = 256 * 1024;
const CLAUDE_RATE_LIMIT_MAX_BYTES: u64 = 64 * 1024;
const CODEX_SQLITE_STDOUT_MAX_BYTES: usize = 256 * 1024;
const CODEX_SQLITE_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct AgentTokenUsageSnapshot {
    pub metrics: Vec<AgentTokenUsageMetric>,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct AgentTokenUsageMetric {
    pub provider: AgentTokenProvider,
    pub window: AgentTokenWindow,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<f64>,
    pub source: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTokenProvider {
    Codex,
    Claude,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTokenWindow {
    FiveHour,
    Weekly,
}

#[derive(Debug, Clone, PartialEq)]
struct RateLimitWindow {
    used_percent: f64,
    reset_at: Option<f64>,
    source: String,
}

#[tauri::command]
pub async fn get_agent_token_usage() -> AppResult<AgentTokenUsageSnapshot> {
    tauri::async_runtime::spawn_blocking(read_agent_token_usage)
        .await
        .map_err(|err| AppError::Other(format!("token usage task failed: {err}")))
}

fn read_agent_token_usage() -> AgentTokenUsageSnapshot {
    let updated_at = unix_now();
    let codex = read_codex_rate_limits();
    let claude = read_claude_rate_limits();

    let mut metrics = Vec::with_capacity(4);
    push_metric(
        &mut metrics,
        AgentTokenProvider::Codex,
        AgentTokenWindow::FiveHour,
        codex.five_hour,
        "~/.codex/sessions rate_limits",
        "No Codex 5h rate-limit event found",
    );
    push_metric(
        &mut metrics,
        AgentTokenProvider::Codex,
        AgentTokenWindow::Weekly,
        codex.weekly,
        "~/.codex/sessions rate_limits",
        "No Codex weekly rate-limit event found",
    );
    push_metric(
        &mut metrics,
        AgentTokenProvider::Claude,
        AgentTokenWindow::FiveHour,
        claude.five_hour,
        "~/.claude/token-widget/claude-rate-limits.json",
        "No Claude 5h statusline rate-limit capture found",
    );
    push_metric(
        &mut metrics,
        AgentTokenProvider::Claude,
        AgentTokenWindow::Weekly,
        claude.weekly,
        "~/.claude/token-widget/claude-rate-limits.json",
        "No Claude weekly statusline rate-limit capture found",
    );

    AgentTokenUsageSnapshot {
        metrics,
        updated_at,
    }
}

fn push_metric(
    metrics: &mut Vec<AgentTokenUsageMetric>,
    provider: AgentTokenProvider,
    window: AgentTokenWindow,
    rate_limit: Option<RateLimitWindow>,
    fallback_source: &str,
    fallback_error: &str,
) {
    if let Some(rate_limit) = rate_limit {
        let used_percent = clamp_percent(rate_limit.used_percent);
        metrics.push(AgentTokenUsageMetric {
            provider,
            window,
            used_percent: Some(used_percent),
            remaining_percent: Some(100.0 - used_percent),
            reset_at: rate_limit.reset_at,
            source: rate_limit.source,
            error: None,
        });
        return;
    }

    metrics.push(AgentTokenUsageMetric {
        provider,
        window,
        used_percent: None,
        remaining_percent: None,
        reset_at: None,
        source: fallback_source.to_string(),
        error: Some(fallback_error.to_string()),
    });
}

#[derive(Debug, Default, PartialEq)]
struct ProviderRateLimits {
    five_hour: Option<RateLimitWindow>,
    weekly: Option<RateLimitWindow>,
}

fn read_codex_rate_limits() -> ProviderRateLimits {
    read_codex_rate_limits_from_latest_sessions().unwrap_or_else(read_codex_rate_limits_from_sqlite)
}

fn read_codex_rate_limits_from_latest_sessions() -> Option<ProviderRateLimits> {
    let home = home_dir()?;
    let sessions = home.join(".codex").join("sessions");
    let scan = latest_jsonl_files(&sessions, CODEX_SESSION_SCAN_LIMIT);
    if scan.truncated {
        return None;
    }

    for file in scan.files {
        if let Some(parsed) = read_codex_rate_limits_from_session_file(&file) {
            return Some(parsed);
        }
    }

    None
}

fn read_codex_rate_limits_from_session_file(file: &Path) -> Option<ProviderRateLimits> {
    if !is_plain_regular_file(file) {
        return None;
    }
    let text = read_tail(file, CODEX_SESSION_TAIL_BYTES).ok()?.text;
    for line in text.lines().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(rate_limits) = value
            .get("payload")
            .and_then(|payload| payload.get("rate_limits"))
        else {
            continue;
        };
        let parsed = parse_codex_rate_limits(rate_limits, "~/.codex/sessions rate_limits");
        if parsed.five_hour.is_some() || parsed.weekly.is_some() {
            return Some(parsed);
        }
    }
    None
}

fn read_codex_rate_limits_from_sqlite() -> ProviderRateLimits {
    let Some(home) = home_dir() else {
        return ProviderRateLimits::default();
    };
    let db = home.join(".codex").join("logs_2.sqlite");
    if !is_plain_regular_file(&db) {
        return ProviderRateLimits::default();
    }

    let query = r#"
        select feedback_log_body from logs
        where feedback_log_body like '%"type":"codex.rate_limits"%'
          and length(feedback_log_body) <= 262144
        order by ts desc, ts_nanos desc, id desc
        limit 1;
    "#;
    let mut command = Command::new("/usr/bin/sqlite3");
    command.arg(&db).arg(query);
    let Ok(stdout) = command_stdout_bounded(
        &mut command,
        CODEX_SQLITE_STDOUT_MAX_BYTES,
        CODEX_SQLITE_TIMEOUT,
    ) else {
        return ProviderRateLimits::default();
    };
    let text = String::from_utf8_lossy(&stdout);
    let Some(json_text) = extract_codex_event_json(&text) else {
        return ProviderRateLimits::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&json_text) else {
        return ProviderRateLimits::default();
    };
    let Some(rate_limits) = value.get("rate_limits") else {
        return ProviderRateLimits::default();
    };

    parse_codex_rate_limits(rate_limits, "~/.codex/logs_2.sqlite rate_limits")
}

fn parse_codex_rate_limits(value: &Value, source: &str) -> ProviderRateLimits {
    ProviderRateLimits {
        five_hour: parse_rate_limit_window(
            value.get("primary"),
            &["used_percent"],
            &["reset_at", "resets_at"],
            source,
        ),
        weekly: parse_rate_limit_window(
            value.get("secondary"),
            &["used_percent"],
            &["reset_at", "resets_at"],
            source,
        ),
    }
}

fn read_claude_rate_limits() -> ProviderRateLimits {
    for path in claude_rate_limit_paths() {
        let Ok(data) = read_bounded_regular_file(&path, CLAUDE_RATE_LIMIT_MAX_BYTES) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        let Some(rate_limits) = value.get("rate_limits") else {
            continue;
        };
        let source = render_source_path(&path);
        let parsed = ProviderRateLimits {
            five_hour: parse_rate_limit_window(
                rate_limits.get("five_hour"),
                &["used_percentage"],
                &["resets_at"],
                &source,
            ),
            weekly: parse_rate_limit_window(
                rate_limits.get("seven_day"),
                &["used_percentage"],
                &["resets_at"],
                &source,
            ),
        };
        if parsed.five_hour.is_some() || parsed.weekly.is_some() {
            return parsed;
        }
    }

    ProviderRateLimits::default()
}

fn claude_rate_limit_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home_dir() {
        paths.push(
            home.join(".claude")
                .join("token-widget")
                .join("claude-rate-limits.json"),
        );
    }
    paths
}

fn parse_rate_limit_window(
    value: Option<&Value>,
    used_keys: &[&str],
    reset_keys: &[&str],
    source: &str,
) -> Option<RateLimitWindow> {
    let value = value?;
    let used_percent = used_keys.iter().find_map(|key| number(value.get(*key)))?;
    let reset_at = reset_keys.iter().find_map(|key| number(value.get(*key)));
    Some(RateLimitWindow {
        used_percent,
        reset_at,
        source: source.to_string(),
    })
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

fn extract_codex_event_json(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if let Some((_, json)) = trimmed.split_once("websocket event: ") {
        return Some(json.to_string());
    }
    let marker = r#""type":"codex.rate_limits""#;
    let marker_index = trimmed.find(marker)?;
    let start = trimmed[..marker_index].rfind('{')?;
    Some(trimmed[start..].to_string())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct SessionScanResult {
    files: Vec<PathBuf>,
    visited_entries: usize,
    truncated: bool,
}

fn latest_jsonl_files(root: &Path, limit: usize) -> SessionScanResult {
    latest_jsonl_files_with_budget(
        root,
        limit,
        CODEX_SESSION_MAX_ENTRIES,
        CODEX_SESSION_MAX_DEPTH,
    )
}

fn latest_jsonl_files_with_budget(
    root: &Path,
    file_limit: usize,
    entry_limit: usize,
    max_depth: usize,
) -> SessionScanResult {
    let mut scan = SessionScanResult::default();
    if file_limit == 0 || !is_plain_directory(root) {
        return scan;
    }

    let mut candidates = Vec::with_capacity(file_limit.saturating_add(1));
    collect_jsonl_files(
        root,
        0,
        file_limit,
        entry_limit,
        max_depth,
        &mut candidates,
        &mut scan,
    );
    if scan.truncated {
        // A partial traversal can make an old file look newest. Discard it so
        // the caller uses the separately bounded SQLite fallback instead.
        return scan;
    }
    scan.files = candidates.into_iter().map(|(path, _)| path).collect();
    scan
}

#[allow(clippy::too_many_arguments)]
fn collect_jsonl_files(
    root: &Path,
    depth: usize,
    file_limit: usize,
    entry_limit: usize,
    max_depth: usize,
    files: &mut Vec<(PathBuf, SystemTime)>,
    scan: &mut SessionScanResult,
) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            scan.truncated = true;
            return;
        }
    };

    for entry in entries {
        if scan.visited_entries >= entry_limit {
            scan.truncated = true;
            return;
        }
        scan.visited_entries += 1;

        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                scan.truncated = true;
                return;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                scan.truncated = true;
                return;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if depth >= max_depth {
                scan.truncated = true;
                return;
            }
            collect_jsonl_files(
                &path,
                depth + 1,
                file_limit,
                entry_limit,
                max_depth,
                files,
                scan,
            );
            if scan.truncated {
                return;
            }
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                scan.truncated = true;
                return;
            }
        };
        retain_latest_file(
            files,
            path,
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            file_limit,
        );
    }
}

fn retain_latest_file(
    files: &mut Vec<(PathBuf, SystemTime)>,
    path: PathBuf,
    modified: SystemTime,
    limit: usize,
) {
    files.push((path, modified));
    files.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    files.truncate(limit);
}

fn is_plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn is_plain_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file())
        .unwrap_or(false)
}

fn read_bounded_regular_file(path: &Path, max_bytes: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file without symlinks",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds byte budget",
        ));
    }

    let file = File::open(path)?;
    let capacity = metadata.len().min(max_bytes).min(usize::MAX as u64) as usize;
    let mut data = Vec::with_capacity(capacity);
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut data)?;
    if data.len() as u64 > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file grew beyond byte budget while reading",
        ));
    }
    Ok(data)
}

fn command_stdout_bounded(
    command: &mut Command,
    max_stdout: usize,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn()?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err(io::Error::other("child stdout pipe missing"));
        }
    };
    let reader = match thread::Builder::new()
        .name("token-usage-stdout".to_string())
        .spawn(move || {
            let mut bytes = Vec::with_capacity(max_stdout.min(8 * 1024));
            stdout
                .take((max_stdout as u64).saturating_add(1))
                .read_to_end(&mut bytes)?;
            Ok::<_, io::Error>(bytes)
        }) {
        Ok(reader) => reader,
        Err(err) => {
            terminate_child(&mut child);
            return Err(err);
        }
    };

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                terminate_child(&mut child);
                let _ = reader.join();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "child process exceeded time budget",
                ));
            }
            Ok(None) => thread::sleep(CHILD_POLL_INTERVAL),
            Err(err) => {
                terminate_child(&mut child);
                let _ = reader.join();
                return Err(err);
            }
        }
    };
    let bytes = reader
        .join()
        .map_err(|_| io::Error::other("child stdout reader panicked"))??;
    if bytes.len() > max_stdout {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "child stdout exceeds byte budget",
        ));
    }
    if !status.success() {
        return Err(io::Error::other(format!(
            "child process exited with {status}"
        )));
    }
    Ok(bytes)
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn render_source_path(path: &Path) -> String {
    let Some(home) = home_dir() else {
        return path.display().to_string();
    };
    if let Ok(suffix) = path.strip_prefix(&home) {
        return format!("~/{}", suffix.display());
    }
    path.display().to_string()
}

fn home_dir() -> Option<PathBuf> {
    UserDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn parses_codex_primary_and_secondary_windows() {
        let value: Value = serde_json::json!({
            "primary": { "used_percent": 12, "resets_at": 1779860400 },
            "secondary": { "used_percent": 34.5, "reset_at": 1779930000 }
        });

        let limits = parse_codex_rate_limits(&value, "codex");
        let five_hour = limits.five_hour.unwrap();
        let weekly = limits.weekly.unwrap();

        assert_eq!(five_hour.used_percent, 12.0);
        assert_eq!(five_hour.reset_at, Some(1779860400.0));
        assert_eq!(weekly.used_percent, 34.5);
        assert_eq!(weekly.reset_at, Some(1779930000.0));
    }

    #[test]
    fn extracts_codex_event_json_from_logged_websocket_prefix() {
        let text = r#"websocket event: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":5}}}"#;

        assert_eq!(
            extract_codex_event_json(text).as_deref(),
            Some(r#"{"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":5}}}"#)
        );
    }

    #[test]
    fn parses_codex_rate_limits_from_large_session_tail() {
        let path = temp_file_path("codex-rate-limit-tail");
        let mut file = File::create(&path).expect("create temp file");
        file.write_all(&vec![b'x'; CODEX_SESSION_TAIL_BYTES as usize + 1024])
            .expect("write prefix");
        writeln!(file).expect("end prefix line");
        writeln!(
            file,
            r#"{{"payload":{{"type":"event_msg","rate_limits":{{"primary":{{"used_percent":42,"resets_at":1779860400}}}}}}}}"#
        )
        .expect("write rate limit event");
        drop(file);

        let parsed = read_codex_rate_limits_from_session_file(&path).expect("rate limits");

        assert_eq!(parsed.five_hour.unwrap().used_percent, 42.0);
        assert_eq!(parsed.weekly, None);
        let tail = read_tail(&path, CODEX_SESSION_TAIL_BYTES)
            .expect("read tail")
            .text;
        assert_eq!(tail.len(), CODEX_SESSION_TAIL_BYTES as usize);
        fs::remove_file(path).ok();
    }

    #[test]
    fn parses_string_percentages() {
        let value: Value = serde_json::json!({
            "used_percentage": "10.5",
            "resets_at": "1779860400"
        });

        let window =
            parse_rate_limit_window(Some(&value), &["used_percentage"], &["resets_at"], "claude")
                .unwrap();

        assert_eq!(window.used_percent, 10.5);
        assert_eq!(window.reset_at, Some(1779860400.0));
    }

    #[test]
    fn retains_only_the_newest_file_candidates() {
        let mut files = Vec::new();
        retain_latest_file(
            &mut files,
            PathBuf::from("old.jsonl"),
            UNIX_EPOCH + Duration::from_secs(1),
            2,
        );
        retain_latest_file(
            &mut files,
            PathBuf::from("new.jsonl"),
            UNIX_EPOCH + Duration::from_secs(3),
            2,
        );
        retain_latest_file(
            &mut files,
            PathBuf::from("middle.jsonl"),
            UNIX_EPOCH + Duration::from_secs(2),
            2,
        );

        assert_eq!(
            files.into_iter().map(|(path, _)| path).collect::<Vec<_>>(),
            vec![PathBuf::from("new.jsonl"), PathBuf::from("middle.jsonl")]
        );
    }

    #[test]
    fn session_scan_discards_results_when_entry_budget_is_exhausted() {
        let root = tempdir().expect("temp dir");
        for name in ["a.jsonl", "b.jsonl", "c.jsonl"] {
            fs::write(root.path().join(name), b"{}\n").expect("write session");
        }

        let scan = latest_jsonl_files_with_budget(root.path(), 20, 2, 4);

        assert!(scan.truncated);
        assert_eq!(scan.visited_entries, 2);
        assert!(scan.files.is_empty());
    }

    #[test]
    fn session_scan_discards_results_beyond_depth_budget() {
        let root = tempdir().expect("temp dir");
        let nested = root.path().join("year").join("month");
        fs::create_dir_all(&nested).expect("create nested dirs");
        fs::write(nested.join("session.jsonl"), b"{}\n").expect("write session");

        let scan = latest_jsonl_files_with_budget(root.path(), 20, 100, 0);

        assert!(scan.truncated);
        assert!(scan.files.is_empty());
    }

    #[test]
    fn bounded_regular_file_accepts_exact_limit_and_rejects_oversize() {
        let root = tempdir().expect("temp dir");
        let path = root.path().join("limits.json");
        fs::write(&path, b"1234").expect("write exact file");
        assert_eq!(read_bounded_regular_file(&path, 4).unwrap(), b"1234");

        fs::write(&path, b"12345").expect("write oversized file");
        let err = read_bounded_regular_file(&path, 4).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[cfg(unix)]
    #[test]
    fn session_scan_and_readers_reject_symlinks() {
        use std::os::unix::fs::symlink;

        let root = tempdir().expect("session root");
        let outside = tempdir().expect("outside root");
        let outside_file = outside.path().join("outside.jsonl");
        fs::write(
            &outside_file,
            br#"{"payload":{"rate_limits":{"primary":{"used_percent":42}}}}"#,
        )
        .expect("write outside session");
        fs::write(root.path().join("regular.jsonl"), b"{}\n").expect("write regular session");
        symlink(outside.path(), root.path().join("linked-dir")).expect("link directory");
        let linked_file = root.path().join("linked.jsonl");
        symlink(&outside_file, &linked_file).expect("link file");

        let scan = latest_jsonl_files_with_budget(root.path(), 20, 100, 4);

        assert!(!scan.truncated);
        assert_eq!(scan.files, vec![root.path().join("regular.jsonl")]);
        assert!(read_codex_rate_limits_from_session_file(&linked_file).is_none());
        assert_eq!(
            read_bounded_regular_file(&linked_file, 1024)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn bounded_command_rejects_oversized_stdout() {
        let mut command = command_fixture("command_fixture_writes_large_stdout");

        let err = command_stdout_bounded(&mut command, 64, Duration::from_secs(2)).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn bounded_command_terminates_after_timeout() {
        let mut command = command_fixture("command_fixture_sleeps");

        let err =
            command_stdout_bounded(&mut command, 1024, Duration::from_millis(40)).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    fn command_fixture(name: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("current test executable"));
        command
            .arg("--exact")
            .arg(format!("token_usage::tests::{name}"))
            .arg("--nocapture")
            .env("ACORN_TOKEN_USAGE_TEST_FIXTURE", name);
        command
    }

    #[test]
    fn command_fixture_writes_large_stdout() {
        if std::env::var("ACORN_TOKEN_USAGE_TEST_FIXTURE").as_deref()
            != Ok("command_fixture_writes_large_stdout")
        {
            return;
        }
        std::io::stdout()
            .write_all(&vec![b'x'; 4 * 1024])
            .expect("write fixture stdout");
    }

    #[test]
    fn command_fixture_sleeps() {
        if std::env::var("ACORN_TOKEN_USAGE_TEST_FIXTURE").as_deref()
            != Ok("command_fixture_sleeps")
        {
            return;
        }
        thread::sleep(Duration::from_secs(2));
    }

    fn temp_file_path(label: &str) -> PathBuf {
        let ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("acorn-token-usage-{label}-{ns}.jsonl"))
    }
}
