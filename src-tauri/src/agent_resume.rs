//! Per-session resume state for the focus-time "이전 대화 이어하기" modal.
//!
//! The `agent_resume_persister` background task mirrors the live transcript
//! UUID of each running `claude` / `codex` process into per-session files
//! under Acorn's data dir. This module owns the on-disk layout, the modal
//! candidate readers, and the acknowledgement writers; the persister is
//! the only writer of `claude.id` / `codex.id`, the frontend modal is the
//! only writer of `claude.id.acknowledged` / `codex.id.acknowledged` via
//! the `acknowledge_*_resume` commands.
//!
//! On-disk layout (under `<data_dir>/agent-state/<session-uuid>/`):
//!
//! ```text
//! claude.id                # bare UUID, written by the persister
//! claude.id.acknowledged   # bare UUID, written by the frontend modal
//! codex.id                 # bare UUID
//! codex.id.acknowledged    # bare UUID
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

const AGENT_STATE_DIR_NAME: &str = "agent-state";

const CLAUDE_ID_FILE: &str = "claude.id";
const CLAUDE_ID_ACK_FILE: &str = "claude.id.acknowledged";
const CODEX_ID_FILE: &str = "codex.id";
const CODEX_ID_ACK_FILE: &str = "codex.id.acknowledged";

/// Per-Acorn-session scratch directory the resume persister writes
/// `claude.id` / `codex.id` into. The directory is also the modal's
/// read source via `claude_resume_candidate` / `codex_resume_candidate`.
pub fn ensure_session_state_dir(session_id: uuid::Uuid) -> io::Result<PathBuf> {
    ensure_session_state_dir_at(&crate::daemon::paths::data_dir()?, session_id)
}

fn ensure_session_state_dir_at(base: &Path, session_id: uuid::Uuid) -> io::Result<PathBuf> {
    let dir = base
        .join(AGENT_STATE_DIR_NAME)
        .join(session_id.to_string());
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
    let dir = base
        .join(AGENT_STATE_DIR_NAME)
        .join(session_id.to_string());
    Ok(if dir.is_dir() { Some(dir) } else { None })
}

/// Shape returned to the frontend modal.
///
/// `uuid` is the JSONL stem; the frontend uses it both to render
/// "Resume this conversation?" and to dispatch `claude --resume <uuid>` /
/// `codex resume <uuid>` when the user accepts. `last_activity_unix` is
/// the JSONL mtime — good enough as a "last touched" signal without
/// parsing the file. `preview` is a single-line excerpt from the last
/// model turn, trimmed to fit the modal layout.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeCandidate {
    pub uuid: String,
    pub last_activity_unix: u64,
    pub preview: Option<String>,
}

/// Surface the claude-side modal candidate for `session_id`, or `Ok(None)`
/// when there is nothing to ask the user about (no claude has run, or the
/// latest UUID was already acknowledged).
pub fn claude_resume_candidate(
    session_id: uuid::Uuid,
) -> io::Result<Option<ResumeCandidate>> {
    candidate_at(
        &crate::daemon::paths::data_dir()?,
        session_id,
        CLAUDE_ID_FILE,
        CLAUDE_ID_ACK_FILE,
        AgentTranscript::Claude,
    )
}

/// Surface the codex-side modal candidate for `session_id`, or `Ok(None)`.
pub fn codex_resume_candidate(
    session_id: uuid::Uuid,
) -> io::Result<Option<ResumeCandidate>> {
    candidate_at(
        &crate::daemon::paths::data_dir()?,
        session_id,
        CODEX_ID_FILE,
        CODEX_ID_ACK_FILE,
        AgentTranscript::Codex,
    )
}

/// Mark the current `claude.id` value as seen so the modal stops popping
/// for the same UUID. No-op if `claude.id` does not exist.
pub fn acknowledge_claude_resume(session_id: uuid::Uuid) -> io::Result<()> {
    acknowledge_at(
        &crate::daemon::paths::data_dir()?,
        session_id,
        CLAUDE_ID_FILE,
        CLAUDE_ID_ACK_FILE,
    )
}

/// Mark the current `codex.id` value as seen. No-op if `codex.id` does
/// not exist.
pub fn acknowledge_codex_resume(session_id: uuid::Uuid) -> io::Result<()> {
    acknowledge_at(
        &crate::daemon::paths::data_dir()?,
        session_id,
        CODEX_ID_FILE,
        CODEX_ID_ACK_FILE,
    )
}

#[derive(Clone, Copy)]
enum AgentTranscript {
    Claude,
    Codex,
}

fn candidate_at(
    base: &Path,
    session_id: uuid::Uuid,
    id_file: &str,
    ack_file: &str,
    kind: AgentTranscript,
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
    let preview = transcript
        .as_ref()
        .and_then(|p| extract_preview(kind, p).ok().flatten());

    Ok(Some(ResumeCandidate {
        uuid,
        last_activity_unix,
        preview,
    }))
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

fn locate_transcript(kind: AgentTranscript, uuid: &str) -> Option<PathBuf> {
    match kind {
        AgentTranscript::Claude => crate::todos::locate_transcript_for(uuid).ok().flatten(),
        AgentTranscript::Codex => locate_codex_transcript(uuid),
    }
}

/// Walk the codex sessions root and find the rollout whose filename ends
/// in `<uuid>`. Codex rolls files into `<root>/<year>/<month>/<day>/`,
/// so we only need to scan the most recent date directories — older
/// rollouts for a given UUID never exist (the UUID is freshly minted
/// each run, never reused).
fn locate_codex_transcript(uuid: &str) -> Option<PathBuf> {
    let root = codex_sessions_root()?;
    for year in iter_subdirs_desc(&root)?.into_iter().take(2) {
        for month in iter_subdirs_desc(&year)?.into_iter().take(2) {
            for day in iter_subdirs_desc(&month)?.into_iter().take(7) {
                if let Some(p) = find_rollout_for_uuid(&day, uuid) {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn codex_sessions_root() -> Option<PathBuf> {
    std::env::var("CODEX_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| directories::UserDirs::new().map(|d| d.home_dir().join(".codex")))
        .map(|p| p.join("sessions"))
}

fn iter_subdirs_desc(dir: &Path) -> Option<Vec<PathBuf>> {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    entries.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    Some(entries)
}

fn find_rollout_for_uuid(day_dir: &Path, uuid: &str) -> Option<PathBuf> {
    for entry in fs::read_dir(day_dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(stem) = path
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|n| n.strip_suffix(".jsonl"))
        else {
            continue;
        };
        if stem.ends_with(uuid) {
            return Some(path);
        }
    }
    None
}

fn extract_preview(kind: AgentTranscript, path: &Path) -> io::Result<Option<String>> {
    match kind {
        AgentTranscript::Claude => extract_claude_preview(path),
        AgentTranscript::Codex => extract_codex_preview(path),
    }
}

const PREVIEW_TAIL_BYTES: u64 = 262_144;
const PREVIEW_CHARS: usize = 90;

/// Walk the last ~256 KiB of the transcript looking for the most recent
/// `assistant` line and return its first text segment, truncated and
/// newline-collapsed for single-line display. Conservative parsing —
/// any JSON parse error or unexpected shape silently yields `None`.
fn extract_claude_preview(path: &Path) -> io::Result<Option<String>> {
    let text = read_tail_lossy(path)?;
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else { continue };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let items = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array());
        let Some(items) = items else { continue };
        for item in items {
            if item.get("type").and_then(|t| t.as_str()) != Some("text") {
                continue;
            }
            let Some(text) = item.get("text").and_then(|t| t.as_str()) else { continue };
            if let Some(p) = collapse_preview(text) {
                return Ok(Some(p));
            }
        }
    }
    Ok(None)
}

/// Codex rollout schema: each line is a JSON event. Conversation turns
/// live under either `payload.message` (older rollouts) or
/// `payload.response.output[].content[].text` / `response_payload.output[]
/// .content[].text` (newer ones). Try the cheap variants in reverse so
/// the latest assistant turn wins; give up to `None` if nothing matches —
/// the modal still renders the UUID + timestamp.
fn extract_codex_preview(path: &Path) -> io::Result<Option<String>> {
    let text = read_tail_lossy(path)?;
    for line in text.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else { continue };

        if v.pointer("/payload/role").and_then(|r| r.as_str()) == Some("assistant") {
            if let Some(content) = v.pointer("/payload/content").and_then(|c| c.as_array()) {
                for item in content.iter().rev() {
                    let text = item
                        .get("text")
                        .or_else(|| item.get("output_text"))
                        .and_then(|t| t.as_str());
                    if let Some(text) = text {
                        if let Some(p) = collapse_preview(text) {
                            return Ok(Some(p));
                        }
                    }
                }
            }
        }

        if let Some(msg) = v
            .pointer("/payload/message")
            .and_then(|m| m.as_str())
            .filter(|s| !s.is_empty())
        {
            if let Some(p) = collapse_preview(msg) {
                return Ok(Some(p));
            }
        }

        let arrays = [
            v.pointer("/payload/response/output"),
            v.pointer("/response_payload/output"),
            v.pointer("/payload/output"),
        ];
        for arr in arrays.into_iter().flatten() {
            let Some(items) = arr.as_array() else { continue };
            for item in items.iter().rev() {
                let content = item.get("content").and_then(|c| c.as_array());
                let Some(content) = content else { continue };
                for c in content.iter().rev() {
                    if let Some(text) = c.get("text").and_then(|t| t.as_str()) {
                        if let Some(p) = collapse_preview(text) {
                            return Ok(Some(p));
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

fn read_tail_lossy(path: &Path) -> io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(PREVIEW_TAIL_BYTES);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity(PREVIEW_TAIL_BYTES as usize);
    f.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn collapse_preview(s: &str) -> Option<String> {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    let truncated: String = collapsed.chars().take(PREVIEW_CHARS).collect();
    let suffix = if collapsed.chars().count() > PREVIEW_CHARS {
        "…"
    } else {
        ""
    };
    Some(format!("{truncated}{suffix}"))
}

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
            AgentTranscript::Claude,
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
            AgentTranscript::Claude,
        )
        .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn claude_candidate_surfaced_after_new_uuid_overrides_ack() {
        let base = ScratchDir::new("rotated");
        let sid = uuid::Uuid::new_v4();
        write_id(base.path(), sid, CLAUDE_ID_ACK_FILE, "11111111-1111-1111-1111-111111111111");
        write_id(base.path(), sid, CLAUDE_ID_FILE, "22222222-2222-2222-2222-222222222222");
        let result = candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentTranscript::Claude,
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

        let preview = extract_codex_preview(&path).unwrap();

        assert_eq!(preview.as_deref(), Some("Here is the latest Codex answer."));
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
        let out = collapse_preview(&long).unwrap();
        assert!(out.ends_with("…"));
        assert!(out.chars().count() <= PREVIEW_CHARS + 1);
    }
}
