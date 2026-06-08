use std::path::{Path, PathBuf};

use acorn_session::{Session, SessionKind, SessionOwner, SessionTitleSource};

use crate::agent_history::{self, AgentHistoryProvider};
use crate::agent_resume;
use crate::ai::{AiExecutionRequest, ResolvedAiCommand};
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
}

pub fn can_generate_title(session: &Session, transcript_id: Option<&str>) -> bool {
    if !can_force_generate_title(session) {
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

pub fn build_prompt(prompt: Option<&str>, title_context: &str) -> String {
    let header = effective_prompt(prompt);
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
    let (path, provider, transcript_id) = resolve_transcript(session_id)?;
    let title_context =
        agent_history::transcript_title_context(provider, &path, TITLE_CONTEXT_CHARS)?;
    Some(ResolvedTitleInput {
        transcript_id,
        title_context,
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
    if collapsed.is_empty() {
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

pub fn generate_title_in_dir(
    ai: &AiExecutionRequest,
    prompt: Option<&str>,
    title_context: &str,
    cwd: Option<&Path>,
) -> AppResult<String> {
    let resolved = title_generation_command(ai.resolve()?);
    let prompt = build_prompt(prompt, title_context);
    let raw = crate::ai::run_resolved_oneshot_in_dir(&resolved, &prompt, "Settings → Agents", cwd)?;
    normalize_generated_title(&raw)
        .ok_or_else(|| AppError::Other("AI returned an empty session title.".to_string()))
}

fn title_generation_command(mut resolved: ResolvedAiCommand) -> ResolvedAiCommand {
    match resolved.command {
        "claude" => resolved.args.push("--no-session-persistence".to_string()),
        "codex" => resolved.args.push("--ephemeral".to_string()),
        _ => {}
    }
    resolved
}

fn resolve_transcript(session_id: uuid::Uuid) -> Option<(PathBuf, AgentHistoryProvider, String)> {
    if let Some(live) = agent_resume::live_transcript(session_id) {
        let provider = match live.kind {
            agent_resume::AgentKind::Claude => AgentHistoryProvider::Claude,
            agent_resume::AgentKind::Codex => AgentHistoryProvider::Codex,
            agent_resume::AgentKind::Antigravity => AgentHistoryProvider::Antigravity,
        };
        return Some((live.path, provider, live.id));
    }

    todos::locate_transcript_for(&session_id.to_string())
        .ok()
        .flatten()
        .map(|path| (path, AgentHistoryProvider::Claude, session_id.to_string()))
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
    fn title_generation_uses_non_persistent_provider_flags() {
        let claude = title_generation_command(
            (AiExecutionRequest {
                provider: crate::ai::AiProvider::Claude,
                ollama_model: None,
                llm_model: None,
            })
            .resolve()
            .unwrap(),
        );
        assert!(claude
            .args
            .contains(&"--no-session-persistence".to_string()));

        let codex = title_generation_command(
            (AiExecutionRequest {
                provider: crate::ai::AiProvider::Codex,
                ollama_model: None,
                llm_model: None,
            })
            .resolve()
            .unwrap(),
        );
        assert!(codex.args.contains(&"--ephemeral".to_string()));
    }

    #[test]
    fn generation_is_limited_to_user_owned_default_regular_sessions() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        assert!(can_generate_title(&session, None));

        session.title_source = SessionTitleSource::Manual;
        assert!(!can_generate_title(&session, Some("transcript-1")));

        session.title_source = SessionTitleSource::Default;
        session.owner = SessionOwner::control(uuid::Uuid::new_v4());
        assert!(!can_generate_title(&session, Some("transcript-1")));
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
