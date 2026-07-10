use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use acorn_agent::AgentKind;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptRole {
    User,
    Assistant,
    Other,
}

impl TranscriptRole {
    pub const fn title_label(self) -> Option<&'static str> {
        match self {
            Self::User => Some("User"),
            Self::Assistant => Some("Assistant"),
            Self::Other => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnState {
    WaitingForInput,
    Working,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedTranscriptLine {
    /// Role used by title-context and message-count consumers.
    pub role: TranscriptRole,
    /// Text used by history list titles and title-context consumers.
    pub text: Option<String>,
    /// Text used by history list head/tail sampling.
    pub state_text: Option<String>,
    /// Role used by history list head/tail sampling.
    pub state_role: TranscriptRole,
    /// Role used by resume/status-preview tail scanning.
    pub preview_role: TranscriptRole,
    /// Text source used by resume/status-preview tail scanning before
    /// whitespace collapse and truncation.
    pub preview_text: Option<String>,
    /// Codex response-output text used by the history list as a fallback
    /// before any assistant role line has been seen.
    pub response_text: Option<String>,
    pub turn_state: Option<TurnState>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

impl Default for ParsedTranscriptLine {
    fn default() -> Self {
        Self {
            role: TranscriptRole::Other,
            text: None,
            state_text: None,
            state_role: TranscriptRole::Other,
            preview_role: TranscriptRole::Other,
            preview_text: None,
            response_text: None,
            turn_state: None,
            session_id: None,
            cwd: None,
        }
    }
}

pub struct TailRead {
    pub text: String,
    pub read_full: bool,
}

pub fn parse_transcript_line(kind: AgentKind, line: &str) -> Option<ParsedTranscriptLine> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return None;
    }
    let value = serde_json::from_str::<Value>(trimmed).ok()?;
    Some(parse_transcript_value(kind, &value))
}

pub fn parse_transcript_value(kind: AgentKind, value: &Value) -> ParsedTranscriptLine {
    match kind {
        AgentKind::Claude => parse_claude_value(value),
        AgentKind::Codex => parse_codex_value(value),
        AgentKind::Antigravity => parse_antigravity_value(value),
    }
}

pub fn latest_turn_state(kind: AgentKind, tail: &str, read_full: bool) -> Option<TurnState> {
    for line in tail_lines_newest_first(tail, read_full) {
        let Some(parsed) = parse_transcript_line(kind, line) else {
            continue;
        };
        if parsed.turn_state.is_some() {
            return parsed.turn_state;
        }
    }
    None
}

pub fn read_tail(path: &Path, max_bytes: u64) -> io::Result<TailRead> {
    if max_bytes == 0 {
        return Ok(TailRead {
            text: String::new(),
            read_full: false,
        });
    }
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(max_bytes.min(len) as usize);
    file.read_to_end(&mut buf)?;
    Ok(TailRead {
        text: String::from_utf8_lossy(&buf).into_owned(),
        read_full: len <= max_bytes,
    })
}

pub fn collapse_preview(s: &str, max_chars: usize) -> Option<String> {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let mut out = collapsed.chars().take(max_chars).collect::<String>();
    if collapsed.chars().count() > max_chars {
        out.push('…');
    }
    Some(out)
}

pub fn assistant_message_text(value: &Value) -> Option<String> {
    if value
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|role| role != "assistant")
    {
        return None;
    }
    if let Some(text) = value.get("content").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let content = value.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(chat_content_part_text)
        .collect::<String>();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn parse_codex_value(value: &Value) -> ParsedTranscriptLine {
    let event = codex_event_value(value);
    let event_role = codex_role_from_event(value, event);
    let role = event_role;
    let texts = codex_event_texts(value, event);
    let response_text = codex_response_text(value, event);
    let state_text = match event_role {
        TranscriptRole::User => joined_text(&texts),
        TranscriptRole::Assistant => first_text(&texts),
        TranscriptRole::Other => None,
    };
    let text = match role {
        TranscriptRole::User => joined_text(&texts),
        TranscriptRole::Assistant => first_text(&texts).or_else(|| response_text.clone()),
        TranscriptRole::Other => None,
    };
    let (preview_role, preview_text) = codex_preview_role_and_text(value, event, event_role);

    ParsedTranscriptLine {
        role,
        text,
        state_text,
        state_role: event_role,
        preview_role,
        preview_text,
        response_text,
        turn_state: codex_turn_state(value),
        session_id: string_at(Some(event), "id")
            .or_else(|| string_at(Some(event), "session_id"))
            .or_else(|| string_at(Some(value), "session_id")),
        cwd: string_at(Some(event), "cwd")
            .or_else(|| string_at(Some(value), "cwd"))
            .or_else(|| extract_cwd_from_text(&texts)),
    }
}

fn parse_claude_value(value: &Value) -> ParsedTranscriptLine {
    let raw_role = role_from_str(value.get("type").and_then(Value::as_str));
    let role = if is_claude_meta_event(value) {
        TranscriptRole::Other
    } else {
        raw_role
    };
    let texts = value_texts(value);
    let text = match role {
        TranscriptRole::User => joined_claude_display_text(&texts),
        TranscriptRole::Assistant => first_claude_display_text(&texts),
        TranscriptRole::Other => None,
    };
    let preview_text = match role {
        TranscriptRole::User | TranscriptRole::Assistant => claude_message_preview_text(value),
        TranscriptRole::Other => None,
    };

    ParsedTranscriptLine {
        role,
        state_text: text.clone(),
        text,
        state_role: role,
        preview_role: role,
        preview_text,
        turn_state: claude_turn_state(value),
        session_id: string_at(Some(value), "sessionId"),
        cwd: string_at(Some(value), "cwd").or_else(|| string_at(Some(value), "project")),
        ..ParsedTranscriptLine::default()
    }
}

fn parse_antigravity_value(value: &Value) -> ParsedTranscriptLine {
    let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let role = match line_type {
        "USER_INPUT" => TranscriptRole::User,
        "PLANNER_RESPONSE" => TranscriptRole::Assistant,
        _ => TranscriptRole::Other,
    };
    let content = string_at(Some(value), "content").or_else(|| first_text(&value_texts(value)));
    let text = match role {
        TranscriptRole::User => content
            .as_deref()
            .and_then(extract_antigravity_user_request),
        TranscriptRole::Assistant => content.clone(),
        TranscriptRole::Other => None,
    };
    let preview_text = match role {
        TranscriptRole::User => value
            .get("content")
            .and_then(Value::as_str)
            .and_then(extract_antigravity_user_request),
        TranscriptRole::Assistant => value
            .get("content")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        TranscriptRole::Other => None,
    };

    ParsedTranscriptLine {
        role,
        state_text: text.clone(),
        text,
        state_role: role,
        preview_role: role,
        preview_text,
        turn_state: antigravity_turn_state(value),
        cwd: string_at(Some(value), "cwd")
            .or_else(|| string_at(Some(value), "project"))
            .or_else(|| first_workspace_path(value)),
        ..ParsedTranscriptLine::default()
    }
}

fn claude_turn_state(value: &Value) -> Option<TurnState> {
    let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if line_type != "user" && line_type != "assistant" {
        return None;
    }
    let msg = value.get("message")?;
    if line_type == "user" {
        return Some(TurnState::Working);
    }
    let stop_reason = msg.get("stop_reason").and_then(Value::as_str).unwrap_or("");
    Some(match stop_reason {
        "end_turn" | "stop_sequence" => TurnState::WaitingForInput,
        "tool_use" => TurnState::Working,
        _ => TurnState::Working,
    })
}

fn codex_turn_state(value: &Value) -> Option<TurnState> {
    let event = codex_event_value(value);
    let payload_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match payload_type {
        "task_complete" | "turn_complete" => Some(TurnState::WaitingForInput),
        "user_message" => Some(TurnState::Working),
        "function_call" | "function_call_output" | "reasoning" => Some(TurnState::Working),
        "agent_message" => {
            let phase = event.get("phase").and_then(Value::as_str).unwrap_or("");
            Some(if phase == "final_answer" {
                TurnState::WaitingForInput
            } else {
                TurnState::Working
            })
        }
        "message" => {
            if event.get("role").and_then(Value::as_str) == Some("assistant") {
                Some(TurnState::Working)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn codex_event_value(value: &Value) -> &Value {
    value
        .get("payload")
        .filter(|v| v.is_object())
        .or_else(|| value.get("msg").filter(|v| v.is_object()))
        .unwrap_or(value)
}

fn codex_role_from_event(value: &Value, event: &Value) -> TranscriptRole {
    let explicit_role = role_from_str(
        event
            .get("role")
            .and_then(Value::as_str)
            .or_else(|| value.get("role").and_then(Value::as_str)),
    );
    if explicit_role != TranscriptRole::Other {
        return explicit_role;
    }

    match event.get("type").and_then(Value::as_str) {
        Some("user_message") => TranscriptRole::User,
        Some("agent_message") => TranscriptRole::Assistant,
        _ => TranscriptRole::Other,
    }
}

fn antigravity_turn_state(value: &Value) -> Option<TurnState> {
    let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    match line_type {
        "USER_INPUT" => Some(TurnState::Working),
        "PLANNER_RESPONSE" => Some(if status == "DONE" {
            TurnState::WaitingForInput
        } else {
            TurnState::Working
        }),
        "CONVERSATION_HISTORY" | "" => None,
        _ => Some(TurnState::Working),
    }
}

fn codex_preview_role_and_text(
    value: &Value,
    event: &Value,
    event_role: TranscriptRole,
) -> (TranscriptRole, Option<String>) {
    match event_role {
        TranscriptRole::User => {
            let text =
                codex_message_preview_text(event).filter(|text| !looks_like_context_block(text));
            if text.is_some() {
                (TranscriptRole::User, text)
            } else {
                (TranscriptRole::Other, None)
            }
        }
        TranscriptRole::Assistant => (
            TranscriptRole::Assistant,
            codex_message_preview_text(event)
                .or_else(|| codex_response_output_preview_text(value, event))
                .or_else(|| codex_message_fallback_text(event)),
        ),
        TranscriptRole::Other => {
            let text = codex_response_output_preview_text(value, event)
                .or_else(|| codex_message_fallback_text(event));
            if text.is_some() {
                (TranscriptRole::Assistant, text)
            } else {
                (TranscriptRole::Other, None)
            }
        }
    }
}

fn claude_message_preview_text(value: &Value) -> Option<String> {
    let content = value.get("message").and_then(|m| m.get("content"))?;
    preview_from_content_value(content)
}

fn preview_from_content_value(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return claude_preview_text(text);
    }
    let items = content.as_array()?;
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = item.get("text").and_then(Value::as_str) else {
            continue;
        };
        if let Some(text) = claude_preview_text(text) {
            return Some(text);
        }
    }
    None
}

fn claude_preview_text(text: &str) -> Option<String> {
    collapsible_text(text)
        .filter(|text| !looks_like_context_block(text) && !looks_like_claude_control_text(text))
}

fn codex_event_texts(value: &Value, event: &Value) -> Vec<String> {
    if std::ptr::eq(value, event) {
        return value_texts(value);
    }

    let mut out = value_texts(event);
    if let Some(response_payload) = value.get("response_payload") {
        out.extend(value_texts(response_payload));
    }
    out
}

fn codex_message_preview_text(value: &Value) -> Option<String> {
    if let Some(content) = value.get("content") {
        if let Some(text) = content.as_str() {
            return collapsible_text(text);
        }
        if let Some(items) = content.as_array() {
            for item in items.iter().rev() {
                let text = item
                    .get("text")
                    .or_else(|| item.get("output_text"))
                    .and_then(Value::as_str);
                if let Some(text) = text.and_then(collapsible_text) {
                    return Some(text);
                }
            }
        }
    }
    codex_message_fallback_text(value)
}

fn codex_message_fallback_text(value: &Value) -> Option<String> {
    value
        .get("message")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn codex_response_output_preview_text(value: &Value, event: &Value) -> Option<String> {
    let arrays = [
        event.pointer("/response/output"),
        value.pointer("/response_payload/output"),
        event.pointer("/output"),
    ];
    for arr in arrays.into_iter().flatten() {
        let Some(items) = arr.as_array() else {
            continue;
        };
        for item in items.iter().rev() {
            let Some(content) = item.get("content").and_then(Value::as_array) else {
                continue;
            };
            for content_item in content.iter().rev() {
                if let Some(text) = content_item.get("text").and_then(Value::as_str) {
                    if let Some(text) = collapsible_text(text) {
                        return Some(text);
                    }
                }
            }
        }
    }
    None
}

fn codex_response_text(value: &Value, event: &Value) -> Option<String> {
    for output in [
        event.pointer("/response/output"),
        value.pointer("/response_payload/output"),
        event.pointer("/output"),
    ] {
        if let Some(v) = output {
            let texts = value_texts(v);
            if let Some(text) = first_text(&texts) {
                return Some(text);
            }
        }
    }
    None
}

fn value_texts(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_texts(value.get("message").unwrap_or(value), &mut out);
    if let Some(payload) = value.get("payload") {
        collect_texts(payload, &mut out);
    }
    out
}

fn collect_texts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if !s.trim().is_empty() {
                out.push(s.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_texts(item, out);
            }
        }
        Value::Object(map) => {
            for key in ["text", "output_text", "message", "content"] {
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
        .map(|s| s.trim())
        .find(|s| !s.is_empty() && !looks_like_context_block(s))
        .map(str::to_string)
}

fn joined_text(texts: &[String]) -> Option<String> {
    join_display_texts(texts, |s| !looks_like_context_block(s))
}

fn first_claude_display_text(texts: &[String]) -> Option<String> {
    texts
        .iter()
        .map(|s| s.trim())
        .find(|s| {
            !s.is_empty() && !looks_like_context_block(s) && !looks_like_claude_control_text(s)
        })
        .map(str::to_string)
}

fn joined_claude_display_text(texts: &[String]) -> Option<String> {
    join_display_texts(texts, |s| {
        !looks_like_context_block(s) && !looks_like_claude_control_text(s)
    })
}

fn join_display_texts(texts: &[String], include: impl Fn(&str) -> bool) -> Option<String> {
    let mut parts = Vec::new();
    for text in texts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && include(s))
    {
        if parts.last().copied() != Some(text) {
            parts.push(text);
        }
    }
    let joined = parts.join("\n\n");
    nonempty_trimmed(&joined)
}

fn tail_lines_newest_first(tail: &str, read_full: bool) -> impl Iterator<Item = &str> {
    let mut lines: Vec<&str> = tail.lines().collect();
    if !read_full && lines.len() > 1 {
        lines.remove(0);
    }
    lines
        .into_iter()
        .rev()
        .filter(|line| !line.trim().is_empty())
}

fn chat_content_part_text(value: &Value) -> Option<&str> {
    let part_type = value.get("type").and_then(Value::as_str);
    match part_type {
        Some("text") | Some("output_text") | Some("message") | None => {
            value.get("text").and_then(Value::as_str)
        }
        _ => None,
    }
}

fn role_from_str(role: Option<&str>) -> TranscriptRole {
    match role {
        Some("user") => TranscriptRole::User,
        Some("assistant") => TranscriptRole::Assistant,
        _ => TranscriptRole::Other,
    }
}

fn string_at(value: Option<&Value>, key: &str) -> Option<String> {
    value?
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn is_claude_meta_event(value: &Value) -> bool {
    value.get("isMeta").and_then(Value::as_bool) == Some(true)
}

fn looks_like_claude_control_text(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    [
        "<command-message>",
        "<command-name>",
        "<ide-context>",
        "<local-command-",
        "<system-reminder>",
        "<task-notification>",
    ]
    .iter()
    .any(|tag| lower.starts_with(tag))
        || lower.starts_with("caveat: the messages below were generated by a local command")
}

fn looks_like_context_block(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<environment_context>")
        || lower.contains("<cwd>")
        || lower.contains("# agents.md")
        || lower.contains("<instructions>")
        || (lower.trim_start().starts_with("<skill>")
            && lower.contains("<name>")
            && lower.contains("<path>"))
}

fn extract_cwd_from_text(texts: &[String]) -> Option<String> {
    for text in texts {
        let Some(start) = text.find("<cwd>") else {
            continue;
        };
        let after = start + "<cwd>".len();
        let Some(end) = text[after..].find("</cwd>") else {
            continue;
        };
        let cwd = text[after..after + end].trim();
        if !cwd.is_empty() {
            return Some(cwd.to_string());
        }
    }
    None
}

fn first_workspace_path(value: &Value) -> Option<String> {
    value
        .get("workspacePaths")
        .or_else(|| value.get("workspace_paths"))
        .and_then(Value::as_array)
        .and_then(|paths| paths.iter().find_map(Value::as_str))
        .map(ToString::to_string)
}

fn extract_antigravity_user_request(content: &str) -> Option<String> {
    let marker = "<USER_REQUEST>";
    let end_marker = "</USER_REQUEST>";
    if let Some(start) = content.find(marker) {
        let after = start + marker.len();
        let end = content[after..]
            .find(end_marker)
            .map(|offset| after + offset)
            .unwrap_or(content.len());
        return nonempty_trimmed(&content[after..end]);
    }
    nonempty_trimmed(content)
}

fn collapsible_text(text: &str) -> Option<String> {
    if text.split_whitespace().next().is_some() {
        Some(text.to_string())
    } else {
        None
    }
}

fn nonempty_trimmed(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
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

    fn classify(kind: AgentKind, tail: &str, read_full: bool) -> Option<TurnState> {
        latest_turn_state(kind, tail, read_full)
    }

    #[test]
    fn claude_user_turn_maps_to_working() {
        assert_eq!(
            classify(AgentKind::Claude, user_turn(), true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn claude_assistant_end_turn_wins_over_trailing_meta() {
        let tail = format!(
            "{}\n{}\n{}\n",
            assistant("end_turn"),
            r#"{"type":"system","subtype":"turn_duration","durationMs":1234}"#,
            r#"{"type":"system","subtype":"away_summary","content":"…"}"#
        );
        assert_eq!(
            classify(AgentKind::Claude, &tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn claude_queue_operation_is_status_meta() {
        let tail = format!(
            "{}\n{}\n",
            assistant("end_turn"),
            r#"{"type":"queue-operation","operation":"enqueue","content":"follow up"}"#
        );
        assert_eq!(
            classify(AgentKind::Claude, &tail, true),
            Some(TurnState::WaitingForInput),
        );
        assert_eq!(
            classify(
                AgentKind::Claude,
                r#"{"type":"queue-operation","operation":"enqueue","content":"follow up"}"#,
                true,
            ),
            None,
        );
    }

    #[test]
    fn claude_unknown_stop_reason_treated_as_working() {
        assert_eq!(
            classify(AgentKind::Claude, &assistant("max_tokens"), true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn truncated_first_line_is_dropped_when_not_read_full() {
        let tail = format!("ent\":[]}}}}\n{}\n", user_turn());
        assert_eq!(
            classify(AgentKind::Claude, &tail, false),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn codex_task_complete_maps_to_waiting_for_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_turn_complete_maps_to_waiting_for_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"turn_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_msg_wrapped_turn_complete_maps_to_waiting_for_input() {
        let tail = r#"{"msg":{"type":"turn_complete","last_agent_message":"done"}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_msg_wrapped_user_message_extracts_message_metadata() {
        let value: Value = serde_json::from_str(
            r#"{"session_id":"outer-session","msg":{"type":"user_message","role":"user","content":"hello codex","cwd":"/tmp/project","id":"inner-session"}}"#,
        )
        .unwrap();
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.turn_state, Some(TurnState::Working));
        assert_eq!(parsed.role, TranscriptRole::User);
        assert_eq!(parsed.text.as_deref(), Some("hello codex"));
        assert_eq!(parsed.state_role, TranscriptRole::User);
        assert_eq!(parsed.state_text.as_deref(), Some("hello codex"));
        assert_eq!(parsed.preview_role, TranscriptRole::User);
        assert_eq!(parsed.preview_text.as_deref(), Some("hello codex"));
        assert_eq!(parsed.session_id.as_deref(), Some("inner-session"));
        assert_eq!(parsed.cwd.as_deref(), Some("/tmp/project"));
    }

    #[test]
    fn codex_payload_user_message_infers_user_role_from_type() {
        let value: Value = serde_json::from_str(
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"hello codex","cwd":"/tmp/project","id":"payload-session"}}"#,
        )
        .unwrap();
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.turn_state, Some(TurnState::Working));
        assert_eq!(parsed.role, TranscriptRole::User);
        assert_eq!(parsed.text.as_deref(), Some("hello codex"));
        assert_eq!(parsed.state_role, TranscriptRole::User);
        assert_eq!(parsed.state_text.as_deref(), Some("hello codex"));
        assert_eq!(parsed.preview_role, TranscriptRole::User);
        assert_eq!(parsed.preview_text.as_deref(), Some("hello codex"));
        assert_eq!(parsed.session_id.as_deref(), Some("payload-session"));
        assert_eq!(parsed.cwd.as_deref(), Some("/tmp/project"));
    }

    #[test]
    fn codex_payload_agent_message_infers_assistant_role_from_type() {
        let value: Value = serde_json::from_str(
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"all done","phase":"final_answer"}}"#,
        )
        .unwrap();
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.turn_state, Some(TurnState::WaitingForInput));
        assert_eq!(parsed.role, TranscriptRole::Assistant);
        assert_eq!(parsed.text.as_deref(), Some("all done"));
        assert_eq!(parsed.state_role, TranscriptRole::Assistant);
        assert_eq!(parsed.state_text.as_deref(), Some("all done"));
        assert_eq!(parsed.preview_role, TranscriptRole::Assistant);
        assert_eq!(parsed.preview_text.as_deref(), Some("all done"));
    }

    #[test]
    fn codex_msg_wrapped_commentary_agent_message_maps_to_working() {
        let value: Value = serde_json::from_str(
            r#"{"msg":{"type":"agent_message","role":"assistant","message":"still working","phase":"commentary"}}"#,
        )
        .unwrap();
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.turn_state, Some(TurnState::Working));
        assert_eq!(parsed.role, TranscriptRole::Assistant);
        assert_eq!(parsed.text.as_deref(), Some("still working"));
        assert_eq!(parsed.preview_role, TranscriptRole::Assistant);
        assert_eq!(parsed.preview_text.as_deref(), Some("still working"));
    }

    #[test]
    fn codex_bare_event_envelope_without_inner_type_is_ignored() {
        let tail = r#"{"type":"event_msg","timestamp":"t"}"#;
        assert_eq!(classify(AgentKind::Codex, tail, true), None);
    }

    #[test]
    fn codex_top_level_turn_complete_maps_to_waiting_for_input() {
        let tail = r#"{"type":"turn_complete","last_agent_message":"done"}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn codex_final_answer_agent_message_maps_to_waiting_for_input() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"all done","phase":"final_answer","memory_citation":null}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
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
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn antigravity_done_planner_maps_to_waiting_for_input() {
        let tail = r#"{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify(AgentKind::Antigravity, tail, true),
            Some(TurnState::WaitingForInput),
        );
    }

    #[test]
    fn antigravity_non_planner_done_maps_to_working() {
        let tail = r#"{"type":"TOOL_CALL","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify(AgentKind::Antigravity, tail, true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn assistant_message_text_concatenates_text_parts() {
        let value: Value = serde_json::from_str(
            r#"{"role":"assistant","content":[{"type":"text","text":"a"},{"type":"output_text","text":"b"}]}"#,
        )
        .unwrap();
        assert_eq!(assistant_message_text(&value).as_deref(), Some("ab"));
    }
}
