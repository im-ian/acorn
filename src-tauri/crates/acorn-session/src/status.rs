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
//! Antigravity transcripts:
//! - last `type=PLANNER_RESPONSE` with `status=DONE` → NeedsInput.
//! - last `type=USER_INPUT` or any non-DONE model/tool line → Running.
//!
//! Meta-only lines (claude: `last-prompt` / `permission-mode` /
//! `attachment` / `file-history-snapshot` / `system`; codex: `token_count`
//! and other event_msg telemetry) are ignored when picking the last
//! message. The transcript line itself is the source of truth — we
//! deliberately do NOT gate on mtime, otherwise the moment after a turn
//! ends (file still warm) gets misreported as Running.
//!
//! Transcript resolution lives in the host `acorn` crate (it consults
//! `agent_resume`'s persister markers + the legacy `~/.claude/projects/`
//! UUID-named fallback) and is passed in here as `(PathBuf, AgentKind)`
//! so this crate stays a leaf with no upstream dependency.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use acorn_pty::ShellHint;
use serde::Serialize;

use crate::session::SessionStatus;

// Big enough to comfortably contain the last assistant turn line for typical
// Claude responses. JSONL lines are one-per-message, so a long assistant
// response can be many KB on a single line.
const TAIL_BYTES: u64 = 262_144;

/// Which agent's transcript format the tail should be parsed as. The host
/// crate maps its richer `agent_resume::AgentKind` onto this enum when a
/// transcript exists.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentKind {
    Claude,
    Codex,
    Antigravity,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StatusReason {
    TurnComplete,
    ShellPrompt,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StatusDetection {
    pub status: SessionStatus,
    pub reason: Option<StatusReason>,
}

impl StatusDetection {
    fn new(status: SessionStatus, reason: Option<StatusReason>) -> Self {
        Self { status, reason }
    }
}

/// Infer a session's status from its transcript tail (when one was resolved)
/// plus an optional shell-mode liveness hint.
///
/// `transcript` is `Some((path, kind))` when the caller resolved a live
/// JSONL for the session (via `agent_resume` markers or the legacy lookup);
/// `None` falls back to the shell hint.
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
/// `shell_hint` carries the descendant-process snapshot for the session's
/// PTY. It also guards transcript markers from becoming sticky state:
/// resume markers are durable, so an old transcript can still end in
/// `NeedsInput` long after the agent process exited. When the PTY is idle
/// (or gone), the durable marker is stale for status purposes and the
/// session should be Idle. When a live descendant exists, the transcript
/// tail refines that live process into Running vs NeedsInput.
pub fn detect(
    transcript: Option<(PathBuf, AgentKind)>,
    previous: SessionStatus,
    shell_hint: Option<ShellHint>,
) -> SessionStatus {
    detect_with_reason(transcript, previous, shell_hint).status
}

pub fn detect_with_reason(
    transcript: Option<(PathBuf, AgentKind)>,
    previous: SessionStatus,
    shell_hint: Option<ShellHint>,
) -> StatusDetection {
    if matches!(shell_hint, Some(ShellHint::Idle) | None) {
        return StatusDetection::new(SessionStatus::Idle, None);
    }

    let (path, kind) = match transcript {
        Some(t) => t,
        None => return detect_shell_hint(shell_hint),
    };

    let file_size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let read_full = file_size <= TAIL_BYTES;
    let tail = read_tail(&path, TAIL_BYTES).unwrap_or_default();
    let classified = match kind {
        AgentKind::Claude => classify_claude_tail(&tail, read_full),
        AgentKind::Codex => classify_codex_tail(&tail, read_full),
        AgentKind::Antigravity => classify_antigravity_tail(&tail, read_full),
    };

    match classified {
        Some(TurnClass::NeedsInput) => {
            StatusDetection::new(SessionStatus::NeedsInput, Some(StatusReason::TurnComplete))
        }
        Some(TurnClass::Running) => StatusDetection::new(SessionStatus::Running, None),
        // Transcript exists but the tail held no turn lines; keep
        // whatever the caller previously observed instead of regressing
        // to Idle. The next poll that lands on a real turn line corrects
        // it.
        None => StatusDetection::new(previous, None),
    }
}

#[cfg(test)]
fn map_shell_hint(hint: Option<ShellHint>) -> SessionStatus {
    detect_shell_hint(hint).status
}

fn detect_shell_hint(hint: Option<ShellHint>) -> StatusDetection {
    match hint {
        Some(ShellHint::Running) => StatusDetection::new(SessionStatus::Running, None),
        Some(ShellHint::NeedsInput) => {
            StatusDetection::new(SessionStatus::NeedsInput, Some(StatusReason::ShellPrompt))
        }
        Some(ShellHint::Idle) | None => StatusDetection::new(SessionStatus::Idle, None),
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

fn classify_antigravity_tail(tail: &str, read_full: bool) -> Option<TurnClass> {
    for line in tail_lines_newest_first(tail, read_full) {
        let Some(v) = parse_json_line(line) else {
            continue;
        };
        let line_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let status = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
        match line_type {
            "USER_INPUT" => return Some(TurnClass::Running),
            "PLANNER_RESPONSE" => {
                return Some(if status == "DONE" {
                    TurnClass::NeedsInput
                } else {
                    TurnClass::Running
                });
            }
            "CONVERSATION_HISTORY" => continue,
            "" => continue,
            _ => return Some(TurnClass::Running),
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

    // --- antigravity format ---

    #[test]
    fn antigravity_done_planner_maps_to_needs_input() {
        let tail = r#"{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify_antigravity_tail(tail, true),
            Some(TurnClass::NeedsInput),
        );
    }

    #[test]
    fn antigravity_user_input_maps_to_running() {
        let tail = r#"{"type":"USER_INPUT","status":"DONE","content":"hi"}"#;
        assert_eq!(
            classify_antigravity_tail(tail, true),
            Some(TurnClass::Running),
        );
    }

    #[test]
    fn antigravity_non_planner_done_maps_to_running() {
        let tail = r#"{"type":"TOOL_CALL","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify_antigravity_tail(tail, true),
            Some(TurnClass::Running),
        );
    }

    // --- detect() entry point ---

    #[test]
    fn detect_returns_idle_when_no_transcript_and_no_hint() {
        assert_eq!(
            detect(None, SessionStatus::Idle, None),
            SessionStatus::Idle
        );
    }

    #[test]
    fn detect_uses_shell_hint_when_no_transcript() {
        assert_eq!(
            detect(None, SessionStatus::Idle, Some(ShellHint::Running)),
            SessionStatus::Running
        );
    }

    #[test]
    fn detect_ignores_stale_needs_input_transcript_when_shell_is_idle() {
        let path = write_status_transcript(&assistant("end_turn"));

        assert_eq!(
            detect(
                Some((path, AgentKind::Claude)),
                SessionStatus::NeedsInput,
                Some(ShellHint::Idle),
            ),
            SessionStatus::Idle,
        );
    }

    #[test]
    fn detect_ignores_stale_needs_input_transcript_without_live_pty() {
        let path = write_status_transcript(&assistant("end_turn"));

        assert_eq!(
            detect(
                Some((path, AgentKind::Claude)),
                SessionStatus::NeedsInput,
                None,
            ),
            SessionStatus::Idle,
        );
    }

    #[test]
    fn detect_uses_needs_input_transcript_while_shell_has_live_child() {
        let path = write_status_transcript(&assistant("end_turn"));

        assert_eq!(
            detect(
                Some((path, AgentKind::Claude)),
                SessionStatus::Running,
                Some(ShellHint::Running),
            ),
            SessionStatus::NeedsInput,
        );
    }

    #[test]
    fn detect_reports_turn_complete_reason_for_finished_transcript() {
        let path = write_status_transcript(
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#,
        );

        assert_eq!(
            detect_with_reason(
                Some((path, AgentKind::Codex)),
                SessionStatus::Running,
                Some(ShellHint::Running),
            ),
            StatusDetection::new(SessionStatus::NeedsInput, Some(StatusReason::TurnComplete)),
        );
    }

    #[test]
    fn detect_reports_shell_prompt_reason_for_shell_needs_input() {
        assert_eq!(
            detect_with_reason(None, SessionStatus::Running, Some(ShellHint::NeedsInput)),
            StatusDetection::new(SessionStatus::NeedsInput, Some(StatusReason::ShellPrompt)),
        );
    }

    fn write_status_transcript(body: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "acorn-status-test-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, body).expect("write status transcript");
        path
    }
}
