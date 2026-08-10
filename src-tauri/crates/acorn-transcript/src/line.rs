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
    Ready,
    Working,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnObservation {
    pub state: TurnState,
    /// Provider-scoped turn identity when the transcript event carries one.
    /// Codex completion events use this to correlate a durable `task_complete`
    /// with the native hook turn that currently owns session status. Grok
    /// completion events expose the same field through `prompt_id`.
    pub provider_turn_id: Option<String>,
    /// Provider timestamp of the classified line. Attention recovery compares
    /// it against the moment the hook raised the attention request: a turn
    /// line written afterwards proves the agent resumed past the dialog.
    pub timestamp: Option<String>,
    /// Newest Claude line that proves the main agent loop is actively running:
    /// either an in-progress assistant turn or explicit feedback from a Stop
    /// hook that rejected completion. Unlike a user-side tool result, this is
    /// safe evidence that a blocked Stop resumed without a new prompt hook.
    pub agent_activity_timestamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedTranscriptLine {
    /// Source timestamp for this transcript event, when the provider emits one.
    pub timestamp: Option<String>,
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
    pub provider_turn_id: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

impl Default for ParsedTranscriptLine {
    fn default() -> Self {
        Self {
            timestamp: None,
            role: TranscriptRole::Other,
            text: None,
            state_text: None,
            state_role: TranscriptRole::Other,
            preview_role: TranscriptRole::Other,
            preview_text: None,
            response_text: None,
            turn_state: None,
            provider_turn_id: None,
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
    parse_transcript_line_details(kind, line).map(|(parsed, _)| parsed)
}

fn parse_transcript_line_details(
    kind: AgentKind,
    line: &str,
) -> Option<(ParsedTranscriptLine, bool)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return None;
    }
    let value = serde_json::from_str::<Value>(trimmed).ok()?;
    let is_stop_hook_feedback = kind == AgentKind::Claude && is_claude_stop_hook_feedback(&value);
    Some((parse_transcript_value(kind, &value), is_stop_hook_feedback))
}

pub fn parse_transcript_value(kind: AgentKind, value: &Value) -> ParsedTranscriptLine {
    match kind {
        AgentKind::Claude => parse_claude_value(value),
        AgentKind::Codex => parse_codex_value(value),
        AgentKind::Antigravity => parse_antigravity_value(value),
        AgentKind::Grok => parse_grok_value(value),
    }
}

pub fn latest_turn_state(kind: AgentKind, tail: &str, read_full: bool) -> Option<TurnState> {
    latest_turn_observation(kind, tail, read_full).map(|observation| observation.state)
}

pub fn latest_turn_observation(
    kind: AgentKind,
    tail: &str,
    read_full: bool,
) -> Option<TurnObservation> {
    let mut observation = None;
    let mut agent_activity_timestamp = None;
    let mut agent_activity_resolved = kind != AgentKind::Claude;

    for line in tail_lines_newest_first(tail, read_full) {
        let Some((parsed, is_stop_hook_feedback)) = parse_transcript_line_details(kind, line)
        else {
            continue;
        };

        if observation.is_none() {
            if let Some(state) = parsed.turn_state {
                observation = Some(TurnObservation {
                    state,
                    provider_turn_id: parsed.provider_turn_id.clone(),
                    timestamp: parsed.timestamp.clone(),
                    agent_activity_timestamp: None,
                });
            }
        }

        if !agent_activity_resolved {
            if is_stop_hook_feedback {
                agent_activity_timestamp = parsed.timestamp.clone();
                agent_activity_resolved = true;
            } else if parsed.role == TranscriptRole::Assistant {
                if parsed.turn_state == Some(TurnState::Working) {
                    agent_activity_timestamp = parsed.timestamp.clone();
                }
                // The newest assistant line is the relevant boundary. A
                // completed assistant turn deliberately prevents older tool
                // activity from reviving a genuine Stop.
                agent_activity_resolved = true;
            }
        }

        if observation.is_some() && agent_activity_resolved {
            break;
        }
    }

    observation.map(|observation| TurnObservation {
        agent_activity_timestamp,
        ..observation
    })
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
    let read_limit = max_bytes.min(len);
    let mut buf = Vec::with_capacity(read_limit as usize);
    file.take(read_limit).read_to_end(&mut buf)?;
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
    let texts = codex_event_texts(value, event);
    let hides_image_envelope =
        event_role == TranscriptRole::User && codex_user_content_has_image_attachment(&texts);
    let content_role = if hides_image_envelope {
        TranscriptRole::Other
    } else {
        event_role
    };
    let response_text = codex_response_text(value, event);
    let state_text = match content_role {
        TranscriptRole::User => joined_text(&texts),
        TranscriptRole::Assistant => first_text(&texts),
        TranscriptRole::Other => None,
    };
    let text = match content_role {
        TranscriptRole::User => joined_text(&texts),
        TranscriptRole::Assistant => first_text(&texts).or_else(|| response_text.clone()),
        TranscriptRole::Other => None,
    };
    let display_role = if content_role == TranscriptRole::User && text.is_none() {
        TranscriptRole::Other
    } else {
        content_role
    };
    let (preview_role, preview_text) = if hides_image_envelope {
        (TranscriptRole::Other, None)
    } else {
        codex_preview_role_and_text(value, event, event_role)
    };

    ParsedTranscriptLine {
        timestamp: string_at(Some(value), "timestamp")
            .or_else(|| string_at(Some(event), "timestamp")),
        role: display_role,
        text,
        state_text,
        state_role: display_role,
        preview_role,
        preview_text,
        response_text,
        turn_state: codex_turn_state(value),
        provider_turn_id: string_at(Some(event), "turn_id")
            .or_else(|| string_at(Some(event), "turn-id"))
            .or_else(|| string_at(Some(value), "turn_id"))
            .or_else(|| string_at(Some(value), "turn-id")),
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
        timestamp: string_at(Some(value), "timestamp"),
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
        timestamp: string_at(Some(value), "timestamp")
            .or_else(|| string_at(Some(value), "created_at"))
            .or_else(|| string_at(Some(value), "createdAt")),
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

fn parse_grok_value(value: &Value) -> ParsedTranscriptLine {
    let method = value.get("method").and_then(Value::as_str).unwrap_or("");
    if !matches!(method, "session/update" | "_x.ai/session/update") {
        return ParsedTranscriptLine::default();
    }

    let Some(update) = value.pointer("/params/update") else {
        return ParsedTranscriptLine::default();
    };
    let update_type = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let role = match update_type {
        "user_message_chunk" => TranscriptRole::User,
        "agent_message_chunk" => TranscriptRole::Assistant,
        _ => TranscriptRole::Other,
    };
    let text = match role {
        TranscriptRole::User | TranscriptRole::Assistant => {
            update.get("content").and_then(grok_content_text)
        }
        TranscriptRole::Other => None,
    };
    let turn_state = match update_type {
        "turn_completed" => Some(grok_completed_turn_state(update)),
        "user_message_chunk"
        | "agent_message_chunk"
        | "agent_thought_chunk"
        | "tool_call"
        | "tool_call_update" => Some(TurnState::Working),
        _ => None,
    };

    ParsedTranscriptLine {
        timestamp: scalar_string_at(Some(value), "timestamp"),
        role,
        text: text.clone(),
        state_text: text.clone(),
        state_role: role,
        preview_role: role,
        preview_text: text,
        turn_state,
        provider_turn_id: string_at(Some(update), "prompt_id")
            .or_else(|| string_at(Some(update), "promptId")),
        session_id: string_at(value.get("params"), "sessionId")
            .or_else(|| string_at(value.get("params"), "session_id")),
        ..ParsedTranscriptLine::default()
    }
}

fn grok_completed_turn_state(update: &Value) -> TurnState {
    let stop_reason = update
        .get("stop_reason")
        .or_else(|| update.get("stopReason"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if matches!(stop_reason, "cancelled" | "canceled" | "interrupted") {
        TurnState::Interrupted
    } else {
        TurnState::Ready
    }
}

fn grok_content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return text.split_whitespace().next().map(|_| text.to_string());
    }
    if let Some(text) = content.get("text").and_then(Value::as_str) {
        return text.split_whitespace().next().map(|_| text.to_string());
    }
    let items = content.as_array()?;
    let text = items
        .iter()
        .filter_map(grok_content_text)
        .collect::<String>();
    if text.split_whitespace().next().is_some() {
        Some(text)
    } else {
        None
    }
}

fn claude_turn_state(value: &Value) -> Option<TurnState> {
    let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if line_type != "user" && line_type != "assistant" {
        return None;
    }
    if value
        .get("interruptedMessageId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
    {
        return Some(TurnState::Interrupted);
    }
    let msg = value.get("message")?;
    if line_type == "user" {
        return Some(TurnState::Working);
    }
    let stop_reason = msg.get("stop_reason").and_then(Value::as_str).unwrap_or("");
    Some(match stop_reason {
        "end_turn" | "stop_sequence" => TurnState::Ready,
        "tool_use" => TurnState::Working,
        _ => TurnState::Working,
    })
}

fn codex_turn_state(value: &Value) -> Option<TurnState> {
    let event = codex_event_value(value);
    let payload_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    match payload_type {
        "task_complete" | "turn_complete" => Some(TurnState::Ready),
        "turn_aborted" => Some(TurnState::Interrupted),
        "user_message" => Some(TurnState::Working),
        "function_call" | "function_call_output" | "reasoning" => Some(TurnState::Working),
        "agent_message" => {
            let phase = event.get("phase").and_then(Value::as_str).unwrap_or("");
            Some(if phase == "final_answer" {
                TurnState::Ready
            } else {
                TurnState::Working
            })
        }
        "message" => {
            if event.get("role").and_then(Value::as_str) == Some("assistant") {
                Some(TurnState::Working)
            } else if event.get("role").and_then(Value::as_str) == Some("user")
                && codex_event_texts(value, event)
                    .iter()
                    .any(|text| text.trim_start().starts_with("<turn_aborted>"))
            {
                Some(TurnState::Interrupted)
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
        "PLANNER_RESPONSE" => Some(if status == "DONE" && !antigravity_has_tool_calls(value) {
            TurnState::Ready
        } else {
            TurnState::Working
        }),
        "CONVERSATION_HISTORY" | "" => None,
        _ => Some(TurnState::Working),
    }
}

fn antigravity_has_tool_calls(value: &Value) -> bool {
    value
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|tool_calls| !tool_calls.is_empty())
}

fn codex_preview_role_and_text(
    value: &Value,
    event: &Value,
    event_role: TranscriptRole,
) -> (TranscriptRole, Option<String>) {
    match event_role {
        TranscriptRole::User => {
            let text = codex_message_preview_text(event)
                .filter(|text| !looks_like_preview_context_block(text));
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
    collapsible_text(text).filter(|text| {
        !looks_like_preview_context_block(text) && !looks_like_claude_control_text(text)
    })
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

fn scalar_string_at(value: Option<&Value>, key: &str) -> Option<String> {
    let value = value?.get(key)?;
    if let Some(text) = value.as_str() {
        return nonempty_trimmed(text);
    }
    if value.is_number() {
        return Some(value.to_string());
    }
    None
}

fn is_claude_meta_event(value: &Value) -> bool {
    value.get("isMeta").and_then(Value::as_bool) == Some(true)
}

fn is_claude_stop_hook_feedback(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("user")
        && is_claude_meta_event(value)
        && value_texts(value)
            .iter()
            .any(|text| text.trim_start().starts_with("Stop hook feedback:"))
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
        || looks_like_hidden_message_block(text)
        || looks_like_skill_context_block(text)
}

fn looks_like_preview_context_block(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    lower.starts_with("<environment_context>")
        || lower.starts_with("<cwd>")
        || lower.starts_with("# agents.md instructions for ")
        || lower.starts_with("<instructions>")
        || looks_like_hidden_message_block(text)
        || looks_like_skill_context_block(text)
}

fn looks_like_hidden_message_block(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    [
        "<codex_internal_context",
        "<turn_aborted>",
        "<subagent_notification>",
        "<recommended_plugins>",
        "<user_shell_command>",
        "<user_action>",
        "<image name=",
        "</image>",
    ]
    .iter()
    .any(|tag| lower.starts_with(tag))
}

fn codex_user_content_has_image_attachment(texts: &[String]) -> bool {
    texts.iter().any(|text| {
        text.trim_start()
            .to_ascii_lowercase()
            .starts_with("<image name=")
    })
}

fn looks_like_skill_context_block(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    lower.starts_with("<skill>") && lower.contains("<name>") && lower.contains("<path>")
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
    use std::fs;

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
    fn tail_read_never_returns_more_than_the_byte_budget() {
        let path = std::env::temp_dir().join(format!("acorn-tail-{}.log", uuid::Uuid::new_v4()));
        fs::write(&path, b"abcdefgh").unwrap();

        let tail = read_tail(&path, 3).unwrap();
        let _ = fs::remove_file(path);

        assert_eq!(tail.text, "fgh");
        assert!(!tail.read_full);
    }

    #[test]
    fn claude_user_turn_maps_to_working() {
        assert_eq!(
            classify(AgentKind::Claude, user_turn(), true),
            Some(TurnState::Working),
        );
    }

    #[test]
    fn claude_interrupted_message_maps_to_interrupted() {
        let tail = r#"{"timestamp":"2026-08-10T00:00:01Z","type":"user","interruptedMessageId":"message-1","message":{"role":"user","content":[]}}"#;
        assert_eq!(
            latest_turn_observation(AgentKind::Claude, tail, true),
            Some(TurnObservation {
                state: TurnState::Interrupted,
                provider_turn_id: None,
                timestamp: Some("2026-08-10T00:00:01Z".to_string()),
                agent_activity_timestamp: None,
            })
        );
    }

    #[test]
    fn claude_assistant_end_turn_maps_to_ready_over_trailing_meta() {
        let tail = format!(
            "{}\n{}\n{}\n",
            assistant("end_turn"),
            r#"{"type":"system","subtype":"turn_duration","durationMs":1234}"#,
            r#"{"type":"system","subtype":"away_summary","content":"…"}"#
        );
        assert_eq!(
            classify(AgentKind::Claude, &tail, true),
            Some(TurnState::Ready),
        );
    }

    #[test]
    fn claude_stop_hook_feedback_proves_a_blocked_stop_resumed() {
        let tail = concat!(
            r#"{"timestamp":"2026-08-05T07:37:55Z","type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[]}}"#,
            "\n",
            r#"{"timestamp":"2026-08-05T07:38:01Z","type":"user","isMeta":true,"message":{"role":"user","content":"Stop hook feedback: keep working"}}"#,
        );

        assert_eq!(
            latest_turn_observation(AgentKind::Claude, tail, true),
            Some(TurnObservation {
                state: TurnState::Working,
                provider_turn_id: None,
                timestamp: Some("2026-08-05T07:38:01Z".to_string()),
                agent_activity_timestamp: Some("2026-08-05T07:38:01Z".to_string()),
            })
        );
    }

    #[test]
    fn claude_in_progress_assistant_proves_activity_over_a_later_tool_result() {
        let tail = concat!(
            r#"{"timestamp":"2026-08-05T07:38:01Z","type":"user","isMeta":true,"message":{"role":"user","content":"Stop hook feedback: keep working"}}"#,
            "\n",
            r#"{"timestamp":"2026-08-05T07:38:08Z","type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[]}}"#,
            "\n",
            r#"{"timestamp":"2026-08-05T07:38:09Z","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"done"}]}}"#,
        );

        assert_eq!(
            latest_turn_observation(AgentKind::Claude, tail, true),
            Some(TurnObservation {
                state: TurnState::Working,
                provider_turn_id: None,
                timestamp: Some("2026-08-05T07:38:09Z".to_string()),
                agent_activity_timestamp: Some("2026-08-05T07:38:08Z".to_string()),
            })
        );
    }

    #[test]
    fn claude_old_stop_feedback_and_background_result_do_not_revive_a_completed_turn() {
        let tail = concat!(
            r#"{"timestamp":"2026-08-05T07:37:40Z","type":"user","isMeta":true,"message":{"role":"user","content":"Stop hook feedback: keep working"}}"#,
            "\n",
            r#"{"timestamp":"2026-08-05T07:37:45Z","type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[]}}"#,
            "\n",
            r#"{"timestamp":"2026-08-05T07:37:55Z","type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[]}}"#,
            "\n",
            r#"{"timestamp":"2026-08-05T07:38:09Z","type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"background-1","content":"done"}]}}"#,
        );

        assert_eq!(
            latest_turn_observation(AgentKind::Claude, tail, true),
            Some(TurnObservation {
                state: TurnState::Working,
                provider_turn_id: None,
                timestamp: Some("2026-08-05T07:38:09Z".to_string()),
                agent_activity_timestamp: None,
            })
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
            Some(TurnState::Ready),
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
    fn codex_task_complete_maps_to_ready() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::Ready),
        );
    }

    #[test]
    fn codex_turn_aborted_maps_to_interrupted_with_turn_id() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t1"}}"#;
        assert_eq!(
            latest_turn_observation(AgentKind::Codex, tail, true),
            Some(TurnObservation {
                state: TurnState::Interrupted,
                provider_turn_id: Some("t1".to_string()),
                timestamp: Some("t".to_string()),
                agent_activity_timestamp: None,
            })
        );
    }

    #[test]
    fn codex_turn_complete_maps_to_ready() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"turn_complete","turn_id":"t1","last_agent_message":"done","completed_at":1,"duration_ms":1,"time_to_first_token_ms":1}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::Ready),
        );
    }

    #[test]
    fn codex_msg_wrapped_turn_complete_maps_to_ready() {
        let tail = r#"{"msg":{"type":"turn_complete","last_agent_message":"done"}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::Ready),
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
        assert_eq!(parsed.timestamp.as_deref(), Some("t"));
        assert_eq!(parsed.session_id.as_deref(), Some("payload-session"));
        assert_eq!(parsed.cwd.as_deref(), Some("/tmp/project"));
    }

    #[test]
    fn codex_hidden_message_blocks_are_not_user_content() {
        let messages = [
            "<codex_internal_context source=\"goal\">\nContinue the active goal.\n</codex_internal_context>",
            "<turn_aborted>\nThe user interrupted the turn.\n</turn_aborted>",
            "<subagent_notification>\nA task completed.\n</subagent_notification>",
            "<recommended_plugins>\nInternal recommendations.\n</recommended_plugins>",
            "<user_shell_command>\npnpm test\n</user_shell_command>",
            "<user_action>\nInternal action metadata.\n</user_action>",
            "</image>",
            "<image name=[Image #1] path=\"/tmp/clipboard.png\">\n</image>\nShip the release",
        ];

        for message in messages {
            let value = serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": message }],
                },
            });
            let parsed = parse_transcript_value(AgentKind::Codex, &value);

            assert_eq!(parsed.role, TranscriptRole::Other, "message: {message}");
            assert_eq!(parsed.text, None, "message: {message}");
            assert_eq!(
                parsed.state_role,
                TranscriptRole::Other,
                "message: {message}"
            );
            assert_eq!(parsed.state_text, None, "message: {message}");
            assert_eq!(
                parsed.preview_role,
                TranscriptRole::Other,
                "message: {message}"
            );
            assert_eq!(parsed.preview_text, None, "message: {message}");
        }
    }

    #[test]
    fn codex_hidden_turn_aborted_marker_maps_to_interrupted() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "<turn_aborted>\nThe user interrupted the turn.\n</turn_aborted>",
                }],
            },
        });

        assert_eq!(
            parse_transcript_value(AgentKind::Codex, &value).turn_state,
            Some(TurnState::Interrupted)
        );
    }

    #[test]
    fn codex_split_image_envelope_is_not_user_content() {
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "<image name=[Image #1] path=\"/tmp/clipboard.png\">",
                    },
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64,abc",
                    },
                    {
                        "type": "input_text",
                        "text": "</image>",
                    },
                    {
                        "type": "input_text",
                        "text": "[Image #1] Remove the </image> marker from History",
                    },
                ],
            },
        });
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.role, TranscriptRole::Other);
        assert_eq!(parsed.text, None);
        assert_eq!(parsed.state_role, TranscriptRole::Other);
        assert_eq!(parsed.state_text, None);
        assert_eq!(parsed.preview_role, TranscriptRole::Other);
        assert_eq!(parsed.preview_text, None);
    }

    #[test]
    fn codex_keeps_inline_hidden_tag_mentions_as_user_content() {
        let message = "Why do <codex_internal_context> and </image> appear in History?";
        let value = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": message }],
            },
        });
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.role, TranscriptRole::User);
        assert_eq!(parsed.text.as_deref(), Some(message));
        assert_eq!(parsed.state_role, TranscriptRole::User);
        assert_eq!(parsed.state_text.as_deref(), Some(message));
        assert_eq!(parsed.preview_role, TranscriptRole::User);
        assert_eq!(parsed.preview_text.as_deref(), Some(message));
    }

    #[test]
    fn codex_payload_agent_message_infers_assistant_role_from_type() {
        let value: Value = serde_json::from_str(
            r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"all done","phase":"final_answer"}}"#,
        )
        .unwrap();
        let parsed = parse_transcript_value(AgentKind::Codex, &value);

        assert_eq!(parsed.turn_state, Some(TurnState::Ready));
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
    fn codex_top_level_turn_complete_maps_to_ready() {
        let tail = r#"{"type":"turn_complete","last_agent_message":"done"}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::Ready),
        );
    }

    #[test]
    fn codex_final_answer_agent_message_maps_to_ready() {
        let tail = r#"{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"all done","phase":"final_answer","memory_citation":null}}"#;
        assert_eq!(
            classify(AgentKind::Codex, tail, true),
            Some(TurnState::Ready),
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
            Some(TurnState::Ready),
        );
        assert_eq!(
            latest_turn_observation(AgentKind::Codex, tail, true),
            Some(TurnObservation {
                state: TurnState::Ready,
                provider_turn_id: Some("t1".to_string()),
                timestamp: Some("t".to_string()),
                agent_activity_timestamp: None,
            }),
        );
    }

    #[test]
    fn antigravity_done_planner_maps_to_ready() {
        let tail = r#"{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}"#;
        assert_eq!(
            classify(AgentKind::Antigravity, tail, true),
            Some(TurnState::Ready),
        );
    }

    #[test]
    fn antigravity_done_planner_with_tool_calls_maps_to_working() {
        let tail = r#"{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{}}]}"#;
        assert_eq!(
            classify(AgentKind::Antigravity, tail, true),
            Some(TurnState::Working),
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
    fn grok_message_chunks_expose_content_and_session_metadata() {
        let value = serde_json::json!({
            "timestamp": 1_723_456_789.25,
            "method": "session/update",
            "params": {
                "sessionId": "0198c151-f3ee-7991-9768-741923bb6b50",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "type": "text", "text": "Add Grok support" }
                }
            }
        });
        let parsed = parse_transcript_value(AgentKind::Grok, &value);

        assert_eq!(parsed.role, TranscriptRole::User);
        assert_eq!(parsed.text.as_deref(), Some("Add Grok support"));
        assert_eq!(parsed.preview_role, TranscriptRole::User);
        assert_eq!(parsed.turn_state, Some(TurnState::Working));
        assert_eq!(
            parsed.session_id.as_deref(),
            Some("0198c151-f3ee-7991-9768-741923bb6b50")
        );
        assert_eq!(parsed.timestamp.as_deref(), Some("1723456789.25"));
    }

    #[test]
    fn grok_turn_completed_maps_to_ready_over_trailing_metadata() {
        let tail = concat!(
            r#"{"method":"session/update","params":{"sessionId":"0198c151-f3ee-7991-9768-741923bb6b50","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done"}}}}"#,
            "\n",
            r#"{"method":"session/update","params":{"sessionId":"0198c151-f3ee-7991-9768-741923bb6b50","update":{"sessionUpdate":"turn_completed","prompt_id":"prompt-7","stop_reason":"end_turn","usage":{"totalTokens":42}}}}"#,
            "\n",
            r#"{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"hook_execution","hookName":"Stop"}}}"#,
        );

        assert_eq!(
            latest_turn_observation(AgentKind::Grok, tail, true),
            Some(TurnObservation {
                state: TurnState::Ready,
                provider_turn_id: Some("prompt-7".to_string()),
                timestamp: None,
                agent_activity_timestamp: None,
            })
        );
    }

    #[test]
    fn grok_cancelled_turn_maps_to_interrupted() {
        let tail = r#"{"method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"turn_completed","prompt_id":"prompt-7","stop_reason":"cancelled"}}}"#;

        assert_eq!(
            latest_turn_observation(AgentKind::Grok, tail, true),
            Some(TurnObservation {
                state: TurnState::Interrupted,
                provider_turn_id: Some("prompt-7".to_string()),
                timestamp: None,
                agent_activity_timestamp: None,
            })
        );
    }

    #[test]
    fn grok_tool_updates_keep_the_turn_working() {
        let tail = r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","status":"completed"}}}"#;
        assert_eq!(
            classify(AgentKind::Grok, tail, true),
            Some(TurnState::Working)
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
