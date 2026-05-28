use std::path::PathBuf;

use acorn_session::{Session, SessionKind, SessionOwner, SessionTitleSource};

use crate::agent_history::{self, AgentHistoryProvider};
use crate::agent_resume;
use crate::error::{AppError, AppResult};
use crate::todos;

const TITLE_INPUT_CHARS: usize = 2_000;
const GENERATED_TITLE_CHARS: usize = 29;
const SESSION_TITLE_PROMPT_CHARS: usize = 1_000;

pub const DEFAULT_SESSION_TITLE_PROMPT: &str = "\
You are naming an Acorn terminal tab from the user's first agent prompt.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Separate each word with hyphens.
- Use lowercase words only.
- Fewer than 30 characters.
- No quotes, Markdown, trailing punctuation, or extra commentary.
- Prefer the concrete task over generic words like \"help\" or \"question\".
";

pub fn can_generate_title(session: &Session) -> bool {
    session.kind == SessionKind::Regular
        && matches!(session.owner, SessionOwner::User)
        && session.title_source == SessionTitleSource::Default
}

pub fn build_prompt(prompt: Option<&str>, first_user_message: &str) -> String {
    let header = effective_prompt(prompt);
    format!("{header}\nFirst user prompt:\n{first_user_message}\n")
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

pub fn resolve_first_user_message(session_id: uuid::Uuid) -> Option<String> {
    let (path, provider) = resolve_transcript(session_id)?;
    agent_history::transcript_first_user_message(provider, &path, TITLE_INPUT_CHARS)
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

pub fn generate_title(
    command: &str,
    args: &[String],
    prompt: Option<&str>,
    first_user_message: &str,
) -> AppResult<String> {
    if command.trim().is_empty() {
        return Err(AppError::Other(
            "No AI command configured. Open Settings → Agents to pick a provider.".to_string(),
        ));
    }
    let prompt = build_prompt(prompt, first_user_message);
    let raw = crate::ai::run_oneshot(command, args, &prompt, "Settings → Agents")?;
    normalize_generated_title(&raw)
        .ok_or_else(|| AppError::Other("AI returned an empty session title.".to_string()))
}

fn resolve_transcript(session_id: uuid::Uuid) -> Option<(PathBuf, AgentHistoryProvider)> {
    if let Some(live) = agent_resume::live_transcript(session_id) {
        let provider = match live.kind {
            agent_resume::AgentKind::Claude => AgentHistoryProvider::Claude,
            agent_resume::AgentKind::Codex => AgentHistoryProvider::Codex,
            agent_resume::AgentKind::Antigravity => AgentHistoryProvider::Antigravity,
        };
        return Some((live.path, provider));
    }

    todos::locate_transcript_for(&session_id.to_string())
        .ok()
        .flatten()
        .map(|path| (path, AgentHistoryProvider::Claude))
}

#[cfg(test)]
mod tests {
    use super::*;
    use acorn_session::{Session, SessionKind};

    #[test]
    fn prompt_contains_first_user_message_and_rules() {
        let prompt = build_prompt(None, "Fix the release workflow failure");

        assert!(prompt.contains("2 to 5 words"));
        assert!(prompt.contains("Separate each word with hyphens"));
        assert!(prompt.contains("Use lowercase words only"));
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
    fn generation_is_limited_to_user_owned_default_regular_sessions() {
        let mut session = Session::new(
            "repo".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        assert!(can_generate_title(&session));

        session.title_source = SessionTitleSource::Manual;
        assert!(!can_generate_title(&session));

        session.title_source = SessionTitleSource::Default;
        session.owner = SessionOwner::control(uuid::Uuid::new_v4());
        assert!(!can_generate_title(&session));
    }
}
