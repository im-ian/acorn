use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use directories::UserDirs;
use serde::Serialize;
use serde_json::Value;

const CODEX_SESSION_SCAN_LIMIT: usize = 20;
const CODEX_SESSION_TAIL_BYTES: u64 = 256 * 1024;

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
pub fn get_agent_token_usage() -> AgentTokenUsageSnapshot {
    read_agent_token_usage()
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
    let files = latest_jsonl_files(&sessions, CODEX_SESSION_SCAN_LIMIT);

    for file in files {
        if let Some(parsed) = read_codex_rate_limits_from_session_file(&file) {
            return Some(parsed);
        }
    }

    None
}

fn read_codex_rate_limits_from_session_file(file: &Path) -> Option<ProviderRateLimits> {
    let text = read_tail_lossy(file, CODEX_SESSION_TAIL_BYTES).ok()?;
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
    if !db.exists() {
        return ProviderRateLimits::default();
    }

    let query = r#"
        select feedback_log_body from logs
        where feedback_log_body like '%"type":"codex.rate_limits"%'
        order by ts desc, ts_nanos desc, id desc
        limit 1;
    "#;
    let Ok(output) = Command::new("/usr/bin/sqlite3")
        .arg(&db)
        .arg(query)
        .output()
    else {
        return ProviderRateLimits::default();
    };
    if !output.status.success() {
        return ProviderRateLimits::default();
    }
    let text = String::from_utf8_lossy(&output.stdout);
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
        let Ok(data) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
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

fn latest_jsonl_files(root: &Path, limit: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl_files(root, &mut files);
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
        .into_iter()
        .take(limit)
        .map(|(path, _)| path)
        .collect()
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if metadata.is_dir() {
            collect_jsonl_files(&path, files);
            continue;
        }
        if !metadata.is_file() || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        files.push((path, metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    }
}

fn read_tail_lossy(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    if max_bytes == 0 {
        return Ok(String::new());
    }
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(max_bytes.min(len) as usize);
    file.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
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
    use std::io::Write;

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
        let tail = read_tail_lossy(&path, CODEX_SESSION_TAIL_BYTES).expect("read tail");
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

    fn temp_file_path(label: &str) -> PathBuf {
        let ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("acorn-token-usage-{label}-{ns}.jsonl"))
    }
}
