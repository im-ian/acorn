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
use std::path::PathBuf;
use std::time::Duration;

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
        if read_trimmed(&id_file).as_deref() == Some(uuid.as_str()) {
            continue;
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

fn write_if_changed(path: &PathBuf, content: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    fs::write(path, content)
}

fn read_trimmed(path: &PathBuf) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}
