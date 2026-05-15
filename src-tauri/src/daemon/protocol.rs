//! Wire protocol for the `acornd` daemon.
//!
//! Two separate socket endpoints, both speaking newline-terminated JSON:
//!
//! * **Control socket** — request/response RPC. Used for spawn, kill, resize,
//!   list, attach, and status queries. Short messages, low volume.
//! * **Stream socket** — bidirectional PTY byte flow per attached session.
//!   Used for `pty:output` push and `pty:input` user keystrokes. Higher
//!   volume; framed as length-prefixed JSON to keep parsing trivial.
//!
//! Splitting the two avoids head-of-line blocking: a multi-megabyte
//! scrollback dump on attach cannot starve a `list-sessions` reply.
//!
//! Protocol versioning is handled at the handshake. The first frame both
//! sides exchange after connecting is `Hello { protocol_version, ... }`.
//! Major-version mismatch is fatal — the connection is closed with an
//! `Error::ProtocolMismatch` reply. Minor-version differences are tolerated
//! through additive optional fields (serde `#[serde(default)]`).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Major version of the protocol. Bump only on breaking changes. Same-major
/// connections must succeed even if one side is newer — newer side falls
/// back to behavior the older side understands.
pub const PROTOCOL_VERSION_MAJOR: u32 = 1;

/// Minor version of the protocol. Bumped when adding optional fields or
/// non-breaking new variants. Reported in the handshake purely for telemetry
/// and feature detection — not used for compatibility gating.
pub const PROTOCOL_VERSION_MINOR: u32 = 0;

/// First frame on every fresh connection. Both daemon and client send their
/// own `Hello`; either side may close the connection if the major version
/// does not match. The `role` discriminates which socket type this is so
/// the daemon can route accept handlers correctly without separate ports.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    pub protocol_version_major: u32,
    pub protocol_version_minor: u32,
    pub role: ClientRole,
    /// Source session id when this connection originates from inside a
    /// control session's PTY (set via `ACORN_SESSION_ID`). Absent for app
    /// connections.
    #[serde(default)]
    pub source_session_id: Option<Uuid>,
    /// Free-form identifier the client emits for log lines and the
    /// daemon's "currently attached clients" status panel. Examples:
    /// `"acorn-app/1.0.10"`, `"acornd-cli/1.0.10"`.
    #[serde(default)]
    pub client_name: Option<String>,
}

impl Hello {
    pub fn current(role: ClientRole) -> Self {
        Self {
            protocol_version_major: PROTOCOL_VERSION_MAJOR,
            protocol_version_minor: PROTOCOL_VERSION_MINOR,
            role,
            source_session_id: None,
            client_name: None,
        }
    }
}

/// Discriminates which socket-shaped contract the connection is following.
/// The same socket file accepts both — the `Hello.role` field tells the
/// daemon which dispatcher to use.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ClientRole {
    /// One request → one response. Connection closes after the reply.
    /// Used by CLI subcommands (`acornd list-sessions` etc.) and by short
    /// app-side queries (`status`, `list`).
    ControlOneShot,
    /// Long-lived control connection — multiple request/response pairs
    /// over the same socket. Used by the Acorn app for its session
    /// management lifetime so it doesn't pay socket-open overhead on
    /// every list/kill.
    ControlPersistent,
    /// Stream attach for a single session. After `Hello` the client sends
    /// `StreamAttach`; from then on the daemon pushes `StreamFrame::Output`
    /// frames and accepts `StreamFrame::Input`/`StreamFrame::Resize` from
    /// the client. Connection lifetime mirrors the user's interest in the
    /// session — closing the stream socket does NOT kill the PTY (the
    /// daemon keeps the session alive across reattaches per the
    /// "explicit-quit only" lifecycle).
    Stream,
}

// ---------- Control socket ----------

/// Control-socket request envelope. Identifies the source (for control
/// session authorization checks) and carries the typed request payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlRequest {
    /// Monotonic request id. The daemon echoes this back in the response
    /// so the client can correlate replies on a persistent connection
    /// that has more than one in-flight request.
    pub seq: u64,
    pub payload: ControlPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ControlPayload {
    /// Probe — daemon replies `Pong` with its version and uptime. Used by
    /// the app's `getDaemonStatus()` and by the StatusBar indicator.
    Ping,
    /// Enumerate all sessions the daemon currently tracks. Returns both
    /// live (PTY alive) and dead (process exited but metadata preserved)
    /// sessions. UI can show both with appropriate visual treatment.
    ListSessions,
    /// Create a new PTY-backed session. The daemon allocates a UUID,
    /// records minimal metadata, spawns the PTY, and returns the new id.
    /// The app merges this id into its own DB on receipt so the two
    /// stores stay in sync without a cross-process transaction.
    SpawnSession {
        spec: SpawnSpec,
    },
    /// Forward raw stdin bytes to a session. Same as a `StreamFrame::Input`
    /// over the stream socket, but available on the control channel for
    /// one-shot CLI use (`acornd send-keys ...`).
    SendInput {
        target_session_id: Uuid,
        data_b64: String,
    },
    /// Resize the target PTY.
    Resize {
        target_session_id: Uuid,
        cols: u16,
        rows: u16,
    },
    /// Read the tail of a session's scrollback ring. Returns up to
    /// `max_bytes` of the freshest output. Pure read — does not drain.
    ReadBuffer {
        target_session_id: Uuid,
        max_bytes: Option<usize>,
    },
    /// Kill a session. Drops the PTY child and marks the session as
    /// `dead`. Metadata is retained so the app can render a ghost row
    /// and offer "resume from disk" before the user opts to forget.
    KillSession {
        target_session_id: Uuid,
    },
    /// Permanently remove a dead session's metadata. The daemon refuses if
    /// the session is still alive — caller must Kill first.
    ForgetSession {
        target_session_id: Uuid,
    },
    /// Status snapshot: version, uptime, session counts, RSS estimate.
    /// Backs the StatusBar daemon indicator + the "Background sessions"
    /// settings panel.
    Status,
    /// Request graceful daemon shutdown. The daemon kills every running
    /// PTY and exits. Used by Settings → "Quit daemon" button and by
    /// `acornd quit` from the CLI. Destructive — caller is responsible
    /// for confirming with the user.
    Shutdown,
}

/// Spec for a new PTY session. Mirrors the shape of the Acorn app's
/// `pty_spawn` Tauri command so the app hands the same payload to
/// either path. The daemon copies these values into its own session
/// metadata so the orphan/ghost reconcile logic can hand them back on
/// next attach.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpawnSpec {
    /// Caller-suggested session id. If `None`, the daemon allocates a
    /// fresh v4 UUID. The app supplies its own id so its DB row and the
    /// daemon's session id stay in lockstep without a callback round-trip.
    #[serde(default)]
    pub session_id: Option<Uuid>,
    /// Cosmetic name surfaced in `Status` / `ListSessions`. Not used by
    /// any policy logic.
    pub name: String,
    /// Working directory the child process inherits.
    pub cwd: std::path::PathBuf,
    /// Command and arguments. The daemon does not interpret these beyond
    /// passing them to `portable-pty`.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables. Overrides the daemon's inherited env
    /// (which is the user-login environment captured at daemon spawn).
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    /// Initial window size. `0` falls back to `80x24`.
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    /// Session classification (regular / control). Mirrors the
    /// `SessionKind` enum in `crate::session`. The daemon preserves it
    /// in metadata so reattach can re-augment the env on respawn.
    #[serde(default)]
    pub kind: SessionKind,
    /// Repository path the session belongs to. The daemon uses this to
    /// scope `acornd` CLI ops (control sessions can only see siblings in
    /// the same project) without pulling in the app's full project model.
    #[serde(default)]
    pub repo_path: Option<std::path::PathBuf>,
    /// Branch label for telemetry / status display. Not authoritative —
    /// the daemon does not run git operations.
    #[serde(default)]
    pub branch: Option<String>,
    /// Resume token for agent-aware recovery. For Claude Code this is
    /// the `--session-id <uuid>` value the daemon will inject into argv.
    /// The resume strategy registry dispatches on `agent_kind`.
    #[serde(default)]
    pub agent_resume_token: Option<String>,
    /// Agent classification — drives the resume strategy registry. `None`
    /// means "unknown agent; do not attempt resume on cold start".
    #[serde(default)]
    pub agent_kind: Option<AgentKind>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    #[default]
    Regular,
    Control,
}

/// Known agent runtimes the daemon can resume across crashes via their own
/// session-history mechanism. `Unknown` is the catch-all for tools without
/// a documented resume protocol — daemon does not attempt revival; ghost UI
/// surfaces them as dead with manual delete only.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    ClaudeCode,
    Aider,
    Llm,
    OpenInterpreter,
    Codex,
    Unknown,
}

/// Control-socket response. Tagged on `seq` so a persistent connection can
/// have multiple in-flight requests without ambiguity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlResponse {
    pub seq: u64,
    pub payload: ControlResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ControlResult {
    Pong {
        daemon_version: String,
        uptime_seconds: u64,
    },
    Sessions {
        sessions: Vec<SessionSummary>,
    },
    SessionSpawned {
        session_id: Uuid,
        /// OS process id of the PTY child the daemon just forked.
        /// `None` only on platforms where `portable-pty` cannot return
        /// one (rare). Included in the response so the app does not
        /// have to round-trip a `ListSessions` immediately after spawn
        /// to pick up the pid for status polling.
        #[serde(default)]
        pid: Option<u32>,
    },
    Ack,
    Buffer {
        data_b64: String,
        /// `true` if the underlying ring buffer held more bytes than were
        /// returned (caller may widen `max_bytes` to see more).
        truncated: bool,
    },
    Status {
        snapshot: StatusSnapshot,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
}

/// Compact, machine-parseable error vocabulary. Each code maps to a
/// non-zero CLI exit status; the human-readable `message` is shown alongside.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// Hello roles or source session id is not authorized for this op.
    Unauthorized,
    /// Target session id is not known to the daemon.
    NotFound,
    /// Target session is in a different project than the source — control
    /// sessions can only see their own project's siblings.
    OutOfScope,
    /// Request shape or fields invalid.
    Invalid,
    /// Daemon protocol version is incompatible with the client's version.
    ProtocolMismatch,
    /// Catch-all for internal failures (PTY write errors, persistence
    /// failures, etc.). The `message` carries the underlying cause.
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub id: Uuid,
    pub name: String,
    pub kind: SessionKind,
    /// `true` while the PTY child is alive; `false` once it has exited.
    /// Dead sessions remain in metadata until `ForgetSession`.
    pub alive: bool,
    pub repo_path: Option<std::path::PathBuf>,
    pub branch: Option<String>,
    pub agent_kind: Option<AgentKind>,
    /// OS process id of the immediate PTY child. `None` once the
    /// process has exited (alive=false) or when the host could not
    /// hand one back at spawn. The app uses this to walk descendants
    /// for shell-mode status detection (Running / NeedsInput / Idle).
    #[serde(default)]
    pub pid: Option<u32>,
    /// `true` when the source of this `ListSessions` call is the same
    /// session being described — the CLI uses this to render a marker.
    #[serde(default)]
    pub is_source: bool,
    /// Fingerprint of the staged zsh dotfile bodies the session was
    /// spawned against (see `shell_init::STAGED_REV`). `None` for
    /// sessions spawned by builds that pre-date the fingerprint —
    /// treated as stale by the app reconcile.
    #[serde(default)]
    pub staged_rev: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StatusSnapshot {
    pub daemon_version: String,
    pub uptime_seconds: u64,
    pub session_count_total: u32,
    pub session_count_alive: u32,
    /// Approximate resident memory of the daemon process in bytes. `None`
    /// when the daemon could not query the OS (rare; not fatal).
    pub rss_bytes: Option<u64>,
}

// ---------- Stream socket ----------

/// First frame the client sends on a stream socket after `Hello`.
/// Identifies which session's bytes to flow over this connection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StreamAttach {
    pub session_id: Uuid,
    /// When `true`, the daemon dumps the session's scrollback ring buffer
    /// to this stream before live tailing. App typically wants this on
    /// reattach; CLI watchers may not.
    #[serde(default)]
    pub replay_scrollback: bool,
}

/// Bidirectional stream frame. The daemon sends `Output` / `Exit` /
/// `ServerNote`; the client sends `Input` / `Resize` / `ClientNote`.
/// Encoded one per line as JSON; non-text bytes carried in base64.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StreamFrame {
    /// PTY stdout bytes (daemon → client).
    Output { data_b64: String },
    /// PTY stdin bytes (client → daemon).
    Input { data_b64: String },
    /// Resize (client → daemon).
    Resize { cols: u16, rows: u16 },
    /// PTY child exited (daemon → client). After this frame the daemon
    /// closes the stream; further input is dropped.
    Exit { code: Option<i32> },
    /// Daemon-side info / warning (e.g. "scrollback dump complete",
    /// "RSS approaching cap"). Pure telemetry — clients may ignore.
    ServerNote { message: String },
    /// Client-side hint (e.g. "user typed, dismiss the NeedsInput sticky").
    /// Optional — daemon may ignore unknown hints.
    ClientNote { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_roundtrips() {
        let h = Hello::current(ClientRole::ControlOneShot);
        let s = serde_json::to_string(&h).unwrap();
        let parsed: Hello = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed, h);
    }

    #[test]
    fn control_request_response_roundtrip() {
        let req = ControlRequest {
            seq: 42,
            payload: ControlPayload::SendInput {
                target_session_id: Uuid::new_v4(),
                data_b64: "aGVsbG8=".into(),
            },
        };
        let s = serde_json::to_string(&req).unwrap();
        let parsed: ControlRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed, req);

        let resp = ControlResponse {
            seq: 42,
            payload: ControlResult::Ack,
        };
        let s = serde_json::to_string(&resp).unwrap();
        let parsed: ControlResponse = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn stream_frame_roundtrip() {
        let f = StreamFrame::Output {
            data_b64: "AAEC".into(),
        };
        let s = serde_json::to_string(&f).unwrap();
        let parsed: StreamFrame = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed, f);

        let f = StreamFrame::Exit { code: Some(0) };
        let s = serde_json::to_string(&f).unwrap();
        let parsed: StreamFrame = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed, f);
    }

    #[test]
    fn unknown_payload_kind_is_rejected() {
        // Forward-compat sentinel — the daemon must NOT silently accept
        // unknown kinds, otherwise newer-client / older-daemon pairings
        // could see "ack" responses for ops the daemon does not implement.
        let bad = r#"{"seq":1,"payload":{"kind":"frobnicate"}}"#;
        let parsed: Result<ControlRequest, _> = serde_json::from_str(bad);
        assert!(parsed.is_err());
    }

    #[test]
    fn additive_optional_fields_load_legacy_hello() {
        // Hello frame without source_session_id / client_name —
        // simulates a client built against an earlier minor version.
        // Must parse successfully so additive minor-version bumps stay
        // non-breaking.
        let s = r#"{"protocol_version_major":1,"protocol_version_minor":0,"role":"control-one-shot"}"#;
        let parsed: Hello = serde_json::from_str(s).unwrap();
        assert_eq!(parsed.protocol_version_major, 1);
        assert!(parsed.source_session_id.is_none());
        assert!(parsed.client_name.is_none());
    }
}
