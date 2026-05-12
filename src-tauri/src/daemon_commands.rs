//! Tauri commands that surface the `acornd` daemon to the frontend.
//!
//! Naming policy: every command in this module is prefixed `daemon_` so
//! the frontend can grep for the entire daemon surface in `api.ts`
//! without ambiguity against the legacy in-process commands in
//! `commands.rs`. The legacy commands stay live alongside this surface;
//! `commands::pty_spawn` is the seam where a future change will route
//! to the daemon when the user has the killswitch on. Frontend call
//! sites do not have to know which side served them.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::daemon::protocol::{AgentKind, SessionKind};
use crate::daemon_bridge::BridgeError;
use crate::state::AppState;

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
        .map(|s| DaemonSessionSummary {
            id: s.id.to_string(),
            name: s.name,
            kind: match s.kind {
                SessionKind::Regular => "regular".into(),
                SessionKind::Control => "control".into(),
            },
            alive: s.alive,
            repo_path: s.repo_path.map(|p| p.display().to_string()),
            branch: s.branch,
            agent_kind: s.agent_kind.map(agent_kind_to_str),
        })
        .collect())
}

/// Frontend → daemon spawn proxy. Invoked by the legacy `pty_spawn`
/// command once daemon-routed spawning lands, and directly by tests
/// that exercise the daemon path. Returns the session UUID the daemon
/// assigned (always equal to `session_id` when supplied).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn daemon_spawn_session(
    session_id: String,
    name: String,
    cwd: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    kind: String,
    repo_path: Option<String>,
    branch: Option<String>,
    agent_kind: Option<String>,
    agent_resume_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let id = Uuid::parse_str(&session_id).map_err(|e| format!("invalid session id: {e}"))?;
    let session_kind = parse_kind(&kind)?;
    let agent = agent_kind.as_deref().and_then(parse_agent_kind);
    let new_id = state
        .daemon_bridge
        .spawn(
            id,
            name,
            PathBuf::from(cwd),
            command,
            args,
            env,
            cols,
            rows,
            session_kind,
            repo_path.map(PathBuf::from),
            branch,
            agent,
            agent_resume_token,
        )
        .map_err(|e| e.to_string())?;
    Ok(new_id.to_string())
}

#[tauri::command]
pub fn daemon_send_input(
    target_session_id: String,
    data_b64: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id =
        Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;
    let bytes = base64_decode(&data_b64)?;
    state
        .daemon_bridge
        .send_input(id, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn daemon_resize(
    target_session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id =
        Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;
    state
        .daemon_bridge
        .resize(id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn daemon_kill_session(
    target_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id =
        Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;
    state.daemon_bridge.kill(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn daemon_forget_session(
    target_session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id =
        Uuid::parse_str(&target_session_id).map_err(|e| format!("invalid session id: {e}"))?;
    state.daemon_bridge.forget(id).map_err(|e| e.to_string())
}

fn parse_kind(kind: &str) -> Result<SessionKind, String> {
    match kind {
        "regular" => Ok(SessionKind::Regular),
        "control" => Ok(SessionKind::Control),
        other => Err(format!("unknown session kind: {other}")),
    }
}

fn parse_agent_kind(s: &str) -> Option<AgentKind> {
    match s {
        "claude-code" => Some(AgentKind::ClaudeCode),
        "aider" => Some(AgentKind::Aider),
        "llm" => Some(AgentKind::Llm),
        "open-interpreter" => Some(AgentKind::OpenInterpreter),
        "codex" => Some(AgentKind::Codex),
        "unknown" => Some(AgentKind::Unknown),
        _ => None,
    }
}

fn agent_kind_to_str(k: AgentKind) -> String {
    match k {
        AgentKind::ClaudeCode => "claude-code".into(),
        AgentKind::Aider => "aider".into(),
        AgentKind::Llm => "llm".into(),
        AgentKind::OpenInterpreter => "open-interpreter".into(),
        AgentKind::Codex => "codex".into(),
        AgentKind::Unknown => "unknown".into(),
    }
}

/// Same RFC 4648 decoder pattern as the daemon's own — duplicated to
/// keep the frontend command layer dep-light.
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(26 + c - b'a'),
            b'0'..=b'9' => Ok(52 + c - b'0'),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("non-base64 byte 0x{c:02x}")),
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut chunks = bytes.chunks(4);
    while let Some(chunk) = chunks.next() {
        if chunk.len() != 4 {
            return Err("bad base64 length".into());
        }
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        let v0 = val(chunk[0])?;
        let v1 = val(chunk[1])?;
        let v2 = if pad >= 2 { 0 } else { val(chunk[2])? };
        let v3 = if pad >= 1 { 0 } else { val(chunk[3])? };
        let n = (u32::from(v0) << 18) | (u32::from(v1) << 12) | (u32::from(v2) << 6) | u32::from(v3);
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_kind_known_values() {
        assert!(matches!(parse_kind("regular"), Ok(SessionKind::Regular)));
        assert!(matches!(parse_kind("control"), Ok(SessionKind::Control)));
        assert!(parse_kind("frobnicate").is_err());
    }

    #[test]
    fn parse_agent_kind_known_values() {
        assert!(matches!(
            parse_agent_kind("claude-code"),
            Some(AgentKind::ClaudeCode)
        ));
        assert!(parse_agent_kind("nope").is_none());
    }
}
