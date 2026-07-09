//! Detects a session's live status by inspecting the tail of the JSONL
//! transcript the in-flight agent is writing. Status mapping:
//!
//! Claude transcripts:
//! - last assistant turn with `stop_reason=end_turn` -> WaitingForInput
//!   (claude has finished its turn and is awaiting the user's next prompt).
//!   Surfaces the warning-tone status dot in the Sidebar and triggers the
//!   `waitingForInput` system notification when the user has it enabled.
//! - last assistant turn with `stop_reason=tool_use` -> Working (tool pending)
//! - last user turn (new prompt or tool_result) -> Working (assistant pending)
//! - no transcript yet -> Ready (session has not produced any conversation)
//!
//! Codex transcripts:
//! - last `payload.type=task_complete` / `turn_complete` (or `agent_message` with
//!   `phase=final_answer`) -> WaitingForInput (codex finished a turn).
//! - last `payload.type=user_message` -> Working (the user just sent a
//!   prompt and codex is composing the response).
//! - everything else with content -> Working (function calls, intermediate
//!   `agent_message phase=commentary`, reasoning, etc.).
//!
//! Antigravity transcripts:
//! - last `type=PLANNER_RESPONSE` with `status=DONE` -> WaitingForInput.
//! - last `type=USER_INPUT` or any non-DONE model/tool line -> Working.
//!
//! Meta-only lines (claude: `last-prompt` / `permission-mode` /
//! `attachment` / `file-history-snapshot` / `system`; codex: `token_count`
//! and other event_msg telemetry) are ignored when picking the last
//! message. The transcript line itself is the source of truth; we
//! deliberately do not gate on mtime, otherwise the moment after a turn
//! ends (file still warm) gets misreported as Working.
//!
//! Transcript resolution lives in the host `acorn` crate (it consults
//! `agent_resume`'s persister markers + the legacy `~/.claude/projects/`
//! UUID-named fallback) and is passed in here as `(PathBuf, AgentKind)`.

use std::path::PathBuf;

use acorn_agent::AgentKind;
use acorn_pty::ShellHint;
use acorn_transcript::{latest_turn_state, read_tail, TurnState};
use serde::Serialize;

use crate::session::SessionStatus;

// Big enough to comfortably contain the last assistant turn line for typical
// Claude responses. JSONL lines are one-per-message, so a long assistant
// response can be many KB on a single line.
const TAIL_BYTES: u64 = 262_144;

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
/// Claude versions, or Codex `token_count` telemetry, can push the actual
/// turn out of the 256 KiB tail window). Without this fallback, polling
/// momentarily reclassifies a live session as Ready, leaving the Sidebar dot
/// stuck at Ready until the agent emits another turn line within the tail
/// window, which for long sessions can be never.
///
/// `shell_hint` carries the descendant-process snapshot for the session's
/// PTY. It also guards transcript markers from becoming sticky state:
/// resume markers are durable, so an old transcript can still end in
/// `waiting_for_input` long after the agent process exited. When the PTY is
/// idle (or gone), the durable marker is stale for status purposes and the
/// session should be Ready. When a live descendant exists, the transcript
/// tail refines that live process into Working vs WaitingForInput.
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
        return StatusDetection::new(SessionStatus::Ready, None);
    }

    let (path, kind) = match transcript {
        Some(t) => t,
        None => return detect_shell_hint(shell_hint),
    };

    let classified = read_tail(&path, TAIL_BYTES)
        .ok()
        .and_then(|tail| latest_turn_state(kind, &tail.text, tail.read_full));

    match classified {
        Some(TurnState::WaitingForInput) => StatusDetection::new(
            SessionStatus::WaitingForInput,
            Some(StatusReason::TurnComplete),
        ),
        Some(TurnState::Working) => StatusDetection::new(SessionStatus::Working, None),
        // Transcript exists but the tail held no turn lines; keep
        // whatever the caller previously observed instead of regressing
        // to Ready. The next poll that lands on a real turn line corrects
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
        Some(ShellHint::Running) => StatusDetection::new(SessionStatus::Working, None),
        Some(ShellHint::NeedsInput) => StatusDetection::new(
            SessionStatus::WaitingForInput,
            Some(StatusReason::ShellPrompt),
        ),
        Some(ShellHint::Idle) | None => StatusDetection::new(SessionStatus::Ready, None),
    }
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
            // classify the trailing assistant turn, otherwise the sidebar dot
            // regresses to Ready the moment Claude finishes a turn.
            r#"{"type":"system","subtype":"turn_duration","durationMs":1234}"#,
            r#"{"type":"system","subtype":"away_summary","content":"..."}"#,
        ]
    }

    fn classify_tail(kind: AgentKind, tail: &str, read_full: bool) -> Option<TurnState> {
        latest_turn_state(kind, tail, read_full)
    }

    #[test]
    fn empty_tail_returns_none() {
        assert_eq!(classify_tail(AgentKind::Claude, "", true), None);
    }

    #[test]
    fn user_turn_maps_to_working() {
        assert_eq!(
            classify_tail(AgentKind::Claude, user_turn(), true),
            Some(TurnState::Working),
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
            classify_tail(AgentKind::Claude, &tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn assistant_tool_use_maps_to_working() {
        assert_eq!(
            classify_tail(AgentKind::Claude, &assistant("tool_use"), true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn unknown_stop_reason_treated_as_working() {
        assert_eq!(
            classify_tail(AgentKind::Claude, &assistant("max_tokens"), true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn truncated_first_line_is_dropped_when_not_read_full() {
        let tail = format!("ent\":[]}}}}\n{}\n", user_turn());
        assert_eq!(
            classify_tail(AgentKind::Claude, &tail, false),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn intact_first_line_is_kept_when_read_full() {
        assert_eq!(
            classify_tail(AgentKind::Claude, user_turn(), true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn meta_only_tail_returns_none() {
        let tail = meta_lines().join("\n");
        assert_eq!(classify_tail(AgentKind::Claude, &tail, true), None);
    }

    #[test]
    fn shell_hint_running_maps_to_working() {
        assert_eq!(
            map_shell_hint(Some(ShellHint::Running)),
            SessionStatus::Working
        );
    }

    #[test]
    fn shell_hint_needs_input_maps_to_waiting_for_input() {
        assert_eq!(
            map_shell_hint(Some(ShellHint::NeedsInput)),
            SessionStatus::WaitingForInput,
        );
    }

    #[test]
    fn shell_hint_idle_maps_to_ready() {
        assert_eq!(map_shell_hint(Some(ShellHint::Idle)), SessionStatus::Ready);
    }

    #[test]
    fn shell_hint_none_maps_to_ready() {
        assert_eq!(map_shell_hint(None), SessionStatus::Ready);
    }

    #[test]
    fn assistant_without_message_is_skipped() {
        let tail = format!("{}\n{}\n", r#"{"type":"assistant"}"#, user_turn(),);
        assert_eq!(
            classify_tail(AgentKind::Claude, &tail, true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn codex_task_complete_maps_to_waiting_for_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_turn_complete_maps_to_waiting_for_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"turn_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_final_answer_agent_message_maps_to_waiting_for_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"all done","phase":"final_answer","memory_citation":null}}"#;
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_function_call_maps_to_working() {
        let tail = r#"{"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"c1"}}"#;
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::Working)
        );
    }

    #[test]
    fn codex_commentary_agent_message_maps_to_working() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"checking","phase":"commentary","memory_citation":null}}"#;
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::Working)
        );
    }

    #[test]
    fn codex_user_message_maps_to_working() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"hi","images":[],"local_images":[],"text_elements":[]}}"#;
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::Working)
        );
    }

    #[test]
    fn codex_token_count_telemetry_is_skipped() {
        let tail = concat!(
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#,
            "\n",
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
        );
        assert_eq!(
            classify_tail(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_empty_tail_returns_none() {
        assert_eq!(classify_tail(AgentKind::Codex, "", true), None);
    }

    #[test]
    fn antigravity_done_planner_maps_to_waiting_for_input() {
        let tail = r#"{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify_tail(AgentKind::Antigravity, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn antigravity_user_input_maps_to_working() {
        let tail = r#"{"type":"USER_INPUT","status":"DONE","content":"hi"}"#;
        assert_eq!(
            classify_tail(AgentKind::Antigravity, tail, true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn antigravity_non_planner_done_maps_to_working() {
        let tail = r#"{"type":"TOOL_CALL","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify_tail(AgentKind::Antigravity, tail, true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn detect_returns_ready_when_no_transcript_and_no_hint() {
        assert_eq!(
            detect(None, SessionStatus::Ready, None),
            SessionStatus::Ready
        );
    }

    #[test]
    fn detect_uses_shell_hint_when_no_transcript() {
        assert_eq!(
            detect(None, SessionStatus::Ready, Some(ShellHint::Running)),
            SessionStatus::Working
        );
    }

    #[test]
    fn detect_ignores_stale_waiting_for_input_transcript_when_shell_is_idle() {
        let path = write_status_transcript(&assistant("end_turn"));

        assert_eq!(
            detect(
                Some((path, AgentKind::Claude)),
                SessionStatus::WaitingForInput,
                Some(ShellHint::Idle),
            ),
            SessionStatus::Ready,
        );
    }

    #[test]
    fn detect_ignores_stale_waiting_for_input_transcript_without_live_pty() {
        let path = write_status_transcript(&assistant("end_turn"));

        assert_eq!(
            detect(
                Some((path, AgentKind::Claude)),
                SessionStatus::WaitingForInput,
                None,
            ),
            SessionStatus::Ready,
        );
    }

    #[test]
    fn detect_uses_waiting_for_input_transcript_while_shell_has_live_child() {
        let path = write_status_transcript(&assistant("end_turn"));

        assert_eq!(
            detect(
                Some((path, AgentKind::Claude)),
                SessionStatus::Working,
                Some(ShellHint::Running),
            ),
            SessionStatus::WaitingForInput,
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
                SessionStatus::Working,
                Some(ShellHint::Running),
            ),
            StatusDetection::new(
                SessionStatus::WaitingForInput,
                Some(StatusReason::TurnComplete)
            ),
        );
    }

    #[test]
    fn detect_reports_shell_prompt_reason_for_shell_needs_input() {
        assert_eq!(
            detect_with_reason(None, SessionStatus::Working, Some(ShellHint::NeedsInput)),
            StatusDetection::new(
                SessionStatus::WaitingForInput,
                Some(StatusReason::ShellPrompt)
            ),
        );
    }

    fn write_status_transcript(body: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("acorn-status-test-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, body).expect("write status transcript");
        path
    }
}
