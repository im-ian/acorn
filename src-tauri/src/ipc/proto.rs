//! Wire protocol shared between the in-process IPC server (this crate's lib)
//! and the out-of-process `acorn-ipc` CLI (`src/bin/acorn-ipc.rs`).
//!
//! Each request/response pair travels as a single newline-terminated JSON
//! object over a Unix domain socket. The CLI sends exactly one request and
//! reads exactly one response, then closes the connection.
//!
//! Errors are returned as a typed `Response::Error { code, message }` rather
//! than as a transport-level signal, so the CLI can render meaningful exit
//! statuses and the server can carry structured failure metadata back to
//! the caller without leaking framework internals.

use serde::{Deserialize, Serialize};

/// Wire-version of the protocol. Bump when introducing breaking changes so
/// older CLIs can refuse to speak to a newer server (and vice versa) instead
/// of silently mis-routing requests.
pub const PROTOCOL_VERSION: u32 = 1;

/// Every request opens with the source session's UUID, captured by the CLI
/// from the `ACORN_SESSION_ID` env var set on control-session PTYs. The
/// server rejects requests from sessions that do not exist or whose
/// `SessionKind` is not `Control`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    pub protocol_version: u32,
    pub source_session_id: String,
    pub request: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Request {
    /// List sessions visible to the source — i.e. sessions in the same
    /// project (`repo_path`) as the calling control session.
    ListSessions,
    /// Send raw bytes to a target session's PTY stdin. Pure passthrough —
    /// the server does not interpret the bytes. Use `data_b64` to carry
    /// non-UTF-8 sequences (e.g. control characters) cleanly.
    SendKeys {
        target_session_id: String,
        data_b64: String,
    },
    /// Read the tail of a target session's PTY output ring buffer. Returns
    /// up to `max_bytes`; `truncated = true` indicates the buffer had more
    /// bytes than were returned.
    ReadBuffer {
        target_session_id: String,
        max_bytes: Option<usize>,
    },
    /// Create a new (non-control) regular session in the same project as the
    /// source. Returns the new session's id. The frontend's `pty_spawn`
    /// flow still has to land in the new session for the PTY to start;
    /// callers that want output should poll `ListSessions` or wait for the
    /// app to surface the new tab.
    NewSession {
        name: String,
        isolated: bool,
    },
    /// Ask the app to focus the given session in its pane. Emits a Tauri
    /// event the frontend reacts to.
    SelectSession {
        target_session_id: String,
    },
    /// Tear down a target session (kill its PTY, remove it from state).
    /// Destructive — the server logs every invocation to the audit log.
    KillSession {
        target_session_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Response {
    Sessions {
        sessions: Vec<SessionSummary>,
    },
    Ack,
    Buffer {
        data_b64: String,
        /// True when the underlying ring buffer held more bytes than were
        /// returned. Callers can decide whether to widen `max_bytes` or
        /// accept the truncation.
        truncated: bool,
    },
    SessionCreated {
        session_id: String,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

/// Compact, machine-parseable error vocabulary. The CLI maps each code to
/// a non-zero exit status; the human-readable `message` is shown alongside.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// Source session does not exist, is not Control kind, or env was
    /// missing/blank when the CLI started.
    Unauthorized,
    /// Target session id does not exist in the server's state.
    NotFound,
    /// Target session exists but is not in the same project as the source.
    /// Surfaced separately from `NotFound` so the CLI can give an accurate
    /// "wrong project" diagnostic instead of "no such session".
    OutOfScope,
    /// Request shape was unrecognized or its arguments were invalid.
    Invalid,
    /// Catch-all for server-side failures (PTY write errors, persistence
    /// errors, etc.). The `message` carries the underlying cause.
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: String,
    pub name: String,
    pub repo_path: String,
    pub branch: String,
    pub kind: String,
    pub status: String,
    /// True when the source session itself is the one being described —
    /// the CLI uses this to render an arrow / current-session marker.
    pub is_source: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_roundtrips_through_json() {
        let env = Envelope {
            protocol_version: PROTOCOL_VERSION,
            source_session_id: "00000000-0000-0000-0000-000000000001".to_string(),
            request: Request::SendKeys {
                target_session_id: "00000000-0000-0000-0000-000000000002".to_string(),
                data_b64: "aGVsbG8=".to_string(),
            },
        };
        let encoded = serde_json::to_string(&env).expect("encode");
        let decoded: Envelope = serde_json::from_str(&encoded).expect("decode");
        assert_eq!(decoded, env);
    }

    #[test]
    fn response_error_is_tagged_kind() {
        let r = Response::Error {
            code: ErrorCode::Unauthorized,
            message: "source is not a control session".to_string(),
        };
        let encoded = serde_json::to_string(&r).expect("encode");
        // External tag is `kind` per the serde attribute; `error` payload
        // sits at the same level. This is what the CLI parses against.
        assert!(encoded.contains("\"kind\":\"error\""));
        assert!(encoded.contains("\"code\":\"unauthorized\""));
    }

    #[test]
    fn unknown_request_kind_rejected() {
        let bad = r#"{"protocol_version":1,"source_session_id":"x","request":{"kind":"frobnicate"}}"#;
        let parsed: Result<Envelope, _> = serde_json::from_str(bad);
        assert!(parsed.is_err());
    }
}
