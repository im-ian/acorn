//! Local IPC server for the `acorn-ipc` CLI. Runs on a dedicated
//! background thread because every downstream interaction (PTY writes,
//! `SessionStore` reads) is synchronous and the `parking_lot::Mutex`es
//! around the PTY pool are not async-aware.
//!
//! Wire format: one newline-terminated JSON `Envelope` per request, one
//! newline-terminated JSON `Response` per request. The CLI opens a fresh
//! connection per command, so we do not need streaming or multiplexing.
//!
//! Security:
//!   * The endpoint is owner-only (`0600` on Unix; protected named-pipe
//!     DACL on Windows).
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

use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use acorn_ipc::primer;
use acorn_ipc::proto::{
    Envelope, ErrorCode, NewSessionOwner, Request, Response, SessionSummary, WorkspaceSummary,
    MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES, PROTOCOL_VERSION,
};
use acorn_ipc::socket_path;
use acorn_local_ipc::{
    Listener, ListenerNonblockingMode, ListenerTrait as _, Stream, StreamTrait as _,
};
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use crate::commands::{
    create_unique_project_worktree, sanitize_worktree_name, session_removal_cascade,
    terminate_session_runtime,
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
/// (`new-session`, `close-self`, `kill-session`). The frontend listens and re-fetches
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
const MAX_ACTIVE_CONNECTIONS: usize = 32;
const CONNECTION_IO_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECTION_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Spawn the IPC server on a dedicated background thread. Returns the
/// shutdown handle on success, or `None` if bind failed (rest of the app
/// remains usable). The listener is non-blocking and polls its `running`
/// flag so `ipc_restart` can stop it without process-level signals.
/// Spawn the IPC server on a dedicated background thread. The listener is
/// non-blocking and polls its `running` flag so `ipc_restart` can stop it
/// without process-level signals.
///
/// The error is returned rather than only logged: boot can ignore it and leave
/// the rest of the app usable, while `ipc_restart` — which the user triggered —
/// can tell them which step failed instead of pointing at the log file.
pub fn start<R: Runtime>(app: AppHandle<R>, state: AppState) -> Result<IpcServerHandle, String> {
    let path = socket_path::resolve()
        .map_err(|err| format!("could not resolve the IPC socket path: {err}"))?;
    let listener = bind_listener(&path)?;
    tracing::info!(path = %path.display(), "ipc: listening");

    let running = Arc::new(AtomicBool::new(true));
    let running_for_thread = running.clone();
    std::thread::Builder::new()
        .name("acorn-ipc-listener".to_string())
        .spawn(move || run_listener(listener, app, state, running_for_thread))
        .map_err(|err| format!("could not start the IPC listener thread: {err}"))?;
    Ok(IpcServerHandle { running })
}

fn bind_listener(path: &Path) -> Result<Listener, String> {
    let listener = acorn_local_ipc::bind(path)
        .map_err(|err| format!("could not bind the IPC socket {}: {err}", path.display()))?;
    // Keep accepted streams nonblocking too. On Windows, `Accept` makes
    // interprocess toggle each connected named pipe back to blocking inside
    // `accept()`, which can race a newly connected client with ERROR_NO_DATA.
    if let Err(err) = listener.set_nonblocking(ListenerNonblockingMode::Both) {
        // Required for the shutdown poll. Bail rather than fall back to
        // blocking accept — a blocking listener could never honour a stop
        // signal and would leak its thread on every restart.
        drop(listener);
        acorn_local_ipc::cleanup(path);
        return Err(format!(
            "could not set the IPC socket {} to non-blocking mode: {err}",
            path.display()
        ));
    }
    Ok(listener)
}

fn run_listener<R: Runtime>(
    listener: Listener,
    app: AppHandle<R>,
    state: AppState,
    running: Arc<AtomicBool>,
) {
    let active_connections = Arc::new(AtomicUsize::new(0));
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok(stream) => {
                let Some(permit) = ConnectionPermit::try_acquire(
                    active_connections.clone(),
                    MAX_ACTIVE_CONNECTIONS,
                ) else {
                    tracing::warn!(
                        limit = MAX_ACTIVE_CONNECTIONS,
                        "ipc: dropping connection because the handler limit is full"
                    );
                    continue;
                };
                // Nonblocking I/O lets the handler enforce a portable deadline.
                // interprocess receive/send timeouts are unsupported by its
                // Windows named-pipe backend.
                if let Err(err) = stream.set_nonblocking(true) {
                    tracing::warn!(error = %err, "ipc: stream set_nonblocking failed");
                    continue;
                }
                let app = app.clone();
                let state = state.clone();
                std::thread::Builder::new()
                    .name("acorn-ipc-conn".to_string())
                    .spawn(move || {
                        let _permit = permit;
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

struct ConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl ConnectionPermit {
    fn try_acquire(active: Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < limit).then_some(current + 1)
            })
            .ok()?;
        Some(Self { active })
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

const CLOSE_SELF_CLIENT_DISCONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PostResponseAction {
    CloseSelf { source_id: Uuid },
}

struct DispatchOutcome {
    response: Response,
    post_response: Option<PostResponseAction>,
}

fn handle_connection<R: Runtime>(
    stream: Stream,
    app: &AppHandle<R>,
    state: &AppState,
) -> std::io::Result<()> {
    let peer_pid = match acorn_local_ipc::peer_process_id(&stream) {
        Ok(pid) => Some(pid),
        Err(error) => {
            tracing::warn!(error = %error, "ipc: kernel peer process id unavailable");
            None
        }
    };
    handle_connection_from_peer(stream, peer_pid, app, state)
}

fn handle_connection_from_peer<R: Runtime>(
    mut stream: Stream,
    peer_pid: Option<u32>,
    app: &AppHandle<R>,
    state: &AppState,
) -> std::io::Result<()> {
    let Some(line) = read_request_line(
        &mut acorn_local_ipc::NonblockingStreamReader::new(&mut stream),
        CONNECTION_IO_TIMEOUT,
    )?
    else {
        return Ok(());
    };
    let outcome = match serde_json::from_str::<Envelope>(line.trim_end()) {
        Ok(envelope) => dispatch_connection(envelope, peer_pid, app, state),
        Err(err) => DispatchOutcome {
            response: Response::Error {
                code: ErrorCode::Invalid,
                message: format!("malformed request: {err}"),
            },
            post_response: None,
        },
    };
    let out = serialize_response_bounded(&outcome.response);
    let write_result = write_with_deadline(&mut stream, &out, CONNECTION_IO_TIMEOUT);
    if write_result.is_ok() {
        if outcome.post_response.is_some() {
            wait_for_close_self_client_disconnect(&mut stream);
        }
        if let Some(action) = outcome.post_response {
            execute_post_response(action, app, state);
        }
    }
    write_result
}

fn dispatch_connection<R: Runtime>(
    envelope: Envelope,
    peer_pid: Option<u32>,
    app: &AppHandle<R>,
    state: &AppState,
) -> DispatchOutcome {
    let close_self_source = matches!(&envelope.request, Request::CloseSelf)
        .then(|| Uuid::parse_str(&envelope.source_session_id).ok())
        .flatten();
    let response = dispatch(envelope, peer_pid, app, state);
    let post_response = if matches!(response, Response::Ack) {
        close_self_source.map(|source_id| PostResponseAction::CloseSelf { source_id })
    } else {
        None
    };
    DispatchOutcome {
        response,
        post_response,
    }
}

fn wait_for_close_self_client_disconnect(stream: &mut Stream) {
    let deadline = Instant::now() + CLOSE_SELF_CLIENT_DISCONNECT_TIMEOUT;
    let mut unexpected = [0_u8; 1];
    loop {
        match stream.read(&mut unexpected) {
            Ok(0) => return,
            Ok(_) => {
                tracing::warn!("ipc: close-self client sent data after the response");
                return;
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    tracing::warn!("ipc: close-self client did not disconnect after the response");
                    return;
                }
                std::thread::sleep(CONNECTION_POLL_INTERVAL);
            }
            Err(err) => {
                tracing::warn!(error = %err, "ipc: close-self client disconnect wait failed");
                return;
            }
        }
    }
}

fn execute_post_response<R: Runtime>(
    action: PostResponseAction,
    app: &AppHandle<R>,
    state: &AppState,
) {
    let result = match action {
        PostResponseAction::CloseSelf { source_id } => {
            let source = match state.sessions.get(&source_id) {
                Ok(source) => source,
                Err(err) => {
                    tracing::warn!(%source_id, error = %err, "ipc: close-self source disappeared");
                    return;
                }
            };
            let sessions_to_remove = session_removal_cascade(state, &source);
            remove_ipc_sessions(&sessions_to_remove, app, state)
        }
    };
    if let Err(err) = result {
        tracing::error!(error = %err, "ipc: post-response action failed");
    }
}

fn read_request_line<R: Read>(
    reader: &mut R,
    timeout: Duration,
) -> std::io::Result<Option<String>> {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) if bytes.is_empty() => return Ok(None),
            Ok(0) => break,
            Ok(read) => {
                let end = chunk[..read]
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(read, |index| index + 1);
                if bytes.len().saturating_add(end) > MAX_REQUEST_FRAME_BYTES {
                    return Err(std::io::Error::new(
                        ErrorKind::InvalidData,
                        format!("IPC request exceeds {MAX_REQUEST_FRAME_BYTES}-byte limit"),
                    ));
                }
                bytes.extend_from_slice(&chunk[..end]);
                if end < read || bytes.last() == Some(&b'\n') {
                    break;
                }
            }
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        ErrorKind::TimedOut,
                        "IPC request read timed out",
                    ));
                }
                std::thread::sleep(CONNECTION_POLL_INTERVAL);
            }
            Err(err) => return Err(err),
        }
    }
    String::from_utf8(bytes).map(Some).map_err(|err| {
        std::io::Error::new(
            ErrorKind::InvalidData,
            format!("IPC request is not UTF-8: {err}"),
        )
    })
}

struct BoundedResponseWriter {
    bytes: Vec<u8>,
}

impl Write for BoundedResponseWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(buf.len()) > MAX_RESPONSE_FRAME_BYTES - 1 {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                format!("IPC response exceeds {MAX_RESPONSE_FRAME_BYTES}-byte limit"),
            ));
        }
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialize_response_bounded(response: &Response) -> Vec<u8> {
    let mut writer = BoundedResponseWriter { bytes: Vec::new() };
    if serde_json::to_writer(&mut writer, response).is_err() {
        writer.bytes =
            b"{\"kind\":\"error\",\"code\":\"internal\",\"message\":\"response exceeded the IPC size limit\"}"
                .to_vec();
    }
    writer.bytes.push(b'\n');
    writer.bytes
}

fn write_with_deadline<W: Write>(
    writer: &mut W,
    bytes: &[u8],
    timeout: Duration,
) -> std::io::Result<()> {
    let deadline = Instant::now() + timeout;
    let mut written = 0;
    while written < bytes.len() {
        match writer.write(&bytes[written..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    ErrorKind::WriteZero,
                    "IPC response writer accepted no bytes",
                ));
            }
            Ok(count) => written += count,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        ErrorKind::TimedOut,
                        "IPC response write timed out",
                    ));
                }
                std::thread::sleep(CONNECTION_POLL_INTERVAL);
            }
            Err(err) => return Err(err),
        }
    }
    loop {
        match writer.flush() {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        ErrorKind::TimedOut,
                        "IPC response flush timed out",
                    ));
                }
                std::thread::sleep(CONNECTION_POLL_INTERVAL);
            }
            Err(err) => return Err(err),
        }
    }
}

/// Top-level request dispatch. Every request resolves the source session and
/// enforces the "must be Control" gate before invoking command-specific
/// handlers. Control authority is granted only when Acorn creates the session;
/// code running inside a regular repository terminal cannot self-promote.
fn dispatch<R: Runtime>(
    envelope: Envelope,
    peer_pid: Option<u32>,
    app: &AppHandle<R>,
    state: &AppState,
) -> Response {
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Response::Error {
            code: ErrorCode::Invalid,
            message: format!(
                "unsupported protocol version {} (server speaks {})",
                envelope.protocol_version, PROTOCOL_VERSION
            ),
        };
    }
    if let Err(response) = authenticate_source_process(&envelope, peer_pid, state) {
        return response;
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
        Request::PromoteSelf => handle_promote_self(&source),
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
        Request::CloseSelf => Response::Ack,
        Request::KillSession {
            target_session_id,
            allow_foreign,
        } => handle_kill_session(&source, &target_session_id, allow_foreign, app, state),
    }
}

fn authenticate_source_process(
    envelope: &Envelope,
    peer_pid: Option<u32>,
    state: &AppState,
) -> Result<(), Response> {
    let source_id = Uuid::parse_str(&envelope.source_session_id).map_err(|_| Response::Error {
        code: ErrorCode::Unauthorized,
        message: "source session identity is invalid".to_string(),
    })?;
    state
        .sessions
        .get(&source_id)
        .map_err(|_| Response::Error {
            code: ErrorCode::Unauthorized,
            message: "source session is not live".to_string(),
        })?;
    let peer_pid = peer_pid.ok_or_else(|| Response::Error {
        code: ErrorCode::Unauthorized,
        message: "the operating system did not identify the IPC peer process".to_string(),
    })?;
    let root_pid =
        crate::commands::session_root_pid(state, &source_id).ok_or_else(|| Response::Error {
            code: ErrorCode::Unauthorized,
            message: "source session has no live PTY process".to_string(),
        })?;
    if !acorn_platform::process::is_descendant_or_same(root_pid, peer_pid) {
        return Err(Response::Error {
            code: ErrorCode::Unauthorized,
            message: "IPC peer is outside the source session process tree".to_string(),
        });
    }
    verify_or_bind_session_capability(state, source_id, &envelope.session_capability)
}

fn verify_or_bind_session_capability(
    state: &AppState,
    source_id: Uuid,
    raw_capability: &str,
) -> Result<(), Response> {
    let capability = Uuid::parse_str(raw_capability).map_err(|_| Response::Error {
        code: ErrorCode::Unauthorized,
        message: "source session capability is invalid".to_string(),
    })?;
    let mut capabilities = state.ipc_session_capabilities.lock();
    match capabilities.get(&source_id) {
        Some(expected) if expected == &capability => Ok(()),
        Some(_) => Err(Response::Error {
            code: ErrorCode::Unauthorized,
            message: "source session capability does not match".to_string(),
        }),
        None => {
            // A daemon PTY can outlive the app. Kernel-verified ancestry above
            // is the authority that permits binding its inherited token into
            // the fresh in-process registry after an app restart.
            capabilities.insert(source_id, capability);
            Ok(())
        }
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
        Request::CloseSelf => "close-self",
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

fn handle_promote_self(session: &Session) -> Response {
    Response::SelfPromoted {
        session_id: session.id.to_string(),
        already_control: true,
        context: control_context_text(),
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
            message: "target session belongs to a different project than the control session"
                .to_string(),
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

fn handle_context(_source: &Session) -> Response {
    Response::Context {
        text: control_context_text(),
    }
}

fn control_context_text() -> String {
    primer::primer().to_string()
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
    let name = match crate::commands::validate_display_name(&name, "session name") {
        Ok(name) => name,
        Err(error) => {
            return Response::Error {
                code: ErrorCode::Invalid,
                message: error.to_string(),
            };
        }
    };
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
        match create_unique_project_worktree(&repo, &base) {
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
    crate::commands::ensure_project_for_root(state, &repo);
    if let Err(err) = persistence::save_sessions(&state.sessions) {
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
    if let Err(message) = remove_ipc_sessions(&sessions_to_remove, app, state) {
        return Response::Error {
            code: ErrorCode::Internal,
            message,
        };
    }
    Response::Ack
}

fn remove_ipc_sessions<R: Runtime>(
    sessions_to_remove: &[Session],
    app: &AppHandle<R>,
    state: &AppState,
) -> Result<(), String> {
    for session in sessions_to_remove {
        terminate_session_runtime(state, &session.id)
            .map_err(|err| format!("terminate {} failed: {err}", session.id))?;
    }
    for session in sessions_to_remove {
        state
            .sessions
            .remove(&session.id)
            .map_err(|err| format!("remove {} failed: {err}", session.id))?;
    }
    if let Err(err) = persistence::save_sessions(&state.sessions) {
        tracing::warn!(error = %err, "ipc: persist after session removal failed");
    }
    for session in sessions_to_remove {
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use acorn_session::SessionStatus;
    use std::io::{BufRead, BufReader, Cursor};
    use std::path::PathBuf;
    use tauri::Manager;

    #[cfg(unix)]
    const CLOSE_SELF_TEST_ROLE: &str = "ACORN_CLOSE_SELF_TEST_ROLE";
    #[cfg(unix)]
    const CLOSE_SELF_TEST_DIRECTORY: &str = "ACORN_CLOSE_SELF_TEST_DIRECTORY";

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

    #[cfg(unix)]
    #[test]
    fn bind_listener_surfaces_socket_parent_access_errors() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("blocked");
        let socket = blocked.join("ipc.sock");
        std::fs::create_dir(&blocked).unwrap();
        let original = std::fs::metadata(&blocked).unwrap().permissions();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let result = bind_listener(&socket);

        let denied = matches!(
            std::fs::metadata(&socket),
            Err(ref error) if error.kind() == std::io::ErrorKind::PermissionDenied
        );
        std::fs::set_permissions(&blocked, original).unwrap();
        if denied {
            let error = result.expect_err("a denied socket parent must fail");
            assert!(error.contains("could not bind the IPC socket"));
            assert!(error.contains(&socket.display().to_string()));
        }
    }

    #[test]
    fn request_reader_enforces_the_frame_limit() {
        let mut exact = vec![b'x'; MAX_REQUEST_FRAME_BYTES - 1];
        exact.push(b'\n');
        let line = read_request_line(&mut Cursor::new(exact), Duration::ZERO)
            .unwrap()
            .expect("line");
        assert_eq!(line.len(), MAX_REQUEST_FRAME_BYTES);

        let mut oversized = vec![b'x'; MAX_REQUEST_FRAME_BYTES];
        oversized.push(b'\n');
        let error = read_request_line(&mut Cursor::new(oversized), Duration::ZERO).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
    }

    #[test]
    fn response_serializer_replaces_oversized_payloads() {
        let response = Response::Context {
            text: "x".repeat(MAX_RESPONSE_FRAME_BYTES),
        };

        let serialized = serialize_response_bounded(&response);

        assert!(serialized.len() < MAX_RESPONSE_FRAME_BYTES);
        assert!(String::from_utf8(serialized)
            .unwrap()
            .contains("exceeded the IPC size limit"));
    }

    #[test]
    fn connection_permit_caps_and_releases_handlers() {
        let active = Arc::new(AtomicUsize::new(0));
        let first = ConnectionPermit::try_acquire(active.clone(), 1).expect("first permit");
        assert!(ConnectionPermit::try_acquire(active.clone(), 1).is_none());
        drop(first);
        assert!(ConnectionPermit::try_acquire(active.clone(), 1).is_some());
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
    fn close_self_requires_an_authorized_control_source() {
        let app = tauri::test::mock_builder()
            .manage(AppState::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app");
        let state = app.state::<AppState>().inner().clone();
        let regular =
            state
                .sessions
                .insert(make_session("/tmp/A", "regular", SessionKind::Regular));
        let outcome = dispatch_connection(
            Envelope {
                protocol_version: PROTOCOL_VERSION,
                source_session_id: regular.id.to_string(),
                session_capability: Uuid::new_v4().to_string(),
                request: Request::CloseSelf,
            },
            None,
            app.handle(),
            &state,
        );

        assert!(matches!(
            outcome.response,
            Response::Error {
                code: ErrorCode::Unauthorized,
                ..
            }
        ));
        assert_eq!(outcome.post_response, None);
        assert!(state.sessions.get(&regular.id).is_ok());
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

    #[cfg(unix)]
    #[test]
    fn close_self_runtime_helper() {
        if std::env::var(CLOSE_SELF_TEST_ROLE).as_deref() != Ok("helper") {
            return;
        }
        let scratch = PathBuf::from(
            std::env::var_os(CLOSE_SELF_TEST_DIRECTORY).expect("helper scratch directory"),
        );
        let app = tauri::test::mock_builder()
            .manage(AppState::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app");
        let state = app.state::<AppState>().inner().clone();
        state.daemon_bridge.set_enabled(false);

        let sibling =
            state
                .sessions
                .insert(make_session("/tmp/A", "unrelated", SessionKind::Regular));
        state
            .pty
            .spawn(
                app.handle().clone(),
                std::sync::Arc::new(|_, _, _| {}),
                sibling.id,
                scratch.clone(),
                "/bin/cat".to_string(),
                Vec::new(),
                |_| {},
                80,
                24,
                0,
                0,
            )
            .expect("spawn unrelated PTY");
        let sibling_pid = state.pty.child_pid(&sibling.id).expect("unrelated pid");
        let cycle_count = std::env::var("ACORN_CLOSE_SELF_TEST_CYCLES")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(12);

        let mut closed_ids = Vec::new();
        let mut closed_pids = Vec::new();
        for cycle in 0..cycle_count {
            let source = state.sessions.insert(make_session(
                "/tmp/A",
                &format!("controller-{cycle}"),
                SessionKind::Control,
            ));
            let worker = state.sessions.insert({
                let mut session =
                    make_session("/tmp/A", &format!("worker-{cycle}"), SessionKind::Regular);
                session.owner = SessionOwner::control(source.id);
                session
            });
            let descendant_pid_path = scratch.join(format!("descendant-{cycle}.pid"));
            state
                .pty
                .spawn(
                    app.handle().clone(),
                    std::sync::Arc::new(|_, _, _| {}),
                    source.id,
                    scratch.clone(),
                    "/bin/sh".to_string(),
                    vec![
                        "-c".to_string(),
                        format!(
                            "sleep 30 & echo $! > '{}' && wait",
                            descendant_pid_path.display()
                        ),
                    ],
                    |_| {},
                    80,
                    24,
                    0,
                    0,
                )
                .expect("spawn source PTY tree");
            state
                .pty
                .spawn(
                    app.handle().clone(),
                    std::sync::Arc::new(|_, _, _| {}),
                    worker.id,
                    scratch.clone(),
                    "/bin/cat".to_string(),
                    Vec::new(),
                    |_| {},
                    80,
                    24,
                    0,
                    0,
                )
                .expect("spawn owned worker PTY");

            wait_until(Duration::from_secs(5), || descendant_pid_path.exists());
            let descendant_pid = std::fs::read_to_string(&descendant_pid_path)
                .expect("read descendant pid")
                .trim()
                .parse::<u32>()
                .expect("parse descendant pid");
            let source_pid = state.pty.child_pid(&source.id).expect("source pid");
            let worker_pid = state.pty.child_pid(&worker.id).expect("worker pid");
            assert!(pid_is_alive(source_pid));
            assert!(pid_is_alive(descendant_pid));
            assert!(pid_is_alive(worker_pid));

            let endpoint = scratch.join(format!("close-self-{cycle}.sock"));
            let listener = acorn_local_ipc::bind(&endpoint).expect("bind close-self endpoint");
            let server = std::thread::spawn({
                let app_handle = app.handle().clone();
                let state = state.clone();
                move || {
                    let stream = listener.accept().expect("accept close-self client");
                    handle_connection_from_peer(stream, Some(source_pid), &app_handle, &state)
                        .expect("handle close-self request");
                }
            });
            let mut client =
                acorn_local_ipc::connect(&endpoint).expect("connect close-self client");
            let envelope = Envelope {
                protocol_version: PROTOCOL_VERSION,
                source_session_id: source.id.to_string(),
                session_capability: Uuid::new_v4().to_string(),
                request: Request::CloseSelf,
            };
            let mut request = serde_json::to_vec(&envelope).expect("encode close-self request");
            request.push(b'\n');
            client
                .write_all(&request)
                .expect("write close-self request");
            client.flush().expect("flush close-self request");
            let mut client = BufReader::new(client);
            let mut response_line = String::new();
            client
                .read_line(&mut response_line)
                .expect("read close-self response");
            let response: Response =
                serde_json::from_str(response_line.trim()).expect("decode close-self response");
            assert_eq!(response, Response::Ack);

            assert!(
                state.pty.contains(&source.id),
                "source PTY must stay alive until the client drops the acknowledged socket"
            );
            assert!(state.sessions.get(&source.id).is_ok());
            drop(client);
            server.join().expect("close-self server thread");
            acorn_local_ipc::cleanup(&endpoint);

            wait_until(Duration::from_secs(5), || {
                !state.pty.contains(&source.id)
                    && !state.pty.contains(&worker.id)
                    && !pid_is_alive(source_pid)
                    && !pid_is_alive(descendant_pid)
                    && !pid_is_alive(worker_pid)
            });
            assert!(state.sessions.get(&source.id).is_err());
            assert!(state.sessions.get(&worker.id).is_err());
            assert!(state.sessions.get(&sibling.id).is_ok());
            assert!(state.pty.contains(&sibling.id));
            assert!(pid_is_alive(sibling_pid));

            closed_ids.extend([source.id, worker.id]);
            closed_pids.extend([source_pid, descendant_pid, worker_pid]);
        }

        assert_eq!(state.sessions.list().len(), 1);
        assert!(closed_ids.iter().all(|id| !state.pty.contains(id)));
        assert!(closed_pids.iter().all(|pid| !pid_is_alive(*pid)));
        assert!(state.pty.contains(&sibling.id));
        assert!(pid_is_alive(sibling_pid));

        state
            .pty
            .kill(&sibling.id)
            .expect("kill unrelated test PTY");
        wait_until(Duration::from_secs(5), || {
            !state.pty.contains(&sibling.id) && !pid_is_alive(sibling_pid)
        });
        std::thread::sleep(Duration::from_millis(500));
    }

    #[cfg(unix)]
    #[test]
    fn close_self_repeatedly_releases_process_trees_and_preserves_unrelated_sessions() {
        let scratch = tempfile::tempdir().expect("create close-self scratch directory");
        let status = std::process::Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "ipc::server::tests::close_self_runtime_helper",
                "--nocapture",
            ])
            .env(CLOSE_SELF_TEST_ROLE, "helper")
            .env(CLOSE_SELF_TEST_DIRECTORY, scratch.path())
            .env(
                acorn_paths::ENV_DATA_DIR_OVERRIDE,
                scratch.path().join("data"),
            )
            .status()
            .expect("run close-self helper");

        assert!(
            status.success(),
            "close-self runtime helper failed: {status}"
        );
    }

    #[cfg(unix)]
    fn wait_until(timeout: Duration, condition: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + timeout;
        while !condition() {
            assert!(
                std::time::Instant::now() < deadline,
                "condition did not become true before {timeout:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        let Ok(pid) = i32::try_from(pid) else {
            return false;
        };
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
    }

    #[test]
    fn promote_self_is_idempotent_for_an_existing_control_session() {
        let ctl = make_session("/tmp/A", "ctl", SessionKind::Control);
        match handle_promote_self(&ctl) {
            Response::SelfPromoted {
                session_id,
                already_control,
                ..
            } => {
                assert_eq!(session_id, ctl.id.to_string());
                assert!(already_control);
            }
            other => panic!("expected idempotent control response, got {other:?}"),
        }
    }

    #[test]
    fn session_capability_binds_once_and_rejects_replacement() {
        let state = AppState::new();
        let source_id = Uuid::new_v4();
        let first = Uuid::new_v4();
        let replacement = Uuid::new_v4();

        assert!(verify_or_bind_session_capability(&state, source_id, &first.to_string()).is_ok());
        assert!(verify_or_bind_session_capability(&state, source_id, &first.to_string()).is_ok());
        assert!(
            verify_or_bind_session_capability(&state, source_id, &replacement.to_string()).is_err()
        );
    }

    #[test]
    fn process_ancestry_accepts_the_same_live_process() {
        let pid = std::process::id();
        assert!(acorn_platform::process::is_descendant_or_same(pid, pid));
        assert!(!acorn_platform::process::is_descendant_or_same(0, pid));
    }
}
