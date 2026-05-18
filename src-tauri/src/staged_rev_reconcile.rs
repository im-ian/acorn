//! Boot-time staged-dotfile reconcile.
//!
//! `acornd` outlives the Acorn app, so a pulled-in update with a new
//! `shell-init/` body leaves the daemon attached to PTYs running
//! against the previous `.zshrc`. The user types into a ZLE that
//! disagrees with the on-disk dotfile — surfaces as duplicated
//! keystrokes / broken prompt redraws.
//!
//! Compare each alive daemon session's `staged_rev` against the
//! build's [`shell_init::STAGED_REV`](crate::shell_init::STAGED_REV);
//! any mismatch (including legacy `staged_rev == None` from
//! pre-fingerprint builds) emits `acorn:staged-rev-mismatch` and
//! caches the result on `AppState` so the frontend prompt can pull
//! it at mount.

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
/// `STAGED_REV`. Store the result on `state` (pulled at mount via
/// `commands::staged_rev_mismatch_status` — defeats the listener
/// race) and emit [`EVENT_STAGED_REV_MISMATCH`] for already-mounted
/// listeners. Both branches overwrite the cache, so a re-reconcile
/// that finds nothing stale correctly retracts an earlier prompt.
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
