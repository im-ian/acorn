//! Background poller that mirrors live agent transcript pairings into
//! per-session state files so the focus-time "이전 대화 이어하기" modal
//! can decide what to surface.
//!
//! The transcript watcher maps a running `claude` / `codex` / `antigravity` / `grok`
//! process to its transcript via PTY descendant scan + cwd match + mtime
//! window. The modal needs the user-facing session owner rather than every
//! nested sub-agent: when the user focuses a session and the agent is *not*
//! currently running, what was the last top-level transcript that session had
//! been writing? This task keeps `<state_dir>/{claude,codex,antigravity,grok}.id`
//! up to date so the modal lookup is a single file read.
//!
//! Why polling and not filesystem events: PTY-tree resolution is the
//! decisive disambiguator when two sessions are running the same agent
//! in the same cwd. A `notify`-driven path would still need the same scan
//! to attribute a new JSONL to an Acorn session, and the agent process
//! is alive for seconds-to-minutes — a 2 s poll is fast enough to capture
//! every fresh UUID before the user could plausibly focus away and back.
//! A second benefit: the owner-scoped scanner has its own short cache, so
//! back-to-back ticks do not repeat the same host-wide process scan.
//!
//! `*.id.acknowledged` is deliberately *not* touched here. When a
//! session starts a new conversation, its UUID changes; the new value
//! lands in `*.id` while the old ack stays put, so the modal pops
//! exactly once per fresh UUID per session.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use acorn_agent::AgentKind;
use acorn_session::Session;
use acorn_transcript::{self as transcript_watcher, SessionPid};
use uuid::Uuid;

use crate::agent_resume;
use crate::state::AppState;

/// Snapshot every Acorn session's PTY root pid for `acorn_transcript`'s
/// scanner. Attached daemon streams take priority because they cache the
/// daemon-side pid; in-process PTYs cover non-daemon sessions; daemon
/// `ListSessions` covers live background PTYs that are not attached.
/// Lives here (and not in the transcript crate) because the AppState
/// surface is owned by the host crate.
pub fn collect_session_pids(state: &AppState) -> Vec<SessionPid> {
    let sessions = state.sessions.list();
    let daemon_pids = daemon_session_pids(state);
    collect_session_pids_from_rows(
        &sessions,
        |id| state.stream_registry.pid(id),
        |id| state.pty.child_pid(id),
        |id| daemon_pids.get(id).copied(),
    )
}

fn collect_session_pids_from_rows(
    sessions: &[Session],
    mut stream_pid: impl FnMut(&Uuid) -> Option<u32>,
    mut pty_pid: impl FnMut(&Uuid) -> Option<u32>,
    mut daemon_pid: impl FnMut(&Uuid) -> Option<u32>,
) -> Vec<SessionPid> {
    sessions
        .iter()
        .map(|s| SessionPid {
            session_id: s.id,
            root_pid: stream_pid(&s.id)
                .or_else(|| pty_pid(&s.id))
                .or_else(|| daemon_pid(&s.id)),
        })
        .collect()
}

fn daemon_session_pids(state: &AppState) -> HashMap<Uuid, u32> {
    state
        .daemon_bridge
        .list_sessions()
        .ok()
        .into_iter()
        .flatten()
        .filter(|s| s.alive)
        .filter_map(|s| s.pid.map(|pid| (s.id, pid)))
        .collect()
}

/// Tick interval. Short enough to capture a UUID before the user could
/// reasonably switch sessions and back; long enough that the host-wide
/// process scan inside `collect_session_owner_mappings` does not show up on any
/// idle-CPU graph.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const ERROR_WARNING_INTERVAL: Duration = Duration::from_secs(60);

/// Spawn the persister on a dedicated OS thread. The poller is process-
/// scoped: one task per Acorn run, walks every session each tick. The
/// `AppState` clone is cheap — every field is an `Arc`.
pub fn spawn(state: AppState) {
    std::thread::Builder::new()
        .name("acorn-resume-persister".into())
        .spawn(move || run(state))
        .map(drop)
        .unwrap_or_else(|err| {
            tracing::warn!(error = %err, "agent_resume_persister: thread spawn failed");
        });
}

fn run(state: AppState) {
    let mut last_warning_at = None;
    loop {
        std::thread::sleep(POLL_INTERVAL);
        match tick(&state) {
            Ok(()) => last_warning_at = None,
            Err(err) => {
                let warning_is_due = last_warning_at
                    .map(|last: Instant| last.elapsed() >= ERROR_WARNING_INTERVAL)
                    .unwrap_or(true);
                if warning_is_due {
                    tracing::warn!(error = %err, "agent_resume_persister: tick failed");
                    last_warning_at = Some(Instant::now());
                } else {
                    tracing::debug!(error = %err, "agent_resume_persister: tick still failing");
                }
            }
        }
    }
}

fn tick(state: &AppState) -> io::Result<()> {
    let session_rows = state.sessions.list();
    let session_cwds = session_rows
        .iter()
        .map(|s| (s.id, s.worktree_path.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let daemon_pids = daemon_session_pids(state);
    let sessions = collect_session_pids_from_rows(
        &session_rows,
        |id| state.stream_registry.pid(id),
        |id| state.pty.child_pid(id),
        |id| daemon_pids.get(id).copied(),
    );
    let mappings = transcript_watcher::collect_session_owner_mappings_checked(&sessions)?;
    if mappings.is_empty() {
        return Ok(());
    }
    let mut first_error = None;
    for (session_id, kind, uuid) in mappings {
        let state_dir = match agent_resume::ensure_session_state_dir(session_id) {
            Ok(p) => p,
            Err(err) => {
                remember_first_error(
                    &mut first_error,
                    contextual_io_error(
                        format!("ensure resume state for session {session_id}"),
                        err,
                    ),
                );
                continue;
            }
        };
        if let Some(cwd_file) = cwd_filename(kind) {
            if let Some(cwd) = session_cwds.get(&session_id) {
                if let Err(err) = write_if_changed(
                    &state_dir.join(cwd_file),
                    &format!("{}\n", cwd.display()),
                    agent_resume::AGENT_CWD_MAX_BYTES,
                ) {
                    remember_first_error(
                        &mut first_error,
                        contextual_io_error(
                            format!("write {kind:?} cwd for session {session_id}"),
                            err,
                        ),
                    );
                }
            }
        }
        if let Err(err) = bind_marker_in_state_dir(&state_dir, kind, &uuid) {
            remember_first_error(
                &mut first_error,
                contextual_io_error(
                    format!("bind {kind:?} resume marker {uuid} for session {session_id}"),
                    err,
                ),
            );
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn contextual_io_error(context: impl std::fmt::Display, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("failed to {context}: {error}"))
}

fn remember_first_error(slot: &mut Option<io::Error>, error: io::Error) {
    if slot.is_none() {
        *slot = Some(error);
    }
}

/// Bind `uuid` as `session_id`'s durable resume marker for `kind`, under
/// the same guards the background tick applies. Exposed so out-of-band
/// binders (the status poll's codex fallback) share one write policy
/// instead of growing a second, subtly different marker writer.
///
/// Inferred writers share a settling window and dormant-rollback guard.
/// Provider-declared hook writes bypass incoming guards, while competing
/// inferred scans wait for the abandoned transcript to become dormant.
pub fn bind_session_marker(session_id: uuid::Uuid, kind: AgentKind, uuid: &str) -> io::Result<()> {
    let state_dir = agent_resume::ensure_session_state_dir(session_id)?;
    bind_marker_in_state_dir(&state_dir, kind, uuid)
}

/// Bind a provider-owned conversation identifier as the session's durable
/// marker. Provider hooks identify the active conversation directly, so
/// transcript activity heuristics must not reject this update.
pub fn bind_provider_session_marker(
    session_id: uuid::Uuid,
    kind: AgentKind,
    uuid: &str,
) -> io::Result<()> {
    let state_dir = agent_resume::ensure_session_state_dir(session_id)?;
    bind_provider_marker_in_state_dir(&state_dir, kind, uuid)
}

/// Serializes marker writes across the background tick and the status
/// poll's fallback. The read-check-write below is not atomic on its own;
/// two threads interleaving could skip marker arbitration and flap the
/// marker.
fn marker_bind_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

struct ProviderMarkerLease {
    uuid: String,
    bound_at: Instant,
}

fn provider_marker_leases() -> &'static Mutex<HashMap<(PathBuf, AgentKind), ProviderMarkerLease>> {
    static LEASES: OnceLock<Mutex<HashMap<(PathBuf, AgentKind), ProviderMarkerLease>>> =
        OnceLock::new();
    LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_provider_marker_lease(state_dir: &Path, kind: AgentKind, uuid: &str) {
    let now = Instant::now();
    let mut leases = provider_marker_leases()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    leases.retain(|_, lease| {
        lease.bound_at.elapsed() <= Duration::from_secs(acorn_transcript::DORMANT_TRANSCRIPT_SECS)
    });
    leases.insert(
        (state_dir.to_path_buf(), kind),
        ProviderMarkerLease {
            uuid: uuid.to_string(),
            bound_at: now,
        },
    );
}

fn provider_marker_lease_is_active(state_dir: &Path, kind: AgentKind, uuid: &str) -> bool {
    let mut leases = provider_marker_leases()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    leases.retain(|_, lease| {
        lease.bound_at.elapsed() <= Duration::from_secs(acorn_transcript::DORMANT_TRANSCRIPT_SECS)
    });
    leases
        .get(&(state_dir.to_path_buf(), kind))
        .is_some_and(|lease| lease.uuid == uuid)
}

fn bind_marker_in_state_dir(state_dir: &Path, kind: AgentKind, uuid: &str) -> io::Result<()> {
    bind_marker_in_state_dir_with_policy(state_dir, kind, uuid, MarkerBindPolicy::Inferred)
}

fn bind_provider_marker_in_state_dir(
    state_dir: &Path,
    kind: AgentKind,
    uuid: &str,
) -> io::Result<()> {
    bind_marker_in_state_dir_with_policy(state_dir, kind, uuid, MarkerBindPolicy::ProviderDeclared)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MarkerBindPolicy {
    Inferred,
    ProviderDeclared,
}

fn bind_marker_in_state_dir_with_policy(
    state_dir: &Path,
    kind: AgentKind,
    uuid: &str,
    policy: MarkerBindPolicy,
) -> io::Result<()> {
    let uuid = agent_resume::normalize_provider_id(uuid)?;
    agent_resume::validate_state_directory(state_dir)?;
    let _guard = marker_bind_lock()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let id_file = state_dir.join(id_filename(kind));
    let previous = agent_resume::read_provider_marker(&id_file)?;
    if previous.as_ref().map(|marker| marker.text.as_str()) == Some(uuid.as_str()) {
        if policy == MarkerBindPolicy::ProviderDeclared {
            remember_provider_marker_lease(state_dir, kind, &uuid);
        }
        return Ok(());
    }
    let provider_binding_is_settling = previous
        .as_ref()
        .is_some_and(|marker| provider_marker_lease_is_active(state_dir, kind, &marker.text));
    // A provider hook can move the marker while the previous transcript is
    // still hot enough for an inferred scan to select it. Hold that declared
    // binding through the ambiguity window, then reject dormant backwards
    // echoes while still allowing an actively written explicit resume.
    if marker_update_is_blocked(
        policy,
        previous.as_ref().map(|marker| marker.text.as_str()),
        &uuid,
        provider_binding_is_settling,
        |prev, next| marker_rollback_is_dormant_echo(kind, prev, next),
    )? {
        return Ok(());
    }
    agent_resume::replace_provider_marker(&id_file, &uuid)?;
    if policy == MarkerBindPolicy::ProviderDeclared {
        remember_provider_marker_lease(state_dir, kind, &uuid);
    }
    Ok(())
}

fn marker_update_is_blocked<F>(
    policy: MarkerBindPolicy,
    previous: Option<&str>,
    next: &str,
    provider_binding_is_settling: bool,
    dormant_echo: F,
) -> io::Result<bool>
where
    F: FnOnce(&str, &str) -> io::Result<bool>,
{
    if policy != MarkerBindPolicy::Inferred {
        return Ok(false);
    }
    let Some(previous) = previous else {
        return Ok(false);
    };
    if provider_binding_is_settling {
        return Ok(true);
    }
    dormant_echo(previous, next)
}

fn id_filename(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude.id",
        AgentKind::Codex => "codex.id",
        AgentKind::Antigravity => "antigravity.id",
        AgentKind::Grok => "grok.id",
    }
}

fn cwd_filename(kind: AgentKind) -> Option<&'static str> {
    match kind {
        AgentKind::Antigravity => Some("antigravity.cwd"),
        AgentKind::Claude | AgentKind::Codex | AgentKind::Grok => None,
    }
}

/// True when replacing `prev_uuid` with `next_uuid` would move the marker
/// to an *earlier-born* transcript that is no longer being written. That
/// combination is the post-`/new` echo: once the new conversation idles,
/// the birth-anchored scan returns the abandoned original again, and
/// writing it would oscillate the marker old → new → old. A real
/// `claude --resume` of an older conversation also moves backwards, but
/// its transcript is being appended right now (hot), so it passes.
fn marker_rollback_is_dormant_echo(
    kind: AgentKind,
    prev_uuid: &str,
    next_uuid: &str,
) -> io::Result<bool> {
    let Some(prev_path) = agent_resume::locate_transcript_checked(kind, prev_uuid)? else {
        return Ok(false);
    };
    let Some(next_path) = agent_resume::locate_transcript_checked(kind, next_uuid)? else {
        return Ok(false);
    };
    rollback_is_dormant_echo_for_kind(kind, &prev_path, &next_path, next_uuid, SystemTime::now())
}

fn rollback_is_dormant_echo_for_kind(
    kind: AgentKind,
    prev: &Path,
    next: &Path,
    next_uuid: &str,
    now: SystemTime,
) -> io::Result<bool> {
    let dormant_echo = rollback_is_dormant_echo(prev, next, now)?;
    if !dormant_echo {
        return Ok(false);
    }
    // A Codex marker can point to a child rollout. If that child names the
    // newly resolved transcript in its bounded parent chain, allow the owner
    // scan to repair the marker even though the owner is older and dormant.
    // Other backwards moves retain the oscillation guard.
    if kind == AgentKind::Codex
        && codex_rollout_declares_ancestor(prev, next_uuid, |thread_id| {
            agent_resume::locate_transcript_checked(AgentKind::Codex, thread_id)
        })?
    {
        return Ok(false);
    }
    Ok(true)
}

fn codex_rollout_declares_ancestor<F>(
    rollout: &Path,
    ancestor_uuid: &str,
    mut locate: F,
) -> io::Result<bool>
where
    F: FnMut(&str) -> io::Result<Option<PathBuf>>,
{
    const MAX_ANCESTOR_DEPTH: usize = 16;

    let mut current = rollout.to_path_buf();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let Some(parent_uuid) = acorn_transcript::codex_rollout_parent_thread_id_checked(&current)?
        else {
            return Ok(false);
        };
        if !seen.insert(parent_uuid.clone()) {
            return Ok(false);
        }
        if parent_uuid == ancestor_uuid {
            return Ok(true);
        }
        let Some(parent_path) = locate(&parent_uuid)? else {
            return Ok(false);
        };
        current = parent_path;
    }
    Ok(false)
}

fn rollback_is_dormant_echo(prev: &Path, next: &Path, now: SystemTime) -> io::Result<bool> {
    let Some(prev_meta) = transcript_metadata_if_present(prev)? else {
        return Ok(false);
    };
    let Some(next_meta) = transcript_metadata_if_present(next)? else {
        return Ok(false);
    };
    let prev_mtime = prev_meta.modified().map_err(|error| {
        contextual_io_error(format!("read mtime for {}", prev.display()), error)
    })?;
    let next_mtime = next_meta.modified().map_err(|error| {
        contextual_io_error(format!("read mtime for {}", next.display()), error)
    })?;
    let prev_birth = prev_meta.created().unwrap_or(prev_mtime);
    let next_birth = next_meta.created().unwrap_or(next_mtime);
    if next_birth >= prev_birth {
        // Moving forward in birth order — always allowed.
        return Ok(false);
    }
    // Backwards move: a dormant target is the echo; a hot one is a
    // genuine resume of the older conversation.
    Ok(now
        .duration_since(next_mtime)
        .map(|d| d.as_secs() > acorn_transcript::DORMANT_TRANSCRIPT_SECS)
        .unwrap_or(false))
}

fn transcript_metadata_if_present(path: &Path) -> io::Result<Option<fs::Metadata>> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(contextual_io_error(
            format!("inspect transcript {}", path.display()),
            error,
        )),
    }
}

fn write_if_changed(path: &Path, content: &str, max_bytes: usize) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "agent state leaf has no parent directory",
        )
    })?;
    agent_resume::validate_state_directory(parent)?;
    if agent_resume::read_state_text_with_limit(path, max_bytes)?
        .as_ref()
        .map(|snapshot| snapshot.text.as_str())
        == Some(content)
    {
        return Ok(());
    }
    agent_resume::replace_state_text_atomically(path, content, max_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn read_marker(path: &Path) -> Option<String> {
        agent_resume::read_provider_marker(path)
            .ok()
            .flatten()
            .map(|marker| marker.text)
    }

    fn session_with_id(id: Uuid) -> Session {
        let mut session = Session::new(
            "test".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            acorn_session::SessionKind::Regular,
        );
        session.id = id;
        session
    }

    fn set_mtime(path: &Path, t: SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(t)).unwrap();
    }

    #[test]
    fn collect_session_pids_falls_back_to_daemon_pid() {
        let id = Uuid::from_u128(1);
        let sessions = vec![session_with_id(id)];

        let pids = collect_session_pids_from_rows(
            &sessions,
            |_| None,
            |_| None,
            |candidate| (*candidate == id).then_some(42),
        );

        assert_eq!(pids.len(), 1);
        assert_eq!(pids[0].session_id, id);
        assert_eq!(pids[0].root_pid, Some(42));
    }

    #[test]
    fn collect_session_pids_keeps_live_attachment_priority() {
        let id = Uuid::from_u128(2);
        let sessions = vec![session_with_id(id)];

        let pids = collect_session_pids_from_rows(
            &sessions,
            |candidate| (*candidate == id).then_some(10),
            |candidate| (*candidate == id).then_some(20),
            |candidate| (*candidate == id).then_some(30),
        );

        assert_eq!(pids.len(), 1);
        assert_eq!(pids[0].session_id, id);
        assert_eq!(pids[0].root_pid, Some(10));
    }

    /// `bind_marker_in_state_dir` backs both the background tick and the
    /// status poll's codex fallback: it must create a fresh marker, stay
    /// idempotent on the same uuid, and move forward to a new uuid.
    #[test]
    fn bind_marker_writes_and_stays_idempotent() {
        let dir =
            std::env::temp_dir().join(format!("acorn-bindmk-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("codex.id");

        bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
        )
        .unwrap();
        assert_eq!(
            read_marker(&marker).as_deref(),
            Some("019e2001-aaaa-76b0-8410-2e073b38a2c1"),
            "first bind must create the marker"
        );

        let metadata_before = fs::metadata(&marker).unwrap();
        bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&marker).unwrap().modified().unwrap(),
            metadata_before.modified().unwrap(),
            "same-uuid rebind must not rewrite the marker"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};

            let metadata_after = fs::metadata(&marker).unwrap();
            assert_eq!(metadata_after.ino(), metadata_before.ino());
            assert_eq!(metadata_after.permissions().mode() & 0o777, 0o600);
        }

        bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-bbbb-76b0-8410-2e073b38a2c2",
        )
        .unwrap();
        assert_eq!(
            read_marker(&marker).as_deref(),
            Some("019e2001-bbbb-76b0-8410-2e073b38a2c2"),
            "a new uuid must replace the marker"
        );
        assert!(fs::read_dir(&dir).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".acorn-agent-state-")
        }));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bind_marker_validates_ids_before_creating_a_leaf() {
        let dir =
            std::env::temp_dir().join(format!("acorn-bindbad-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();

        for invalid in [
            "not-a-uuid",
            "../019e2001-aaaa-76b0-8410-2e073b38a2c1",
            "/tmp/019e2001-aaaa-76b0-8410-2e073b38a2c1",
            &"x".repeat(agent_resume::PROVIDER_MARKER_MAX_BYTES + 1),
        ] {
            assert!(bind_marker_in_state_dir(&dir, AgentKind::Codex, invalid).is_err());
            assert!(!dir.join("codex.id").exists());
        }

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn atomic_state_writer_honors_an_injected_limit_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!(
            "acorn-statewrite-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("antigravity.cwd");

        write_if_changed(&path, "abcd", 4).unwrap();
        let before = fs::metadata(&path).unwrap();
        write_if_changed(&path, "abcd", 4).unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};

            assert_eq!(before.ino(), after.ino());
            assert_eq!(after.permissions().mode() & 0o777, 0o600);
        }
        assert!(write_if_changed(&path, "abcde", 4).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "abcd");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn marker_writer_rejects_symlink_and_replaces_hardlink_without_clobbering_sentinel() {
        use std::os::unix::fs::symlink;

        let dir =
            std::env::temp_dir().join(format!("acorn-bindlink-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("codex.id");
        let sentinel = dir.join("sentinel");
        let sentinel_body = "019e2001-bbbb-76b0-8410-2e073b38a2c2\n";
        fs::write(&sentinel, sentinel_body).unwrap();

        symlink(&sentinel, &marker).unwrap();
        assert!(bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
        )
        .is_err());
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), sentinel_body);

        fs::remove_file(&marker).unwrap();
        fs::hard_link(&sentinel, &marker).unwrap();
        bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), sentinel_body);
        assert_eq!(
            read_marker(&marker).as_deref(),
            Some("019e2001-aaaa-76b0-8410-2e073b38a2c1")
        );

        let outside_state = dir.join("outside-state");
        let linked_state = dir.join("linked-state");
        fs::create_dir(&outside_state).unwrap();
        fs::write(
            outside_state.join("codex.id"),
            "019e2001-aaaa-76b0-8410-2e073b38a2c1\n",
        )
        .unwrap();
        symlink(&outside_state, &linked_state).unwrap();
        assert!(bind_marker_in_state_dir(
            &linked_state,
            AgentKind::Codex,
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(outside_state.join("codex.id")).unwrap(),
            "019e2001-aaaa-76b0-8410-2e073b38a2c1\n"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn provider_declared_bind_replaces_existing_claude_and_codex_markers() {
        let dir = std::env::temp_dir().join(format!(
            "acorn-provider-bind-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let previous = "019f2001-bbbb-76b0-8410-2e073b38a2c2";
        let resumed = "019e2001-aaaa-76b0-8410-2e073b38a2c1";

        assert!(marker_update_is_blocked(
            MarkerBindPolicy::Inferred,
            Some(previous),
            resumed,
            false,
            |_, _| Ok(true),
        )
        .unwrap());
        assert!(!marker_update_is_blocked(
            MarkerBindPolicy::ProviderDeclared,
            Some(previous),
            resumed,
            true,
            |_, _| Ok(true),
        )
        .unwrap());

        for kind in [AgentKind::Claude, AgentKind::Codex] {
            let marker = dir.join(id_filename(kind));
            fs::write(&marker, format!("{previous}\n")).unwrap();
            bind_provider_marker_in_state_dir(&dir, kind, resumed).unwrap();
            bind_marker_in_state_dir(&dir, kind, previous).unwrap();
            assert_eq!(read_marker(&marker).as_deref(), Some(resumed));
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn inferred_marker_gate_propagates_transcript_lookup_errors() {
        let result = marker_update_is_blocked(
            MarkerBindPolicy::Inferred,
            Some("019f2001-bbbb-76b0-8410-2e073b38a2c2"),
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
            false,
            |_, _| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "unreadable",
                ))
            },
        );

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }

    /// Two writers race the same marker (background tick vs status-poll
    /// fallback). The bind lock must serialize them: every call succeeds
    /// and the surviving value is one of the written uuids, never a torn
    /// or empty file.
    #[test]
    fn concurrent_binds_serialize_cleanly() {
        let dir =
            std::env::temp_dir().join(format!("acorn-bindrace-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();

        let a = "019e2001-aaaa-76b0-8410-2e073b38a2c1";
        let b = "019e2001-bbbb-76b0-8410-2e073b38a2c2";
        let handles: Vec<_> = [a, b, a, b]
            .into_iter()
            .map(|uuid| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        bind_marker_in_state_dir(&dir, AgentKind::Codex, uuid).unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let survivor = read_marker(&dir.join("codex.id"));
        assert!(
            survivor.as_deref() == Some(a) || survivor.as_deref() == Some(b),
            "marker must hold one intact uuid, got {survivor:?}"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Forward birth-order moves always pass; a backwards move passes
    /// only while the older transcript is being actively written (a real
    /// `--resume`), and is skipped once it has gone dormant (the
    /// post-`/new` echo that would oscillate the marker).
    #[test]
    fn rollback_gate_distinguishes_echo_from_resume() {
        let dir =
            std::env::temp_dir().join(format!("acorn-rollback-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let older = dir.join("older.jsonl");
        fs::File::create(&older).unwrap();
        // Distinct birth seconds (btime rounds to seconds on macOS).
        std::thread::sleep(Duration::from_millis(1100));
        let newer = dir.join("newer.jsonl");
        fs::File::create(&newer).unwrap();
        let now = fs::metadata(&newer).unwrap().modified().unwrap();

        // Forward move (older → newer): never an echo.
        assert!(!rollback_is_dormant_echo(&older, &newer, now).unwrap());

        // Backwards move onto a dormant older transcript: echo → skip.
        set_mtime(
            &older,
            now - Duration::from_secs(acorn_transcript::DORMANT_TRANSCRIPT_SECS + 60),
        );
        assert!(rollback_is_dormant_echo(&newer, &older, now).unwrap());

        // Backwards move onto a hot older transcript: a real resume.
        set_mtime(&older, now);
        assert!(!rollback_is_dormant_echo(&newer, &older, now).unwrap());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rollback_gate_reports_transcript_access_errors() {
        use std::os::unix::fs::PermissionsExt;

        let dir =
            std::env::temp_dir().join(format!("acorn-rollback-access-{}", Uuid::new_v4().simple()));
        let locked = dir.join("locked");
        fs::create_dir_all(&locked).unwrap();
        let previous = locked.join("previous.jsonl");
        let next = dir.join("next.jsonl");
        fs::write(&previous, "{}\n").unwrap();
        fs::write(&next, "{}\n").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let permission_bits_enforced = fs::metadata(&previous).is_err();
        let result = rollback_is_dormant_echo(&previous, &next, SystemTime::now());
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        if permission_bits_enforced {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        }
    }

    #[test]
    fn codex_declared_parent_bypasses_dormant_echo_gate() {
        let dir = std::env::temp_dir().join(format!(
            "acorn-subagent-rollback-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        let parent_id = "019e2001-3250-76b0-8410-2e073b38a2f1";
        let child_id = "019e2001-3250-76b0-8410-2e073b38a2f2";
        let parent = dir.join("parent.jsonl");
        fs::write(
            &parent,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{parent_id}\",\"source\":\"cli\"}}}}\n"
            ),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1100));
        let child = dir.join("child.jsonl");
        fs::write(
            &child,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{child_id}\",\"source\":{{\"subagent\":{{\"thread_spawn\":{{\"parent_thread_id\":\"{parent_id}\",\"depth\":1}}}}}}}}}}\n"
            ),
        )
        .unwrap();
        let now = fs::metadata(&child).unwrap().modified().unwrap();
        set_mtime(
            &parent,
            now - Duration::from_secs(acorn_transcript::DORMANT_TRANSCRIPT_SECS + 60),
        );

        assert!(
            rollback_is_dormant_echo(&child, &parent, now).unwrap(),
            "generic rollback detection sees a dormant backwards move"
        );
        assert!(
            !rollback_is_dormant_echo_for_kind(AgentKind::Codex, &child, &parent, parent_id, now,)
                .unwrap(),
            "a child marker must be allowed to self-heal to its declared parent"
        );
        assert!(
            rollback_is_dormant_echo_for_kind(AgentKind::Claude, &child, &parent, parent_id, now,)
                .unwrap(),
            "the Codex ownership repair must not weaken other providers' rollback guard"
        );

        let grandchild = dir.join("grandchild.jsonl");
        fs::write(
            &grandchild,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"source\":{{\"subagent\":{{\"thread_spawn\":{{\"parent_thread_id\":\"{child_id}\",\"depth\":2}}}}}}}}}}\n"
            ),
        )
        .unwrap();
        assert!(
            codex_rollout_declares_ancestor(&grandchild, parent_id, |thread_id| {
                Ok((thread_id == child_id).then(|| child.clone()))
            })
            .unwrap(),
            "a marker corrupted to a deeper descendant must self-heal to the top-level owner"
        );
        assert!(
            !codex_rollout_declares_ancestor(&grandchild, parent_id, |_| Ok(None)).unwrap(),
            "a missing intermediate rollout must fail closed"
        );

        let cycle_a_id = "019e2001-3250-76b0-8410-2e073b38a2f3";
        let cycle_b_id = "019e2001-3250-76b0-8410-2e073b38a2f4";
        let cycle_a = dir.join("cycle-a.jsonl");
        let cycle_b = dir.join("cycle-b.jsonl");
        for (path, parent_thread_id) in [(&cycle_a, cycle_b_id), (&cycle_b, cycle_a_id)] {
            fs::write(
                path,
                format!(
                    "{{\"type\":\"session_meta\",\"payload\":{{\"source\":{{\"subagent\":{{\"thread_spawn\":{{\"parent_thread_id\":\"{parent_thread_id}\"}}}}}}}}}}\n"
                ),
            )
            .unwrap();
        }
        assert!(
            !codex_rollout_declares_ancestor(&cycle_a, parent_id, |thread_id| {
                Ok(match thread_id {
                    id if id == cycle_a_id => Some(cycle_a.clone()),
                    id if id == cycle_b_id => Some(cycle_b.clone()),
                    _ => None,
                })
            })
            .unwrap(),
            "a malformed ancestry cycle must fail closed"
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}
