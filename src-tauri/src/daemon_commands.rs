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
use tauri::State;
use uuid::Uuid;

use crate::daemon_bridge::BridgeError;
use crate::state::AppState;
use acorn_daemon::protocol::{AgentKind, ErrorCode, SessionKind};

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
    /// Settings). `None` when the data dir cannot be resolved on this
    /// platform.
    pub log_path: Option<String>,
    /// Last error message, if the most recent operation failed. Reset
    /// to `None` on a successful subsequent call.
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn daemon_status(state: State<'_, AppState>) -> DaemonStatus {
    let enabled = state.daemon_bridge.is_enabled();
    let log_path = crate::daemon_bridge::data_dir_path()
        .ok()
        .map(|p| p.join("daemon.log").display().to_string());

    if !enabled {
        return DaemonStatus {
            running: false,
            enabled: false,
            daemon_version: None,
            uptime_seconds: None,
            session_count_total: None,
            session_count_alive: None,
            log_path,
            last_error: None,
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
            last_error: None,
        },
        Err(BridgeError::Disabled) => DaemonStatus {
            running: false,
            enabled: false,
            daemon_version: None,
            uptime_seconds: None,
            session_count_total: None,
            session_count_alive: None,
            log_path,
            last_error: None,
        },
        Err(err) => DaemonStatus {
            running: false,
            enabled: true,
            daemon_version: None,
            uptime_seconds: None,
            session_count_total: None,
            session_count_alive: None,
            log_path,
            last_error: Some(err.to_string()),
        },
    }
}

/// Toggle the daemon path. Persistence (so the toggle survives a restart)
/// happens on the frontend in `localStorage` under `acorn:daemon-enabled`;
/// the backend's `AppState` reflects the runtime-active value only.
#[tauri::command]
pub fn daemon_set_enabled(enabled: bool, state: State<'_, AppState>) {
    state.daemon_bridge.set_enabled(enabled);
}

/// Cause the bridge to attempt a fresh connection (and spawn the daemon
/// if necessary). Useful for the Settings "restart daemon" button after
/// a manual `acornd shutdown`.
#[tauri::command]
pub fn daemon_restart(state: State<'_, AppState>) -> Result<(), String> {
    // Drop any cached connection so `ensure_connection` re-spawns.
    state.daemon_bridge.set_enabled(false);
    state.daemon_bridge.set_enabled(true);
    state
        .daemon_bridge
        .ensure_connection()
        .map_err(|e| e.to_string())
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
            kind: match s.kind {
                SessionKind::Regular => "regular".into(),
                SessionKind::Control => "control".into(),
            },
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

    let repo_path = summary
        .repo_path
        .clone()
        .ok_or_else(|| "daemon session has no repo_path — cannot adopt".to_string())?;
    let worktree_path = summary.cwd.clone().unwrap_or_else(|| repo_path.clone());
    // Branch is informational — leave empty when the daemon never knew
    // it. Synthesizing "main" would silently lie for repos on master /
    // trunk / detached HEAD; UI tolerates the empty string.
    let branch = summary.branch.clone().unwrap_or_default();

    let kind = match summary.kind {
        acorn_daemon::protocol::SessionKind::Regular => acorn_session::SessionKind::Regular,
        acorn_daemon::protocol::SessionKind::Control => acorn_session::SessionKind::Control,
    };

    let project_name = repo_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| repo_path.display().to_string());
    state.projects.ensure(repo_path.clone(), project_name);

    let now = chrono::Utc::now();
    let session = acorn_session::Session {
        id,
        name: summary.name.clone(),
        repo_path: repo_path.clone(),
        worktree_path,
        branch,
        isolated: false,
        project_scoped: true,
        status: acorn_session::SessionStatus::Ready,
        created_at: now,
        updated_at: now,
        last_message: None,
        title_source: acorn_session::SessionTitleSource::Manual,
        auto_title_enabled: Some(false),
        generated_title_transcript_id: None,
        kind,
        mode: acorn_session::SessionMode::Terminal,
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

fn agent_kind_to_str(k: AgentKind) -> String {
    match k {
        AgentKind::ClaudeCode => "claude-code".into(),
        AgentKind::Aider => "aider".into(),
        AgentKind::Llm => "llm".into(),
        AgentKind::OpenInterpreter => "open-interpreter".into(),
        AgentKind::Codex => "codex".into(),
        AgentKind::Antigravity => "antigravity".into(),
        AgentKind::Unknown => "unknown".into(),
    }
}
