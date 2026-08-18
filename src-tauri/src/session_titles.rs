#[cfg(test)]
use std::path::PathBuf;

use acorn_session::{Session, SessionKind, SessionMode, SessionOwner, SessionTitleSource};

use crate::agent_history::{self, AgentHistoryProvider};
use crate::agent_resume;
use crate::ai::AiExecutionRequest;
use crate::error::{AppError, AppResult};
use crate::todos;

const TITLE_CONTEXT_CHARS: usize = 8_000;
const GENERATED_TITLE_CHARS: usize = 29;
const SESSION_TITLE_PROMPT_CHARS: usize = 1_000;
pub const INTERNAL_TITLE_PROMPT_MARKER: &str = "<ACORN_INTERNAL_SESSION_TITLE_GENERATION>";

pub const DEFAULT_SESSION_TITLE_PROMPT: &str = "\
You are naming an Acorn session tab from the conversation transcript.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Separate each word with hyphens.
- Use lowercase words only.
- Fewer than 30 characters.
- No quotes, Markdown, trailing punctuation, or extra commentary.
- Summarize the overall intent of the full request, not just the first line or first task.
- Prefer the main user goal over setup steps and generic words like \"help\" or \"question\".
";

pub struct ResolvedTitleInput {
    pub transcript_id: String,
    pub title_context: String,
    pub native_session: Option<agent_resume::LiveTranscript>,
}

pub fn can_generate_title(session: &Session, transcript_id: Option<&str>) -> bool {
    if !can_force_generate_title(session) {
        return false;
    }
    if !auto_title_enabled(session) {
        return false;
    }
    match session.title_source {
        SessionTitleSource::Default => true,
        SessionTitleSource::Generated => transcript_id
            .is_some_and(|id| session.generated_title_transcript_id.as_deref() != Some(id)),
        SessionTitleSource::Manual => false,
    }
}

pub fn can_force_generate_title(session: &Session) -> bool {
    session.kind == SessionKind::Regular && matches!(session.owner, SessionOwner::User)
}

fn auto_title_enabled(session: &Session) -> bool {
    if let Some(enabled) = session.auto_title_enabled {
        return enabled;
    }

    session.mode == SessionMode::Chat
        || session.title_source == SessionTitleSource::Generated
        || name_implies_agent_session(&session.name)
}

fn name_implies_agent_session(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["claude", "codex", "antigravity", "agy", "grok"]
        .iter()
        .any(|needle| {
            lower
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|part| part == *needle)
        })
}

pub fn build_prompt(prompt: Option<&str>, title_context: &str) -> String {
    let header = effective_prompt(prompt);
    let title_context = title_context
        .chars()
        .take(TITLE_CONTEXT_CHARS)
        .collect::<String>();
    format!("{header}\n{INTERNAL_TITLE_PROMPT_MARKER}\nConversation transcript context:\n{title_context}\n")
}

fn effective_prompt(prompt: Option<&str>) -> String {
    let raw = prompt.unwrap_or(DEFAULT_SESSION_TITLE_PROMPT);
    let prompt = if raw.trim().is_empty() {
        DEFAULT_SESSION_TITLE_PROMPT
    } else {
        raw
    };
    prompt.chars().take(SESSION_TITLE_PROMPT_CHARS).collect()
}

pub fn resolve_title_input(session_id: uuid::Uuid) -> Option<ResolvedTitleInput> {
    let native_session = resolve_native_session(session_id)?;
    let provider: AgentHistoryProvider = native_session.kind.into();
    let title_context = agent_history::transcript_title_context(
        provider,
        &native_session.path,
        TITLE_CONTEXT_CHARS,
    )?;
    Some(ResolvedTitleInput {
        transcript_id: native_session.id.clone(),
        title_context,
        native_session: Some(native_session),
    })
}

pub fn resolve_chat_title_input(session_id: uuid::Uuid) -> Option<ResolvedTitleInput> {
    let state = crate::persistence::load_chat_session_state(&session_id.to_string()).ok()?;
    chat_title_input_from_state(&state)
}

pub fn chat_title_input_from_state(
    state: &crate::persistence::ChatSessionState,
) -> Option<ResolvedTitleInput> {
    let first_user_index = state.messages.iter().position(|message| {
        message.role == crate::persistence::ChatRole::User && !message.content.trim().is_empty()
    })?;
    let first_user_message = &state.messages[first_user_index];
    let title_context = state
        .messages
        .iter()
        .skip(first_user_index)
        .filter_map(|message| {
            let content = truncate_chat_message_for_title(&message.content)?;
            let role = match message.role {
                crate::persistence::ChatRole::User => "User",
                crate::persistence::ChatRole::Assistant => "Assistant",
                crate::persistence::ChatRole::System => "System",
                crate::persistence::ChatRole::Tool => "Tool",
            };
            Some(format!("{role}: {content}"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(ResolvedTitleInput {
        transcript_id: format!("chat:{}", first_user_message.id),
        title_context: title_context.chars().take(TITLE_CONTEXT_CHARS).collect(),
        native_session: None,
    })
}

fn truncate_chat_message_for_title(content: &str) -> Option<String> {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let max_chars = 700;
    let mut out = collapsed.chars().take(max_chars).collect::<String>();
    if collapsed.chars().count() > max_chars {
        out.push('…');
    }
    Some(out)
}

pub fn normalize_generated_title(raw: &str) -> Option<String> {
    let line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .trim_matches(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\'' | '`' | '*' | '#' | '-' | ':' | '.' | '!' | '?'
                )
        });
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty()
        || collapsed.chars().any(|value| {
            value.is_control()
                || matches!(
                    value,
                    '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                )
        })
    {
        return None;
    }
    let mut out = collapsed
        .chars()
        .take(GENERATED_TITLE_CHARS)
        .collect::<String>();
    out = out
        .trim()
        .trim_end_matches(['.', '!', '?', ':'])
        .to_string();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn generate_title(
    ai: &AiExecutionRequest,
    prompt: Option<&str>,
    title_context: &str,
) -> AppResult<String> {
    let prompt = build_prompt(prompt, title_context);
    let raw = crate::ai::run_passive_text(ai, &prompt, "Settings → Agents")?;
    normalize_generated_title(&raw)
        .ok_or_else(|| AppError::Other("AI returned an empty session title.".to_string()))
}

pub fn resolve_native_session(session_id: uuid::Uuid) -> Option<agent_resume::LiveTranscript> {
    match agent_resume::live_transcript_checked(session_id) {
        Ok(Some(live)) => return Some(live),
        Ok(None) => {}
        Err(error) => {
            tracing::debug!(
                %session_id,
                error = %error,
                "session title: transcript lookup failed"
            );
            return None;
        }
    }

    todos::locate_transcript_for(&session_id.to_string())
        .ok()
        .flatten()
        .map(|path| agent_resume::LiveTranscript {
            path,
            kind: acorn_agent::AgentKind::Claude,
            id: session_id.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use acorn_session::{Session, SessionKind};

    #[test]
    fn prompt_contains_transcript_context_and_rules() {
        let prompt = build_prompt(None, "Fix the release workflow failure");

        assert!(prompt.contains("2 to 5 words"));
        assert!(prompt.contains("Separate each word with hyphens"));
        assert!(prompt.contains("Use lowercase words only"));
        assert!(prompt.contains("overall intent of the full request"));
        assert!(prompt.contains(INTERNAL_TITLE_PROMPT_MARKER));
        assert!(prompt.contains("Conversation transcript context:"));
        assert!(prompt.contains("Fix the release workflow failure"));
    }

    #[test]
    fn prompt_bounds_preview_context_at_the_shared_limit() {
        let prompt = build_prompt(None, &"가".repeat(TITLE_CONTEXT_CHARS + 10));
        let context = prompt
            .split_once("Conversation transcript context:\n")
            .unwrap()
            .1
            .trim_end();

        assert_eq!(context.chars().count(), TITLE_CONTEXT_CHARS);
    }

    #[test]
    fn prompt_uses_custom_instructions() {
        let prompt = build_prompt(
            Some("Name this tab in Korean. Return only the title."),
            "Fix the release workflow failure",
        );

        assert!(prompt.contains("Name this tab in Korean"));
        assert!(prompt.contains("Fix the release workflow failure"));
    }

    #[test]
    fn blank_prompt_falls_back_to_default_instructions() {
        let prompt = build_prompt(Some("  \n  "), "Fix the release workflow failure");

        assert!(prompt.contains("2 to 5 words"));
        assert!(prompt.contains("Separate each word with hyphens"));
        assert!(prompt.contains("Fix the release workflow failure"));
    }

    #[test]
    fn normalize_generated_title_keeps_titles_under_thirty_chars() {
        let title = normalize_generated_title("Investigate release workflow regression").unwrap();

        assert!(title.chars().count() < 30);
    }

    #[test]
    fn normalize_generated_title_strips_wrapper_text() {
        assert_eq!(
            normalize_generated_title("\"Fix Release Workflow.\"").as_deref(),
            Some("Fix Release Workflow")
        );
        assert_eq!(
            normalize_generated_title("### Investigate Codex Resume\nextra").as_deref(),
            Some("Investigate Codex Resume")
        );
    }

    #[test]
    fn normalize_generated_title_rejects_terminal_and_bidi_controls() {
        assert!(normalize_generated_title("safe\u{1b}[2Jtitle").is_none());
        assert!(normalize_generated_title("safe\u{202e}txt").is_none());
    }

    #[test]
    fn generation_is_limited_to_opted_in_user_owned_regular_sessions() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.auto_title_enabled = Some(true);
        assert!(can_generate_title(&session, None));

        session.title_source = SessionTitleSource::Manual;
        assert!(!can_generate_title(&session, Some("transcript-1")));

        session.title_source = SessionTitleSource::Default;
        session.owner = SessionOwner::control(uuid::Uuid::new_v4());
        assert!(!can_generate_title(&session, Some("transcript-1")));
    }

    #[test]
    fn generation_requires_auto_title_opt_in() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(acorn_session::SessionAgentProvider::Codex);

        assert!(!can_generate_title(&session, Some("transcript-1")));

        session.auto_title_enabled = Some(true);
        assert!(can_generate_title(&session, Some("transcript-1")));
    }

    #[test]
    fn legacy_plain_terminals_do_not_auto_title_from_detected_child_agents() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.auto_title_enabled = None;
        session.agent_provider = Some(acorn_session::SessionAgentProvider::Codex);
        session.agent_transcript_id = Some("transcript-1".to_string());

        assert!(!can_generate_title(&session, Some("transcript-1")));
    }

    #[test]
    fn legacy_generated_and_named_agent_sessions_can_auto_title() {
        let mut generated = Session::new(
            "generated-title".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        generated.auto_title_enabled = None;
        generated.title_source = SessionTitleSource::Generated;
        generated.generated_title_transcript_id = Some("old-transcript".to_string());
        assert!(can_generate_title(&generated, Some("new-transcript")));

        let mut named = Session::new(
            "codex resume".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        named.auto_title_enabled = None;
        assert!(can_generate_title(&named, Some("transcript-1")));
    }

    #[test]
    fn forced_generation_allows_manual_and_same_transcript_titles() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.title_source = SessionTitleSource::Manual;
        assert!(!can_generate_title(&session, Some("transcript-1")));
        assert!(can_force_generate_title(&session));

        session.title_source = SessionTitleSource::Generated;
        session.generated_title_transcript_id = Some("transcript-1".to_string());
        assert!(!can_generate_title(&session, Some("transcript-1")));
        assert!(can_force_generate_title(&session));

        session.kind = SessionKind::Control;
        assert!(!can_force_generate_title(&session));
    }

    #[test]
    fn generated_titles_can_regenerate_after_transcript_rotation() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.auto_title_enabled = Some(true);
        session.title_source = SessionTitleSource::Generated;
        session.generated_title_transcript_id = Some("old-transcript".to_string());

        assert!(!can_generate_title(&session, Some("old-transcript")));
        assert!(can_generate_title(&session, Some("new-transcript")));
        assert!(!can_generate_title(&session, None));
    }

    #[test]
    fn chat_title_input_uses_first_user_message() {
        let now = chrono::Utc::now();
        let state = crate::persistence::ChatSessionState {
            schema_version: crate::persistence::CHAT_SESSION_SCHEMA_VERSION,
            session_id: uuid::Uuid::new_v4().to_string(),
            session: crate::persistence::ChatSession::default(),
            provider: Some("claude".to_string()),
            model: None,
            messages: vec![
                crate::persistence::ChatMessage {
                    id: "assistant-first".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::Assistant,
                    content: "assistant content".to_string(),
                    graph_prompt_plan: None,
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: None,
                },
                crate::persistence::ChatMessage {
                    id: "user-first".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::User,
                    content: "Build Acorn native chat history".to_string(),
                    graph_prompt_plan: None,
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: None,
                },
            ],
            turns: Vec::new(),
            provider_threads: Vec::new(),
            context_snapshots: Vec::new(),
            memory: crate::persistence::SessionMemory::default(),
            created_at: now,
            updated_at: now,
        };

        let input = chat_title_input_from_state(&state).unwrap();

        assert_eq!(input.transcript_id, "chat:user-first");
        assert_eq!(input.title_context, "User: Build Acorn native chat history");
    }

    #[test]
    fn chat_title_input_uses_full_chat_context() {
        let now = chrono::Utc::now();
        let state = crate::persistence::ChatSessionState {
            schema_version: crate::persistence::CHAT_SESSION_SCHEMA_VERSION,
            session_id: uuid::Uuid::new_v4().to_string(),
            session: crate::persistence::ChatSession::default(),
            provider: Some("claude".to_string()),
            model: None,
            messages: vec![
                crate::persistence::ChatMessage {
                    id: "user-first".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::User,
                    content: "Investigate the release failure".to_string(),
                    graph_prompt_plan: None,
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: None,
                },
                crate::persistence::ChatMessage {
                    id: "assistant-first".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::Assistant,
                    content: "The failing job is release-ci.".to_string(),
                    graph_prompt_plan: None,
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: None,
                },
                crate::persistence::ChatMessage {
                    id: "user-second".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::User,
                    content: "Rename the tab from the final diagnosis.".to_string(),
                    graph_prompt_plan: None,
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: None,
                },
            ],
            turns: Vec::new(),
            provider_threads: Vec::new(),
            context_snapshots: Vec::new(),
            memory: crate::persistence::SessionMemory::default(),
            created_at: now,
            updated_at: now,
        };

        let input = chat_title_input_from_state(&state).unwrap();

        assert_eq!(
            input.title_context,
            "User: Investigate the release failure\nAssistant: The failing job is release-ci.\nUser: Rename the tab from the final diagnosis."
        );
    }
}
