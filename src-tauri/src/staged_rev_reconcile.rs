//! Boot-time staged-dotfile reconcile.
//!
//! `acornd` may still own PTY sessions spawned by an older Acorn build
//! whose staged zsh dotfiles were different. Reattaching to those PTYs
//! leaves the user typing into a ZLE wired up against the old `.zshrc`
//! while the new body is materialised on disk — surfaces as duplicated
//! keystrokes / broken prompt redraws.
//!
//! Compare each alive daemon session's `staged_rev` against the
//! current [`shell_init::STAGED_REV`](crate::shell_init::STAGED_REV).
//! Any mismatch emits an `acorn:staged-rev-mismatch` event the
//! frontend prompts on; the user-confirmed restart path is
//! `daemon_restart` (which respawns every session against the new
//! dotfiles).
//!
//! Sessions with `staged_rev == None` are also treated as stale —
//! they were spawned by a build that pre-dates the fingerprint and
//! therefore can't be proven up-to-date.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::daemon_bridge::DaemonBridge;
use crate::state::AppState;

pub const EVENT_STAGED_REV_MISMATCH: &str = "acorn:staged-rev-mismatch";

#[derive(Debug, Clone, Serialize)]
pub struct StagedRevMismatch {
    pub current_rev: String,
    pub stale_session_count: usize,
}

/// Compare the daemon's session staged-revs against the build's
/// `STAGED_REV`. On mismatch, both store the result in `state` (so
/// the frontend can pull it via `commands::staged_rev_mismatch_status`
/// at mount — defeating the listener-mount race) and emit
/// [`EVENT_STAGED_REV_MISMATCH`] for already-mounted listeners.
///
/// Always overwrites `state.staged_rev_mismatch` — clearing it back
/// to `None` when reconcile finds nothing stale, so a `daemon_restart`
/// followed by a re-reconcile correctly retracts an earlier prompt.
pub fn reconcile<R: Runtime>(app: &AppHandle<R>, state: &AppState, bridge: &DaemonBridge) {
    if !bridge.is_enabled() {
        *state.staged_rev_mismatch.lock() = None;
        return;
    }
    let sessions = match bridge.list_sessions() {
        Ok(s) => s,
        Err(err) => {
            tracing::warn!(error = %err, "staged-rev reconcile: list_sessions failed");
            return;
        }
    };
    let current = crate::shell_init::STAGED_REV;
    let stale = sessions
        .iter()
        .filter(|s| s.alive)
        .filter(|s| s.staged_rev.as_deref() != Some(current))
        .count();
    if stale == 0 {
        *state.staged_rev_mismatch.lock() = None;
        return;
    }
    let payload = StagedRevMismatch {
        current_rev: current.to_string(),
        stale_session_count: stale,
    };
    *state.staged_rev_mismatch.lock() = Some(payload.clone());
    match app.emit(EVENT_STAGED_REV_MISMATCH, payload) {
        Ok(()) => tracing::info!(
            stale_count = stale,
            current_rev = current,
            "staged-rev mismatch detected; user prompted to restart daemon",
        ),
        Err(err) => tracing::warn!(error = %err, "staged-rev reconcile: emit failed"),
    }
}
