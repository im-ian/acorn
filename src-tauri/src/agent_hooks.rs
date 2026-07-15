use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use acorn_session::{SessionAgentProvider, SessionStatus, SessionStore};
use serde::Deserialize;
use uuid::Uuid;

pub const AGENT_HOOK_STATUS_EVENT: &str = "acorn:agent-hook-status";

const HOOK_PATH: &str = "/agent-hook";
const MAX_HEADER_BYTES: usize = 8 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024;
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

    // Mark native hook channels live so the transcript-tail status poll
    // defers turn-boundary classification to them instead of clobbering a
    // just-set resting status (Ready/WaitingForInput) back to Working on its
    // next tick. Transcript-derived wrapper observations are only a low-latency
    // preview of the same data the poll reads. Treating those as an
    // authoritative hook would make a missed line, owner rotation, or watcher
    // restart permanently hide the fresher transcript classification.
    // See `poll_defers_to_hook` in `commands`.
    if event.source.as_deref() != Some("transcript") {
        sessions.mark_hook_active(&event.session_id, event.provider);
    }

    // The Codex JSONL watcher tags task and exec starts separately. This
    // runtime-only turn evidence lets the process poll distinguish a real
    // background command from helpers that live for the whole Codex session.
    // Generic native hook events intentionally do not reset this marker: they
    // arrive through a separate channel and can race the ordered JSONL tail.
    if event.provider == SessionAgentProvider::Codex && event.event == AgentHookEventKind::Start {
        match event.source.as_deref() {
            Some("turn") => sessions.begin_hook_turn(&event.session_id),
            Some("tool") => {
                sessions.mark_hook_tool_started_at(&event.session_id, SystemTime::now())
            }
            _ => {}
        }
    }

    let status = event.event.session_status();
    sessions
        .refresh_status(&event.session_id, status)
        .map_err(|err| err.to_string())?;
    Ok(status)
}

pub struct AgentHookServer {
    hook_url: String,
    token: String,
    running: Arc<AtomicBool>,
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

        let running = Arc::new(AtomicBool::new(true));
        let running_for_thread = running.clone();
        let token_for_thread = token.clone();
        std::thread::Builder::new()
            .name("acorn-agent-hooks".to_string())
            .spawn(move || run_listener(listener, token_for_thread, handler, running_for_thread))?;

        Ok(Self {
            hook_url,
            token,
            running,
        })
    }
}

impl Drop for AgentHookServer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
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
                let token = token.clone();
                let handler = handler.clone();
                std::thread::Builder::new()
                    .name("acorn-agent-hook-conn".to_string())
                    .spawn(move || {
                        if let Err(err) = handle_connection(stream, &token, &handler) {
                            tracing::warn!(error = %err, "agent hook connection failed");
                        }
                    })
                    .map(|_| ())
                    .unwrap_or_else(|err| {
                        tracing::warn!(error = %err, "agent hook worker thread failed to start");
                    });
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

fn handle_connection(
    mut stream: TcpStream,
    token: &str,
    handler: &HookEventHandler,
) -> io::Result<()> {
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
    let event = match serde_json::from_slice::<AgentHookEvent>(body) {
        Ok(event) => event,
        Err(err) => {
            tracing::warn!(error = %err, "agent hook payload rejected");
            return HttpStatus::BadRequest;
        }
    };
    handler(event);
    HttpStatus::NoContent
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
    use super::{apply_agent_hook_event, AgentHookEvent, AgentHookEventKind, AgentHookServer};
    use acorn_session::{Session, SessionAgentProvider, SessionKind, SessionStatus};
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::sync::mpsc;
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

    fn addr_from_url(url: &str) -> SocketAddr {
        let raw = url
            .strip_prefix("http://")
            .and_then(|rest| rest.strip_suffix("/agent-hook"))
            .expect("expected hook url shape");
        raw.parse().expect("parse hook addr")
    }
}
