//! Tauri commands that surface the `acornd` daemon to the frontend.
//!
//! Naming policy: every command in this module is prefixed `daemon_` so
//! the frontend can grep for the entire daemon surface in `api.ts`
//! without ambiguity against the legacy in-process commands in
//! `commands.rs`. The legacy commands stay live alongside this surface;
//! `commands::pty_spawn` is the seam where a future change will route
//! to the daemon when the user has the killswitch on. Frontend call
//! sites do not have to know which side served them.

use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Runtime, State};
use uuid::Uuid;

use crate::daemon_bridge::{BridgeError, DaemonBridge};
use crate::state::AppState;
use acorn_daemon::protocol::{AgentKind, ErrorCode, StatusSnapshot};

/// JSON shape for `daemon_status` — what the StatusBar indicator and the
/// Settings → Background sessions panel render.
#[derive(Debug, Serialize)]
pub struct DaemonStatus {
    /// `true` if the daemon answered the probe within the timeout.
    pub running: bool,
    /// `true` while the user has the killswitch off; `false` => calls
    /// fall through to the legacy in-process PTY path.
    pub enabled: bool,
    pub daemon_version: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub session_count_total: Option<u32>,
    pub session_count_alive: Option<u32>,
    /// Absolute path to the daemon log file (for "open log" buttons in
    /// Settings). `None` when the data dir cannot be resolved; `last_error`
    /// carries the reason.
    pub log_path: Option<String>,
    /// Last error message, if the most recent operation failed. Reset
    /// to `None` on a successful subsequent call.
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn daemon_status(state: State<'_, AppState>) -> DaemonStatus {
    let enabled = state.daemon_bridge.is_enabled();
    let (log_path, log_path_error) = daemon_log_path(crate::daemon_bridge::data_dir_path());

    if !enabled {
        return DaemonStatus {
            running: false,
            enabled: false,
            daemon_version: None,
            uptime_seconds: None,
            session_count_total: None,
            session_count_alive: None,
            log_path,
            last_error: log_path_error,
        };
    }

    match state.daemon_bridge.status() {
        Ok(snap) => DaemonStatus {
            running: true,
            enabled: true,
            daemon_version: Some(snap.daemon_version),
            uptime_seconds: Some(snap.uptime_seconds),
            session_count_total: Some(snap.session_count_total),
            session_count_alive: Some(snap.session_count_alive),
            log_path,
            last_error: log_path_error,
        },
        Err(BridgeError::Disabled) => DaemonStatus {
            running: false,
            enabled: false,
            daemon_version: None,
            uptime_seconds: None,
            session_count_total: None,
            session_count_alive: None,
            log_path,
            last_error: log_path_error,
        },
        Err(err) => DaemonStatus {
            running: false,
            enabled: true,
            daemon_version: None,
            uptime_seconds: None,
            session_count_total: None,
            session_count_alive: None,
            log_path,
            last_error: combine_status_errors(Some(err.to_string()), log_path_error),
        },
    }
}

fn daemon_log_path(data_dir: io::Result<PathBuf>) -> (Option<String>, Option<String>) {
    match data_dir {
        Ok(path) => (Some(path.join("daemon.log").display().to_string()), None),
        Err(err) => (
            None,
            Some(format!("failed to resolve daemon log path: {err}")),
        ),
    }
}

fn combine_status_errors(primary: Option<String>, secondary: Option<String>) -> Option<String> {
    match (primary, secondary) {
        (Some(primary), Some(secondary)) => Some(format!("{primary}; {secondary}")),
        (Some(error), None) | (None, Some(error)) => Some(error),
        (None, None) => None,
    }
}

/// JSON shape for the daemon-update prompt. Present while the running
/// `acornd` was built by a different app version but still owns live
/// PTYs — the bridge's `PreserveActive` policy keeps that generation
/// serving every RPC (new spawns included), so daemon-side fixes such
/// as PTY spawn env never reach new sessions until it is replaced.
#[derive(Debug, Clone, Serialize)]
pub struct DaemonVersionMismatch {
    pub daemon_version: String,
    pub app_version: String,
    pub alive_session_count: u32,
}

pub const EVENT_DAEMON_VERSION_MISMATCH: &str = "acorn:daemon-version-mismatch";

/// Decision kernel for [`reconcile_daemon_version`]. `None` when the
/// daemon matches this build, or when it is idle — an idle outdated
/// daemon is replaced silently by the bridge (`RestartIdle`), so only
/// a live-PTY holdout warrants prompting the user.
fn daemon_version_mismatch_from(
    snapshot: &StatusSnapshot,
    app_version: &str,
) -> Option<DaemonVersionMismatch> {
    if snapshot.daemon_version == app_version || snapshot.session_count_alive == 0 {
        return None;
    }
    Some(DaemonVersionMismatch {
        daemon_version: snapshot.daemon_version.clone(),
        app_version: app_version.to_string(),
        alive_session_count: snapshot.session_count_alive,
    })
}

/// Boot-time daemon-version reconcile, run on the daemon boot thread
/// after `ensure_connection`. Mirrors `staged_rev_reconcile`: cache the
/// verdict on `AppState` (pulled at mount, defeats the
/// listener-mount-after-emit race) and emit for already-mounted
/// listeners. Both branches overwrite the cache so a re-reconcile that
/// finds the daemon current retracts an earlier prompt.
pub fn reconcile_daemon_version<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    bridge: &DaemonBridge,
) {
    if !bridge.is_enabled() {
        *state.daemon_version_mismatch.lock() = None;
        return;
    }
    let snapshot = match bridge.status() {
        Ok(snapshot) => snapshot,
        Err(err) => {
            tracing::warn!(error = %err, "daemon-version reconcile: status probe failed");
            return;
        }
    };
    let mismatch = daemon_version_mismatch_from(&snapshot, env!("CARGO_PKG_VERSION"));
    *state.daemon_version_mismatch.lock() = mismatch.clone();
    let Some(payload) = mismatch else { return };
    match app.emit(EVENT_DAEMON_VERSION_MISMATCH, payload.clone()) {
        Ok(()) => tracing::info!(
            daemon_version = %payload.daemon_version,
            app_version = %payload.app_version,
            alive_sessions = payload.alive_session_count,
            "outdated daemon holds live PTYs; user prompted to update",
        ),
        Err(err) => tracing::warn!(error = %err, "daemon-version reconcile: emit failed"),
    }
}

/// Returns the cached boot-time daemon-version reconcile result. The
/// frontend pulls this at mount so the prompt survives a
/// listener-mount-after-emit race.
#[tauri::command]
pub fn daemon_version_mismatch_status(state: State<'_, AppState>) -> Option<DaemonVersionMismatch> {
    state.daemon_version_mismatch.lock().clone()
}

/// Clear the cached daemon-version mismatch so the prompt does not
/// re-show after the user dismisses it or completes the update flow.
/// Idempotent.
#[tauri::command]
pub fn acknowledge_daemon_version_mismatch(state: State<'_, AppState>) {
    *state.daemon_version_mismatch.lock() = None;
}

/// Toggle the default path for new sessions. Persistence (so the toggle
/// survives a restart) happens on the frontend in `localStorage` under
/// `acorn:daemon-enabled`; existing daemon-bound sessions remain sticky.
#[tauri::command]
pub fn daemon_set_enabled(enabled: bool, state: State<'_, AppState>) {
    state.daemon_bridge.set_enabled(enabled);
}

/// Fully restart the daemon: shut a running one down (killing its
/// PTYs), wait for it to release the endpoint, and spawn a fresh
/// daemon from this build. Backs the Settings "Restart daemon" button.
/// Destructive — the UI confirmation is the caller's responsibility.
#[tauri::command]
pub fn daemon_restart(state: State<'_, AppState>) -> Result<(), String> {
    state.daemon_bridge.restart().map_err(|e| e.to_string())
}

/// Ask the daemon to shut down (graceful). All PTYs die; the daemon
/// process exits. Destructive — the UI confirmation is the caller's
/// responsibility.
#[tauri::command]
pub fn daemon_shutdown(state: State<'_, AppState>) -> Result<(), String> {
    state.daemon_bridge.shutdown().map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
pub struct DaemonSessionSummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub alive: bool,
    pub cwd: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub agent_kind: Option<String>,
}

#[tauri::command]
pub fn daemon_list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<DaemonSessionSummary>, String> {
    let sessions = state
        .daemon_bridge
        .list_sessions()
        .map_err(|e| e.to_string())?;
    Ok(sessions
        .into_iter()
        .filter(|s| s.alive)
        .map(|s| DaemonSessionSummary {
            id: s.id.to_string(),
            name: s.name,
            kind: "regular".into(),
            alive: s.alive,
            cwd: s.cwd.map(|p| p.display().to_string()),
            repo_path: s.repo_path.map(|p| p.display().to_string()),
            branch: s.branch,
            agent_kind: s.agent_kind.map(agent_kind_to_str),
        })
        .collect())
}

#[tauri::command]
pub fn daemon_kill_session(
    target_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;
    state.daemon_bridge.kill(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn daemon_forget_session(
    target_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;
    state.daemon_bridge.forget(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn daemon_forget_inactive_sessions(state: State<'_, AppState>) -> Result<usize, String> {
    let inactive_ids: Vec<Uuid> = state
        .daemon_bridge
        .list_sessions()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| !s.alive)
        .map(|s| s.id)
        .collect();

    let mut forgotten = 0;
    for id in inactive_ids {
        match state.daemon_bridge.forget(id) {
            Ok(()) => forgotten += 1,
            Err(BridgeError::Daemon {
                code: ErrorCode::NotFound,
                ..
            }) => {}
            Err(err) => return Err(err.to_string()),
        }
    }

    Ok(forgotten)
}

/// Reconstruct an app-side `Session` row from a daemon-owned PTY the app
/// has lost track of (typical cause: user deleted the session row while
/// the daemon kept the PTY). Idempotent — if the app already has a row
/// for this id, returns it untouched.
///
/// Pulls metadata (name, kind, repo_path, cwd, branch) straight from the
/// daemon's `SessionSummary`. The daemon must still know this id; pass
/// `force` semantics through by always querying `list_sessions` first.
#[tauri::command]
pub fn daemon_adopt_session(
    target_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;

    if state.sessions.get(&id).is_ok() {
        return Ok(());
    }

    let summary = state
        .daemon_bridge
        .list_sessions()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("daemon does not know session {id}"))?;
    if !summary.alive {
        return Err(format!("daemon session {id} is not alive"));
    }

    let reported_repo_path = summary
        .repo_path
        .clone()
        .ok_or_else(|| "daemon session has no repo_path — cannot adopt".to_string())?;
    let reported_cwd = summary.cwd.as_deref().unwrap_or(&reported_repo_path);
    let (repo_path, worktree_path) =
        validate_daemon_adoption_paths(state.inner(), &reported_repo_path, reported_cwd)?;
    // Branch is informational — leave empty when the daemon never knew
    // it. Synthesizing "main" would silently lie for repos on master /
    // trunk / detached HEAD; UI tolerates the empty string.
    let name = crate::commands::validate_display_name(&summary.name, "daemon session name")
        .map_err(|error| error.to_string())?;
    let branch = summary.branch.clone().unwrap_or_default();

    let kind = acorn_session::SessionKind::Regular;

    let now = chrono::Utc::now();
    let session = acorn_session::Session {
        id,
        name,
        repo_path: repo_path.clone(),
        worktree_path,
        branch,
        isolated: false,
        project_scoped: true,
        status: acorn_session::SessionStatus::Ready,
        created_at: now,
        updated_at: now,
        archived_at: None,
        last_message: None,
        title_source: acorn_session::SessionTitleSource::Manual,
        auto_title_enabled: Some(false),
        generated_title_transcript_id: None,
        kind,
        mode: acorn_session::SessionMode::Terminal,
        goal: None,
        graph: None,
        owner: acorn_session::SessionOwner::User,
        position: None,
        daemon_session_id: Some(id),
        agent_resume_token: Some(id.to_string()),
        hook_active: false,
        hook_provider: None,
        in_worktree: false,
        agent_provider: None,
        agent_transcript_id: None,
    };
    state.sessions.insert(session);

    if let Err(e) = crate::persistence::save_sessions(&state.sessions) {
        tracing::warn!("failed to persist sessions after adopt: {e}");
    }
    if let Err(e) = crate::persistence::save_projects(&state.projects.list()) {
        tracing::warn!("failed to persist projects after adopt: {e}");
    }
    Ok(())
}

fn validate_daemon_adoption_paths(
    state: &AppState,
    reported_repo_path: &Path,
    reported_cwd: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let repo_path = crate::commands::authorize_registered_project_root(state, reported_repo_path)
        .map_err(|error| format!("invalid daemon repo_path: {error}"))?;
    if !repo_path.is_dir() {
        return Err(format!(
            "daemon repo_path is not a directory: {}",
            repo_path.display()
        ));
    }

    if !reported_cwd.is_absolute() {
        return Err("daemon cwd must be absolute".to_string());
    }
    let worktree_path = reported_cwd
        .canonicalize()
        .map_err(|error| format!("invalid daemon cwd '{}': {error}", reported_cwd.display()))?;
    if !worktree_path.is_dir() {
        return Err(format!(
            "daemon cwd is not a directory: {}",
            worktree_path.display()
        ));
    }
    crate::commands::authorize_project_session_cwd(&repo_path, &worktree_path)
        .map_err(|error| format!("invalid daemon cwd: {error}"))?;

    Ok((repo_path, worktree_path))
}

fn agent_kind_to_str(k: AgentKind) -> String {
    match k {
        AgentKind::ClaudeCode => "claude-code".into(),
        AgentKind::Aider => "aider".into(),
        AgentKind::Llm => "llm".into(),
        AgentKind::OpenInterpreter => "open-interpreter".into(),
        AgentKind::Codex => "codex".into(),
        AgentKind::Antigravity => "antigravity".into(),
        AgentKind::Grok => "grok".into(),
        AgentKind::Unknown => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[test]
    fn daemon_adoption_requires_registered_project_and_scoped_cwd() {
        let state = AppState::new();
        let registered = tempfile::tempdir().expect("registered project");
        let nested = registered.path().join("nested");
        std::fs::create_dir(&nested).expect("nested cwd");
        let outside = tempfile::tempdir().expect("outside cwd");
        state.projects.ensure(
            registered.path().canonicalize().unwrap(),
            "registered".to_string(),
        );

        let (repo, cwd) = validate_daemon_adoption_paths(&state, registered.path(), &nested)
            .expect("registered nested cwd should be accepted");
        assert_eq!(repo, registered.path().canonicalize().unwrap());
        assert_eq!(cwd, nested.canonicalize().unwrap());

        assert!(
            validate_daemon_adoption_paths(&state, registered.path(), outside.path(),).is_err()
        );
        assert!(validate_daemon_adoption_paths(
            &AppState::new(),
            registered.path(),
            registered.path(),
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn daemon_adoption_rejects_cwd_symlink_escape() {
        use std::os::unix::fs::symlink;

        let state = AppState::new();
        let registered = tempfile::tempdir().expect("registered project");
        let outside = tempfile::tempdir().expect("outside cwd");
        let linked = registered.path().join("linked-outside");
        symlink(outside.path(), &linked).expect("cwd symlink");
        state.projects.ensure(
            registered.path().canonicalize().unwrap(),
            "registered".to_string(),
        );

        assert!(validate_daemon_adoption_paths(&state, registered.path(), &linked).is_err());
    }

    #[test]
    fn daemon_log_path_preserves_access_errors() {
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "permission denied");

        let (path, last_error) = daemon_log_path(Err(error));

        assert_eq!(path, None);
        assert_eq!(
            last_error.as_deref(),
            Some("failed to resolve daemon log path: permission denied")
        );
    }

    #[test]
    fn daemon_status_preserves_bridge_and_log_path_errors() {
        assert_eq!(
            combine_status_errors(
                Some("daemon connection failed".into()),
                Some("failed to resolve daemon log path: permission denied".into()),
            )
            .as_deref(),
            Some("daemon connection failed; failed to resolve daemon log path: permission denied")
        );
    }

    fn status_snapshot(daemon_version: &str, alive: u32) -> StatusSnapshot {
        StatusSnapshot {
            daemon_version: daemon_version.to_string(),
            uptime_seconds: 1,
            session_count_total: alive,
            session_count_alive: alive,
            pid: None,
            rss_bytes: None,
        }
    }

    #[test]
    fn version_mismatch_reported_only_for_live_outdated_daemon() {
        let mismatch = daemon_version_mismatch_from(
            &status_snapshot("1.39.1-preview.20260929005847", 10),
            "1.40.0",
        )
        .expect("outdated daemon with live PTYs must prompt");
        assert_eq!(mismatch.daemon_version, "1.39.1-preview.20260929005847");
        assert_eq!(mismatch.app_version, "1.40.0");
        assert_eq!(mismatch.alive_session_count, 10);
    }

    #[test]
    fn version_mismatch_silent_when_versions_match() {
        assert!(daemon_version_mismatch_from(&status_snapshot("1.40.0", 10), "1.40.0").is_none());
    }

    #[test]
    fn version_mismatch_silent_when_daemon_idle() {
        // RestartIdle already replaces an idle outdated daemon without
        // user involvement — prompting would be noise.
        assert!(daemon_version_mismatch_from(&status_snapshot("1.39.0", 0), "1.40.0").is_none());
    }
}
