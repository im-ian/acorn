//! Background poller that mirrors live agent transcript pairings into
//! per-session state files so the focus-time "이전 대화 이어하기" modal
//! can decide what to surface.
//!
//! The transcript watcher maps a running `claude` / `codex` / `antigravity`
//! process to its transcript via PTY descendant scan + cwd match + mtime
//! window. The modal needs the user-facing session owner rather than every
//! nested sub-agent: when the user focuses a session and the agent is *not*
//! currently running, what was the last top-level transcript that session had
//! been writing? This task keeps `<state_dir>/{claude,codex,antigravity}.id`
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
use std::time::{Duration, SystemTime};

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
    loop {
        std::thread::sleep(POLL_INTERVAL);
        if let Err(err) = tick(&state) {
            tracing::warn!(error = %err, "agent_resume_persister: tick failed");
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
    let mappings = transcript_watcher::collect_session_owner_mappings(&sessions);
    if mappings.is_empty() {
        return Ok(());
    }
    for (session_id, kind, uuid) in mappings {
        let state_dir = match agent_resume::ensure_session_state_dir(session_id) {
            Ok(p) => p,
            Err(err) => {
                tracing::warn!(
                    %session_id, error = %err,
                    "agent_resume_persister: failed to ensure state dir"
                );
                continue;
            }
        };
        if let Some(cwd_file) = cwd_filename(kind) {
            if let Some(cwd) = session_cwds.get(&session_id) {
                if let Err(err) =
                    write_if_changed(&state_dir.join(cwd_file), &format!("{}\n", cwd.display()))
                {
                    tracing::warn!(
                        %session_id, ?kind, error = %err,
                        "agent_resume_persister: cwd write failed"
                    );
                }
            }
        }
        if let Err(err) = bind_marker_in_state_dir(&state_dir, kind, &uuid) {
            tracing::warn!(
                %session_id, ?kind, %uuid, error = %err,
                "agent_resume_persister: write failed"
            );
        }
    }
    Ok(())
}

/// Bind `uuid` as `session_id`'s durable resume marker for `kind`, under
/// the same guards the background tick applies. Exposed so out-of-band
/// binders (the status poll's codex fallback) share one write policy
/// instead of growing a second, subtly different marker writer.
///
/// Writer hierarchy: the background tick stays authoritative — its
/// PTY-tree scan disambiguates multi-process cwds the fallback abstains
/// from — and a fallback write it disagrees with is corrected on the next
/// tick (forward moves pass, the dormant-echo gate blocks bad rollbacks).
pub fn bind_session_marker(session_id: uuid::Uuid, kind: AgentKind, uuid: &str) -> io::Result<()> {
    let state_dir = agent_resume::ensure_session_state_dir(session_id)?;
    bind_marker_in_state_dir(&state_dir, kind, uuid)
}

/// Serializes marker writes across the background tick and the status
/// poll's fallback. The read-check-write below is not atomic on its own;
/// two threads interleaving could skip the dormant-echo arbitration and
/// flap the marker.
fn marker_bind_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn bind_marker_in_state_dir(state_dir: &Path, kind: AgentKind, uuid: &str) -> io::Result<()> {
    let _guard = marker_bind_lock()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let id_file = state_dir.join(id_filename(kind));
    let previous = read_trimmed(&id_file);
    if previous.as_deref() == Some(uuid) {
        return Ok(());
    }
    // A backwards move (to an earlier-born transcript) is legitimate
    // when the user `--resume`d an old conversation — that transcript
    // is hot again. But right after an in-session `/new` rotation the
    // scan can echo the abandoned original once the new transcript
    // goes idle; writing that echo would oscillate the marker. Skip
    // only the dormant-echo case so the marker never flaps.
    if let Some(prev) = previous.as_deref() {
        if marker_rollback_is_dormant_echo(kind, prev, uuid) {
            return Ok(());
        }
    }
    write_if_changed(&id_file, &format!("{uuid}\n"))
}

fn id_filename(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude.id",
        AgentKind::Codex => "codex.id",
        AgentKind::Antigravity => "antigravity.id",
    }
}

fn cwd_filename(kind: AgentKind) -> Option<&'static str> {
    match kind {
        AgentKind::Antigravity => Some("antigravity.cwd"),
        AgentKind::Claude | AgentKind::Codex => None,
    }
}

/// True when replacing `prev_uuid` with `next_uuid` would move the marker
/// to an *earlier-born* transcript that is no longer being written. That
/// combination is the post-`/new` echo: once the new conversation idles,
/// the birth-anchored scan returns the abandoned original again, and
/// writing it would oscillate the marker old → new → old. A real
/// `claude --resume` of an older conversation also moves backwards, but
/// its transcript is being appended right now (hot), so it passes.
fn marker_rollback_is_dormant_echo(kind: AgentKind, prev_uuid: &str, next_uuid: &str) -> bool {
    let Some(prev_path) = agent_resume::locate_transcript(kind, prev_uuid) else {
        return false;
    };
    let Some(next_path) = agent_resume::locate_transcript(kind, next_uuid) else {
        return false;
    };
    rollback_is_dormant_echo_for_kind(kind, &prev_path, &next_path, next_uuid, SystemTime::now())
}

fn rollback_is_dormant_echo_for_kind(
    kind: AgentKind,
    prev: &Path,
    next: &Path,
    next_uuid: &str,
    now: SystemTime,
) -> bool {
    let dormant_echo = rollback_is_dormant_echo(prev, next, now);
    if !dormant_echo {
        return false;
    }
    // A Codex marker can point to a child rollout. If that child names the
    // newly resolved transcript in its bounded parent chain, allow the owner
    // scan to repair the marker even though the owner is older and dormant.
    // Other backwards moves retain the oscillation guard.
    if kind == AgentKind::Codex
        && codex_rollout_declares_ancestor(prev, next_uuid, |thread_id| {
            agent_resume::locate_transcript(AgentKind::Codex, thread_id)
        })
    {
        return false;
    }
    true
}

fn codex_rollout_declares_ancestor<F>(rollout: &Path, ancestor_uuid: &str, mut locate: F) -> bool
where
    F: FnMut(&str) -> Option<PathBuf>,
{
    const MAX_ANCESTOR_DEPTH: usize = 16;

    let mut current = rollout.to_path_buf();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..MAX_ANCESTOR_DEPTH {
        let Some(parent_uuid) = acorn_transcript::codex_rollout_parent_thread_id(&current) else {
            return false;
        };
        if !seen.insert(parent_uuid.clone()) {
            return false;
        }
        if parent_uuid == ancestor_uuid {
            return true;
        }
        let Some(parent_path) = locate(&parent_uuid) else {
            return false;
        };
        current = parent_path;
    }
    false
}

fn rollback_is_dormant_echo(prev: &Path, next: &Path, now: SystemTime) -> bool {
    let (Ok(prev_meta), Ok(next_meta)) = (fs::metadata(prev), fs::metadata(next)) else {
        return false;
    };
    let (Ok(prev_mtime), Ok(next_mtime)) = (prev_meta.modified(), next_meta.modified()) else {
        return false;
    };
    let prev_birth = prev_meta.created().unwrap_or(prev_mtime);
    let next_birth = next_meta.created().unwrap_or(next_mtime);
    if next_birth >= prev_birth {
        // Moving forward in birth order — always allowed.
        return false;
    }
    // Backwards move: a dormant target is the echo; a hot one is a
    // genuine resume of the older conversation.
    now.duration_since(next_mtime)
        .map(|d| d.as_secs() > acorn_transcript::DORMANT_TRANSCRIPT_SECS)
        .unwrap_or(false)
}

fn write_if_changed(path: &PathBuf, content: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    fs::write(path, content)
}

fn read_trimmed(path: &PathBuf) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
            read_trimmed(&marker).as_deref(),
            Some("019e2001-aaaa-76b0-8410-2e073b38a2c1"),
            "first bind must create the marker"
        );

        let mtime_before = fs::metadata(&marker).unwrap().modified().unwrap();
        bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-aaaa-76b0-8410-2e073b38a2c1",
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&marker).unwrap().modified().unwrap(),
            mtime_before,
            "same-uuid rebind must not rewrite the marker"
        );

        bind_marker_in_state_dir(
            &dir,
            AgentKind::Codex,
            "019e2001-bbbb-76b0-8410-2e073b38a2c2",
        )
        .unwrap();
        assert_eq!(
            read_trimmed(&marker).as_deref(),
            Some("019e2001-bbbb-76b0-8410-2e073b38a2c2"),
            "a new uuid must replace the marker"
        );

        fs::remove_dir_all(&dir).unwrap();
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

        let survivor = read_trimmed(&dir.join("codex.id"));
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
        assert!(!rollback_is_dormant_echo(&older, &newer, now));

        // Backwards move onto a dormant older transcript: echo → skip.
        set_mtime(
            &older,
            now - Duration::from_secs(acorn_transcript::DORMANT_TRANSCRIPT_SECS + 60),
        );
        assert!(rollback_is_dormant_echo(&newer, &older, now));

        // Backwards move onto a hot older transcript: a real resume.
        set_mtime(&older, now);
        assert!(!rollback_is_dormant_echo(&newer, &older, now));

        fs::remove_dir_all(&dir).unwrap();
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
            rollback_is_dormant_echo(&child, &parent, now),
            "generic rollback detection sees a dormant backwards move"
        );
        assert!(
            !rollback_is_dormant_echo_for_kind(AgentKind::Codex, &child, &parent, parent_id, now,),
            "a child marker must be allowed to self-heal to its declared parent"
        );
        assert!(
            rollback_is_dormant_echo_for_kind(AgentKind::Claude, &child, &parent, parent_id, now,),
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
                (thread_id == child_id).then(|| child.clone())
            }),
            "a marker corrupted to a deeper descendant must self-heal to the top-level owner"
        );
        assert!(
            !codex_rollout_declares_ancestor(&grandchild, parent_id, |_| None),
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
            !codex_rollout_declares_ancestor(&cycle_a, parent_id, |thread_id| match thread_id {
                id if id == cycle_a_id => Some(cycle_a.clone()),
                id if id == cycle_b_id => Some(cycle_b.clone()),
                _ => None,
            }),
            "a malformed ancestry cycle must fail closed"
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}
