//! Unix-socket IPC server for the `acorn-ipc` CLI. Runs on a dedicated
//! background thread because every downstream interaction (PTY writes,
//! `SessionStore` reads) is synchronous and the `parking_lot::Mutex`es
//! around the PTY pool are not async-aware.
//!
//! Wire format: one newline-terminated JSON `Envelope` per request, one
//! newline-terminated JSON `Response` per request. The CLI opens a fresh
//! connection per command, so we do not need streaming or multiplexing.
//!
//! Security:
//!   * Socket file is created with permission `0600` (owner-only).
//!   * Every request carries a `source_session_id`. The server requires that
//!     id to resolve to a live `Session` whose `kind == Control`. Any other
//!     state (missing, wrong kind) returns `Unauthorized`.
//!   * Target session lookups are scoped to the source's `repo_path`, so a
//!     control session can only drive siblings inside its own project.
//!
//! The implementation deliberately avoids tokio. We spawn the listener
//! thread once at app boot and one short-lived worker thread per accepted
//! connection. A persistent dev-tool socket carrying single-shot requests
//! has very little concurrency to exploit; thread-per-conn keeps the
//! handler code linear and reuses the existing blocking PTY pool without
//! a runtime hop.

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

use acorn_ipc::primer;
use acorn_ipc::proto::{
    Envelope, ErrorCode, NewSessionOwner, Request, Response, SessionSummary, WorkspaceSummary,
    PROTOCOL_VERSION,
};
use acorn_ipc::socket_path;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use crate::commands::{
    create_unique_worktree, sanitize_worktree_name, session_removal_cascade, terminate_session_pty,
};
use crate::ipc::workspaces::{ListWorkspacesRequestPayload, LIST_WORKSPACES_REQUEST_EVENT};
use crate::persistence;
use crate::state::AppState;
use crate::worktree;
use acorn_session::{Session, SessionKind, SessionOwner, SessionStore};

/// Tauri event the frontend listens for to focus a session requested via
/// the IPC `select-session` command. Kept in lockstep with the listener
/// wired up in `src/components/Sidebar.tsx`'s sibling for `acorn:*` events.
const SELECT_SESSION_EVENT: &str = "acorn:ipc-select-session";
/// Fired whenever an IPC handler mutates the persisted session list
/// (`new-session`, `kill-session`). The frontend listens and re-fetches
/// via `list_sessions` so a control-session-driven mutation surfaces in
/// the sidebar without the user clicking anything. Payload is the
/// affected session's id as a string, mostly for debugging — the
/// frontend ignores the value today and just triggers a full refresh.
const SESSIONS_CHANGED_EVENT: &str = "acorn:ipc-sessions-changed";

#[derive(Debug, Clone, Serialize)]
struct SessionsChangedPayload {
    action: &'static str,
    session_id: String,
    repo_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
}

/// Shutdown signal for an active IPC listener. The listener thread polls
/// `running` between non-blocking `accept` attempts; flipping it to false
/// causes the thread to exit within ~`ACCEPT_POLL_INTERVAL_MS`. Stored in
/// `AppState` so `ipc_restart` can swap a fresh listener in place.
pub struct IpcServerHandle {
    pub running: Arc<AtomicBool>,
}

impl IpcServerHandle {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn signal_stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// Poll cadence for the accept loop. Trades a tiny amount of idle CPU for a
/// fast restart: the listener notices a stop signal within this window.
const ACCEPT_POLL_INTERVAL_MS: u64 = 100;
const LIST_WORKSPACES_TIMEOUT_MS: u64 = 2_000;

/// Spawn the IPC server on a dedicated background thread. Returns the
/// shutdown handle on success, or `None` if bind failed (rest of the app
/// remains usable). The listener is non-blocking and polls its `running`
/// flag so `ipc_restart` can stop it without process-level signals.
pub fn start<R: Runtime>(app: AppHandle<R>, state: AppState) -> Option<IpcServerHandle> {
    let path = match socket_path::resolve() {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(error = %err, "ipc: could not resolve socket path; server disabled");
            return None;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            tracing::warn!(
                error = %err,
                path = %parent.display(),
                "ipc: could not create socket parent dir; server disabled",
            );
            return None;
        }
    }
    // Best-effort cleanup of any previous socket inode. We do not block on
    // failure because the next `bind` will surface the real error.
    let _ = std::fs::remove_file(&path);
    // Bind at a temporary name, tighten permissions, then rename onto the
    // advertised path. Binding directly at `path` would leave a window
    // between bind (umask-derived permissions) and chmod during which any
    // local user could connect.
    let staging_path = path.with_extension("sock-staging");
    let _ = std::fs::remove_file(&staging_path);
    let listener = match UnixListener::bind(&staging_path) {
        Ok(l) => l,
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %staging_path.display(),
                "ipc: bind failed; server disabled",
            );
            return None;
        }
    };
    if let Err(err) = listener.set_nonblocking(true) {
        // Required for the shutdown poll. Bail rather than fall back to
        // blocking accept — a blocking listener could never honour a stop
        // signal and would leak its thread on every restart.
        tracing::warn!(
            error = %err,
            "ipc: set_nonblocking failed; server disabled",
        );
        return None;
    }
    if let Err(err) =
        std::fs::set_permissions(&staging_path, std::fs::Permissions::from_mode(0o600))
    {
        // Tighten on best-effort. If chmod fails we keep going — it just
        // means the socket is more permissive than ideal, not that the
        // server is unsafe (the unix peer is still local).
        tracing::warn!(
            error = %err,
            path = %staging_path.display(),
            "ipc: chmod 0600 failed",
        );
    }
    if let Err(err) = std::fs::rename(&staging_path, &path) {
        tracing::warn!(
            error = %err,
            from = %staging_path.display(),
            to = %path.display(),
            "ipc: socket rename failed; server disabled",
        );
        let _ = std::fs::remove_file(&staging_path);
        return None;
    }
    tracing::info!(path = %path.display(), "ipc: listening");

    let running = Arc::new(AtomicBool::new(true));
    let running_for_thread = running.clone();
    let spawn_result = std::thread::Builder::new()
        .name("acorn-ipc-listener".to_string())
        .spawn(move || run_listener(listener, app, state, running_for_thread));
    match spawn_result {
        Ok(_) => Some(IpcServerHandle { running }),
        Err(err) => {
            tracing::warn!(error = %err, "ipc: listener thread failed to start");
            None
        }
    }
}

fn run_listener<R: Runtime>(
    listener: UnixListener,
    app: AppHandle<R>,
    state: AppState,
    running: Arc<AtomicBool>,
) {
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                // Accepted streams inherit the listener's non-blocking flag,
                // but the per-connection handler does blocking reads/writes.
                // Restoring blocking mode here keeps the handler code simple.
                if let Err(err) = stream.set_nonblocking(false) {
                    tracing::warn!(error = %err, "ipc: stream set_blocking failed");
                    continue;
                }
                let app = app.clone();
                let state = state.clone();
                std::thread::Builder::new()
                    .name("acorn-ipc-conn".to_string())
                    .spawn(move || {
                        if let Err(err) = handle_connection(stream, &app, &state) {
                            tracing::warn!(error = %err, "ipc: connection handler failed");
                        }
                    })
                    .map(|_| ())
                    .unwrap_or_else(|err| {
                        tracing::warn!(error = %err, "ipc: conn thread spawn failed");
                    });
            }
            Err(ref err) if err.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(ACCEPT_POLL_INTERVAL_MS));
            }
            Err(err) => {
                tracing::warn!(error = %err, "ipc: accept failed");
            }
        }
    }
    tracing::info!("ipc: listener stopped");
}

/// Upper bound for a single request line. `read_line` otherwise grows the
/// buffer without limit, so a misbehaving client writing an endless unbroken
/// line could exhaust memory. Generous compared to any real `Envelope`.
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

fn handle_connection<R: Runtime>(
    stream: UnixStream,
    app: &AppHandle<R>,
    state: &AppState,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    let mut line = String::new();
    let n = std::io::Read::take(&mut reader, MAX_REQUEST_BYTES).read_line(&mut line)?;
    if n == 0 {
        return Ok(());
    }
    let response = match serde_json::from_str::<Envelope>(line.trim_end()) {
        Ok(envelope) => dispatch(envelope, app, state),
        Err(err) => Response::Error {
            code: ErrorCode::Invalid,
            message: format!("malformed request: {err}"),
        },
    };
    let mut out = serde_json::to_vec(&response).unwrap_or_else(|_| {
        b"{\"kind\":\"error\",\"code\":\"internal\",\"message\":\"failed to serialize response\"}"
            .to_vec()
    });
    out.push(b'\n');
    writer.write_all(&out)?;
    writer.flush()?;
    Ok(())
}

/// Top-level request dispatch. Except for `promote-self`, resolves the source
/// session and enforces the "must be Control" gate before invoking
/// command-specific handlers, so each handler can assume `source` is a live,
/// authorized session.
fn dispatch<R: Runtime>(envelope: Envelope, app: &AppHandle<R>, state: &AppState) -> Response {
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Response::Error {
            code: ErrorCode::Invalid,
            message: format!(
                "unsupported protocol version {} (server speaks {})",
                envelope.protocol_version, PROTOCOL_VERSION
            ),
        };
    }
    if matches!(&envelope.request, Request::PromoteSelf) {
        return handle_promote_self(&envelope.source_session_id, app, state);
    }
    let source = match resolve_source(&envelope.source_session_id, &state.sessions) {
        Ok(s) => s,
        Err(err) => return err,
    };
    let request_label = request_label(&envelope.request);
    tracing::info!(
        source = %source.id,
        request = request_label,
        "ipc: dispatch",
    );
    match envelope.request {
        Request::PromoteSelf => handle_promote_self(&source.id.to_string(), app, state),
        Request::Context => handle_context(&source),
        Request::ListSessions => handle_list_sessions(&source, &state.sessions),
        Request::ListWorkspaces => handle_list_workspaces(&source, app, state),
        Request::SendKeys {
            target_session_id,
            data_b64,
            allow_foreign,
        } => handle_send_keys(&source, &target_session_id, &data_b64, allow_foreign, state),
        Request::ReadBuffer {
            target_session_id,
            max_bytes,
            allow_foreign,
        } => handle_read_buffer(&source, &target_session_id, max_bytes, allow_foreign, state),
        Request::NewSession {
            name,
            isolated,
            owner,
            workspace_path,
            workspace_id,
        } => handle_new_session(
            &source,
            name,
            isolated,
            owner,
            workspace_path,
            workspace_id,
            app,
            state,
        ),
        Request::SelectSession {
            target_session_id,
            allow_foreign,
        } => handle_select_session(&source, &target_session_id, allow_foreign, app, state),
        Request::KillSession {
            target_session_id,
            allow_foreign,
        } => handle_kill_session(&source, &target_session_id, allow_foreign, app, state),
    }
}

fn request_label(req: &Request) -> &'static str {
    match req {
        Request::PromoteSelf => "promote-self",
        Request::Context => "context",
        Request::ListSessions => "list-sessions",
        Request::ListWorkspaces => "list-workspaces",
        Request::SendKeys { .. } => "send-keys",
        Request::ReadBuffer { .. } => "read-buffer",
        Request::NewSession { .. } => "new-session",
        Request::SelectSession { .. } => "select-session",
        Request::KillSession { .. } => "kill-session",
    }
}

fn resolve_source(raw_id: &str, sessions: &SessionStore) -> Result<Session, Response> {
    let id = Uuid::parse_str(raw_id).map_err(|_| Response::Error {
        code: ErrorCode::Unauthorized,
        message: format!("source session id is not a valid uuid: {raw_id}"),
    })?;
    let session = sessions.get(&id).map_err(|_| Response::Error {
        code: ErrorCode::Unauthorized,
        message: "source session not found; is the ACORN_SESSION_ID env still valid?".to_string(),
    })?;
    if session.kind != SessionKind::Control {
        return Err(Response::Error {
            code: ErrorCode::Unauthorized,
            message: "source session is not a control session".to_string(),
        });
    }
    Ok(session)
}

fn promote_source_session(
    raw_id: &str,
    sessions: &SessionStore,
) -> Result<(Session, bool), Response> {
    let id = Uuid::parse_str(raw_id).map_err(|_| Response::Error {
        code: ErrorCode::Unauthorized,
        message: format!("source session id is not a valid uuid: {raw_id}"),
    })?;
    let session = sessions.get(&id).map_err(|_| Response::Error {
        code: ErrorCode::Unauthorized,
        message: "source session not found; is the Acorn session id still valid?".to_string(),
    })?;
    if session.kind == SessionKind::Control {
        return Ok((session, true));
    }
    let promoted = sessions
        .set_kind(&id, SessionKind::Control)
        .map_err(|err| Response::Error {
            code: ErrorCode::Internal,
            message: format!("promote-self failed: {err}"),
        })?;
    Ok((promoted, false))
}

fn handle_promote_self<R: Runtime>(
    source_id: &str,
    app: &AppHandle<R>,
    state: &AppState,
) -> Response {
    let (session, already_control) = match promote_source_session(source_id, &state.sessions) {
        Ok(result) => result,
        Err(err) => return err,
    };
    if !already_control {
        if let Err(err) = persistence::save_sessions(&state.sessions.list()) {
            tracing::warn!(error = %err, "ipc: persist after promote-self failed");
        }
        if let Err(err) = app.emit(
            SESSIONS_CHANGED_EVENT,
            SessionsChangedPayload {
                action: "promoted",
                session_id: session.id.to_string(),
                repo_path: session.repo_path.display().to_string(),
                workspace_path: Some(session.worktree_path.display().to_string()),
                workspace_id: None,
            },
        ) {
            tracing::warn!(
                error = %err,
                event = SESSIONS_CHANGED_EVENT,
                "ipc: sessions-changed emit failed after promote-self",
            );
        }
    }
    Response::SelfPromoted {
        session_id: session.id.to_string(),
        already_control,
        context: control_context_text(&session),
    }
}

/// Resolve a target session id, enforcing project scope. Returns
/// `(target, response)` so handlers can short-circuit on lookup failure
/// with the standardized error variant.
fn resolve_target(
    source: &Session,
    raw_id: &str,
    sessions: &SessionStore,
) -> Result<Session, Response> {
    let id = Uuid::parse_str(raw_id).map_err(|_| Response::Error {
        code: ErrorCode::Invalid,
        message: format!("target session id is not a valid uuid: {raw_id}"),
    })?;
    let target = sessions.get(&id).map_err(|_| Response::Error {
        code: ErrorCode::NotFound,
        message: format!("no session with id {id}"),
    })?;
    if target.repo_path != source.repo_path {
        return Err(Response::Error {
            code: ErrorCode::OutOfScope,
            message: format!(
                "target session belongs to a different project than the control session"
            ),
        });
    }
    Ok(target)
}

fn is_owned_by_source(source: &Session, target: &Session) -> bool {
    target.id == source.id || target.owner.is_control_owner(source.id)
}

fn resolve_action_target(
    source: &Session,
    raw_id: &str,
    sessions: &SessionStore,
    allow_foreign: bool,
) -> Result<Session, Response> {
    let target = resolve_target(source, raw_id, sessions)?;
    if !allow_foreign && !is_owned_by_source(source, &target) {
        return Err(Response::Error {
            code: ErrorCode::ForeignSession,
            message: format!(
                "target session is owned by {}; pass --allow-foreign only when the user explicitly asked you to touch it",
                target.owner.label()
            ),
        });
    }
    Ok(target)
}

fn handle_context(source: &Session) -> Response {
    Response::Context {
        text: control_context_text(source),
    }
}

fn control_context_text(source: &Session) -> String {
    let socket = socket_path::resolve().unwrap_or_default();
    let daemon_socket = acorn_daemon::paths::control_socket_path().ok();
    primer::primer_for(
        &source.id.to_string(),
        &source.repo_path,
        &socket,
        daemon_socket.as_deref(),
    )
}

fn handle_list_sessions(source: &Session, sessions: &SessionStore) -> Response {
    let summaries: Vec<SessionSummary> = sessions
        .list()
        .into_iter()
        .filter(|s| s.repo_path == source.repo_path)
        .map(|s| {
            let owned_by_me = is_owned_by_source(source, &s);
            SessionSummary {
                is_source: s.id == source.id,
                id: s.id.to_string(),
                name: s.name,
                repo_path: s.repo_path.display().to_string(),
                workspace_path: s.worktree_path.display().to_string(),
                branch: s.branch,
                kind: match s.kind {
                    SessionKind::Regular => "regular".to_string(),
                    SessionKind::Control => "control".to_string(),
                },
                owner: s.owner.label(),
                status: format!("{:?}", s.status).to_lowercase(),
                owned_by_me,
            }
        })
        .collect();
    Response::Sessions {
        sessions: summaries,
    }
}

fn handle_list_workspaces<R: Runtime>(
    source: &Session,
    app: &AppHandle<R>,
    state: &AppState,
) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    state
        .ipc_workspace_requests
        .lock()
        .insert(request_id.clone(), sender);

    let payload = ListWorkspacesRequestPayload {
        request_id: request_id.clone(),
        source_session_id: source.id.to_string(),
        repo_path: source.repo_path.display().to_string(),
        source_workspace_path: source.worktree_path.display().to_string(),
    };
    if let Err(err) = app.emit(LIST_WORKSPACES_REQUEST_EVENT, payload) {
        state.ipc_workspace_requests.lock().remove(&request_id);
        return Response::Error {
            code: ErrorCode::Internal,
            message: format!("workspace list request emit failed: {err}"),
        };
    }

    match receiver.recv_timeout(Duration::from_millis(LIST_WORKSPACES_TIMEOUT_MS)) {
        Ok(Ok(workspaces)) => Response::Workspaces {
            workspaces: sanitize_workspace_summaries(source, workspaces),
        },
        Ok(Err(message)) => Response::Error {
            code: ErrorCode::Internal,
            message,
        },
        Err(RecvTimeoutError::Timeout) => {
            state.ipc_workspace_requests.lock().remove(&request_id);
            Response::Error {
                code: ErrorCode::Internal,
                message: "frontend did not answer workspace list request".to_string(),
            }
        }
        Err(RecvTimeoutError::Disconnected) => {
            state.ipc_workspace_requests.lock().remove(&request_id);
            Response::Error {
                code: ErrorCode::Internal,
                message: "workspace list response channel closed".to_string(),
            }
        }
    }
}

fn sanitize_workspace_summaries(
    source: &Session,
    workspaces: Vec<WorkspaceSummary>,
) -> Vec<WorkspaceSummary> {
    let repo_path = source.repo_path.display().to_string();
    workspaces
        .into_iter()
        .filter(|workspace| workspace.repo_path == repo_path)
        .collect()
}

fn handle_send_keys(
    source: &Session,
    target_id: &str,
    data_b64: &str,
    allow_foreign: bool,
    state: &AppState,
) -> Response {
    let target = match resolve_action_target(source, target_id, &state.sessions, allow_foreign) {
        Ok(t) => t,
        Err(err) => return err,
    };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(data_b64) {
        Ok(b) => b,
        Err(err) => {
            return Response::Error {
                code: ErrorCode::Invalid,
                message: format!("data_b64 is not valid base64: {err}"),
            };
        }
    };
    if let Err(err) = state.pty.write(&target.id, &bytes) {
        return Response::Error {
            code: ErrorCode::Internal,
            message: format!("pty write failed: {err}"),
        };
    }
    Response::Ack
}

fn handle_read_buffer(
    source: &Session,
    target_id: &str,
    max_bytes: Option<usize>,
    allow_foreign: bool,
    state: &AppState,
) -> Response {
    let target = match resolve_action_target(source, target_id, &state.sessions, allow_foreign) {
        Ok(t) => t,
        Err(err) => return err,
    };
    let cap = max_bytes.unwrap_or(64 * 1024).min(4 * 1024 * 1024);
    match state.pty.tail_bytes(&target.id, cap) {
        Some((bytes, truncated)) => Response::Buffer {
            data_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            truncated,
        },
        None => Response::Error {
            code: ErrorCode::NotFound,
            message: format!("session {} has no live pty", target.id),
        },
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn canonical_existing_path(path: &Path, label: &str) -> Result<PathBuf, Response> {
    if !path.is_absolute() {
        return Err(Response::Error {
            code: ErrorCode::Invalid,
            message: format!("{label} must be an absolute path: {}", path.display()),
        });
    }
    path.canonicalize().map_err(|err| Response::Error {
        code: ErrorCode::Invalid,
        message: format!("{label} is not accessible: {} ({err})", path.display()),
    })
}

fn authorize_new_session_workspace(
    source: &Session,
    workspace_path: Option<String>,
) -> Result<Option<PathBuf>, Response> {
    let Some(raw_path) = normalize_optional_string(workspace_path) else {
        return Ok(None);
    };
    let cwd = canonical_existing_path(Path::new(&raw_path), "workspace path")?;
    let repo = source
        .repo_path
        .canonicalize()
        .map_err(|err| Response::Error {
            code: ErrorCode::Internal,
            message: format!(
                "source project path is not accessible: {} ({err})",
                source.repo_path.display()
            ),
        })?;
    if path_is_inside(&cwd, &repo) {
        return Ok(Some(cwd));
    }
    let worktrees =
        worktree::list_worktree_paths(&source.repo_path).map_err(|err| Response::Error {
            code: ErrorCode::Internal,
            message: format!("could not list project worktrees: {err}"),
        })?;
    for worktree in worktrees {
        if let Ok(worktree) = worktree.canonicalize() {
            if path_is_inside(&cwd, &worktree) {
                return Ok(Some(cwd));
            }
        }
    }
    Err(Response::Error {
        code: ErrorCode::OutOfScope,
        message: format!(
            "workspace path is outside the control session project and its worktrees: {}",
            cwd.display()
        ),
    })
}

fn handle_new_session<R: Runtime>(
    source: &Session,
    name: String,
    isolated: bool,
    owner: Option<NewSessionOwner>,
    workspace_path: Option<String>,
    workspace_id: Option<String>,
    app: &AppHandle<R>,
    state: &AppState,
) -> Response {
    if name.trim().is_empty() {
        return Response::Error {
            code: ErrorCode::Invalid,
            message: "name must not be empty".to_string(),
        };
    }
    let workspace_id = normalize_optional_string(workspace_id);
    if isolated
        && (normalize_optional_string(workspace_path.clone()).is_some() || workspace_id.is_some())
    {
        return Response::Error {
            code: ErrorCode::Invalid,
            message: "`--isolated` cannot target an existing workspace".to_string(),
        };
    }
    let repo = source.repo_path.clone();
    let workspace_path = match authorize_new_session_workspace(source, workspace_path) {
        Ok(path) => path,
        Err(err) => return err,
    };
    let worktree_path = if isolated {
        let base = sanitize_worktree_name(&name);
        match create_unique_worktree(&repo, &base) {
            Ok((_safe, path)) => path,
            Err(err) => {
                return Response::Error {
                    code: ErrorCode::Internal,
                    message: format!("worktree create failed: {err}"),
                };
            }
        }
    } else {
        workspace_path.unwrap_or_else(|| repo.clone())
    };
    let branch = worktree::current_branch(&worktree_path).unwrap_or_else(|_| "HEAD".to_string());
    let mut session = Session::new(
        name,
        repo.clone(),
        worktree_path,
        branch,
        isolated,
        SessionKind::Regular,
    );
    session.owner = match owner.unwrap_or(NewSessionOwner::SourceControl) {
        NewSessionOwner::SourceControl => SessionOwner::control(source.id),
        NewSessionOwner::User => SessionOwner::User,
    };
    let inserted = state.sessions.insert(session);
    let basename = repo
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("project")
        .to_string();
    state.projects.ensure(repo, basename);
    if let Err(err) = persistence::save_sessions(&state.sessions.list()) {
        tracing::warn!(error = %err, "ipc: persist sessions after new-session failed");
    }
    // Nudge the frontend so the new session appears in the sidebar
    // without the user clicking around. Best-effort: a failed emit
    // leaves the backend state correct, the user can still reach the
    // session via the next app reload or a manual refresh.
    if let Err(err) = app.emit(
        SESSIONS_CHANGED_EVENT,
        SessionsChangedPayload {
            action: "created",
            session_id: inserted.id.to_string(),
            repo_path: inserted.repo_path.display().to_string(),
            workspace_path: Some(inserted.worktree_path.display().to_string()),
            workspace_id,
        },
    ) {
        tracing::warn!(
            error = %err,
            event = SESSIONS_CHANGED_EVENT,
            "ipc: sessions-changed emit failed",
        );
    }
    Response::SessionCreated {
        session_id: inserted.id.to_string(),
    }
}

fn handle_select_session<R: Runtime>(
    source: &Session,
    target_id: &str,
    allow_foreign: bool,
    app: &AppHandle<R>,
    state: &AppState,
) -> Response {
    let target = match resolve_action_target(source, target_id, &state.sessions, allow_foreign) {
        Ok(t) => t,
        Err(err) => return err,
    };
    if let Err(err) = app.emit(SELECT_SESSION_EVENT, target.id.to_string()) {
        return Response::Error {
            code: ErrorCode::Internal,
            message: format!("event emit failed: {err}"),
        };
    }
    Response::Ack
}

fn handle_kill_session<R: Runtime>(
    source: &Session,
    target_id: &str,
    allow_foreign: bool,
    app: &AppHandle<R>,
    state: &AppState,
) -> Response {
    let target = match resolve_action_target(source, target_id, &state.sessions, allow_foreign) {
        Ok(t) => t,
        Err(err) => return err,
    };
    if target.id == source.id {
        return Response::Error {
            code: ErrorCode::Invalid,
            message: "refusing to kill the source control session".to_string(),
        };
    }
    let sessions_to_remove = session_removal_cascade(state, &target);
    for session in &sessions_to_remove {
        terminate_session_pty(state, &session.id);
    }
    for session in &sessions_to_remove {
        if let Err(err) = state.sessions.remove(&session.id) {
            return Response::Error {
                code: ErrorCode::Internal,
                message: format!("remove failed: {err}"),
            };
        }
    }
    if let Err(err) = persistence::save_sessions(&state.sessions.list()) {
        tracing::warn!(error = %err, "ipc: persist after kill-session failed");
    }
    for session in &sessions_to_remove {
        if let Err(err) = app.emit(
            SESSIONS_CHANGED_EVENT,
            SessionsChangedPayload {
                action: "removed",
                session_id: session.id.to_string(),
                repo_path: session.repo_path.display().to_string(),
                workspace_path: Some(session.worktree_path.display().to_string()),
                workspace_id: None,
            },
        ) {
            tracing::warn!(
                error = %err,
                event = SESSIONS_CHANGED_EVENT,
                "ipc: sessions-changed emit failed",
            );
        }
    }
    Response::Ack
}

#[cfg(test)]
mod tests {
    use super::*;
    use acorn_session::SessionStatus;
    use std::path::PathBuf;

    fn make_session(repo: &str, name: &str, kind: SessionKind) -> Session {
        let mut s = Session::new(
            name.to_string(),
            PathBuf::from(repo),
            PathBuf::from(repo),
            "main".to_string(),
            false,
            kind,
        );
        s.status = SessionStatus::Ready;
        s
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir =
            std::env::temp_dir().join(format!("acorn-ipc-{label}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn resolve_source_rejects_regular_kind() {
        let store = SessionStore::new();
        let regular = store.insert(make_session("/tmp/repo", "reg", SessionKind::Regular));
        let result = resolve_source(&regular.id.to_string(), &store);
        match result {
            Err(Response::Error {
                code: ErrorCode::Unauthorized,
                ..
            }) => {}
            other => panic!("expected unauthorized, got {other:?}"),
        }
    }

    #[test]
    fn resolve_source_accepts_control_kind() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/repo", "ctl", SessionKind::Control));
        let result = resolve_source(&ctl.id.to_string(), &store);
        assert!(result.is_ok(), "control session should be allowed");
    }

    #[test]
    fn resolve_source_rejects_unknown_uuid() {
        let store = SessionStore::new();
        let result = resolve_source("00000000-0000-0000-0000-000000000000", &store);
        match result {
            Err(Response::Error {
                code: ErrorCode::Unauthorized,
                ..
            }) => {}
            other => panic!("expected unauthorized for unknown id, got {other:?}"),
        }
    }

    #[test]
    fn list_sessions_filters_by_project() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/A", "ctl", SessionKind::Control));
        let mut peer = make_session("/tmp/A", "peer", SessionKind::Regular);
        peer.owner = SessionOwner::control(ctl.id);
        let _peer = store.insert(peer);
        let _other = store.insert(make_session("/tmp/B", "other", SessionKind::Regular));
        match handle_list_sessions(&ctl, &store) {
            Response::Sessions { sessions } => {
                assert_eq!(sessions.len(), 2, "should see ctl + peer, not other");
                assert!(sessions.iter().all(|s| s.repo_path == "/tmp/A"));
                let source = sessions
                    .iter()
                    .find(|s| s.is_source)
                    .expect("source marked");
                assert_eq!(source.id, ctl.id.to_string());
                let worker = sessions.iter().find(|s| s.name == "peer").expect("worker");
                assert_eq!(worker.owner, format!("control:{}", ctl.id));
                assert_eq!(worker.workspace_path, "/tmp/A");
                assert!(worker.owned_by_me);
            }
            other => panic!("expected sessions response, got {other:?}"),
        }
    }

    #[test]
    fn list_workspaces_filters_renderer_response_to_source_project() {
        let source = make_session("/tmp/A", "ctl", SessionKind::Control);
        let workspaces = vec![
            WorkspaceSummary {
                id: "/tmp/A".to_string(),
                name: "Default".to_string(),
                repo_path: "/tmp/A".to_string(),
                workspace_path: "/tmp/A".to_string(),
                is_default: true,
                active: true,
                source: true,
                session_count: 1,
            },
            WorkspaceSummary {
                id: "/tmp/B".to_string(),
                name: "Other".to_string(),
                repo_path: "/tmp/B".to_string(),
                workspace_path: "/tmp/B".to_string(),
                is_default: true,
                active: false,
                source: false,
                session_count: 1,
            },
        ];

        let filtered = sanitize_workspace_summaries(&source, workspaces);

        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].repo_path, "/tmp/A");
    }

    #[test]
    fn new_session_workspace_accepts_project_subdirectory() {
        let repo = unique_temp_dir("repo");
        let subdir = repo.join("packages").join("web");
        std::fs::create_dir_all(&subdir).expect("create subdir");
        let source = Session::new(
            "ctl".to_string(),
            repo.clone(),
            repo.clone(),
            "main".to_string(),
            false,
            SessionKind::Control,
        );

        let resolved = authorize_new_session_workspace(&source, Some(subdir.display().to_string()))
            .expect("authorized");

        assert_eq!(resolved, Some(subdir.canonicalize().unwrap()));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn new_session_workspace_rejects_relative_path() {
        let repo = unique_temp_dir("repo-relative");
        let source = Session::new(
            "ctl".to_string(),
            repo.clone(),
            repo.clone(),
            "main".to_string(),
            false,
            SessionKind::Control,
        );

        let result = authorize_new_session_workspace(&source, Some("relative/path".to_string()));

        match result {
            Err(Response::Error {
                code: ErrorCode::Invalid,
                ..
            }) => {}
            other => panic!("expected invalid path, got {other:?}"),
        }
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn resolve_target_rejects_cross_project() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/A", "ctl", SessionKind::Control));
        let other = store.insert(make_session("/tmp/B", "other", SessionKind::Regular));
        let res = resolve_target(&ctl, &other.id.to_string(), &store);
        match res {
            Err(Response::Error {
                code: ErrorCode::OutOfScope,
                ..
            }) => {}
            other => panic!("expected out-of-scope, got {other:?}"),
        }
    }

    #[test]
    fn action_target_rejects_foreign_owner_by_default() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/A", "ctl", SessionKind::Control));
        let target = store.insert(make_session("/tmp/A", "user", SessionKind::Regular));
        let res = resolve_action_target(&ctl, &target.id.to_string(), &store, false);
        match res {
            Err(Response::Error {
                code: ErrorCode::ForeignSession,
                ..
            }) => {}
            other => panic!("expected foreign-session, got {other:?}"),
        }
    }

    #[test]
    fn action_target_accepts_source_owned_session() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/A", "ctl", SessionKind::Control));
        let mut target = make_session("/tmp/A", "worker", SessionKind::Regular);
        target.owner = SessionOwner::control(ctl.id);
        let target = store.insert(target);
        let res = resolve_action_target(&ctl, &target.id.to_string(), &store, false);
        assert!(res.is_ok(), "source-owned worker should be allowed");
    }

    #[test]
    fn action_target_allows_foreign_owner_when_explicit() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/A", "ctl", SessionKind::Control));
        let target = store.insert(make_session("/tmp/A", "user", SessionKind::Regular));
        let res = resolve_action_target(&ctl, &target.id.to_string(), &store, true);
        assert!(res.is_ok(), "allow_foreign should bypass owner guard");
    }

    #[test]
    fn session_removal_cascade_includes_control_owned_descendants() {
        let state = AppState::new();
        let controller = state
            .sessions
            .insert(make_session("/tmp/A", "ctl", SessionKind::Control));
        let worker = state.sessions.insert({
            let mut session = make_session("/tmp/A", "worker", SessionKind::Regular);
            session.owner = SessionOwner::control(controller.id);
            session
        });
        let nested = state.sessions.insert({
            let mut session = make_session("/tmp/A", "nested", SessionKind::Regular);
            session.owner = SessionOwner::control(worker.id);
            session
        });
        let user = state
            .sessions
            .insert(make_session("/tmp/A", "user", SessionKind::Regular));

        let cascade = session_removal_cascade(&state, &controller);
        let ids: std::collections::HashSet<_> =
            cascade.into_iter().map(|session| session.id).collect();

        assert_eq!(
            ids,
            std::collections::HashSet::from([controller.id, worker.id, nested.id])
        );
        assert!(!ids.contains(&user.id));
    }

    #[test]
    fn promote_regular_source_session_sets_control_kind() {
        let store = SessionStore::new();
        let regular = store.insert(make_session("/tmp/A", "regular", SessionKind::Regular));

        let (promoted, already_control) =
            promote_source_session(&regular.id.to_string(), &store).expect("promoted");

        assert_eq!(promoted.id, regular.id);
        assert_eq!(promoted.kind, SessionKind::Control);
        assert!(!already_control);
        assert_eq!(
            store.get(&regular.id).expect("session persisted").kind,
            SessionKind::Control
        );
    }

    #[test]
    fn promote_control_source_session_is_idempotent() {
        let store = SessionStore::new();
        let ctl = store.insert(make_session("/tmp/A", "ctl", SessionKind::Control));

        let (promoted, already_control) =
            promote_source_session(&ctl.id.to_string(), &store).expect("promoted");

        assert_eq!(promoted.id, ctl.id);
        assert_eq!(promoted.kind, SessionKind::Control);
        assert!(already_control);
    }
}
