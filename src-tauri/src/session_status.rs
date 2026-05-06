//! Detects a Claude Code session's live status by inspecting the tail of its
//! JSONL transcript. Status mapping:
//!
//! - last assistant turn with `stop_reason=end_turn` → Idle (waiting on user)
//! - last assistant turn with `stop_reason=tool_use` → Running (tool pending)
//! - last user turn (new prompt or tool_result) → Running (assistant pending)
//! - no transcript yet → Idle
//!
//! Meta-only lines (type `last-prompt`, `permission-mode`, `attachment`,
//! `file-history-snapshot`) are ignored when picking the last message. The
//! transcript line itself is the source of truth — we deliberately do NOT
//! gate on mtime, otherwise the moment after `end_turn` (when the file is
//! still warm) gets misreported as Running.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use crate::error::AppResult;
use crate::session::SessionStatus;
use crate::todos;

// Big enough to comfortably contain the last assistant turn line for typical
// Claude responses. JSONL lines are one-per-message, so a long assistant
// response can be many KB on a single line.
const TAIL_BYTES: u64 = 262_144;

/// Locate the JSONL transcript via `todos::locate_transcript` and infer the
/// session's status from its tail.
pub fn detect(session_id: &str) -> AppResult<SessionStatus> {
    let path = match todos::locate_transcript_for(session_id)? {
        Some(p) => p,
        None => return Ok(SessionStatus::Idle),
    };

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let read_full = file_size <= TAIL_BYTES;
    let tail = read_tail(&path, TAIL_BYTES).unwrap_or_default();
    let last_kind = last_meaningful_kind(&tail, read_full);

    Ok(match last_kind {
        Some(LastKind::AssistantEndTurn) => SessionStatus::Idle,
        Some(LastKind::AssistantToolUse) => SessionStatus::Running,
        Some(LastKind::User) => SessionStatus::Running,
        None => SessionStatus::Idle,
    })
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

fn last_meaningful_kind(tail: &str, read_full: bool) -> Option<LastKind> {
    // Walk lines newest-first; skip meta lines.
    let mut lines: Vec<&str> = tail.lines().collect();
    if lines.is_empty() {
        return None;
    }
    // The first line in the buffer may be truncated when we tail-read; drop
    // it. When the entire file fit in the buffer, the first line is intact
    // and we keep it.
    if !read_full && lines.len() > 1 {
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
