//! Detects a Claude Code session's live status by inspecting the tail of its
//! JSONL transcript. Status mapping:
//!
//! - last assistant turn with `stop_reason=end_turn` → Idle (waiting on user)
//! - last assistant turn with `stop_reason=tool_use` → Running (tool pending)
//! - last user turn (new prompt or tool_result) → Running (assistant pending)
//! - mtime within 2s → Running (still streaming, even if tail shows end_turn)
//! - no transcript yet → Idle
//!
//! Meta-only lines (type `last-prompt`, `permission-mode`, `attachment`,
//! `file-history-snapshot`) are ignored when picking the last message.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::time::SystemTime;

use crate::error::AppResult;
use crate::session::SessionStatus;
use crate::todos;

const TAIL_BYTES: u64 = 65_536;
const STREAMING_FRESH_SECS: u64 = 2;

/// Locate the JSONL transcript via `todos::locate_transcript` and infer the
/// session's status from its tail.
pub fn detect(session_id: &str) -> AppResult<SessionStatus> {
    let path = match todos::locate_transcript_for(session_id)? {
        Some(p) => p,
        None => return Ok(SessionStatus::Idle),
    };

    let mtime_age = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_secs())
        .unwrap_or(u64::MAX);

    let tail = read_tail(&path, TAIL_BYTES).unwrap_or_default();
    let last_kind = last_meaningful_kind(&tail);

    let status = match last_kind {
        Some(LastKind::AssistantEndTurn) => SessionStatus::Idle,
        Some(LastKind::AssistantToolUse) => SessionStatus::Running,
        Some(LastKind::User) => SessionStatus::Running,
        None => SessionStatus::Idle,
    };

    // If the file was just touched, treat as Running regardless of tail (the
    // assistant turn currently streaming may not be fully written yet).
    if mtime_age <= STREAMING_FRESH_SECS && status == SessionStatus::Idle {
        return Ok(SessionStatus::Running);
    }
    Ok(status)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LastKind {
    AssistantEndTurn,
    AssistantToolUse,
    User,
}

fn read_tail(path: &std::path::Path, max_bytes: u64) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(max_bytes.min(len) as usize);
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn last_meaningful_kind(tail: &str) -> Option<LastKind> {
    // Walk lines newest-first; skip meta lines and partial first line.
    let mut lines: Vec<&str> = tail.lines().collect();
    if lines.is_empty() {
        return None;
    }
    // The first line in the buffer may be truncated (we did a tail read).
    // Drop it unless it's the only line.
    if lines.len() > 1 {
        lines.remove(0);
    }
    for line in lines.into_iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if line_type != "user" && line_type != "assistant" {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        if line_type == "user" {
            return Some(LastKind::User);
        }
        // assistant
        let stop_reason = msg
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        return match stop_reason {
            "end_turn" | "stop_sequence" => Some(LastKind::AssistantEndTurn),
            "tool_use" => Some(LastKind::AssistantToolUse),
            // Unknown / null → assume the assistant turn is still live.
            _ => Some(LastKind::AssistantToolUse),
        };
    }
    None
}
