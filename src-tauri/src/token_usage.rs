use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(test)]
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    push_provider_metrics(
        &mut metrics,
        AgentTokenProvider::Codex,
        codex,
        "~/.codex/sessions rate_limits",
        "No Codex 5h rate-limit event found",
        "No Codex weekly rate-limit event found",
    );
    push_provider_metrics(
        &mut metrics,
        AgentTokenProvider::Claude,
        claude,
        "~/.claude/token-widget/claude-rate-limits.json",
        "No Claude 5h statusline rate-limit capture found",
        "No Claude weekly statusline rate-limit capture found",
    );

    AgentTokenUsageSnapshot {
        metrics,
        updated_at,
    }
}

fn push_provider_metrics(
    metrics: &mut Vec<AgentTokenUsageMetric>,
    provider: AgentTokenProvider,
    rate_limits: ProviderRateLimits,
    fallback_source: &str,
    five_hour_fallback_error: &str,
    weekly_fallback_error: &str,
) {
    let has_reported_window = rate_limits.five_hour.is_some() || rate_limits.weekly.is_some();
    if has_reported_window {
        if let Some(five_hour) = rate_limits.five_hour {
            push_metric(
                metrics,
                provider,
                AgentTokenWindow::FiveHour,
                Some(five_hour),
                fallback_source,
                five_hour_fallback_error,
            );
        }
        if let Some(weekly) = rate_limits.weekly {
            push_metric(
                metrics,
                provider,
                AgentTokenWindow::Weekly,
                Some(weekly),
                fallback_source,
                weekly_fallback_error,
            );
        }
        return;
    }

    push_metric(
        metrics,
        provider,
        AgentTokenWindow::FiveHour,
        None,
        fallback_source,
        five_hour_fallback_error,
    );
    push_metric(
        metrics,
        provider,
        AgentTokenWindow::Weekly,
        None,
        fallback_source,
        weekly_fallback_error,
    );
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
    let mut parsed = ProviderRateLimits::default();
    for (key, fallback_window) in [
        ("primary", AgentTokenWindow::FiveHour),
        ("secondary", AgentTokenWindow::Weekly),
    ] {
        let Some(value) = value.get(key) else {
            continue;
        };
        let Some(rate_limit) = parse_rate_limit_window(
            Some(value),
            &["used_percent"],
            &["reset_at", "resets_at"],
            source,
        ) else {
            continue;
        };
        let window = match number(value.get("window_minutes")) {
            Some(300.0) => AgentTokenWindow::FiveHour,
            Some(10_080.0) => AgentTokenWindow::Weekly,
            _ => fallback_window,
        };
        match window {
            AgentTokenWindow::FiveHour => parsed.five_hour = Some(rate_limit),
            AgentTokenWindow::Weekly => parsed.weekly = Some(rate_limit),
        }
    }
    parsed
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
    let before = fs::symlink_metadata(path)?;
    if !before.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a regular file without symlinks",
        ));
    }
    if before.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds byte budget",
        ));
    }

    let file = File::open(path)?;
    let opened = file.metadata()?;
    if !opened.file_type().is_file()
        || opened.len() > max_bytes
        || !same_opened_file(&before, &opened)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file changed or exceeded its byte budget while opening",
        ));
    }
    let capacity = opened.len().min(max_bytes).min(usize::MAX as u64) as usize;
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

#[cfg(unix)]
fn same_opened_file(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    before.dev() == opened.dev() && before.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_opened_file(_before: &fs::Metadata, _opened: &fs::Metadata) -> bool {
    true
}

fn command_stdout_bounded(
    command: &mut Command,
    max_stdout: usize,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    let output = acorn_platform::process::run_bounded(
        command,
        None,
        acorn_platform::process::BoundedOutputLimits {
            timeout,
            stdin_bytes: 0,
            stdout_bytes: max_stdout,
            stderr_bytes: 64 * 1024,
        },
    )?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "child process exited with {}",
            output.status
        )));
    }
    Ok(output.stdout)
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
            "primary": {
                "used_percent": 12,
                "window_minutes": 300,
                "resets_at": 1779860400
            },
            "secondary": {
                "used_percent": 34.5,
                "window_minutes": 10080,
                "reset_at": 1779930000
            }
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
    fn parses_weekly_codex_limit_from_primary_window_metadata() {
        let value: Value = serde_json::json!({
            "primary": {
                "used_percent": 36,
                "window_minutes": 10080,
                "resets_at": 1785902976
            },
            "secondary": null
        });

        let limits = parse_codex_rate_limits(&value, "codex");

        assert_eq!(limits.five_hour, None);
        let weekly = limits.weekly.unwrap();
        assert_eq!(weekly.used_percent, 36.0);
        assert_eq!(weekly.reset_at, Some(1785902976.0));
    }

    #[test]
    fn parses_five_hour_codex_limit_when_it_is_the_only_window() {
        let value: Value = serde_json::json!({
            "primary": {
                "used_percent": 21,
                "window_minutes": 300,
                "resets_at": 1785902976
            },
            "secondary": null
        });

        let limits = parse_codex_rate_limits(&value, "codex");

        let five_hour = limits.five_hour.unwrap();
        assert_eq!(five_hour.used_percent, 21.0);
        assert_eq!(five_hour.reset_at, Some(1785902976.0));
        assert_eq!(limits.weekly, None);
    }

    #[test]
    fn preserves_positional_fallback_for_codex_events_without_window_metadata() {
        let value: Value = serde_json::json!({
            "primary": { "used_percent": 12 },
            "secondary": { "used_percent": 34.5 }
        });

        let limits = parse_codex_rate_limits(&value, "codex");

        assert_eq!(limits.five_hour.unwrap().used_percent, 12.0);
        assert_eq!(limits.weekly.unwrap().used_percent, 34.5);
    }

    #[test]
    fn omits_unreported_windows_when_provider_has_usage() {
        let mut metrics = Vec::new();
        let limits = ProviderRateLimits {
            five_hour: None,
            weekly: Some(RateLimitWindow {
                used_percent: 36.0,
                reset_at: Some(1785902976.0),
                source: "codex".to_string(),
            }),
        };

        push_provider_metrics(
            &mut metrics,
            AgentTokenProvider::Codex,
            limits,
            "codex",
            "missing 5h",
            "missing weekly",
        );

        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].window, AgentTokenWindow::Weekly);
        assert_eq!(metrics[0].remaining_percent, Some(64.0));
        assert_eq!(metrics[0].error, None);
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
            r#"{{"payload":{{"type":"event_msg","rate_limits":{{"primary":{{"used_percent":42,"window_minutes":10080,"resets_at":1779860400}},"secondary":null}}}}}}"#
        )
        .expect("write rate limit event");
        drop(file);

        let parsed = read_codex_rate_limits_from_session_file(&path).expect("rate limits");

        assert_eq!(parsed.five_hour, None);
        assert_eq!(parsed.weekly.unwrap().used_percent, 42.0);
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
