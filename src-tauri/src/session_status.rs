//! Detects a Claude Code session's live status by inspecting the tail of its
//! JSONL transcript. Status mapping:
//!
//! - last assistant turn with `stop_reason=end_turn` → NeedsInput (claude
//!   has finished its turn and is awaiting the user's next prompt). Surfaces
//!   the warning-tone status dot in the Sidebar and triggers the
//!   `needsInput` system notification when the user has it enabled.
//! - last assistant turn with `stop_reason=tool_use` → Running (tool pending)
//! - last user turn (new prompt or tool_result) → Running (assistant pending)
//! - no transcript yet → Idle (session has not produced any conversation)
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
///
/// `previous` is the last status the caller observed for this session. It is
/// only consulted when the transcript file exists but the tail buffer is
/// filled entirely with non-`user`/`assistant` entries (long bursts of
/// `system`/`last-prompt`/`attachment`/`file-history-snapshot` lines from
/// recent claude versions can push the actual turn out of the 256 KiB tail
/// window). Without this fallback, polling momentarily reclassifies a live
/// session as Idle, leaving the Sidebar dot stuck at Idle until claude
/// emits another user/assistant line within the tail window — which for
/// long sessions can be never. Sessions with no transcript on disk still
/// resolve to Idle regardless of `previous`.
pub fn detect(session_id: &str, previous: SessionStatus) -> AppResult<SessionStatus> {
    let path = match todos::locate_transcript_for(session_id)? {
        Some(p) => p,
        None => return Ok(SessionStatus::Idle),
    };

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let read_full = file_size <= TAIL_BYTES;
    let tail = read_tail(&path, TAIL_BYTES).unwrap_or_default();
    let last_kind = last_meaningful_kind(&tail, read_full);

    Ok(match last_kind {
        Some(LastKind::AssistantEndTurn) => SessionStatus::NeedsInput,
        Some(LastKind::AssistantToolUse) => SessionStatus::Running,
        Some(LastKind::User) => SessionStatus::Running,
        // Transcript exists but the tail held no user/assistant lines; keep
        // whatever the caller previously observed instead of regressing to
        // Idle. The next poll that lands on a real turn line corrects it.
        None => previous,
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
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

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(stop_reason: &str) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"role":"assistant","stop_reason":"{stop_reason}","content":[]}}}}"#
        )
    }

    fn user_turn() -> &'static str {
        r#"{"type":"user","message":{"role":"user","content":"hi"}}"#
    }

    fn meta_lines() -> Vec<&'static str> {
        vec![
            r#"{"type":"last-prompt","lastPrompt":"x"}"#,
            r#"{"type":"permission-mode","mode":"acceptEdits"}"#,
            r#"{"type":"attachment"}"#,
            r#"{"type":"file-history-snapshot"}"#,
            // System lines (turn_duration, away_summary) get appended after the
            // assistant's `end_turn`. The walker must skip past them and still
            // classify the trailing assistant turn — otherwise the sidebar
            // dot regresses to Idle the moment claude finishes a turn.
            r#"{"type":"system","subtype":"turn_duration","durationMs":1234}"#,
            r#"{"type":"system","subtype":"away_summary","content":"…"}"#,
        ]
    }

    #[test]
    fn empty_tail_returns_none() {
        assert_eq!(last_meaningful_kind("", true), None);
    }

    #[test]
    fn user_turn_maps_to_user() {
        assert_eq!(
            last_meaningful_kind(user_turn(), true),
            Some(LastKind::User),
        );
    }

    #[test]
    fn assistant_end_turn_wins_over_trailing_meta() {
        let mut tail = String::new();
        tail.push_str(&assistant("end_turn"));
        tail.push('\n');
        for m in meta_lines() {
            tail.push_str(m);
            tail.push('\n');
        }
        assert_eq!(
            last_meaningful_kind(&tail, true),
            Some(LastKind::AssistantEndTurn),
        );
    }

    #[test]
    fn assistant_tool_use_maps_to_tool_use() {
        assert_eq!(
            last_meaningful_kind(&assistant("tool_use"), true),
            Some(LastKind::AssistantToolUse),
        );
    }

    #[test]
    fn unknown_stop_reason_treated_as_tool_use() {
        assert_eq!(
            last_meaningful_kind(&assistant("max_tokens"), true),
            Some(LastKind::AssistantToolUse),
        );
    }

    #[test]
    fn truncated_first_line_is_dropped_when_not_read_full() {
        // Synthesize a buffer whose first line is a partial JSON fragment
        // (the kind tail-reading produces when the file exceeds TAIL_BYTES).
        // The walker must drop it and still find the user turn behind it
        // instead of bailing to None.
        let tail = format!("ent\":[]}}}}\n{}\n", user_turn());
        assert_eq!(
            last_meaningful_kind(&tail, false),
            Some(LastKind::User),
        );
    }

    #[test]
    fn intact_first_line_is_kept_when_read_full() {
        // When the entire file fits in the buffer, the first line is intact
        // and must be considered — otherwise short transcripts with a single
        // user turn would report Idle.
        assert_eq!(
            last_meaningful_kind(user_turn(), true),
            Some(LastKind::User),
        );
    }

    #[test]
    fn meta_only_tail_returns_none() {
        // Documents the case the `previous`-status fallback in
        // `detect()` exists to compensate for: a tail packed with
        // meta lines (no user/assistant turn within the window) leaves
        // the walker with nothing to classify.
        let tail = meta_lines().join("\n");
        assert_eq!(last_meaningful_kind(&tail, true), None);
    }

    #[test]
    fn assistant_without_message_is_skipped() {
        // Defensive: a malformed assistant line without a `message` field
        // must not be classified — the walker should keep looking.
        let tail = format!(
            "{}\n{}\n",
            r#"{"type":"assistant"}"#,
            user_turn(),
        );
        assert_eq!(
            last_meaningful_kind(&tail, true),
            Some(LastKind::User),
        );
    }
}
