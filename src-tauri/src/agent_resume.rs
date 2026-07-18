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
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

use acorn_agent::AgentKind;
use acorn_transcript::{collapse_preview, parse_transcript_line, read_tail, TranscriptRole};

const AGENT_STATE_DIR_NAME: &str = "agent-state";

const CLAUDE_ID_FILE: &str = "claude.id";
const CLAUDE_ID_ACK_FILE: &str = "claude.id.acknowledged";
const CODEX_ID_FILE: &str = "codex.id";
const CODEX_ID_ACK_FILE: &str = "codex.id.acknowledged";
const ANTIGRAVITY_ID_FILE: &str = "antigravity.id";
const ANTIGRAVITY_ID_ACK_FILE: &str = "antigravity.id.acknowledged";

pub(crate) const PROVIDER_MARKER_MAX_BYTES: usize = 128;
pub(crate) const AGENT_CWD_MAX_BYTES: usize = 4 * 1024;

pub(crate) struct StateFileSnapshot {
    pub text: String,
    pub modified: Option<SystemTime>,
}

pub(crate) struct AntigravityTranscriptSnapshot {
    pub path: PathBuf,
    pub file: fs::File,
    pub len: u64,
    pub modified: Option<SystemTime>,
}

fn invalid_state(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

pub(crate) fn normalize_provider_id(value: &str) -> io::Result<String> {
    uuid::Uuid::parse_str(value.trim())
        .map(|id| id.to_string())
        .map_err(|_| invalid_state("agent provider marker must contain a UUID"))
}

fn require_plain_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        Err(invalid_state(format!(
            "agent state path is not a regular directory: {}",
            path.display()
        )))
    }
}

pub(crate) fn validate_state_directory(path: &Path) -> io::Result<()> {
    require_plain_directory(path)
}

fn ensure_plain_directory(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(err),
    }
    require_plain_directory(path)
}

fn plain_directory_exists(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(true),
        Ok(_) => Err(invalid_state(format!(
            "agent state path is not a regular directory: {}",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

fn open_regular_state_file(path: &Path) -> io::Result<Option<(fs::File, fs::Metadata)>> {
    let path_metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if !path_metadata.file_type().is_file() {
        return Err(invalid_state(format!(
            "agent state leaf is not a regular file: {}",
            path.display()
        )));
    }

    let file = fs::File::open(path)?;
    let opened_metadata = file.metadata()?;
    if !opened_metadata.file_type().is_file() {
        return Err(invalid_state(format!(
            "opened agent state leaf is not a regular file: {}",
            path.display()
        )));
    }
    #[cfg(unix)]
    if path_metadata.dev() != opened_metadata.dev() || path_metadata.ino() != opened_metadata.ino()
    {
        return Err(invalid_state(format!(
            "agent state leaf changed while opening: {}",
            path.display()
        )));
    }

    Ok(Some((file, opened_metadata)))
}

pub(crate) fn read_state_text_with_limit(
    path: &Path,
    max_bytes: usize,
) -> io::Result<Option<StateFileSnapshot>> {
    let Some((file, metadata)) = open_regular_state_file(path)? else {
        return Ok(None);
    };
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "state read limit overflow"))?;
    let mut bytes = Vec::with_capacity(read_limit.min(4 * 1024 + 1));
    file.take(read_limit as u64).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(invalid_state(format!(
            "agent state leaf exceeds {max_bytes} bytes: {}",
            path.display()
        )));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| invalid_state(format!("agent state leaf is not UTF-8: {}", path.display())))?;
    Ok(Some(StateFileSnapshot {
        text,
        modified: metadata.modified().ok(),
    }))
}

pub(crate) fn read_provider_marker(path: &Path) -> io::Result<Option<StateFileSnapshot>> {
    read_provider_marker_with_limit(path, PROVIDER_MARKER_MAX_BYTES)
}

fn read_provider_marker_with_limit(
    path: &Path,
    max_bytes: usize,
) -> io::Result<Option<StateFileSnapshot>> {
    let Some(snapshot) = read_state_text_with_limit(path, max_bytes)? else {
        return Ok(None);
    };
    Ok(Some(StateFileSnapshot {
        text: normalize_provider_id(&snapshot.text)?,
        modified: snapshot.modified,
    }))
}

fn validate_replace_leaf(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(invalid_state(format!(
            "agent state leaf is not a regular file: {}",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

pub(crate) fn replace_state_text_atomically(
    path: &Path,
    content: &str,
    max_bytes: usize,
) -> io::Result<()> {
    if content.len() > max_bytes {
        return Err(invalid_state(format!(
            "agent state value exceeds {max_bytes} bytes"
        )));
    }
    let parent = path
        .parent()
        .ok_or_else(|| invalid_state("agent state leaf has no parent directory"))?;
    require_plain_directory(parent)?;
    validate_replace_leaf(path)?;

    // The leaf is published by same-directory rename, so an existing hard link
    // is replaced rather than written through. A parent component can still be
    // swapped between these pathname operations; RES-006 tracks the dirfd/handle
    // redesign needed to close that remaining TOCTOU window.
    let mut temporary = tempfile::Builder::new()
        .prefix(".acorn-agent-state-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    #[cfg(unix)]
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    temporary.as_file_mut().write_all(content.as_bytes())?;
    temporary
        .persist(path)
        .map_err(|persist_error| persist_error.error)?;
    Ok(())
}

pub(crate) fn replace_provider_marker(path: &Path, value: &str) -> io::Result<String> {
    let normalized = normalize_provider_id(value)?;
    replace_state_text_atomically(path, &format!("{normalized}\n"), PROVIDER_MARKER_MAX_BYTES)?;
    Ok(normalized)
}

/// Per-Acorn-session scratch directory the resume persister writes
/// `*.id` into. The directory is also the modal's read source.
pub fn ensure_session_state_dir(session_id: uuid::Uuid) -> io::Result<PathBuf> {
    ensure_session_state_dir_at(&acorn_daemon::paths::data_dir()?, session_id)
}

fn ensure_session_state_dir_at(base: &Path, session_id: uuid::Uuid) -> io::Result<PathBuf> {
    let root = base.join(AGENT_STATE_DIR_NAME);
    ensure_plain_directory(&root)?;
    let dir = root.join(session_id.to_string());
    ensure_plain_directory(&dir)?;
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
    let root = base.join(AGENT_STATE_DIR_NAME);
    if !plain_directory_exists(&root)? {
        return Ok(None);
    }
    let dir = root.join(session_id.to_string());
    Ok(plain_directory_exists(&dir)?.then_some(dir))
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
        let marker = read_provider_marker(&dir.join(file)).ok().flatten()?;
        Some((kind, marker))
    })
    .collect::<Vec<_>>();
    markers.sort_by(|a, b| b.1.modified.cmp(&a.1.modified));
    markers.into_iter().find_map(|(kind, marker)| {
        live_transcript_for_id_with_locator(kind, marker.text, &locate_transcript)
    })
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
    let marker = read_provider_marker(&dir.join(file)).ok().flatten()?;
    live_transcript_for_id_with_locator(kind, marker.text, locate)
}

fn live_transcript_for_id_with_locator(
    kind: AgentKind,
    id: String,
    locate: &dyn Fn(AgentKind, &str) -> Option<PathBuf>,
) -> Option<LiveTranscript> {
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
    let uuid = match read_provider_marker(&state_dir.join(id_file))? {
        Some(marker) => marker.text,
        None => return Ok(None),
    };
    let acked = read_provider_marker(&state_dir.join(ack_file))?;
    if acked.as_ref().map(|marker| marker.text.as_str()) == Some(uuid.as_str()) {
        return Ok(None);
    }

    let (last_activity_unix, conversation_preview) = if kind == AgentKind::Antigravity {
        match open_antigravity_transcript_snapshot(&uuid) {
            Some(snapshot) => {
                let last_activity = snapshot
                    .modified
                    .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0);
                let preview = extract_conversation_preview_from_snapshot(kind, snapshot).ok();
                (last_activity, preview)
            }
            None => (0, None),
        }
    } else {
        let transcript = locate_transcript(kind, &uuid);
        let last_activity = transcript
            .as_ref()
            .and_then(|path| fs::metadata(path).ok())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let preview = transcript
            .as_ref()
            .and_then(|path| extract_conversation_preview(kind, path).ok());
        (last_activity, preview)
    };
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
    let id = match read_provider_marker(&state_dir.join(id_file))? {
        Some(marker) => marker.text,
        None => return Ok(()),
    };
    replace_provider_marker(&state_dir.join(ack_file), &id).map(drop)
}

pub(crate) fn locate_transcript(kind: AgentKind, uuid: &str) -> Option<PathBuf> {
    let uuid = normalize_provider_id(uuid).ok()?;
    match kind {
        AgentKind::Claude => crate::todos::locate_transcript_for(&uuid).ok().flatten(),
        AgentKind::Codex => locate_codex_transcript(&uuid),
        AgentKind::Antigravity => locate_antigravity_transcript(&uuid),
    }
}

/// Walk the codex sessions root and find the rollout whose filename ends
/// in `<uuid>`.
fn locate_codex_transcript(uuid: &str) -> Option<PathBuf> {
    acorn_transcript::locate_codex_transcript(uuid)
}

fn locate_antigravity_transcript(id: &str) -> Option<PathBuf> {
    open_antigravity_transcript_snapshot(id).map(|snapshot| snapshot.path)
}

fn google_agent_storage_root() -> Option<PathBuf> {
    std::env::var_os("ANTIGRAVITY_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_DIR").map(PathBuf::from))
        .or_else(|| directories::UserDirs::new().map(|d| d.home_dir().join(".gemini")))
}

fn open_antigravity_transcript_snapshot(id: &str) -> Option<AntigravityTranscriptSnapshot> {
    let root = google_agent_storage_root()?;
    open_antigravity_transcript_snapshots_at(&root, id)
        .into_iter()
        .next()
}

pub(crate) fn open_antigravity_transcript_snapshots_at(
    storage_root: &Path,
    id: &str,
) -> Vec<AntigravityTranscriptSnapshot> {
    let Ok(id) = normalize_provider_id(id) else {
        return Vec::new();
    };
    let Ok(storage_metadata) = fs::symlink_metadata(storage_root) else {
        return Vec::new();
    };
    if !storage_metadata.file_type().is_dir() {
        return Vec::new();
    }
    let Ok(canonical_storage_root) = storage_root.canonicalize() else {
        return Vec::new();
    };

    let mut snapshots = Vec::new();
    ["antigravity", "antigravity-ide", "antigravity-cli"]
        .into_iter()
        .filter_map(|profile| {
            let profile_dir = storage_root.join(profile);
            if !plain_directory(&profile_dir) {
                return None;
            }
            let brain_root = profile_dir.join("brain");
            if !plain_directory(&brain_root) {
                return None;
            }
            open_antigravity_transcript_in_brain_root(&brain_root, &canonical_storage_root, &id)
        })
        .for_each(|snapshot| snapshots.push(snapshot));
    snapshots
}

fn plain_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn open_antigravity_transcript_in_brain_root(
    brain_root: &Path,
    canonical_storage_root: &Path,
    id: &str,
) -> Option<AntigravityTranscriptSnapshot> {
    let canonical_brain_root = brain_root.canonicalize().ok()?;
    if !canonical_brain_root.starts_with(canonical_storage_root) {
        return None;
    }

    let session_dir = brain_root.join(id);
    let generated_dir = session_dir.join(".system_generated");
    let logs_dir = generated_dir.join("logs");
    if ![
        session_dir.as_path(),
        generated_dir.as_path(),
        logs_dir.as_path(),
    ]
    .into_iter()
    .all(plain_directory)
    {
        return None;
    }

    let path = logs_dir.join("transcript.jsonl");
    let path_metadata = fs::symlink_metadata(&path).ok()?;
    if !path_metadata.file_type().is_file() {
        return None;
    }
    let canonical_path = path.canonicalize().ok()?;
    if !canonical_path.starts_with(&canonical_brain_root) {
        return None;
    }

    let file = fs::File::open(&path).ok()?;
    let opened_metadata = file.metadata().ok()?;
    if !opened_metadata.file_type().is_file() {
        return None;
    }
    #[cfg(unix)]
    if path_metadata.dev() != opened_metadata.dev() || path_metadata.ino() != opened_metadata.ino()
    {
        return None;
    }

    // Stable links and special components are rejected before opening, and the
    // opened leaf is identity-checked. Parent replacement between pathname
    // operations remains the RES-006 dirfd/handle-relative TOCTOU follow-up.
    Some(AntigravityTranscriptSnapshot {
        path: canonical_path,
        file,
        len: opened_metadata.len(),
        modified: opened_metadata.modified().ok(),
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ConversationPreview {
    pub last_user_message: Option<String>,
    pub last_user_message_at: Option<String>,
    pub last_agent_message: Option<String>,
}

pub(crate) fn extract_conversation_preview(
    kind: AgentKind,
    path: &Path,
) -> io::Result<ConversationPreview> {
    let tail = read_tail(path, PREVIEW_TAIL_BYTES)?;
    let mut preview = scan_conversation_preview(kind, &tail.text);
    // A long agent turn (big review, many tool calls) can push the last user
    // message past the small tail window, blanking the card's USER line. Only
    // when the cheap tail missed it — and the file has more to read — pay for a
    // wider read to recover it.
    // ponytail: 32 MiB ceiling. Autonomous agents churn megabytes per turn
    // (a live review session measured ~6.5 MiB and climbing), so the cap must
    // clear realistic single-turn spans; a turn larger than this keeps no USER
    // preview. Reads hit the OS page cache (~3 ms) and run off the UI thread.
    if preview.last_user_message.is_none() && !tail.read_full {
        let wider = read_tail(path, PREVIEW_MAX_TAIL_BYTES)?;
        let recovered = scan_conversation_preview(kind, &wider.text);
        preview.last_user_message = recovered.last_user_message;
        preview.last_agent_message = preview.last_agent_message.or(recovered.last_agent_message);
    }
    Ok(preview)
}

fn extract_conversation_preview_from_snapshot(
    kind: AgentKind,
    snapshot: AntigravityTranscriptSnapshot,
) -> io::Result<ConversationPreview> {
    let AntigravityTranscriptSnapshot { mut file, len, .. } = snapshot;
    let (tail, read_full) = read_preview_tail(&mut file, len, PREVIEW_TAIL_BYTES)?;
    let mut preview = scan_conversation_preview(kind, &tail);
    if preview.last_user_message.is_none() && !read_full {
        let (wider, _) = read_preview_tail(&mut file, len, PREVIEW_MAX_TAIL_BYTES)?;
        let recovered = scan_conversation_preview(kind, &wider);
        preview.last_user_message = recovered.last_user_message;
        preview.last_agent_message = preview.last_agent_message.or(recovered.last_agent_message);
    }
    Ok(preview)
}

fn read_preview_tail(file: &mut fs::File, len: u64, max_bytes: u64) -> io::Result<(String, bool)> {
    if max_bytes == 0 {
        return Ok((String::new(), false));
    }
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let read_limit = max_bytes.min(len);
    let mut bytes = Vec::with_capacity(read_limit as usize);
    Read::take(file, read_limit).read_to_end(&mut bytes)?;
    Ok((
        String::from_utf8_lossy(&bytes).into_owned(),
        len <= max_bytes,
    ))
}

fn scan_conversation_preview(kind: AgentKind, text: &str) -> ConversationPreview {
    let mut preview = ConversationPreview::default();
    for line in text.lines().rev() {
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
                if preview.last_user_message.is_some() {
                    preview.last_user_message_at = parsed.timestamp;
                }
            }
            _ => {}
        }
        if preview.last_user_message.is_some() && preview.last_agent_message.is_some() {
            break;
        }
    }
    preview
}

const PREVIEW_TAIL_BYTES: u64 = 262_144;
const PREVIEW_MAX_TAIL_BYTES: u64 = 32 * 1024 * 1024;
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

    fn write_antigravity_transcript(storage_root: &Path, id: &str, body: &str) -> PathBuf {
        let path = storage_root
            .join("antigravity/brain")
            .join(id)
            .join(".system_generated/logs/transcript.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn provider_ids_are_normalized_and_path_shaped_values_are_rejected() {
        assert_eq!(
            normalize_provider_id("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE").unwrap(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
        assert_eq!(
            normalize_provider_id("aaaaaaaabbbbccccddddeeeeeeeeeeee").unwrap(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );

        for invalid in [
            "",
            "not-a-uuid",
            "../aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "/tmp/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        ] {
            assert!(
                normalize_provider_id(invalid).is_err(),
                "accepted {invalid:?}"
            );
            assert!(locate_transcript(AgentKind::Antigravity, invalid).is_none());
        }
    }

    #[test]
    fn provider_marker_reader_enforces_injected_byte_limit_for_id_and_ack() {
        let base = ScratchDir::new("marker-limit");
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        for file in [CLAUDE_ID_FILE, CLAUDE_ID_ACK_FILE] {
            let path = base.path().join(file);
            fs::write(&path, id).unwrap();
            assert_eq!(
                read_provider_marker_with_limit(&path, id.len())
                    .unwrap()
                    .unwrap()
                    .text,
                id
            );

            fs::write(&path, format!("{id}\n")).unwrap();
            assert!(read_provider_marker_with_limit(&path, id.len()).is_err());
        }
    }

    #[test]
    fn antigravity_snapshot_reads_preview_from_valid_opened_leaf() {
        let storage = ScratchDir::new("antigravity-secure-preview");
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let path = write_antigravity_transcript(
            storage.path(),
            id,
            r#"{"type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>Secure this lookup.</USER_REQUEST>"}
{"type":"PLANNER_RESPONSE","status":"DONE","content":"The opened snapshot is bounded."}
"#,
        );

        let mut snapshots = open_antigravity_transcript_snapshots_at(storage.path(), id);
        assert_eq!(snapshots.len(), 1);
        let snapshot = snapshots.pop().unwrap();
        assert_eq!(snapshot.path, path.canonicalize().unwrap());
        let preview =
            extract_conversation_preview_from_snapshot(AgentKind::Antigravity, snapshot).unwrap();
        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Secure this lookup.")
        );
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("The opened snapshot is bounded.")
        );
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_snapshot_rejects_symlinked_storage_and_brain_roots() {
        use std::os::unix::fs::symlink;

        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let outside = ScratchDir::new("antigravity-root-sentinel");
        let sentinel = write_antigravity_transcript(outside.path(), id, "sentinel\n");

        let configured = ScratchDir::new("antigravity-linked-storage");
        let linked_storage = configured.path().join("storage");
        symlink(outside.path(), &linked_storage).unwrap();
        assert!(open_antigravity_transcript_snapshots_at(&linked_storage, id).is_empty());

        let storage = ScratchDir::new("antigravity-linked-brain");
        let profile = storage.path().join("antigravity");
        fs::create_dir(&profile).unwrap();
        symlink(
            outside.path().join("antigravity/brain"),
            profile.join("brain"),
        )
        .unwrap();
        assert!(open_antigravity_transcript_snapshots_at(storage.path(), id).is_empty());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "sentinel\n");
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_snapshot_rejects_symlinked_session_and_internal_components() {
        use std::os::unix::fs::symlink;

        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";

        let storage = ScratchDir::new("antigravity-linked-session");
        let brain = storage.path().join("antigravity/brain");
        fs::create_dir_all(&brain).unwrap();
        let outside = ScratchDir::new("antigravity-session-sentinel");
        let outside_transcript = write_antigravity_transcript(outside.path(), id, "session\n");
        symlink(
            outside.path().join("antigravity/brain").join(id),
            brain.join(id),
        )
        .unwrap();
        assert!(open_antigravity_transcript_snapshots_at(storage.path(), id).is_empty());
        assert_eq!(fs::read_to_string(outside_transcript).unwrap(), "session\n");

        let storage = ScratchDir::new("antigravity-linked-generated");
        let session = storage.path().join("antigravity/brain").join(id);
        fs::create_dir_all(&session).unwrap();
        let outside = ScratchDir::new("antigravity-generated-sentinel");
        let generated = outside.path().join(".system_generated");
        fs::create_dir_all(generated.join("logs")).unwrap();
        let sentinel = generated.join("logs/transcript.jsonl");
        fs::write(&sentinel, "generated\n").unwrap();
        symlink(&generated, session.join(".system_generated")).unwrap();
        assert!(open_antigravity_transcript_snapshots_at(storage.path(), id).is_empty());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "generated\n");

        let storage = ScratchDir::new("antigravity-linked-logs");
        let generated = storage
            .path()
            .join("antigravity/brain")
            .join(id)
            .join(".system_generated");
        fs::create_dir_all(&generated).unwrap();
        let outside = ScratchDir::new("antigravity-logs-sentinel");
        let sentinel = outside.path().join("transcript.jsonl");
        fs::write(&sentinel, "logs\n").unwrap();
        symlink(outside.path(), generated.join("logs")).unwrap();
        assert!(open_antigravity_transcript_snapshots_at(storage.path(), id).is_empty());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "logs\n");
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_snapshot_rejects_symlinked_transcript_leaf() {
        use std::os::unix::fs::symlink;

        let storage = ScratchDir::new("antigravity-linked-transcript");
        let id = "17f38e8c-3a7e-408b-8c79-aef7432c0fd2";
        let leaf = storage
            .path()
            .join("antigravity/brain")
            .join(id)
            .join(".system_generated/logs/transcript.jsonl");
        fs::create_dir_all(leaf.parent().unwrap()).unwrap();
        let sentinel = storage.path().join("transcript-sentinel");
        fs::write(&sentinel, "leaf\n").unwrap();
        symlink(&sentinel, &leaf).unwrap();

        assert!(open_antigravity_transcript_snapshots_at(storage.path(), id).is_empty());
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "leaf\n");
    }

    #[test]
    fn candidate_rejects_oversized_or_invalid_provider_markers() {
        let base = ScratchDir::new("invalid-marker");
        let sid = uuid::Uuid::new_v4();
        write_id(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            &"x".repeat(PROVIDER_MARKER_MAX_BYTES + 1),
        );
        assert!(candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .is_err());

        write_id(base.path(), sid, CLAUDE_ID_FILE, "../outside");
        assert!(candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .is_err());

        write_id(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        );
        write_id(
            base.path(),
            sid,
            CLAUDE_ID_ACK_FILE,
            &"x".repeat(PROVIDER_MARKER_MAX_BYTES + 1),
        );
        assert!(candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_agent_state_directories_are_rejected() {
        use std::os::unix::fs::symlink;

        let base = ScratchDir::new("linked-state-root");
        let outside = ScratchDir::new("linked-state-outside");
        symlink(outside.path(), base.path().join(AGENT_STATE_DIR_NAME)).unwrap();
        let sid = uuid::Uuid::new_v4();
        assert!(ensure_session_state_dir_at(base.path(), sid).is_err());
        assert!(!outside.path().join(sid.to_string()).exists());

        let base = ScratchDir::new("linked-session-dir");
        let root = base.path().join(AGENT_STATE_DIR_NAME);
        fs::create_dir(&root).unwrap();
        symlink(outside.path(), root.join(sid.to_string())).unwrap();
        assert!(ensure_session_state_dir_at(base.path(), sid).is_err());
        assert!(session_state_dir_if_exists_at(base.path(), sid).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_marker_and_ack_leaves_never_touch_their_sentinel() {
        use std::os::unix::fs::symlink;

        let base = ScratchDir::new("linked-marker");
        let sid = uuid::Uuid::new_v4();
        let state_dir = ensure_session_state_dir_at(base.path(), sid).unwrap();
        let sentinel = base.path().join("sentinel");
        fs::write(&sentinel, "do not change").unwrap();

        symlink(&sentinel, state_dir.join(CLAUDE_ID_FILE)).unwrap();
        assert!(candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .is_err());
        assert!(acknowledge_at(base.path(), sid, CLAUDE_ID_FILE, CLAUDE_ID_ACK_FILE).is_err());
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "do not change");

        fs::remove_file(state_dir.join(CLAUDE_ID_FILE)).unwrap();
        fs::write(
            state_dir.join(CLAUDE_ID_FILE),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n",
        )
        .unwrap();
        symlink(&sentinel, state_dir.join(CLAUDE_ID_ACK_FILE)).unwrap();
        assert!(candidate_at(
            base.path(),
            sid,
            CLAUDE_ID_FILE,
            CLAUDE_ID_ACK_FILE,
            AgentKind::Claude,
        )
        .is_err());
        assert!(acknowledge_at(base.path(), sid, CLAUDE_ID_FILE, CLAUDE_ID_ACK_FILE).is_err());
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "do not change");
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
    fn claude_conversation_preview_recovers_user_message_past_tail_window() {
        let base = ScratchDir::new("claude-long-turn-preview");
        let path = base.path().join("transcript.jsonl");
        // One big assistant turn pushes the user message well past the 256 KiB
        // tail window; the preview must still recover it.
        let filler = "x".repeat((PREVIEW_TAIL_BYTES as usize) + 100_000);
        let contents = format!(
            "{}\n{}\n{}\n",
            r#"{"type":"user","message":{"content":"Review PRs 638 to 603."}}"#,
            format!(
                r#"{{"type":"assistant","message":{{"content":"{}"}}}}"#,
                filler
            ),
            r#"{"type":"assistant","message":{"content":"CI: nearly all CLEAN."}}"#,
        );
        fs::write(&path, contents).unwrap();

        let preview = extract_conversation_preview(AgentKind::Claude, &path).unwrap();

        assert_eq!(
            preview.last_user_message.as_deref(),
            Some("Review PRs 638 to 603.")
        );
        assert_eq!(
            preview.last_agent_message.as_deref(),
            Some("CI: nearly all CLEAN.")
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
            r#"{"timestamp":"2026-01-02T03:00:00.000Z","type":"message","payload":{"role":"user","content":[{"type":"input_text","text":"Check the drawer regression."}]}}
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
        assert_eq!(
            preview.last_user_message_at.as_deref(),
            Some("2026-01-02T03:00:00.000Z")
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
    fn codex_conversation_preview_skips_internal_control_messages() {
        let base = ScratchDir::new("codex-control-preview");
        let path = base.path().join("rollout.jsonl");
        fs::write(
            &path,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Implement the kanban preview fix."}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I will inspect the transcript parser."}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<codex_internal_context source=\"goal\">\nThe user set an active goal.\n</codex_internal_context>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\nThe user intentionally interrupted the previous turn.\n</turn_aborted>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<subagent_notification>\nA background task completed.\n</subagent_notification>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>\nInternal plugin recommendations.\n</recommended_plugins>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<user_shell_command>\nShell command metadata.\n</user_shell_command>"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<user_action>\nInternal action metadata.\n</user_action>"}]}}
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
