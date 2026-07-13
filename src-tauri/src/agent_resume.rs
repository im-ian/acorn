//! Per-session resume state for the focus-time "이전 대화 이어하기" modal.
//!
//! The `agent_resume_persister` background task mirrors the live transcript
//! UUID of each running `claude` / `codex` / `antigravity` process into
//! per-session files under Acorn's data dir. This module owns the on-disk
//! layout, the modal candidate reader for providers with verified resume
//! commands, and the acknowledgement writer; the persister is the only
//! writer of `*.id`, the frontend modal is the only writer of
//! `*.id.acknowledged`.
//!
//! On-disk layout (under `<data_dir>/agent-state/<session-uuid>/`):
//!
//! ```text
//! claude.id                # bare UUID, written by the persister
//! claude.id.acknowledged   # bare UUID, written by the frontend modal
//! codex.id                 # bare UUID
//! codex.id.acknowledged    # bare UUID
//! antigravity.id           # bare session id / UUID
//! antigravity.cwd          # Acorn worktree cwd fallback for cwd-less brain transcripts
//! antigravity.id.acknowledged
//! ```
//!
//! Modal pop rule: surface a candidate when `*.id` exists, is non-empty,
//! and differs from `*.id.acknowledged`. The persister only writes when
//! the new UUID differs from the current one, so the modal never re-pops
//! for the same conversation once acknowledged, and *always* pops when
//! the user starts a new conversation in the same session.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use acorn_agent::AgentKind;
use acorn_transcript::{collapse_preview, parse_transcript_line, read_tail, TranscriptRole};

const AGENT_STATE_DIR_NAME: &str = "agent-state";

const CLAUDE_ID_FILE: &str = "claude.id";
const CLAUDE_ID_ACK_FILE: &str = "claude.id.acknowledged";
const CODEX_ID_FILE: &str = "codex.id";
const CODEX_ID_ACK_FILE: &str = "codex.id.acknowledged";
const ANTIGRAVITY_ID_FILE: &str = "antigravity.id";
const ANTIGRAVITY_ID_ACK_FILE: &str = "antigravity.id.acknowledged";

/// Per-Acorn-session scratch directory the resume persister writes
/// `*.id` into. The directory is also the modal's read source.
pub fn ensure_session_state_dir(session_id: uuid::Uuid) -> io::Result<PathBuf> {
    ensure_session_state_dir_at(&acorn_daemon::paths::data_dir()?, session_id)
}

fn ensure_session_state_dir_at(base: &Path, session_id: uuid::Uuid) -> io::Result<PathBuf> {
    let dir = base.join(AGENT_STATE_DIR_NAME).join(session_id.to_string());
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Read-only sibling of `ensure_session_state_dir`. Returns `Ok(None)`
/// when the directory does not exist instead of creating it — the
/// resume-candidate query must not be the call that materialises the
/// state dir for sessions that never spawned an agent.
fn session_state_dir_if_exists_at(
    base: &Path,
    session_id: uuid::Uuid,
) -> io::Result<Option<PathBuf>> {
    let dir = base.join(AGENT_STATE_DIR_NAME).join(session_id.to_string());
    Ok(if dir.is_dir() { Some(dir) } else { None })
}

/// Shape returned to the frontend modal.
///
/// `uuid` is the provider transcript id; the frontend uses it both to render
/// "Resume this conversation?" and to dispatch the provider's resume command
/// when that provider has one. `last_activity_unix` is
/// the JSONL mtime — good enough as a "last touched" signal without
/// parsing the file. `preview` is a single-line excerpt from the last
/// model turn, trimmed to fit the modal layout.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCandidate {
    pub uuid: String,
    pub last_activity_unix: u64,
    pub preview: Option<String>,
    pub last_user_message: Option<String>,
    pub last_agent_message: Option<String>,
}

/// Surface the modal candidate for `session_id` and `kind`, or `Ok(None)`
/// when there is nothing to ask the user about.
pub fn resume_candidate(
    session_id: uuid::Uuid,
    kind: AgentKind,
) -> io::Result<Option<ResumeCandidate>> {
    let (id_file, ack_file) = resume_state_files(kind);
    candidate_at(
        &acorn_daemon::paths::data_dir()?,
        session_id,
        id_file,
        ack_file,
        kind,
    )
}

/// Identifier + live transcript path resolved through the persister's
/// `<data_dir>/agent-state/<session-uuid>/{claude,codex,antigravity}.id`
/// marker. The status detector consumes this to read the actual JSONL the
/// agent is writing instead of guessing from PTY descendant liveness.
#[derive(Debug, Clone)]
pub struct LiveTranscript {
    pub id: String,
    pub path: PathBuf,
    pub kind: AgentKind,
}

/// Resolve `session_id` to the live transcript its in-flight agent is
/// writing, by reading the on-disk resume markers and looking up the
/// matching transcript. Returns `None` when no marker is present, all markers
/// point to UUIDs whose transcript files have not (or no longer) exist on
/// disk, or `data_dir()` fails to resolve.
///
/// When multiple provider markers exist, the marker file with the
/// newer mtime wins — that matches the persister's behaviour of only
/// touching a marker when the live UUID rotates, so "most recently
/// written marker" is "the agent the session was last paired with".
pub fn live_transcript(session_id: uuid::Uuid) -> Option<LiveTranscript> {
    let base = acorn_daemon::paths::data_dir().ok()?;
    live_transcript_at(&base, session_id)
}

/// Resolve only the marker for `kind`. Status polling uses this when the
/// current PTY tree already tells us which live provider owns the tab, so a
/// nested peer agent from another provider cannot steal the session status.
pub fn live_transcript_for_kind(session_id: uuid::Uuid, kind: AgentKind) -> Option<LiveTranscript> {
    let base = acorn_daemon::paths::data_dir().ok()?;
    live_transcript_for_kind_at(&base, session_id, kind)
}

fn live_transcript_at(base: &Path, session_id: uuid::Uuid) -> Option<LiveTranscript> {
    let dir = session_state_dir_if_exists_at(base, session_id)
        .ok()
        .flatten()?;
    let mut markers = [
        (AgentKind::Claude, CLAUDE_ID_FILE),
        (AgentKind::Codex, CODEX_ID_FILE),
        (AgentKind::Antigravity, ANTIGRAVITY_ID_FILE),
    ]
    .into_iter()
    .filter_map(|(kind, file)| {
        let mtime = fs::metadata(dir.join(file))
            .and_then(|m| m.modified())
            .ok()?;
        Some((kind, mtime))
    })
    .collect::<Vec<_>>();
    markers.sort_by(|a, b| b.1.cmp(&a.1));
    markers
        .into_iter()
        .find_map(|(kind, _)| live_transcript_for_kind_in_dir(&dir, kind))
}

fn live_transcript_for_kind_at(
    base: &Path,
    session_id: uuid::Uuid,
    kind: AgentKind,
) -> Option<LiveTranscript> {
    let dir = session_state_dir_if_exists_at(base, session_id)
        .ok()
        .flatten()?;
    live_transcript_for_kind_in_dir(&dir, kind)
}

fn live_transcript_for_kind_in_dir(dir: &Path, kind: AgentKind) -> Option<LiveTranscript> {
    live_transcript_for_kind_in_dir_with_locator(dir, kind, &locate_transcript)
}

fn live_transcript_for_kind_in_dir_with_locator(
    dir: &Path,
    kind: AgentKind,
    locate: &dyn Fn(AgentKind, &str) -> Option<PathBuf>,
) -> Option<LiveTranscript> {
    let file = match kind {
        AgentKind::Claude => CLAUDE_ID_FILE,
        AgentKind::Codex => CODEX_ID_FILE,
        AgentKind::Antigravity => ANTIGRAVITY_ID_FILE,
    };
    let id = fs::read_to_string(dir.join(file)).ok()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    let path = locate(kind, &id)?;
    Some(LiveTranscript { id, path, kind })
}

/// Mark the current provider id value as seen so the modal stops popping
/// for the same UUID. No-op if the provider id file does not exist.
pub fn acknowledge_resume(session_id: uuid::Uuid, kind: AgentKind) -> io::Result<()> {
    let (id_file, ack_file) = resume_state_files(kind);
    acknowledge_at(
        &acorn_daemon::paths::data_dir()?,
        session_id,
        id_file,
        ack_file,
    )
}

fn candidate_at(
    base: &Path,
    session_id: uuid::Uuid,
    id_file: &str,
    ack_file: &str,
    kind: AgentKind,
) -> io::Result<Option<ResumeCandidate>> {
    let Some(state_dir) = session_state_dir_if_exists_at(base, session_id)? else {
        return Ok(None);
    };
    let uuid = match fs::read_to_string(state_dir.join(id_file)) {
        Ok(s) => s.trim().to_string(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if uuid.is_empty() {
        return Ok(None);
    }
    let acked = fs::read_to_string(state_dir.join(ack_file))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if acked == uuid {
        return Ok(None);
    }

    let transcript = locate_transcript(kind, &uuid);
    let last_activity_unix = transcript
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|mt| mt.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let conversation_preview = transcript
        .as_ref()
        .and_then(|p| extract_conversation_preview(kind, p).ok());
    let last_user_message = conversation_preview
        .as_ref()
        .and_then(|preview| preview.last_user_message.clone());
    let last_agent_message = conversation_preview
        .as_ref()
        .and_then(|preview| preview.last_agent_message.clone());
    let preview = last_agent_message.clone();

    Ok(Some(ResumeCandidate {
        uuid,
        last_activity_unix,
        preview,
        last_user_message,
        last_agent_message,
    }))
}

fn resume_state_files(kind: AgentKind) -> (&'static str, &'static str) {
    match kind {
        AgentKind::Claude => (CLAUDE_ID_FILE, CLAUDE_ID_ACK_FILE),
        AgentKind::Codex => (CODEX_ID_FILE, CODEX_ID_ACK_FILE),
        AgentKind::Antigravity => (ANTIGRAVITY_ID_FILE, ANTIGRAVITY_ID_ACK_FILE),
    }
}

fn acknowledge_at(
    base: &Path,
    session_id: uuid::Uuid,
    id_file: &str,
    ack_file: &str,
) -> io::Result<()> {
    let Some(state_dir) = session_state_dir_if_exists_at(base, session_id)? else {
        return Ok(());
    };
    let id = match fs::read_to_string(state_dir.join(id_file)) {
        Ok(s) => s,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    fs::write(state_dir.join(ack_file), id)
}

pub(crate) fn locate_transcript(kind: AgentKind, uuid: &str) -> Option<PathBuf> {
    match kind {
        AgentKind::Claude => crate::todos::locate_transcript_for(uuid).ok().flatten(),
        AgentKind::Codex => locate_codex_transcript(uuid),
        AgentKind::Antigravity => locate_antigravity_transcript(uuid),
    }
}

/// Walk the codex sessions root and find the rollout whose filename ends
/// in `<uuid>`.
fn locate_codex_transcript(uuid: &str) -> Option<PathBuf> {
    acorn_transcript::locate_codex_transcript(uuid)
}

fn locate_antigravity_transcript(id: &str) -> Option<PathBuf> {
    for root in antigravity_brain_roots() {
        let path = root
            .join(id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn google_agent_storage_root() -> Option<PathBuf> {
    std::env::var_os("ANTIGRAVITY_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_DIR").map(PathBuf::from))
        .or_else(|| directories::UserDirs::new().map(|d| d.home_dir().join(".gemini")))
}

fn antigravity_brain_roots() -> Vec<PathBuf> {
    let Some(root) = google_agent_storage_root() else {
        return Vec::new();
    };
    ["antigravity", "antigravity-ide", "antigravity-cli"]
        .into_iter()
        .map(|profile| root.join(profile).join("brain"))
        .filter(|path| path.is_dir())
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConversationPreview {
    pub last_user_message: Option<String>,
    pub last_agent_message: Option<String>,
}

pub(crate) fn extract_conversation_preview(
    kind: AgentKind,
    path: &Path,
) -> io::Result<ConversationPreview> {
    let tail = read_tail(path, PREVIEW_TAIL_BYTES)?;
    let mut preview = ConversationPreview::default();
    for line in tail.text.lines().rev() {
        let Some(parsed) = parse_transcript_line(kind, line) else {
            continue;
        };
        match parsed.preview_role {
            TranscriptRole::Assistant if preview.last_agent_message.is_none() => {
                preview.last_agent_message = parsed
                    .preview_text
                    .as_deref()
                    .and_then(|text| collapse_preview(text, PREVIEW_CHARS));
            }
            TranscriptRole::User if preview.last_user_message.is_none() => {
                preview.last_user_message = parsed
                    .preview_text
                    .as_deref()
                    .and_then(|text| collapse_preview(text, PREVIEW_CHARS));
            }
            TranscriptRole::Other => {}
            _ => {}
        }
        if preview.last_user_message.is_some() && preview.last_agent_message.is_some() {
            break;
        }
    }
    Ok(preview)
}

const PREVIEW_TAIL_BYTES: u64 = 262_144;
const PREVIEW_CHARS: usize = 90;

#[cfg(test)]
mod tests {
    use super::*;

    struct ScratchDir(PathBuf);
    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let p = PathBuf::from("/tmp").join(format!(
                "acn-resume-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_id(base: &Path, sid: uuid::Uuid, file: &str, body: &str) {
        let dir = base.join(AGENT_STATE_DIR_NAME).join(sid.to_string());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(file), body).unwrap();
    }

    #[test]
    fn claude_candidate_returns_none_when_state_dir_missing() {
        let base = ScratchDir::new("missing");
        let sid = uuid::Uuid::new_v4();
        let result = candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn claude_candidate_suppressed_when_acked() {
        let base = ScratchDir::new("acked");
        let sid = uuid::Uuid::new_v4();
        let uuid_val = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        write_id(base.path(), sid, CLAUDE_ID_FILE, uuid_val);
        write_id(base.path(), sid, CLAUDE_ID_ACK_FILE, uuid_val);
        let result = candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn claude_candidate_surfaced_after_new_uuid_overrides_ack() {
        let base = ScratchDir::new("rotated");
        let sid = uuid::Uuid::new_v4();
        write_id(
            base.path(),
            sid,
            CLAUDE_ID_ACK_FILE,
            "11111111-1111-1111-1111-111111111111",
        );
        write_id(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            "22222222-2222-2222-2222-222222222222",
        );
        let result = candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .unwrap();
        let candidate = result.expect("rotated UUID must re-surface");
        assert_eq!(candidate.uuid, "22222222-2222-2222-2222-222222222222");
    }

    #[test]
    fn codex_preview_reads_response_item_output_text() {
        let base = ScratchDir::new("codex-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Here is the latest Codex answer."}]}}"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Codex, &path)
            .unwrap()
            .last_agent_message;

        assert_eq!(preview.as_deref(), Some("Here is the latest Codex answer."));
    }

    #[test]
    fn claude_conversation_preview_reads_latest_user_and_assistant() {
        let base = ScratchDir::new("claude-conversation-preview");
        let path = base.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","message":{"content":[{"type":"text","text":"Please fix the failing tests."}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"I found the failing assertion."}]}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Claude, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Please fix the failing tests.")
        );
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("I found the failing assertion.")
        );
    }

    #[test]
    fn claude_conversation_preview_skips_meta_messages() {
        let base = ScratchDir::new("claude-meta-preview");
        let path = base.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","message":{"content":"Please review the pull request."}}
{"type":"assistant","message":{"content":"The pull request is ready."}}
{"type":"user","isMeta":true,"message":{"content":"Synthetic session metadata."}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Claude, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Please review the pull request.")
        );
    }

    #[test]
    fn claude_conversation_preview_skips_control_messages() {
        let base = ScratchDir::new("claude-control-preview");
        let path = base.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","message":{"content":"Please review the pull request."}}
{"type":"assistant","message":{"content":"The pull request is ready."}}
{"type":"user","message":{"content":"<command-name>/exit</command-name>\n<command-message>exit</command-message>"}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Claude, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Please review the pull request.")
        );
    }

    #[test]
    fn claude_conversation_preview_keeps_inline_context_tag_mentions() {
        let base = ScratchDir::new("claude-inline-context-preview");
        let path = base.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"user","message":{"content":"Why does <cwd> appear in the preview?"}}
{"type":"assistant","message":{"content":"I will inspect the preview parser."}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Claude, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Why does <cwd> appear in the preview?")
        );
    }

    #[test]
    fn codex_conversation_preview_reads_payload_roles() {
        let base = ScratchDir::new("codex-conversation-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"message","payload":{"role":"user","content":[{"type":"input_text","text":"Check the drawer regression."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The regression is in the popover target."}]}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Codex, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Check the drawer regression.")
        );
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("The regression is in the popover target.")
        );
    }

    #[test]
    fn codex_conversation_preview_skips_injected_skill_content() {
        let base = ScratchDir::new("codex-skill-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"$merge-pr"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<skill>\n<name>merge-pr</name>\n<path>/tmp/merge-pr/SKILL.md</path>\nInternal skill instructions\n</skill>"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Preflight passed."}]}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Codex, &path).unwrap();

        assert_eq!(preview.last_user_message.as_deref(), Some("$merge-pr"));
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("Preflight passed.")
        );
    }

    #[test]
    fn codex_conversation_preview_skips_goal_internal_context() {
        let base = ScratchDir::new("codex-goal-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Implement the kanban preview fix."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will inspect the transcript parser."}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<codex_internal_context source=\"goal\">\nThe user set an active goal.\n</codex_internal_context>"}]}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Codex, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Implement the kanban preview fix.")
        );
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("I will inspect the transcript parser.")
        );
    }

    #[test]
    fn codex_conversation_preview_keeps_inline_context_tag_mentions() {
        let base = ScratchDir::new("codex-inline-context-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Why does <cwd> appear in the preview?"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will inspect the preview parser."}]}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Codex, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Why does <cwd> appear in the preview?")
        );
    }

    #[test]
    fn codex_conversation_preview_does_not_treat_user_message_as_agent() {
        let base = ScratchDir::new("codex-user-message-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"message","payload":{"role":"user","message":"Please inspect the popover."}}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Codex, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Please inspect the popover.")
        );
        assert_eq!(preview.last_agent_message, None);
    }

    #[test]
    fn antigravity_preview_reads_latest_planner_response() {
        let base = ScratchDir::new("antigravity-preview");
        let path = base.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>hello</USER_REQUEST>"}
{"type":"PLANNER_RESPONSE","status":"DONE","content":"Here is the latest Antigravity answer."}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Antigravity, &path)
            .unwrap()
            .last_agent_message;

        assert_eq!(
            preview.as_deref(),
            Some("Here is the latest Antigravity answer.")
        );
    }

    #[test]
    fn antigravity_conversation_preview_reads_user_request_tag() {
        let base = ScratchDir::new("antigravity-conversation-preview");
        let path = base.path().join("transcript.jsonl");
        fs::write(
            &path,
            r#"{"type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>Make the board calmer.</USER_REQUEST><ADDITIONAL_METADATA>Internal model settings.</ADDITIONAL_METADATA>"}
{"type":"PLANNER_RESPONSE","status":"DONE","content":"I will reduce the terminal surface."}
"#,
        )
        .unwrap();

        let preview = extract_conversation_preview(AgentKind::Antigravity, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Make the board calmer.")
        );
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("I will reduce the terminal surface.")
        );
    }

    #[test]
    fn acknowledge_copies_id_into_ack_file() {
        let base = ScratchDir::new("ack");
        let sid = uuid::Uuid::new_v4();
        let uuid_val = "33333333-3333-3333-3333-333333333333";
        write_id(base.path(), sid, CLAUDE_ID_FILE, uuid_val);
        acknowledge_at(base.path(), sid, CLAUDE_ID_FILE, CLAUDE_ID_ACK_FILE).unwrap();
        let dir = base.path().join(AGENT_STATE_DIR_NAME).join(sid.to_string());
        let acked = fs::read_to_string(dir.join(CLAUDE_ID_ACK_FILE)).unwrap();
        assert_eq!(acked.trim(), uuid_val);
    }

    #[test]
    fn acknowledge_noop_when_id_missing() {
        let base = ScratchDir::new("ack-noop");
        let sid = uuid::Uuid::new_v4();
        acknowledge_at(base.path(), sid, CLAUDE_ID_FILE, CLAUDE_ID_ACK_FILE).unwrap();
        let dir = base.path().join(AGENT_STATE_DIR_NAME).join(sid.to_string());
        assert!(!dir.join(CLAUDE_ID_ACK_FILE).exists());
    }

    #[test]
    fn collapse_preview_truncates_with_ellipsis() {
        let long = "a ".repeat(120);
        let out = collapse_preview(&long, PREVIEW_CHARS).unwrap();
        assert!(out.ends_with("…"));
        assert!(out.chars().count() <= PREVIEW_CHARS + 1);
    }

    #[test]
    fn live_transcript_returns_none_when_no_marker_dir() {
        let base = ScratchDir::new("live-empty");
        let sid = uuid::Uuid::new_v4();
        assert!(live_transcript_at(base.path(), sid).is_none());
    }

    #[test]
    fn live_transcript_returns_none_when_marker_points_at_missing_transcript() {
        // Marker present but no JSONL exists on disk for that UUID. The
        // resolver must report None so the status detector falls back to
        // its shell-hint path instead of mistakenly classifying nothing.
        let base = ScratchDir::new("live-missing-jsonl");
        let sid = uuid::Uuid::new_v4();
        write_id(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            "00000000-0000-0000-0000-000000000000",
        );
        // No fixture JSONL exists for that UUID under ~/.claude/projects.
        assert!(live_transcript_at(base.path(), sid).is_none());
    }

    #[test]
    fn live_transcript_for_kind_reads_only_requested_provider_marker() {
        let base = ScratchDir::new("live-for-kind");
        let sid = uuid::Uuid::new_v4();
        let claude_id = "11111111-1111-1111-1111-111111111111";
        let codex_id = "22222222-2222-2222-2222-222222222222";
        write_id(base.path(), sid, CLAUDE_ID_FILE, claude_id);
        write_id(base.path(), sid, CODEX_ID_FILE, codex_id);
        let dir = base.path().join(AGENT_STATE_DIR_NAME).join(sid.to_string());

        let found =
            live_transcript_for_kind_in_dir_with_locator(&dir, AgentKind::Codex, &|kind, id| {
                Some(base.path().join(format!("{kind:?}-{id}.jsonl")))
            })
            .expect("codex marker resolves");

        assert_eq!(found.kind, AgentKind::Codex);
        assert_eq!(found.id, codex_id);
        assert!(found.path.ends_with(format!("Codex-{codex_id}.jsonl")));
    }
}
