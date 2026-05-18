//! Detects a session's live status by inspecting the tail of the JSONL
//! transcript the in-flight agent is writing. Status mapping:
//!
//! Claude transcripts:
//! - last assistant turn with `stop_reason=end_turn` → NeedsInput (claude
//!   has finished its turn and is awaiting the user's next prompt). Surfaces
//!   the warning-tone status dot in the Sidebar and triggers the
//!   `needsInput` system notification when the user has it enabled.
//! - last assistant turn with `stop_reason=tool_use` → Running (tool pending)
//! - last user turn (new prompt or tool_result) → Running (assistant pending)
//! - no transcript yet → Idle (session has not produced any conversation)
//!
//! Codex transcripts:
//! - last `payload.type=task_complete` (or `agent_message` with
//!   `phase=final_answer`) → NeedsInput (codex finished a turn).
//! - last `payload.type=user_message` → Running (the user just sent a
//!   prompt and codex is composing the response).
//! - everything else with content → Running (function calls, intermediate
//!   `agent_message phase=commentary`, reasoning, etc.).
//!
//! Meta-only lines (claude: `last-prompt` / `permission-mode` /
//! `attachment` / `file-history-snapshot` / `system`; codex: `token_count`
//! and other event_msg telemetry) are ignored when picking the last
//! message. The transcript line itself is the source of truth — we
//! deliberately do NOT gate on mtime, otherwise the moment after a turn
//! ends (file still warm) gets misreported as Running.
//!
//! Transcript resolution. The on-disk markers `<data_dir>/agent-state/
//! <acorn-session-uuid>/{claude,codex}.id` (kept fresh by
//! `agent_resume_persister`) are the canonical bridge from an Acorn
//! session UUID to the agent's transcript filename. Without this, the
//! detector could only consult `~/.claude/projects/*/<acorn-uuid>.jsonl`,
//! which never matches in the common case where the user runs
//! `claude` / `codex` *inside* an Acorn shell session (the JSONL is
//! named after the agent's own UUID, not Acorn's). The result was that
//! every claude/codex run looked perpetually `Running` until the agent
//! process exited — `NeedsInput` was structurally unreachable.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use acorn_pty::ShellHint;

use crate::agent_resume::{self, AgentKind, LiveTranscript};
use crate::error::AppResult;
use crate::session::SessionStatus;
use crate::todos;

// Big enough to comfortably contain the last assistant turn line for typical
// Claude responses. JSONL lines are one-per-message, so a long assistant
// response can be many KB on a single line.
const TAIL_BYTES: u64 = 262_144;

/// Resolve the session's live transcript (via the persister's resume
/// markers or — as a legacy fallback — the Acorn UUID itself) and infer
/// status from its tail.
///
/// `previous` is the last status the caller observed for this session. It is
/// only consulted when the transcript file exists but the tail buffer is
/// filled entirely with non-turn entries (long bursts of `system`/
/// `last-prompt`/`attachment`/`file-history-snapshot` lines from recent
/// claude versions, or codex `token_count` telemetry, can push the actual
/// turn out of the 256 KiB tail window). Without this fallback, polling
/// momentarily reclassifies a live session as Idle, leaving the Sidebar
/// dot stuck at Idle until the agent emits another turn line within the
/// tail window — which for long sessions can be never.
///
/// `shell_hint` carries the descendant-process snapshot for shell-mode
/// sessions (no transcript on disk). It is the only signal we have for
/// terminal sessions, so when no transcript resolves we map it directly
/// to a status. `None` means "no live PTY" → Idle.
pub fn detect(
    session_id: &str,
    previous: SessionStatus,
    shell_hint: Option<ShellHint>,
) -> AppResult<SessionStatus> {
    let resolved = resolve_transcript(session_id);
    let (path, kind) = match resolved {
        Some(LiveTranscript { path, kind }) => (path, kind),
        None => return Ok(map_shell_hint(shell_hint)),
    };

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let read_full = file_size <= TAIL_BYTES;
    let tail = read_tail(&path, TAIL_BYTES).unwrap_or_default();
    let classified = match kind {
        AgentKind::Claude => classify_claude_tail(&tail, read_full),
        AgentKind::Codex => classify_codex_tail(&tail, read_full),
    };

    Ok(match classified {
        Some(TurnClass::NeedsInput) => SessionStatus::NeedsInput,
        Some(TurnClass::Running) => SessionStatus::Running,
        // Transcript exists but the tail held no turn lines; keep
        // whatever the caller previously observed instead of regressing
        // to Idle. The next poll that lands on a real turn line corrects
        // it.
        None => previous,
    })
}

/// Two-stage transcript lookup. First the persister marker (the canonical
/// path for "user ran `claude` / `codex` inside a shell session"), then
/// the legacy Acorn-UUID-named JSONL (kept so any direct caller that
/// passes a claude session-id continues to work, and so the dedicated
/// unit tests below can stage a fixture without standing up a fake
/// `agent-state` tree). Returns `None` only when neither lookup
/// resolves — that's the cue for `detect` to fall back to `shell_hint`.
fn resolve_transcript(session_id: &str) -> Option<LiveTranscript> {
    let parsed = uuid::Uuid::parse_str(session_id).ok();
    if let Some(uuid) = parsed {
        if let Some(found) = agent_resume::live_transcript(uuid) {
            return Some(found);
        }
    }
    todos::locate_transcript_for(session_id)
        .ok()
        .flatten()
        .map(|path| LiveTranscript {
            path,
            kind: AgentKind::Claude,
        })
}

fn map_shell_hint(hint: Option<ShellHint>) -> SessionStatus {
    match hint {
        Some(ShellHint::Running) => SessionStatus::Running,
        Some(ShellHint::NeedsInput) => SessionStatus::NeedsInput,
        Some(ShellHint::Idle) | None => SessionStatus::Idle,
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TurnClass {
    NeedsInput,
    Running,
}

fn read_tail(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(max_bytes.min(len) as usize);
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn classify_claude_tail(tail: &str, read_full: bool) -> Option<TurnClass> {
    for line in tail_lines_newest_first(tail, read_full) {
        let Some(v) = parse_json_line(line) else {
            continue;
        };
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if line_type != "user" && line_type != "assistant" {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        if line_type == "user" {
            return Some(TurnClass::Running);
        }
        let stop_reason = msg
            .get("stop_reason")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        return Some(match stop_reason {
            "end_turn" | "stop_sequence" => TurnClass::NeedsInput,
            "tool_use" => TurnClass::Running,
            // Unknown / null → assume the assistant turn is still live.
            _ => TurnClass::Running,
        });
    }
    None
}

fn classify_codex_tail(tail: &str, read_full: bool) -> Option<TurnClass> {
    for line in tail_lines_newest_first(tail, read_full) {
        let Some(v) = parse_json_line(line) else {
            continue;
        };
        let payload_type = v
            .pointer("/payload/type")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        match payload_type {
            // `task_complete` is emitted exactly once per turn, after the
            // final `agent_message`. Authoritative "codex is waiting".
            "task_complete" => return Some(TurnClass::NeedsInput),
            "user_message" => return Some(TurnClass::Running),
            "function_call" | "function_call_output" | "reasoning" => {
                return Some(TurnClass::Running);
            }
            "agent_message" => {
                // The final answer phase is the user-visible "turn over"
                // signal when `task_complete` got truncated out of the
                // tail window. `commentary` is intermediate narration
                // between tool calls — keep treating those as Running.
                let phase = v
                    .pointer("/payload/phase")
                    .and_then(|p| p.as_str())
                    .unwrap_or("");
                return Some(if phase == "final_answer" {
                    TurnClass::NeedsInput
                } else {
                    TurnClass::Running
                });
            }
            "message" => {
                // `response_item` mirror of an `agent_message`. Treat
                // assistant messages as in-flight unless we have stronger
                // signal upstream (the `task_complete` / `final_answer`
                // branches above land first when present).
                if v.pointer("/payload/role").and_then(|r| r.as_str()) == Some("assistant") {
                    return Some(TurnClass::Running);
                }
                continue;
            }
            // event_msg lines that are pure telemetry (`token_count`,
            // `agent_reasoning_*`, `rate_limit_*`, etc.) are skipped —
            // they don't change the turn-completion state.
            _ => continue,
        }
    }
    None
}

fn tail_lines_newest_first(tail: &str, read_full: bool) -> impl Iterator<Item = &str> {
    let mut lines: Vec<&str> = tail.lines().collect();
    // The first line in the buffer may be truncated when we tail-read; drop
    // it. When the entire file fit in the buffer, the first line is intact
    // and we keep it.
    if !read_full && lines.len() > 1 {
        lines.remove(0);
    }
    lines.into_iter().rev().filter(|l| !l.trim().is_empty())
}

fn parse_json_line(line: &str) -> Option<serde_json::Value> {
    serde_json::from_str(line.trim()).ok()
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
        assert_eq!(classify_claude_tail("", true), None);
    }

    #[test]
    fn user_turn_maps_to_running() {
        assert_eq!(
            classify_claude_tail(user_turn(), true),
            Some(TurnClass::Running),
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
            classify_claude_tail(&tail, true),
            Some(TurnClass::NeedsInput),
        );
    }

    #[test]
    fn assistant_tool_use_maps_to_running() {
        assert_eq!(
            classify_claude_tail(&assistant("tool_use"), true),
            Some(TurnClass::Running),
        );
    }

    #[test]
    fn unknown_stop_reason_treated_as_running() {
        assert_eq!(
            classify_claude_tail(&assistant("max_tokens"), true),
            Some(TurnClass::Running),
        );
    }

    #[test]
    fn truncated_first_line_is_dropped_when_not_read_full() {
        let tail = format!("ent\":[]}}}}\n{}\n", user_turn());
        assert_eq!(classify_claude_tail(&tail, false), Some(TurnClass::Running),);
    }

    #[test]
    fn intact_first_line_is_kept_when_read_full() {
        assert_eq!(
            classify_claude_tail(user_turn(), true),
            Some(TurnClass::Running),
        );
    }

    #[test]
    fn meta_only_tail_returns_none() {
        let tail = meta_lines().join("\n");
        assert_eq!(classify_claude_tail(&tail, true), None);
    }

    #[test]
    fn shell_hint_running_maps_to_running() {
        assert_eq!(
            map_shell_hint(Some(ShellHint::Running)),
            SessionStatus::Running
        );
    }

    #[test]
    fn shell_hint_needs_input_maps_to_needs_input() {
        assert_eq!(
            map_shell_hint(Some(ShellHint::NeedsInput)),
            SessionStatus::NeedsInput,
        );
    }

    #[test]
    fn shell_hint_idle_maps_to_idle() {
        assert_eq!(map_shell_hint(Some(ShellHint::Idle)), SessionStatus::Idle);
    }

    #[test]
    fn shell_hint_none_maps_to_idle() {
        assert_eq!(map_shell_hint(None), SessionStatus::Idle);
    }

    #[test]
    fn assistant_without_message_is_skipped() {
        let tail = format!("{}\n{}\n", r#"{"type":"assistant"}"#, user_turn(),);
        assert_eq!(classify_claude_tail(&tail, true), Some(TurnClass::Running),);
    }

    // --- codex format ---

    #[test]
    fn codex_task_complete_maps_to_needs_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(classify_codex_tail(tail, true), Some(TurnClass::NeedsInput),);
    }

    #[test]
    fn codex_final_answer_agent_message_maps_to_needs_input() {
        // Simulates `task_complete` falling outside the tail window so
        // the walker falls back to the most recent `agent_message`
        // phase.
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"all done","phase":"final_answer","memory_citation":null}}"#;
        assert_eq!(classify_codex_tail(tail, true), Some(TurnClass::NeedsInput),);
    }

    #[test]
    fn codex_function_call_maps_to_running() {
        let tail = r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c1"}}"#;
        assert_eq!(classify_codex_tail(tail, true), Some(TurnClass::Running));
    }

    #[test]
    fn codex_commentary_agent_message_maps_to_running() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"checking","phase":"commentary","memory_citation":null}}"#;
        assert_eq!(classify_codex_tail(tail, true), Some(TurnClass::Running));
    }

    #[test]
    fn codex_user_message_maps_to_running() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"hi","images":[],"local_images":[],"text_elements":[]}}"#;
        assert_eq!(classify_codex_tail(tail, true), Some(TurnClass::Running));
    }

    #[test]
    fn codex_token_count_telemetry_is_skipped() {
        // A `token_count` event after a `task_complete` must not flip
        // the classification — the walker should skip it and find the
        // `task_complete` behind it.
        let tail = concat!(
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#,
            "\n",
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
        );
        assert_eq!(classify_codex_tail(tail, true), Some(TurnClass::NeedsInput),);
    }

    #[test]
    fn codex_empty_tail_returns_none() {
        assert_eq!(classify_codex_tail("", true), None);
    }
}
