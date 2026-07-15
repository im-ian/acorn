use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use acorn_session::{SessionAgentProvider, SessionStatus, SessionStore};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

pub const AGENT_HOOK_STATUS_EVENT: &str = "acorn:agent-hook-status";

const HOOK_PATH: &str = "/agent-hook";
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const READ_TIMEOUT: Duration = Duration::from_secs(2);

type HookEventHandler = Arc<dyn Fn(AgentHookEvent) + Send + Sync + 'static>;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AgentHookEvent {
    pub session_id: Uuid,
    pub provider: SessionAgentProvider,
    pub event: AgentHookEventKind,
    pub message: Option<String>,
    pub source: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentHookEventKind {
    Start,
    Stop,
    NeedsInput,
    Error,
}

impl AgentHookEventKind {
    pub fn session_status(self) -> SessionStatus {
        match self {
            Self::Start => SessionStatus::Working,
            Self::NeedsInput => SessionStatus::WaitingForInput,
            Self::Stop => SessionStatus::Ready,
            Self::Error => SessionStatus::Errored,
        }
    }
}

pub fn apply_agent_hook_event(
    sessions: &SessionStore,
    event: AgentHookEvent,
) -> Result<SessionStatus, String> {
    let session = sessions
        .get(&event.session_id)
        .map_err(|_| format!("session not found: {}", event.session_id))?;
    // A terminal can carry stale live-provider metadata from a resting agent.
    // Accept a provider switch only from a resting session; while the owner is
    // Working, mismatched provider events are nested agent activity.
    if let Some(provider) = session.agent_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session = event.event == AgentHookEventKind::Start
                && session.status != SessionStatus::Working;
            if !provider_switch_from_resting_session {
                return Err(format!(
                    "provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                ));
            }
        }
    }
    if let Some(provider) = session.hook_provider {
        if provider != event.provider {
            let provider_switch_from_resting_session = event.event == AgentHookEventKind::Start
                && session.status != SessionStatus::Working;
            if !provider_switch_from_resting_session {
                return Err(format!(
                    "hook provider mismatch for {}: expected {:?}, got {:?}",
                    event.session_id, provider, event.provider
                ));
            }
        }
    }

    // The TUI recorder is an asynchronous compatibility preview and can lag
    // behind native UserPromptSubmit or Stop. PTY writes and native hooks own
    // the real transition, so a delayed preview must never overwrite them.
    if event.provider == SessionAgentProvider::Codex && event.source.as_deref() == Some("preview") {
        return Ok(session.status);
    }

    let is_codex = event.provider == SessionAgentProvider::Codex;
    let is_codex_native_source =
        is_codex && matches!(event.source.as_deref(), Some("turn" | "tool" | "hook"));
    let scoped_codex_turn_id = is_codex_native_source
        .then_some(event.turn_id.as_deref())
        .flatten()
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty());
    let is_codex_user_boundary = is_codex
        && event.event == AgentHookEventKind::Start
        && event.source.as_deref() == Some("turn");

    // UserPromptSubmit is the authoritative owner boundary. The asynchronous
    // TUI preview only makes Working visible sooner: allowing a delayed
    // preview to clear this id could erase a native hook that already arrived.
    if is_codex_user_boundary {
        sessions.begin_hook_turn(&event.session_id, scoped_codex_turn_id);
    } else if let Some(turn_id) = scoped_codex_turn_id {
        let current_turn_id = sessions.hook_turn_id(&event.session_id);
        let has_turn_boundary = sessions.has_hook_turn_boundary(&event.session_id);
        match current_turn_id.as_deref() {
            Some(current_turn_id) if current_turn_id != turn_id => {
                return Err(format!(
                    "stale Codex turn event for {}: current {}, got {}",
                    event.session_id, current_turn_id, turn_id
                ));
            }
            None if !has_turn_boundary
                || (event.event == AgentHookEventKind::Start
                    && event.source.as_deref() == Some("tool")) =>
            {
                // Runtime turn ownership is intentionally not persisted. The
                // first trusted scoped event after an app restart reattaches
                // the still-running turn; a PreToolUse may arrive before Stop.
                // A tool start may also fill a pending id-less user boundary.
                sessions.begin_hook_turn(&event.session_id, Some(turn_id));
            }
            _ => {}
        }
    }

    if is_codex
        && event.event == AgentHookEventKind::NeedsInput
        && event.source.as_deref() == Some("legacy")
        && sessions.has_hook_turn_boundary(&event.session_id)
    {
        return Err(format!(
            "legacy Codex completion cannot override a native turn for {}",
            event.session_id
        ));
    }

    if is_codex_native_source
        && event.event == AgentHookEventKind::NeedsInput
        && scoped_codex_turn_id.is_none()
        && sessions.has_hook_turn_boundary(&event.session_id)
    {
        return Err(format!(
            "unscoped Codex completion cannot override a native turn for {}",
            event.session_id
        ));
    }

    let scoped_codex_completion = (is_codex_native_source
        && event.event == AgentHookEventKind::NeedsInput)
        .then_some(scoped_codex_turn_id)
        .flatten();
    if let Some(turn_id) = scoped_codex_completion {
        let current_turn_id = sessions.hook_turn_id(&event.session_id);
        if current_turn_id.as_deref() != Some(turn_id) {
            return Err(format!(
                "stale Codex turn completion for {}: current {:?}, got {}",
                event.session_id, current_turn_id, turn_id
            ));
        }
    }

    // Mark native hook channels live so the transcript-tail status poll
    // defers turn-boundary classification to them instead of clobbering a
    // just-set resting status (Ready/WaitingForInput) back to Working on its
    // next tick. Transcript-derived wrapper observations are only a low-latency
    // preview of the same data the poll reads. Treating those as an
    // authoritative hook would make a missed line, owner rotation, or watcher
    // restart permanently hide the fresher transcript classification.
    // See `poll_defers_to_hook` in `commands`.
    let is_authoritative_hook = event.source.as_deref() != Some("transcript");
    let hook_revision =
        is_authoritative_hook.then(|| sessions.mark_hook_active(&event.session_id, event.provider));

    // The Codex JSONL watcher tags task and exec starts separately. This
    // runtime-only turn evidence lets the process poll distinguish a real
    // background command from helpers that live for the whole Codex session.
    // Generic native hook events intentionally do not reset this marker: they
    // arrive through a separate channel and can race the ordered JSONL tail.
    if event.provider == SessionAgentProvider::Codex
        && event.event == AgentHookEventKind::Start
        && event.source.as_deref() == Some("tool")
    {
        sessions.mark_hook_tool_started_at(&event.session_id, SystemTime::now());
    }

    let status = event.event.session_status();
    if let (Some(turn_id), Some(revision)) = (scoped_codex_completion, hook_revision) {
        if sessions.hook_turn_id(&event.session_id).as_deref() != Some(turn_id) {
            return Err(format!(
                "stale Codex turn completion for {}: owner changed before apply",
                event.session_id
            ));
        }
        let applied = sessions
            .refresh_status_if_hook_revision(&event.session_id, session.status, revision, status)
            .map_err(|err| err.to_string())?;
        if !applied {
            return Err(format!(
                "stale Codex turn completion for {}: superseded before apply",
                event.session_id
            ));
        }
    } else {
        sessions
            .refresh_status(&event.session_id, status)
            .map_err(|err| err.to_string())?;
    }
    Ok(status)
}

pub struct AgentHookServer {
    hook_url: String,
    token: String,
    running: Arc<AtomicBool>,
    listener_thread: Option<std::thread::JoinHandle<()>>,
}

impl AgentHookServer {
    #[cfg(test)]
    pub fn start() -> io::Result<Self> {
        Self::start_with_handler(|_| {})
    }

    pub fn start_with_handler<F>(handler: F) -> io::Result<Self>
    where
        F: Fn(AgentHookEvent) + Send + Sync + 'static,
    {
        Self::start_with_token_and_handler(
            uuid::Uuid::new_v4().simple().to_string(),
            Arc::new(handler),
        )
    }

    pub fn hook_url(&self) -> &str {
        &self.hook_url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    fn start_with_token_and_handler(token: String, handler: HookEventHandler) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        let hook_url = format!("http://{addr}{HOOK_PATH}");

        // Connections are parsed concurrently, but the application callback
        // applies state, persists the complete session list, and emits a UI
        // notification as one logical pipeline. Keep those side effects from
        // overlapping and writing snapshots out of order.
        let pipeline_lock = Arc::new(Mutex::new(()));
        let handler: HookEventHandler = Arc::new(move |event| {
            let _pipeline_guard = pipeline_lock.lock();
            handler(event);
        });

        let running = Arc::new(AtomicBool::new(true));
        let running_for_thread = running.clone();
        let token_for_thread = token.clone();
        let listener_thread = std::thread::Builder::new()
            .name("acorn-agent-hooks".to_string())
            .spawn(move || run_listener(listener, token_for_thread, handler, running_for_thread))?;

        Ok(Self {
            hook_url,
            token,
            running,
            listener_thread: Some(listener_thread),
        })
    }
}

impl Drop for AgentHookServer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(listener_thread) = self.listener_thread.take() {
            if listener_thread.join().is_err() {
                tracing::warn!("agent hook listener thread panicked during shutdown");
            }
        }
    }
}

fn run_listener(
    listener: TcpListener,
    token: String,
    handler: HookEventHandler,
    running: Arc<AtomicBool>,
) {
    while running.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                dispatch_connection(
                    stream,
                    token.clone(),
                    handler.clone(),
                    |stream, token, handler| {
                        std::thread::Builder::new()
                            .name("acorn-agent-hook-conn".to_string())
                            .spawn(move || {
                                if let Err(err) = handle_connection(stream, &token, &handler) {
                                    tracing::warn!(error = %err, "agent hook connection failed");
                                }
                            })
                            .map(|_| ())
                    },
                );
            }
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(err) => {
                tracing::warn!(error = %err, "agent hook accept failed");
                std::thread::sleep(ACCEPT_POLL_INTERVAL);
            }
        }
    }
}

fn dispatch_connection<F>(
    stream: TcpStream,
    token: String,
    handler: HookEventHandler,
    spawn_worker: F,
) where
    F: FnOnce(TcpStream, String, HookEventHandler) -> io::Result<()>,
{
    let fallback_stream = stream.try_clone();
    if let Err(spawn_error) = spawn_worker(stream, token.clone(), handler.clone()) {
        tracing::warn!(
            error = %spawn_error,
            "agent hook worker thread failed to start; handling request inline"
        );
        match fallback_stream {
            Ok(stream) => {
                if let Err(err) = handle_connection(stream, &token, &handler) {
                    tracing::warn!(error = %err, "inline agent hook connection failed");
                }
            }
            Err(clone_error) => {
                tracing::warn!(
                    error = %clone_error,
                    "agent hook connection could not be retained for inline fallback"
                );
            }
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    handler: &HookEventHandler,
) -> io::Result<()> {
    // Accepted sockets can inherit the listener's nonblocking mode. Restore
    // blocking reads so a temporarily empty receive buffer is not mistaken
    // for the end of an HTTP request.
    stream.set_nonblocking(false)?;
    if let Ok(addr) = stream.peer_addr() {
        if !addr.ip().is_loopback() {
            let status = HttpStatus::Forbidden;
            return write_response(&mut stream, status.code(), status.reason());
        }
    }
    stream.set_read_timeout(Some(READ_TIMEOUT))?;

    let mut request = Vec::new();
    let status = match read_request(&mut stream, &mut request) {
        Ok(()) => validate_request(&request, token, handler),
        Err(ReadRequestError::TooLarge) => HttpStatus::PayloadTooLarge,
        Err(ReadRequestError::Io(err)) => return Err(err),
    };

    write_response(&mut stream, status.code(), status.reason())
}

enum ReadRequestError {
    TooLarge,
    Io(io::Error),
}

fn read_request(stream: &mut TcpStream, request: &mut Vec<u8>) -> Result<(), ReadRequestError> {
    let mut buf = [0_u8; 1024];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                request.extend_from_slice(&buf[..n]);
                if request.len() > MAX_HEADER_BYTES + MAX_BODY_BYTES {
                    return Err(ReadRequestError::TooLarge);
                }
                if request_complete(request)? {
                    return Ok(());
                }
            }
            Err(err)
                if matches!(
                    err.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(());
            }
            Err(err) => return Err(ReadRequestError::Io(err)),
        }
    }
}

fn request_complete(request: &[u8]) -> Result<bool, ReadRequestError> {
    let Some(header_end) = find_header_end(request) else {
        if request.len() > MAX_HEADER_BYTES {
            return Err(ReadRequestError::TooLarge);
        }
        return Ok(false);
    };
    if header_end.saturating_add(4) > MAX_HEADER_BYTES {
        return Err(ReadRequestError::TooLarge);
    }
    let head = String::from_utf8_lossy(&request[..header_end]);
    let content_length = header_value(&head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY_BYTES {
        return Err(ReadRequestError::TooLarge);
    }
    Ok(request.len() >= header_end + 4 + content_length)
}

fn validate_request(request: &[u8], token: &str, handler: &HookEventHandler) -> HttpStatus {
    let Some(header_end) = find_header_end(request) else {
        return HttpStatus::BadRequest;
    };
    let Ok(head) = std::str::from_utf8(&request[..header_end]) else {
        return HttpStatus::BadRequest;
    };
    let mut lines = head.split("\r\n");
    let Some(request_line) = lines.next() else {
        return HttpStatus::BadRequest;
    };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    if path != HOOK_PATH {
        return HttpStatus::NotFound;
    }
    if method != "POST" {
        return HttpStatus::MethodNotAllowed;
    }
    match header_value(head, "x-acorn-agent-hook-token") {
        Some(value) if value == token => {}
        _ => return HttpStatus::Unauthorized,
    }
    let body_start = header_end + 4;
    let content_length = header_value(head, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let body_end = body_start.saturating_add(content_length);
    let body = request.get(body_start..body_end).unwrap_or_default();
    let event = match parse_agent_hook_request(head, body) {
        Ok(Some(event)) => event,
        Ok(None) => return HttpStatus::NoContent,
        Err(err) => {
            tracing::warn!(error = %err, "agent hook payload rejected");
            return HttpStatus::BadRequest;
        }
    };
    handler(event);
    HttpStatus::NoContent
}

fn parse_agent_hook_request(head: &str, body: &[u8]) -> Result<Option<AgentHookEvent>, String> {
    match header_value(head, "x-acorn-agent-hook-provider") {
        Some("codex") => parse_raw_codex_hook_request(head, body),
        Some(provider) => Err(format!("unsupported raw hook provider: {provider}")),
        None => serde_json::from_slice::<AgentHookEvent>(body)
            .map(Some)
            .map_err(|err| err.to_string()),
    }
}

fn parse_raw_codex_hook_request(head: &str, body: &[u8]) -> Result<Option<AgentHookEvent>, String> {
    if header_value(head, "x-acorn-agent-hook-source") != Some("native") {
        return Err("unsupported Codex hook source".to_string());
    }
    let session_id = header_value(head, "x-acorn-agent-hook-session-id")
        .ok_or_else(|| "missing Acorn session id".to_string())?
        .parse::<Uuid>()
        .map_err(|_| "invalid Acorn session id".to_string())?;
    let payload = serde_json::from_slice::<Value>(body).map_err(|err| err.to_string())?;
    let hook_event_name = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex hook payload has no hook_event_name".to_string())?;
    let turn_id = payload
        .get("turn_id")
        .and_then(Value::as_str)
        .filter(|value| Uuid::parse_str(value).is_ok())
        .ok_or_else(|| "Codex hook payload has no valid turn_id".to_string())?;

    let (event, source, requires_explicit_owner) = match hook_event_name {
        "UserPromptSubmit" => (AgentHookEventKind::Start, "turn", true),
        "PreToolUse" => (AgentHookEventKind::Start, "tool", true),
        "PermissionRequest" => (AgentHookEventKind::NeedsInput, "hook", true),
        "Stop" => (AgentHookEventKind::NeedsInput, "hook", false),
        other => return Err(format!("unsupported Codex hook event: {other}")),
    };
    if requires_explicit_owner
        && (!payload.get("agent_id").is_some_and(Value::is_null)
            || !payload.get("agent_type").is_some_and(Value::is_null))
    {
        return Ok(None);
    }

    Ok(Some(AgentHookEvent {
        session_id,
        provider: SessionAgentProvider::Codex,
        event,
        message: None,
        source: Some(source.to_string()),
        turn_id: Some(turn_id.to_string()),
    }))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    for line in head.split("\r\n").skip(1) {
        let (raw_name, raw_value) = line.split_once(':')?;
        if raw_name.eq_ignore_ascii_case(name) {
            return Some(raw_value.trim());
        }
    }
    None
}

enum HttpStatus {
    NoContent,
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    MethodNotAllowed,
    PayloadTooLarge,
}

impl HttpStatus {
    fn code(&self) -> u16 {
        match self {
            Self::NoContent => 204,
            Self::BadRequest => 400,
            Self::Unauthorized => 401,
            Self::Forbidden => 403,
            Self::NotFound => 404,
            Self::MethodNotAllowed => 405,
            Self::PayloadTooLarge => 413,
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::NoContent => "No Content",
            Self::BadRequest => "Bad Request",
            Self::Unauthorized => "Unauthorized",
            Self::Forbidden => "Forbidden",
            Self::NotFound => "Not Found",
            Self::MethodNotAllowed => "Method Not Allowed",
            Self::PayloadTooLarge => "Payload Too Large",
        }
    }
}

fn write_response(stream: &mut TcpStream, code: u16, reason: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        apply_agent_hook_event, dispatch_connection, handle_connection, AgentHookEvent,
        AgentHookEventKind, AgentHookServer, HookEventHandler, MAX_HEADER_BYTES,
    };
    use acorn_session::{Session, SessionAgentProvider, SessionKind, SessionStatus};
    use std::io::{self, Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use uuid::Uuid;

    #[test]
    fn hook_server_exposes_local_url_and_token() {
        let hooks = AgentHookServer::start().expect("hook server starts");

        assert!(hooks.hook_url().starts_with("http://127.0.0.1:"));
        assert!(hooks.hook_url().ends_with("/agent-hook"));
        assert!(!hooks.token().is_empty());
    }

    #[test]
    fn hook_server_serializes_handler_side_effects() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let hooks = Arc::new(
            AgentHookServer::start_with_handler(move |_| {
                entered_tx.send(()).expect("report handler entry");
                release_rx
                    .lock()
                    .expect("lock release receiver")
                    .recv_timeout(Duration::from_secs(2))
                    .expect("release handler");
            })
            .expect("hook server starts"),
        );
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );

        let first_hooks = hooks.clone();
        let first_body = body.clone();
        let first = std::thread::spawn(move || {
            let token = first_hooks.token().to_string();
            post(&first_hooks, &token, &first_body)
        });
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("first handler enters");

        let second_hooks = hooks.clone();
        let second = std::thread::spawn(move || {
            let token = second_hooks.token().to_string();
            post(&second_hooks, &token, &body)
        });
        let handlers_overlapped = entered_rx.recv_timeout(Duration::from_millis(500)).is_ok();

        release_tx.send(()).expect("release first handler");
        if handlers_overlapped {
            release_tx.send(()).expect("release second handler");
        } else {
            entered_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("second handler enters after first exits");
            release_tx.send(()).expect("release second handler");
        }

        assert!(first
            .join()
            .expect("first client")
            .starts_with("HTTP/1.1 204 No Content"));
        assert!(second
            .join()
            .expect("second client")
            .starts_with("HTTP/1.1 204 No Content"));
        assert!(
            !handlers_overlapped,
            "concurrent hook callbacks can reorder apply, persist, and emit"
        );
    }

    #[test]
    fn hook_server_drop_releases_the_listener_before_returning() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let addr = addr_from_url(hooks.hook_url());
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );
        assert!(post(&hooks, hooks.token(), &body).starts_with("HTTP/1.1 204 No Content"));

        std::thread::sleep(Duration::from_millis(20));
        drop(hooks);

        assert!(
            TcpStream::connect(addr).is_err(),
            "hook listener remained reachable after server drop"
        );
    }

    #[test]
    fn hook_connection_waits_for_bytes_on_an_inherited_nonblocking_socket() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "test-token".to_string();
        let (tx, rx) = mpsc::channel();
        let handler: HookEventHandler = Arc::new(move |event| {
            tx.send(event).expect("send event");
        });
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"start\"}}"
        );

        let client = std::thread::spawn(move || -> std::io::Result<String> {
            let mut stream = TcpStream::connect(addr)?;
            std::thread::sleep(Duration::from_millis(50));
            write!(
                stream,
                "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: test-token\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )?;
            let mut response = String::new();
            stream.read_to_string(&mut response)?;
            Ok(response)
        });

        let (stream, _) = listener.accept().expect("accept hook");
        stream
            .set_nonblocking(true)
            .expect("simulate inherited listener mode");
        handle_connection(stream, &token, &handler).expect("handle request");

        let response = client
            .join()
            .expect("client thread")
            .expect("request remains connected");
        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected delayed-request response: {response:?}"
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("event delivered")
                .session_id,
            session_id
        );
    }

    #[test]
    fn hook_connection_falls_back_inline_when_worker_spawn_fails() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let token = "test-token".to_string();
        let (tx, rx) = mpsc::channel();
        let handler: HookEventHandler = Arc::new(move |event| {
            tx.send(event).expect("send event");
        });
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"start\"}}"
        );

        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).expect("connect hook");
            write!(
                stream,
                "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: test-token\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .expect("write request");
            let mut response = String::new();
            stream.read_to_string(&mut response).expect("read response");
            response
        });

        let (stream, _) = listener.accept().expect("accept hook");
        dispatch_connection(stream, token, handler, |_, _, _| {
            Err(io::Error::other("forced worker spawn failure"))
        });

        assert!(client
            .join()
            .expect("client thread")
            .starts_with("HTTP/1.1 204 No Content"));
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("event delivered")
                .session_id,
            session_id
        );
    }

    #[test]
    fn hook_server_rejects_invalid_token_and_accepts_valid_token() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );

        let invalid = post(&hooks, "invalid", &body);
        assert!(invalid.starts_with("HTTP/1.1 401 Unauthorized"));

        let valid = post(&hooks, hooks.token(), &body);
        assert!(valid.starts_with("HTTP/1.1 204 No Content"));
    }

    #[test]
    fn hook_server_parses_valid_event_and_invokes_handler() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let body = format!(
            "{{\"session_id\":\"{session_id}\",\"provider\":\"codex\",\"event\":\"needs_input\",\"message\":\"ready\",\"source\":\"hook\"}}"
        );

        let response = post(&hooks, hooks.token(), &body);
        assert!(response.starts_with("HTTP/1.1 204 No Content"));

        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("event delivered");
        assert_eq!(event.session_id, session_id);
        assert_eq!(event.provider, SessionAgentProvider::Codex);
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.message.as_deref(), Some("ready"));
    }

    #[test]
    fn raw_codex_native_payloads_are_normalized_in_rust() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();
        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";

        for (hook_event_name, expected_event, expected_source) in [
            ("UserPromptSubmit", AgentHookEventKind::Start, "turn"),
            ("PreToolUse", AgentHookEventKind::Start, "tool"),
            ("PermissionRequest", AgentHookEventKind::NeedsInput, "hook"),
        ] {
            let body = serde_json::json!({
                "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
                "turn_id": turn_id,
                "hook_event_name": hook_event_name,
                "agent_id": null,
                "agent_type": null,
            })
            .to_string();
            let response = post_raw_codex_hook(&hooks, session_id, &body);
            assert!(
                response.starts_with("HTTP/1.1 204 No Content"),
                "unexpected {hook_event_name} response: {response:?}"
            );
            let event = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("native event delivered");
            assert_eq!(event.session_id, session_id);
            assert_eq!(event.event, expected_event);
            assert_eq!(event.source.as_deref(), Some(expected_source));
            assert_eq!(event.turn_id.as_deref(), Some(turn_id));
        }

        let stop = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": turn_id,
            "hook_event_name": "Stop",
        })
        .to_string();
        let response = post_raw_codex_hook(&hooks, session_id, &stop);
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        let event = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("Stop delivered");
        assert_eq!(event.event, AgentHookEventKind::NeedsInput);
        assert_eq!(event.source.as_deref(), Some("hook"));
        assert_eq!(event.turn_id.as_deref(), Some(turn_id));
    }

    #[test]
    fn raw_codex_native_payloads_fail_closed_for_unscoped_or_invalid_owners() {
        let (tx, rx) = mpsc::channel();
        let hooks = AgentHookServer::start_with_handler(move |event| {
            tx.send(event).expect("send event");
        })
        .expect("hook server starts");
        let session_id = Uuid::new_v4();

        for body in [
            serde_json::json!({
                "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
                "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
                "hook_event_name": "UserPromptSubmit",
                "agent_id": null,
            }),
            serde_json::json!({
                "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
                "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
                "hook_event_name": "PermissionRequest",
                "agent_id": "019f6322-41e5-7882-a99a-d186dff6739c",
                "agent_type": "worker",
            }),
        ] {
            let response = post_raw_codex_hook(&hooks, session_id, &body.to_string());
            assert!(response.starts_with("HTTP/1.1 204 No Content"));
            assert!(
                rx.try_recv().is_err(),
                "unscoped or child event reached the owner handler"
            );
        }

        let invalid_turn = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "not-a-turn-id",
            "hook_event_name": "Stop",
        })
        .to_string();
        let response = post_raw_codex_hook(&hooks, session_id, &invalid_turn);
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));
    }

    #[test]
    fn hook_server_accepts_large_documented_codex_payloads() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": "019f6338-6250-7303-88a6-a7add31dba1d",
            "hook_event_name": "UserPromptSubmit",
            "agent_id": null,
            "agent_type": null,
            "prompt": "x".repeat(32 * 1024),
        })
        .to_string();

        let response = post_raw_codex_hook(&hooks, Uuid::new_v4(), &body);
        assert!(
            response.starts_with("HTTP/1.1 204 No Content"),
            "unexpected large-payload response: {response:?}"
        );
    }

    #[test]
    fn hook_server_rejects_headers_over_the_documented_limit() {
        let hooks = AgentHookServer::start().expect("hook server starts");
        let body = format!(
            "{{\"session_id\":\"{}\",\"provider\":\"codex\",\"event\":\"start\"}}",
            Uuid::new_v4()
        );
        let padding = "x".repeat(MAX_HEADER_BYTES);
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Padding: {padding}\r\nX-Acorn-Agent-Hook-Token: {}\r\nContent-Length: {}\r\n\r\n{body}",
            hooks.token(),
            body.len()
        )
        .expect("write oversized header");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");

        assert!(
            response.starts_with("HTTP/1.1 413 Payload Too Large"),
            "oversized completed header bypassed the limit: {response:?}"
        );
    }

    #[test]
    fn hook_event_kind_maps_to_session_status() {
        assert_eq!(
            AgentHookEventKind::Start.session_status(),
            acorn_session::SessionStatus::Working
        );
        assert_eq!(
            AgentHookEventKind::NeedsInput.session_status(),
            acorn_session::SessionStatus::WaitingForInput
        );
        assert_eq!(
            AgentHookEventKind::Stop.session_status(),
            acorn_session::SessionStatus::Ready
        );
        assert_eq!(
            AgentHookEventKind::Error.session_status(),
            acorn_session::SessionStatus::Errored
        );
    }

    #[test]
    fn apply_agent_hook_event_updates_known_session_status() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let status = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("hook".to_string()),
                turn_id: None,
            },
        )
        .expect("event applies");

        assert_eq!(status, SessionStatus::WaitingForInput);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
        assert_eq!(
            sessions.hook_provider(&session_id),
            Some(SessionAgentProvider::Codex)
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").agent_provider,
            Some(SessionAgentProvider::Codex)
        );
    }

    #[test]
    fn transcript_observations_do_not_disable_authoritative_status_polling() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Antigravity".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Antigravity);
        let session_id = session.id;
        sessions.insert(session);

        let status = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Antigravity,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("transcript".to_string()),
                turn_id: None,
            },
        )
        .expect("transcript observation applies");

        assert_eq!(status, SessionStatus::WaitingForInput);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
        assert!(
            !sessions.is_hook_active(&session_id),
            "a transcript-derived event must not make the poll defer to itself"
        );
        assert_eq!(sessions.hook_provider(&session_id), None);
    }

    #[test]
    fn apply_agent_hook_event_accepts_provider_switch_from_resting_session() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Ready;
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let status = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Claude,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("hook".to_string()),
                turn_id: None,
            },
        )
        .expect("resting provider switch applies");

        let stored = sessions.get(&session_id).expect("session");
        assert_eq!(status, SessionStatus::Working);
        assert_eq!(stored.status, SessionStatus::Working);
        assert_eq!(stored.agent_provider, Some(SessionAgentProvider::Claude));
        assert_eq!(
            sessions.hook_provider(&session_id),
            Some(SessionAgentProvider::Claude)
        );
    }

    #[test]
    fn apply_agent_hook_event_rejects_nested_provider_while_owner_is_working() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Agent".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.status = SessionStatus::Working;
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let err = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Claude,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("hook".to_string()),
                turn_id: None,
            },
        )
        .expect_err("nested provider event is rejected");

        assert!(err.contains("provider mismatch"));
        let stored = sessions.get(&session_id).expect("session");
        assert_eq!(stored.status, SessionStatus::Working);
        assert_eq!(stored.agent_provider, Some(SessionAgentProvider::Codex));
    }

    #[test]
    fn codex_hook_sources_scope_tool_activity_to_the_current_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let apply = |source: &str, event| {
            apply_agent_hook_event(
                &sessions,
                AgentHookEvent {
                    session_id,
                    provider: SessionAgentProvider::Codex,
                    event,
                    message: None,
                    source: Some(source.to_string()),
                    turn_id: None,
                },
            )
            .expect("event applies")
        };

        apply("turn", AgentHookEventKind::Start);
        assert_eq!(sessions.hook_tool_started_at(&session_id), None);

        apply("tool", AgentHookEventKind::Start);
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        apply("hook", AgentHookEventKind::Stop);
        assert!(sessions.hook_tool_started_at(&session_id).is_some());

        apply("turn", AgentHookEventKind::Start);
        assert_eq!(sessions.hook_tool_started_at(&session_id), None);
    }

    #[test]
    fn codex_tui_preview_is_not_an_authoritative_hook_event() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        session.hook_active = true;
        session.status = SessionStatus::Working;
        let session_id = session.id;
        sessions.insert(session);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("preview".to_string()),
                turn_id: None,
            },
        )
        .expect("the ordered TUI preview applies");

        assert_eq!(sessions.hook_revision(&session_id), 0);
        assert!(!sessions.is_hook_confirmed_this_run(&session_id));
        assert!(!sessions.has_hook_turn_boundary(&session_id));
        assert_eq!(sessions.hook_turn_id(&session_id), None);

        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";
        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("turn".to_string()),
                turn_id: Some(turn_id.to_string()),
            },
        )
        .expect("the native prompt establishes the turn");
        let native_revision = sessions.hook_revision(&session_id);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("preview".to_string()),
                turn_id: None,
            },
        )
        .expect("a delayed preview remains harmless");
        assert_eq!(sessions.hook_revision(&session_id), native_revision);
        assert_eq!(sessions.hook_turn_id(&session_id).as_deref(), Some(turn_id));

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("hook".to_string()),
                turn_id: Some(turn_id.to_string()),
            },
        )
        .expect("the native stop completes the turn");
        let stop_revision = sessions.hook_revision(&session_id);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("preview".to_string()),
                turn_id: None,
            },
        )
        .expect("a preview delayed past Stop remains harmless");
        assert_eq!(sessions.hook_revision(&session_id), stop_revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn delayed_codex_completion_cannot_overwrite_a_newer_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let apply_json = |json: String| {
            let event = serde_json::from_str::<AgentHookEvent>(&json).expect("valid hook event");
            apply_agent_hook_event(&sessions, event)
        };
        let event = |kind: &str, source: &str, turn_id: Option<&str>| {
            let turn_id = turn_id
                .map(|id| format!(r#","turn_id":"{id}""#))
                .unwrap_or_default();
            format!(
                r#"{{"session_id":"{session_id}","provider":"codex","event":"{kind}","source":"{source}"{turn_id}}}"#
            )
        };

        apply_json(event("start", "turn", Some("turn-1"))).expect("first turn starts");
        apply_json(event("start", "turn", Some("turn-2"))).expect("second turn starts");
        let revision_after_start = sessions.hook_revision(&session_id);

        let error = apply_json(event("needs_input", "hook", Some("turn-1")))
            .expect_err("a delayed completion from the previous turn is stale");
        assert!(
            error.contains("stale Codex turn"),
            "unexpected error: {error}"
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
        assert_eq!(sessions.hook_revision(&session_id), revision_after_start);

        apply_json(event("needs_input", "hook", Some("turn-2")))
            .expect("the current turn may complete");
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn codex_user_turn_without_an_id_invalidates_the_previous_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        let apply = |kind: &str, turn_id: Option<&str>| {
            let turn_id = turn_id
                .map(|id| format!(r#","turn_id":"{id}""#))
                .unwrap_or_default();
            let json = format!(
                r#"{{"session_id":"{session_id}","provider":"codex","event":"{kind}","source":"turn"{turn_id}}}"#
            );
            let event = serde_json::from_str::<AgentHookEvent>(&json).expect("valid hook event");
            apply_agent_hook_event(&sessions, event)
        };

        apply("start", Some("turn-1")).expect("first turn starts");
        apply("start", None).expect("new user turn starts before Codex assigns its id");

        let error = apply("needs_input", Some("turn-1"))
            .expect_err("the previous completion must not win the new-turn race");
        assert!(
            error.contains("stale Codex turn"),
            "unexpected error: {error}"
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    #[test]
    fn first_native_codex_completion_after_restart_bootstraps_the_turn_id() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        session.hook_active = true;
        session.status = SessionStatus::Working;
        let session_id = session.id;
        sessions.insert(session);

        assert_eq!(sessions.hook_revision(&session_id), 0);
        assert_eq!(sessions.hook_turn_id(&session_id), None);

        let event = AgentHookEvent {
            session_id,
            provider: SessionAgentProvider::Codex,
            event: AgentHookEventKind::NeedsInput,
            message: None,
            source: Some("hook".to_string()),
            turn_id: Some("019f6338-6250-7303-88a6-a7add31dba1d".to_string()),
        };
        apply_agent_hook_event(&sessions, event)
            .expect("the first native event after restart establishes the current turn");

        assert_eq!(
            sessions.hook_turn_id(&session_id).as_deref(),
            Some("019f6338-6250-7303-88a6-a7add31dba1d")
        );
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn first_native_codex_tool_after_restart_binds_the_later_completion() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        session.hook_provider = Some(SessionAgentProvider::Codex);
        session.hook_active = true;
        session.status = SessionStatus::Working;
        let session_id = session.id;
        sessions.insert(session);

        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";
        let apply = |event: AgentHookEventKind, source: &str, turn_id: &str| {
            apply_agent_hook_event(
                &sessions,
                AgentHookEvent {
                    session_id,
                    provider: SessionAgentProvider::Codex,
                    event,
                    message: None,
                    source: Some(source.to_string()),
                    turn_id: Some(turn_id.to_string()),
                },
            )
        };

        apply(AgentHookEventKind::Start, "tool", turn_id)
            .expect("the first native tool after restart establishes the current turn");
        assert_eq!(sessions.hook_turn_id(&session_id).as_deref(), Some(turn_id));

        let stale_turn = "019f6338-6250-7303-88a6-a7add31dba1e";
        let revision = sessions.hook_revision(&session_id);
        apply(AgentHookEventKind::NeedsInput, "hook", stale_turn)
            .expect_err("a later completion from another turn remains stale");
        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );

        apply(AgentHookEventKind::NeedsInput, "hook", turn_id)
            .expect("the completion for the restart-bound turn applies");
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn legacy_codex_completion_cannot_override_a_bound_native_turn() {
        let sessions = acorn_session::SessionStore::new();
        let mut session = Session::new(
            "Codex".to_string(),
            "/tmp/repo".into(),
            "/tmp/repo".into(),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = Some(SessionAgentProvider::Codex);
        let session_id = session.id;
        sessions.insert(session);

        apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::Start,
                message: None,
                source: Some("turn".to_string()),
                turn_id: Some("019f6338-6250-7303-88a6-a7add31dba1d".to_string()),
            },
        )
        .expect("native turn starts");

        let error = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("legacy".to_string()),
                turn_id: None,
            },
        )
        .expect_err("an unscoped legacy callback must not end a native turn");

        assert!(error.contains("legacy Codex completion"), "{error}");
        let revision = sessions.hook_revision(&session_id);
        let error = apply_agent_hook_event(
            &sessions,
            AgentHookEvent {
                session_id,
                provider: SessionAgentProvider::Codex,
                event: AgentHookEventKind::NeedsInput,
                message: None,
                source: Some("hook".to_string()),
                turn_id: None,
            },
        )
        .expect_err("an unscoped hook callback must not bypass native turn ownership");
        assert!(error.contains("unscoped Codex completion"), "{error}");
        assert_eq!(sessions.hook_revision(&session_id), revision);
        assert_eq!(
            sessions.get(&session_id).expect("session").status,
            SessionStatus::Working
        );
    }

    fn post(hooks: &AgentHookServer, token: &str, body: &str) -> String {
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .expect("write request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    }

    fn post_raw_codex_hook(hooks: &AgentHookServer, session_id: Uuid, body: &str) -> String {
        let mut stream = TcpStream::connect(addr_from_url(hooks.hook_url())).expect("connect hook");
        write!(
            stream,
            "POST /agent-hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nX-Acorn-Agent-Hook-Token: {}\r\nX-Acorn-Agent-Hook-Provider: codex\r\nX-Acorn-Agent-Hook-Session-Id: {session_id}\r\nX-Acorn-Agent-Hook-Source: native\r\nX-Acorn-Codex-Lifecycle-Id: lifecycle-1\r\nX-Acorn-Codex-Version: 0.144.4\r\nContent-Length: {}\r\n\r\n{body}",
            hooks.token(),
            body.len()
        )
        .expect("write raw Codex request");
        let mut response = String::new();
        stream.read_to_string(&mut response).expect("read response");
        response
    }

    fn addr_from_url(url: &str) -> SocketAddr {
        let raw = url
            .strip_prefix("http://")
            .and_then(|rest| rest.strip_suffix("/agent-hook"))
            .expect("expected hook url shape");
        raw.parse().expect("parse hook addr")
    }
}
