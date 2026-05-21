use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::agent_resume::AgentKind;
use crate::error::AppResult;

const READ_TAIL_BYTES: u64 = 512 * 1024;
const DEFAULT_LIMIT: usize = 80;
const MAX_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptEntry {
    pub role: String,
    pub text: String,
    pub timestamp: Option<String>,
    pub phase: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptSnapshot {
    pub provider: String,
    pub transcript_path: String,
    pub updated_at: u64,
    pub entries: Vec<AgentTranscriptEntry>,
    pub truncated: bool,
}

pub fn read_snapshot(
    kind: AgentKind,
    path: &Path,
    limit: usize,
) -> AppResult<AgentTranscriptSnapshot> {
    let limit = if limit == 0 {
        DEFAULT_LIMIT
    } else {
        limit.min(MAX_LIMIT)
    };
    let mut entries = match kind {
        AgentKind::Claude => parse_claude_lines(&tail_lines(path)?),
        AgentKind::Codex => parse_codex_lines(&tail_lines(path)?),
    };
    let total = entries.len();
    let truncated = total > limit;
    if truncated {
        entries = entries.split_off(total - limit);
    }
    Ok(AgentTranscriptSnapshot {
        provider: provider_label(kind).to_string(),
        transcript_path: path.display().to_string(),
        updated_at: file_updated_at(path),
        entries,
        truncated,
    })
}

fn provider_label(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
    }
}

fn tail_lines(path: &Path) -> std::io::Result<Vec<String>> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(READ_TAIL_BYTES);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut lines = String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    Ok(lines)
}

fn parse_codex_lines(lines: &[String]) -> Vec<AgentTranscriptEntry> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let timestamp = string_at(Some(&value), "timestamp");
        let Some(kind) = string_at(Some(&value), "type") else {
            continue;
        };
        let payload = value.get("payload");
        let entry = match kind.as_str() {
            "event_msg" => parse_codex_event(payload, timestamp),
            "response_item" => parse_codex_response_item(payload, timestamp),
            "thread_rolled_back" => Some(AgentTranscriptEntry {
                role: "system".to_string(),
                text: string_at(payload, "num_turns")
                    .map(|n| format!("Thread rolled back {n} turn(s)."))
                    .unwrap_or_else(|| "Thread rolled back.".to_string()),
                timestamp,
                phase: None,
            }),
            _ => None,
        };
        if let Some(entry) = entry {
            if seen.insert((entry.role.clone(), entry.text.clone())) {
                entries.push(entry);
            }
        }
    }
    entries
}

fn parse_codex_event(
    payload: Option<&Value>,
    timestamp: Option<String>,
) -> Option<AgentTranscriptEntry> {
    let ty = string_at(payload, "type")?;
    match ty.as_str() {
        "user_message" => text_entry("user", string_at(payload, "message")?, timestamp, None),
        "agent_message" => text_entry(
            "assistant",
            string_at(payload, "message")?,
            timestamp,
            string_at(payload, "phase"),
        ),
        "task_complete" => text_entry(
            "assistant",
            string_at(payload, "last_agent_message")?,
            timestamp,
            Some("final_answer".to_string()),
        ),
        _ => None,
    }
}

fn parse_codex_response_item(
    payload: Option<&Value>,
    timestamp: Option<String>,
) -> Option<AgentTranscriptEntry> {
    if string_at(payload, "type").as_deref() != Some("message") {
        return None;
    }
    let role = string_at(payload, "role")?;
    if role != "user" && role != "assistant" {
        return None;
    }
    let text = first_text(&value_texts(payload?))?;
    text_entry(&role, text, timestamp, string_at(payload, "phase"))
}

fn parse_claude_lines(lines: &[String]) -> Vec<AgentTranscriptEntry> {
    let mut entries = Vec::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ty = string_at(Some(&value), "type");
        let role = value
            .get("message")
            .and_then(|message| string_at(Some(message), "role"))
            .or(ty);
        let Some(role) = role else {
            continue;
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = value
            .get("message")
            .and_then(|message| first_text(&value_texts(message)));
        if let Some(text) = text {
            entries.push(AgentTranscriptEntry {
                role,
                text,
                timestamp: string_at(Some(&value), "timestamp"),
                phase: value
                    .pointer("/message/stop_reason")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            });
        }
    }
    entries
}

fn text_entry(
    role: &str,
    text: String,
    timestamp: Option<String>,
    phase: Option<String>,
) -> Option<AgentTranscriptEntry> {
    let text = collapse_text(&text)?;
    Some(AgentTranscriptEntry {
        role: role.to_string(),
        text,
        timestamp,
        phase,
    })
}

fn value_texts(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_texts(value, &mut out);
    out
}

fn collect_texts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => {
            for item in items {
                collect_texts(item, out);
            }
        }
        Value::Object(map) => {
            for key in ["text", "output_text", "input_text", "message", "content"] {
                if let Some(child) = map.get(key) {
                    collect_texts(child, out);
                }
            }
        }
        _ => {}
    }
}

fn first_text(texts: &[String]) -> Option<String> {
    texts
        .iter()
        .filter_map(|text| collapse_text(text))
        .find(|text| !looks_like_context_block(text))
}

fn collapse_text(text: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

fn looks_like_context_block(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<environment_context>")
        || lower.contains("<instructions>")
        || lower.contains("# agents.md")
}

fn string_at(value: Option<&Value>, key: &str) -> Option<String> {
    let value = value?.get(key)?;
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .as_u64()
                .map(|n| n.to_string())
                .or_else(|| value.as_i64().map(|n| n.to_string()))
        })
}

fn file_updated_at(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_snapshot_extracts_user_and_final_answer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"timestamp":"2026-05-20T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"hello","images":[]}}"#,
                "\n",
                r#"{"timestamp":"2026-05-20T00:00:01Z","type":"event_msg","payload":{"type":"agent_message","message":"done","phase":"final_answer"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let snapshot = read_snapshot(AgentKind::Codex, &path, 20).unwrap();

        assert_eq!(snapshot.provider, "codex");
        assert_eq!(snapshot.entries.len(), 2);
        assert_eq!(snapshot.entries[0].role, "user");
        assert_eq!(snapshot.entries[0].text, "hello");
        assert_eq!(snapshot.entries[1].role, "assistant");
        assert_eq!(snapshot.entries[1].text, "done");
        assert_eq!(snapshot.entries[1].phase.as_deref(), Some("final_answer"));
    }

    #[test]
    fn claude_snapshot_extracts_user_and_assistant_text_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"timestamp":"2026-05-20T00:00:00Z","type":"user","message":{"role":"user","content":"hello claude"}}"#,
                "\n",
                r#"{"timestamp":"2026-05-20T00:00:01Z","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done claude"}]}}"#,
                "\n",
            ),
        )
        .unwrap();

        let snapshot = read_snapshot(AgentKind::Claude, &path, 20).unwrap();

        assert_eq!(snapshot.provider, "claude");
        assert_eq!(snapshot.entries.len(), 2);
        assert_eq!(snapshot.entries[0].role, "user");
        assert_eq!(snapshot.entries[0].text, "hello claude");
        assert_eq!(snapshot.entries[1].role, "assistant");
        assert_eq!(snapshot.entries[1].text, "done claude");
    }

    #[test]
    fn snapshot_limits_to_recent_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                r#"{"timestamp":"1","type":"event_msg","payload":{"type":"user_message","message":"one"}}"#,
                "\n",
                r#"{"timestamp":"2","type":"event_msg","payload":{"type":"user_message","message":"two"}}"#,
                "\n",
                r#"{"timestamp":"3","type":"event_msg","payload":{"type":"user_message","message":"three"}}"#,
                "\n",
            ),
        )
        .unwrap();

        let snapshot = read_snapshot(AgentKind::Codex, &path, 2).unwrap();

        assert!(snapshot.truncated);
        assert_eq!(
            snapshot
                .entries
                .iter()
                .map(|entry| entry.text.as_str())
                .collect::<Vec<_>>(),
            vec!["two", "three"],
        );
    }
}
