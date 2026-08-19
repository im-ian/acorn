//! Daemon client helpers used both by the `acornd` CLI subcommands and by
//! the Acorn app's Tauri command shims.
//!
//! Wire shape mirrors `server::handle_control_conn`: every connection
//! opens with a `Hello` exchange, then a sequence of `ControlRequest` →
//! `ControlResponse` round-trips. The one-shot variants below open a
//! fresh connection per call; the app uses `ControlConn::persistent` so
//! its long-lived session-management traffic does not pay handshake
//! overhead per request.

use std::io::{self, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use acorn_local_ipc::{Stream, TryClone};

use super::protocol::{
    ClientRole, ControlPayload, ControlRequest, ControlResponse, ControlResult, Hello,
    StatusSnapshot, PROTOCOL_VERSION_MAJOR,
};
use super::socket;
use super::wire::read_response_frame_line;

/// Long-lived control-socket connection. Use this when the same caller
/// will issue more than one request — the connection handshake happens
/// once and subsequent calls just exchange `ControlRequest`/`Response`.
pub struct ControlConn {
    writer: Stream,
    reader: BufReader<Stream>,
    seq: AtomicU64,
}

impl ControlConn {
    /// Open a persistent connection. The app holds one of these for its
    /// lifetime; CLI subcommands typically use `one_shot()` instead.
    pub fn persistent(client_name: impl Into<String>) -> io::Result<Self> {
        let conn = socket::connect_control()?;
        let mut writer = conn.try_clone()?;
        let mut reader = BufReader::new(conn);

        let mut hello = authenticated_hello(ClientRole::ControlPersistent)?;
        hello.client_name = Some(client_name.into());
        writeln!(
            writer,
            "{}",
            serde_json::to_string(&hello).map_err(io::Error::other)?
        )?;
        writer.flush()?;
        let mut buf = String::new();
        if read_response_frame_line(&mut reader, &mut buf)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "daemon closed before server hello",
            ));
        }
        validate_server_hello(&buf, ClientRole::ControlPersistent)?;

        Ok(Self {
            writer,
            reader,
            seq: AtomicU64::new(1),
        })
    }

    /// Send one request and read the matching response.
    pub fn call(&mut self, payload: ControlPayload) -> io::Result<ControlResponse> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let req = ControlRequest { seq, payload };
        writeln!(
            self.writer,
            "{}",
            serde_json::to_string(&req).map_err(io::Error::other)?
        )?;
        self.writer.flush()?;
        let mut buf = String::new();
        if read_response_frame_line(&mut self.reader, &mut buf)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "daemon closed",
            ));
        }
        serde_json::from_str(buf.trim()).map_err(io::Error::other)
    }
}

/// Open a fresh connection, send one request, and close. Used by the
/// `acornd` CLI subcommands and by app probes that do not want to pin a
/// long-lived connection (e.g. status polling from the StatusBar).
pub fn one_shot(payload: ControlPayload) -> io::Result<ControlResponse> {
    one_shot_with_hello(payload, authenticated_hello(ClientRole::ControlOneShot)?)
}

/// One-shot call issued from the `acornd` CLI inside an Acorn PTY. Unlike app
/// calls, this must carry the source id and per-session capability; the server
/// additionally verifies that the kernel peer PID descends from that PTY.
pub fn one_shot_from_session(payload: ControlPayload) -> io::Result<ControlResponse> {
    let mut hello = authenticated_hello(ClientRole::ControlOneShot)?;
    hello.source_session_id = std::env::var("ACORN_SESSION_ID")
        .ok()
        .or_else(|| std::env::var("ACORN_RESUME_TOKEN").ok())
        .and_then(|value| uuid::Uuid::parse_str(&value).ok());
    hello.session_capability = std::env::var("ACORN_IPC_CAPABILITY").ok();
    if hello.source_session_id.is_none() || hello.session_capability.is_none() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "daemon CLI authority is missing; run this command inside an Acorn session",
        ));
    }
    one_shot_with_hello(payload, hello)
}

/// Build an app/CLI hello and ensure the shared token exists first. Creating
/// the token here lets a new client negotiate with a pre-token daemon on a
/// clean upgrade; that daemon ignores the additive field, and its replacement
/// later reuses the same token.
pub fn authenticated_hello(role: ClientRole) -> io::Result<Hello> {
    let mut hello = Hello::current(role);
    hello.auth_token = Some(super::auth::load_or_create()?.simple().to_string());
    Ok(hello)
}

fn one_shot_with_hello(payload: ControlPayload, hello: Hello) -> io::Result<ControlResponse> {
    let conn = socket::connect_control()?;
    let mut writer = conn.try_clone()?;
    let mut reader = BufReader::new(conn);

    writeln!(
        writer,
        "{}",
        serde_json::to_string(&hello).map_err(io::Error::other)?
    )?;
    writer.flush()?;
    let mut buf = String::new();
    if read_response_frame_line(&mut reader, &mut buf)? == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "daemon closed before server hello",
        ));
    }
    // The daemon identifies the control endpoint as ControlPersistent for
    // both client lifetimes; the request-side role still tells it whether to
    // keep this particular connection open after one response.
    validate_server_hello(&buf, ClientRole::ControlPersistent)?;

    let req = ControlRequest { seq: 1, payload };
    writeln!(
        writer,
        "{}",
        serde_json::to_string(&req).map_err(io::Error::other)?
    )?;
    writer.flush()?;
    if read_response_frame_line(&mut reader, &mut buf)? == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "daemon closed",
        ));
    }
    serde_json::from_str(buf.trim()).map_err(io::Error::other)
}

/// Probe the daemon — returns `Ok(Some(snapshot))` if the daemon answered
/// our `Status` request, `Ok(None)` if no daemon is bound to the socket
/// (clean "not running" signal), and `Err` only on unexpected I/O
/// failures the caller may want to log.
pub fn probe_status() -> io::Result<Option<StatusSnapshot>> {
    match one_shot(ControlPayload::Status) {
        Ok(resp) => match resp.payload {
            ControlResult::Status { snapshot } => Ok(Some(snapshot)),
            ControlResult::Error { .. } => Ok(None),
            _ => Ok(None),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => Ok(None),
        Err(e) => Err(e),
    }
}

/// Parse and validate the daemon's first response on a fresh connection.
/// Transport-level peer authentication establishes which Windows user owns
/// the server; this check then fails closed on malformed or incompatible wire
/// endpoints owned by that user.
pub fn validate_server_hello(line: &str, expected_role: ClientRole) -> io::Result<Hello> {
    let hello: Hello = match serde_json::from_str(line.trim()) {
        Ok(hello) => hello,
        Err(hello_error) => {
            if let Ok(ControlResponse {
                payload: ControlResult::Error { code, message },
                ..
            }) = serde_json::from_str(line.trim())
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("daemon handshake rejected ({code:?}): {message}"),
                ));
            }
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid daemon hello: {hello_error}"),
            ));
        }
    };
    if hello.protocol_version_major != PROTOCOL_VERSION_MAJOR {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "daemon protocol major mismatch: expected {PROTOCOL_VERSION_MAJOR}, got {}",
                hello.protocol_version_major
            ),
        ));
    }
    if hello.role != expected_role {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unexpected daemon hello role: expected {expected_role:?}, got {:?}",
                hello.role
            ),
        ));
    }
    Ok(hello)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::ENV_LOCK;

    #[test]
    fn server_hello_accepts_expected_role_and_protocol() {
        let hello = Hello::current(ClientRole::ControlPersistent);
        let encoded = serde_json::to_string(&hello).unwrap();

        assert_eq!(
            validate_server_hello(&encoded, ClientRole::ControlPersistent).unwrap(),
            hello
        );
    }

    #[test]
    fn server_hello_rejects_malformed_payload() {
        let error = validate_server_hello("not-json", ClientRole::ControlPersistent).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn server_hello_preserves_typed_handshake_error() {
        let encoded = serde_json::to_string(&ControlResponse {
            seq: 0,
            payload: ControlResult::Error {
                code: super::super::protocol::ErrorCode::ProtocolMismatch,
                message: "daemon authentication token is missing or invalid".into(),
            },
        })
        .unwrap();

        let error = validate_server_hello(&encoded, ClientRole::ControlPersistent).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(
            error.to_string(),
            "daemon handshake rejected (ProtocolMismatch): daemon authentication token is missing or invalid"
        );
    }

    #[test]
    fn authenticated_hello_bootstraps_a_missing_token() {
        let _guard = ENV_LOCK.lock();
        let root = std::env::temp_dir().join(format!(
            "acorn-daemon-client-auth-{}",
            uuid::Uuid::new_v4().simple()
        ));
        unsafe { std::env::set_var(crate::paths::ENV_DATA_DIR_OVERRIDE, &root) };

        let hello = authenticated_hello(ClientRole::ControlOneShot).unwrap();
        let presented = uuid::Uuid::parse_str(hello.auth_token.as_deref().unwrap()).unwrap();
        assert_eq!(presented, crate::auth::read().unwrap());

        unsafe { std::env::remove_var(crate::paths::ENV_DATA_DIR_OVERRIDE) };
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn server_hello_rejects_protocol_or_role_mismatch() {
        let mut hello = Hello::current(ClientRole::ControlPersistent);
        hello.protocol_version_major += 1;
        let encoded = serde_json::to_string(&hello).unwrap();
        assert_eq!(
            validate_server_hello(&encoded, ClientRole::ControlPersistent)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        let encoded = serde_json::to_string(&Hello::current(ClientRole::Stream)).unwrap();
        assert_eq!(
            validate_server_hello(&encoded, ClientRole::ControlPersistent)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }
}
