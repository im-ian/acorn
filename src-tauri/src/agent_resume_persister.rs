//! Background poller that mirrors live agent transcript pairings into
//! per-session state files so the focus-time "이전 대화 이어하기" modal
//! can decide what to surface.
//!
//! The on-demand pairing logic in `transcript_watcher::collect_live_mappings`
//! is already what the Fork menu uses to map a running `claude` / `codex`
//! process to its JSONL transcript via PTY descendant scan + cwd match +
//! mtime window. The modal needs the same answer but from a different
//! direction: when the user focuses a session and the agent is *not*
//! currently running, what was the last transcript that session had been
//! writing? This task keeps `<state_dir>/claude.id` and `<state_dir>/codex.id`
//! up to date so the modal lookup is a single file read.
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
//! `claude.id.acknowledged` is deliberately *not* touched here. When a
//! session starts a new conversation, its UUID changes; the new value
//! lands in `claude.id` while the old ack stays put, so the modal pops
//! exactly once per fresh UUID per session.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::Duration;

use crate::agent_resume;
use crate::state::AppState;
use crate::transcript_watcher::{self, AgentKind};

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
    let mappings = transcript_watcher::collect_live_mappings(state);
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
        let id_file = state_dir.join(id_filename(kind));
        if read_trimmed(&id_file).as_deref() == Some(uuid.as_str()) {
            continue;
        }
        if let Err(err) = fs::write(&id_file, format!("{uuid}\n")) {
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
    }
}

fn read_trimmed(path: &PathBuf) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_string())
}
