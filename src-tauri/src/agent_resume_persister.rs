//! Background poller that mirrors live agent transcript pairings into
//! per-session state files so the focus-time "이전 대화 이어하기" modal
//! can decide what to surface.
//!
//! The on-demand pairing logic in `transcript_watcher::collect_live_mappings`
//! is already what the Fork menu uses to map a running `claude` / `codex`
//! process to its transcript via PTY descendant scan + cwd match +
//! mtime window. The modal needs the same answer but from a different
//! direction: when the user focuses a session and the agent is *not*
//! currently running, what was the last transcript that session had been
//! writing? This task keeps `<state_dir>/{claude,codex,antigravity}.id` up to
//! date so the modal lookup is a single file read.
//!
//! Why polling and not filesystem events: PTY-tree resolution is the
//! decisive disambiguator when two sessions are running the same agent
//! in the same cwd. A `notify`-driven path would still need the same scan
//! to attribute a new JSONL to an Acorn session, and the agent process
//! is alive for seconds-to-minutes — a 2 s poll is fast enough to capture
//! every fresh UUID before the user could plausibly focus away and back.
//! A second benefit: the persister shares its scan with the Fork menu's
//! `SCAN_CACHE_TTL_MS` cache, so neither pays the cost twice.
//!
//! `*.id.acknowledged` is deliberately *not* touched here. When a
//! session starts a new conversation, its UUID changes; the new value
//! lands in `*.id` while the old ack stays put, so the modal pops
//! exactly once per fresh UUID per session.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use acorn_transcript::{self as transcript_watcher, AgentKind, SessionPid};

use crate::agent_resume;
use crate::state::AppState;

/// Snapshot every Acorn session's PTY root pid for `acorn_transcript`'s
/// scanner. Daemon-managed sessions take priority — the stream registry
/// records the daemon-side pid as soon as the attachment lands — with
/// the in-process `PtyManager` as fallback for non-daemon sessions.
/// Lives here (and not in the transcript crate) because the AppState
/// surface is owned by the host crate.
pub fn collect_session_pids(state: &AppState) -> Vec<SessionPid> {
    state
        .sessions
        .list()
        .into_iter()
        .map(|s| SessionPid {
            session_id: s.id,
            root_pid: state
                .stream_registry
                .pid(&s.id)
                .or_else(|| state.pty.child_pid(&s.id)),
        })
        .collect()
}

/// Tick interval. Short enough to capture a UUID before the user could
/// reasonably switch sessions and back; long enough that the host-wide
/// process scan inside `collect_live_mappings` does not show up on any
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
    let sessions = session_rows
        .into_iter()
        .map(|s| SessionPid {
            session_id: s.id,
            root_pid: state
                .stream_registry
                .pid(&s.id)
                .or_else(|| state.pty.child_pid(&s.id)),
        })
        .collect::<Vec<_>>();
    let mappings = transcript_watcher::collect_live_mappings(&sessions);
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
        let id_file = state_dir.join(id_filename(kind));
        let previous = read_trimmed(&id_file);
        if previous.as_deref() == Some(uuid.as_str()) {
            continue;
        }
        // A backwards move (to an earlier-born transcript) is legitimate
        // when the user `--resume`d an old conversation — that transcript
        // is hot again. But right after an in-session `/new` rotation the
        // scan can echo the abandoned original once the new transcript
        // goes idle; writing that echo would oscillate the marker. Skip
        // only the dormant-echo case so the marker never flaps.
        if let Some(prev) = previous.as_deref() {
            if marker_rollback_is_dormant_echo(kind, prev, &uuid) {
                continue;
            }
        }
        if let Err(err) = write_if_changed(&id_file, &format!("{uuid}\n")) {
            tracing::warn!(
                %session_id, ?kind, %uuid, error = %err,
                "agent_resume_persister: write failed"
            );
        }
    }
    Ok(())
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
    let resume_kind = match kind {
        AgentKind::Claude => agent_resume::AgentKind::Claude,
        AgentKind::Codex => agent_resume::AgentKind::Codex,
        AgentKind::Antigravity => agent_resume::AgentKind::Antigravity,
    };
    let Some(prev_path) = agent_resume::locate_transcript(resume_kind, prev_uuid) else {
        return false;
    };
    let Some(next_path) = agent_resume::locate_transcript(resume_kind, next_uuid) else {
        return false;
    };
    rollback_is_dormant_echo(&prev_path, &next_path, SystemTime::now())
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

    fn set_mtime(path: &Path, t: SystemTime) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(t)).unwrap();
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
}
