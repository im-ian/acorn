//! Daemon main loop. Owns the listener pair, dispatches every connection
//! to a per-connection worker thread, and routes `ControlRequest`s onto
//! `PtyManager` + `SessionRegistry` calls.
//!
//! Threading model:
//!
//! * **Two accept threads** — one per listener (control / stream). Each
//!   spawns a fresh worker thread per accepted connection.
//! * **Worker threads block on socket I/O** with std `BufReader` /
//!   `BufWriter`. The daemon is intentionally NOT built on tokio: the
//!   total connection count is bounded by attached Acorn clients +
//!   control-session CLI invocations (single-digit normally) and the
//!   per-connection work is dominated by PTY syscalls, which are
//!   blocking anyway via `portable-pty`. Tokio would add a runtime and
//!   buy nothing here.
//! * **Shutdown** — `ControlPayload::Shutdown` sets the shared
//!   `shutdown_flag` and closes the listeners. Worker threads exit on
//!   their next read after the flag is set, or sooner if the client
//!   closes the connection.

use std::io::{self, BufRead, BufReader, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use interprocess::TryClone;
use interprocess::local_socket::{ListenerNonblockingMode, Stream};
use interprocess::local_socket::traits::{
    Listener as _ListenerTrait, Stream as _StreamTrait,
};

use super::protocol::{
    ClientRole, ControlPayload, ControlRequest, ControlResponse, ControlResult, ErrorCode,
    Hello, PROTOCOL_VERSION_MAJOR, SessionSummary, StatusSnapshot, StreamAttach, StreamFrame,
};
use super::pty::PtyManager;
use super::session::SessionRegistry;
use super::socket::DaemonListeners;

/// Wraps all the per-process state a connection handler needs.
pub struct Daemon {
    pub registry: Arc<SessionRegistry>,
    pub pty: Arc<PtyManager>,
    started_at: Instant,
    shutdown_flag: Arc<AtomicBool>,
    next_seq: AtomicU64,
}

impl Daemon {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            registry: SessionRegistry::new(),
            pty: PtyManager::new(),
            started_at: Instant::now(),
            shutdown_flag: Arc::new(AtomicBool::new(false)),
            next_seq: AtomicU64::new(1),
        })
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    pub fn shutdown_flag(&self) -> Arc<AtomicBool> {
        self.shutdown_flag.clone()
    }

    /// Run accept loops on both listeners. Blocks until either the
    /// shutdown flag is set or both listeners error out terminally.
    pub fn serve(self: Arc<Self>, listeners: DaemonListeners) -> io::Result<()> {
        let DaemonListeners {
            control,
            stream,
            control_path: _,
            stream_path: _,
        } = listeners;

        let me_control = Arc::clone(&self);
        let control_thread = std::thread::Builder::new()
            .name("acornd-accept-control".into())
            .spawn(move || me_control.run_control_accept(control))?;

        let me_stream = Arc::clone(&self);
        let stream_thread = std::thread::Builder::new()
            .name("acornd-accept-stream".into())
            .spawn(move || me_stream.run_stream_accept(stream))?;

        let _ = control_thread.join();
        let _ = stream_thread.join();
        Ok(())
    }

    fn run_control_accept(self: Arc<Self>, listener: interprocess::local_socket::Listener) {
        self.accept_loop(listener, "control", |me, conn| {
            if let Err(err) = me.handle_control_conn(conn) {
                tracing::warn!(error = %err, "control conn error");
            }
        });
    }

    fn run_stream_accept(self: Arc<Self>, listener: interprocess::local_socket::Listener) {
        self.accept_loop(listener, "stream", |me, conn| {
            if let Err(err) = me.handle_stream_conn(conn) {
                tracing::warn!(error = %err, "stream conn error");
            }
        });
    }

    /// Shared poll-based accept loop. Using non-blocking accept with a
    /// short sleep (instead of `listener.incoming()`) is what lets the
    /// daemon honor the shutdown flag: a blocking `incoming()` does not
    /// return until the next connection arrives, so a `Shutdown` RPC
    /// would leave the accept threads parked forever after their last
    /// client closed. 50 ms is short enough that `acornd shutdown`
    /// feels instant and long enough that the loop is not a busy-spin
    /// (~20 syscalls per second per socket).
    fn accept_loop<F>(self: Arc<Self>, listener: interprocess::local_socket::Listener, kind: &'static str, handle: F)
    where
        F: Fn(Arc<Self>, Stream) + Send + Sync + 'static,
    {
        if let Err(err) = listener.set_nonblocking(ListenerNonblockingMode::Accept) {
            tracing::warn!(error = %err, kind, "failed to set listener non-blocking; falling back to blocking accept");
        }
        let handle = Arc::new(handle);
        loop {
            if self.shutdown_flag.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok(conn) => {
                    // `ListenerNonblockingMode::Accept` only nominally
                    // splits "non-blocking accept, blocking stream",
                    // but interprocess's macOS impl propagates the
                    // listener's non-blocking flag onto accepted
                    // streams (kqueue inherits it on accept). Reset
                    // here so the BufReader in `handle_control_conn`
                    // does not return `WouldBlock` on the first read.
                    if let Err(err) = conn.set_nonblocking(false) {
                        tracing::warn!(error = %err, kind, "failed to clear stream non-blocking flag");
                    }
                    let me = Arc::clone(&self);
                    let h = handle.clone();
                    std::thread::Builder::new()
                        .name(format!("acornd-{kind}-{}", me.alloc_seq()))
                        .spawn(move || h(me, conn))
                        .ok();
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(err) => {
                    tracing::warn!(error = %err, kind, "accept error");
                    break;
                }
            }
        }
        tracing::info!(kind, "accept loop exiting");
    }

    fn alloc_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed)
    }

    fn handle_control_conn(&self, conn: Stream) -> io::Result<()> {
        // BufRead pair: NDJSON in, NDJSON out.
        let mut reader = BufReader::new(conn);

        // Handshake: client `Hello` must arrive first.
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(()); // immediate close
        }
        let hello: Hello = match serde_json::from_str(line.trim()) {
            Ok(h) => h,
            Err(e) => {
                return write_line(reader.get_mut(), &Self::protocol_error_envelope(format!(
                    "invalid hello: {e}"
                )));
            }
        };
        if hello.protocol_version_major != PROTOCOL_VERSION_MAJOR {
            return write_line(
                reader.get_mut(),
                &Self::protocol_error_envelope(format!(
                    "protocol major mismatch: daemon={}, client={}",
                    PROTOCOL_VERSION_MAJOR, hello.protocol_version_major
                )),
            );
        }
        let persistent = matches!(hello.role, ClientRole::ControlPersistent);

        // Respond with our own hello (telemetry / version exchange).
        write_line(
            reader.get_mut(),
            &serde_json::to_string(&Hello::current(ClientRole::ControlPersistent)).unwrap(),
        )?;

        loop {
            line.clear();
            let n = reader.read_line(&mut line)?;
            if n == 0 {
                return Ok(()); // peer closed
            }
            let req: ControlRequest = match serde_json::from_str(line.trim()) {
                Ok(r) => r,
                Err(e) => {
                    let resp = ControlResponse {
                        seq: 0,
                        payload: ControlResult::Error {
                            code: ErrorCode::Invalid,
                            message: format!("bad request: {e}"),
                        },
                    };
                    write_line(reader.get_mut(), &serde_json::to_string(&resp).unwrap())?;
                    if !persistent {
                        return Ok(());
                    }
                    continue;
                }
            };
            let resp = self.dispatch(req, hello.source_session_id);
            write_line(reader.get_mut(), &serde_json::to_string(&resp).unwrap())?;
            if matches!(resp.payload, ControlResult::Error { .. }) && !persistent {
                return Ok(());
            }
            // `Shutdown` is the one payload that sets the global flag
            // inside `dispatch` AND closes this connection so the
            // client knows the daemon will not accept further requests.
            // The accept loops then exit on their next poll.
            if self.shutdown_flag.load(Ordering::SeqCst) {
                return Ok(());
            }
            if !persistent {
                return Ok(());
            }
        }
    }

    fn dispatch(
        &self,
        req: ControlRequest,
        source_session_id: Option<uuid::Uuid>,
    ) -> ControlResponse {
        let payload = match req.payload {
            ControlPayload::Ping => ControlResult::Pong {
                daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                uptime_seconds: self.uptime_seconds(),
            },
            ControlPayload::ListSessions => ControlResult::Sessions {
                sessions: self
                    .registry
                    .list()
                    .into_iter()
                    .map(|s| SessionSummary {
                        is_source: source_session_id == Some(s.id),
                        id: s.id,
                        name: s.name,
                        kind: s.kind,
                        alive: s.alive,
                        repo_path: s.repo_path,
                        branch: s.branch,
                        agent_kind: s.agent_kind,
                        pid: s.pid,
                    })
                    .collect(),
            },
            ControlPayload::SpawnSession { spec } => {
                match self.pty.spawn(spec, self.registry.clone()) {
                    Ok(spawned) => ControlResult::SessionSpawned {
                        session_id: spawned.session_id,
                        pid: spawned.pid,
                    },
                    Err(err) => ControlResult::Error {
                        code: ErrorCode::Internal,
                        message: err.to_string(),
                    },
                }
            }
            ControlPayload::SendInput {
                target_session_id,
                data_b64,
            } => match base64_decode(&data_b64) {
                Ok(bytes) => match self.pty.write(&target_session_id, &bytes) {
                    Ok(()) => ControlResult::Ack,
                    Err(err) => ControlResult::Error {
                        code: io_error_to_code(&err),
                        message: err.to_string(),
                    },
                },
                Err(msg) => ControlResult::Error {
                    code: ErrorCode::Invalid,
                    message: msg,
                },
            },
            ControlPayload::Resize {
                target_session_id,
                cols,
                rows,
            } => match self.pty.resize(&target_session_id, cols, rows) {
                Ok(()) => ControlResult::Ack,
                Err(err) => ControlResult::Error {
                    code: io_error_to_code(&err),
                    message: err.to_string(),
                },
            },
            ControlPayload::ReadBuffer {
                target_session_id,
                max_bytes,
            } => {
                let cap = max_bytes.unwrap_or(super::ring_buffer::BYTE_CAP);
                let snapshot = self
                    .registry
                    .get(&target_session_id)
                    .map(|s| s.scrollback.tail(cap));
                match snapshot {
                    Some((bytes, truncated)) => ControlResult::Buffer {
                        data_b64: base64_encode(&bytes),
                        truncated,
                    },
                    None => ControlResult::Error {
                        code: ErrorCode::NotFound,
                        message: format!("no session {target_session_id}"),
                    },
                }
            }
            ControlPayload::KillSession { target_session_id } => {
                match self.pty.kill(&target_session_id) {
                    Ok(()) => ControlResult::Ack,
                    Err(err) => ControlResult::Error {
                        code: io_error_to_code(&err),
                        message: err.to_string(),
                    },
                }
            }
            ControlPayload::ForgetSession { target_session_id } => {
                // Only allow forget if the session is already dead.
                let alive = self
                    .registry
                    .get(&target_session_id)
                    .map(|s| s.alive)
                    .unwrap_or(false);
                if alive {
                    ControlResult::Error {
                        code: ErrorCode::Invalid,
                        message: "session is still alive — kill it first".into(),
                    }
                } else if self.registry.forget(&target_session_id).is_some() {
                    ControlResult::Ack
                } else {
                    ControlResult::Error {
                        code: ErrorCode::NotFound,
                        message: format!("no session {target_session_id}"),
                    }
                }
            }
            ControlPayload::Status => ControlResult::Status {
                snapshot: StatusSnapshot {
                    daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                    uptime_seconds: self.uptime_seconds(),
                    session_count_total: self.registry.count_total() as u32,
                    session_count_alive: self.registry.count_alive() as u32,
                    rss_bytes: None,
                },
            },
            ControlPayload::Shutdown => {
                self.shutdown_flag.store(true, Ordering::SeqCst);
                ControlResult::Ack
            }
        };
        ControlResponse {
            seq: req.seq,
            payload,
        }
    }

    fn handle_stream_conn(&self, conn: Stream) -> io::Result<()> {
        let mut reader = BufReader::new(conn);

        // Hello → StreamAttach → live frames loop.
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let hello: Hello = match serde_json::from_str(line.trim()) {
            Ok(h) => h,
            Err(e) => {
                return write_line(
                    reader.get_mut(),
                    &Self::protocol_error_envelope(format!("invalid hello: {e}")),
                );
            }
        };
        if hello.protocol_version_major != PROTOCOL_VERSION_MAJOR {
            return write_line(
                reader.get_mut(),
                &Self::protocol_error_envelope(format!(
                    "protocol major mismatch: daemon={}, client={}",
                    PROTOCOL_VERSION_MAJOR, hello.protocol_version_major
                )),
            );
        }
        if !matches!(hello.role, ClientRole::Stream) {
            return write_line(
                reader.get_mut(),
                &Self::protocol_error_envelope(
                    "stream socket received non-stream role hello".into(),
                ),
            );
        }
        write_line(
            reader.get_mut(),
            &serde_json::to_string(&Hello::current(ClientRole::Stream)).unwrap(),
        )?;

        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let attach: StreamAttach = match serde_json::from_str(line.trim()) {
            Ok(a) => a,
            Err(e) => {
                return write_line(
                    reader.get_mut(),
                    &Self::protocol_error_envelope(format!("invalid stream-attach: {e}")),
                );
            }
        };

        // Snapshot scrollback first (if requested), then subscribe to live.
        if attach.replay_scrollback {
            if let Some(snap) = self.pty.scrollback_snapshot(&attach.session_id) {
                let frame = StreamFrame::Output {
                    data_b64: base64_encode(&snap),
                };
                write_line(reader.get_mut(), &serde_json::to_string(&frame).unwrap())?;
            }
        }
        let Some(mut rx) = self.pty.subscribe(&attach.session_id) else {
            let frame = StreamFrame::Exit { code: None };
            return write_line(reader.get_mut(), &serde_json::to_string(&frame).unwrap());
        };

        // Reader side (client → daemon) runs on a separate thread so
        // the broadcast pump can keep delivering even while the client
        // is mid-write.
        let session_id = attach.session_id;
        let pty_for_input = self.pty.clone();
        let input_reader = reader.get_ref().try_clone()?;
        std::thread::Builder::new()
            .name(format!("acornd-stream-in-{session_id}"))
            .spawn(move || {
                let mut r = BufReader::new(input_reader);
                let mut buf = String::new();
                loop {
                    buf.clear();
                    match r.read_line(&mut buf) {
                        Ok(0) => return,
                        Ok(_) => {}
                        Err(_) => return,
                    }
                    let frame: StreamFrame = match serde_json::from_str(buf.trim()) {
                        Ok(f) => f,
                        Err(_) => return, // protocol violation — drop
                    };
                    match frame {
                        StreamFrame::Input { data_b64 } => {
                            if let Ok(b) = base64_decode(&data_b64) {
                                let _ = pty_for_input.write(&session_id, &b);
                            }
                        }
                        StreamFrame::Resize { cols, rows } => {
                            let _ = pty_for_input.resize(&session_id, cols, rows);
                        }
                        StreamFrame::ClientNote { .. } => {} // telemetry-only
                        _ => {} // daemon-bound frames from client are ignored
                    }
                }
            })?;

        // Pump loop: forward broadcast output to the socket.
        loop {
            match rx.blocking_recv() {
                Ok(chunk) => {
                    let frame = StreamFrame::Output {
                        data_b64: base64_encode(&chunk),
                    };
                    if write_line(reader.get_mut(), &serde_json::to_string(&frame).unwrap())
                        .is_err()
                    {
                        return Ok(());
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    // Slow consumer — emit a note but keep going.
                    let note = StreamFrame::ServerNote {
                        message: "consumer lagged; some output dropped".into(),
                    };
                    let _ = write_line(reader.get_mut(), &serde_json::to_string(&note).unwrap());
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // PTY exited. Emit an Exit frame and close.
                    let code = self
                        .registry
                        .get(&session_id)
                        .and_then(|s| s.exit_code);
                    let frame = StreamFrame::Exit { code };
                    let _ = write_line(reader.get_mut(), &serde_json::to_string(&frame).unwrap());
                    return Ok(());
                }
            }
        }
    }

    fn protocol_error_envelope(msg: String) -> String {
        let env = ControlResponse {
            seq: 0,
            payload: ControlResult::Error {
                code: ErrorCode::ProtocolMismatch,
                message: msg,
            },
        };
        serde_json::to_string(&env).unwrap()
    }
}

fn write_line<W: Write>(w: &mut W, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

fn io_error_to_code(err: &io::Error) -> ErrorCode {
    match err.kind() {
        io::ErrorKind::NotFound => ErrorCode::NotFound,
        io::ErrorKind::InvalidInput => ErrorCode::Invalid,
        _ => ErrorCode::Internal,
    }
}

/// Minimal base64 encode/decode local to the daemon so the binary does
/// not pull in the `base64` crate's full feature surface. Kept in sync
/// with `crate::pty::base64_encode` semantics (RFC 4648).
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut chunks = input.chunks_exact(3);
    for chunk in &mut chunks {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHABET[(n & 0x3f) as usize] as char);
    }
    let rem = chunks.remainder();
    match rem.len() {
        0 => {}
        1 => {
            let n = u32::from(rem[0]) << 16;
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = (u32::from(rem[0]) << 16) | (u32::from(rem[1]) << 8);
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
            out.push('=');
        }
        _ => unreachable!(),
    }
    out
}

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
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
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
    use super::super::protocol::SessionKind;

    #[test]
    fn base64_roundtrip() {
        let cases = [&b""[..], &b"hello"[..], &b"hello world"[..], &b"\x00\x01\xff"[..]];
        for input in cases {
            let encoded = base64_encode(input);
            let decoded = base64_decode(&encoded).unwrap();
            assert_eq!(&decoded, input);
        }
    }

    #[test]
    fn ping_returns_pong() {
        let d = Daemon::new();
        let req = ControlRequest {
            seq: 1,
            payload: ControlPayload::Ping,
        };
        let resp = d.dispatch(req, None);
        assert_eq!(resp.seq, 1);
        match resp.payload {
            ControlResult::Pong { .. } => {}
            other => panic!("expected pong, got {other:?}"),
        }
    }

    #[test]
    fn forget_alive_session_is_rejected() {
        let d = Daemon::new();
        let id = uuid::Uuid::new_v4();
        d.registry.insert(super::super::session::DaemonSession::new(
            id,
            "test".into(),
            SessionKind::Regular,
            std::path::PathBuf::from("/tmp"),
        ));
        let req = ControlRequest {
            seq: 2,
            payload: ControlPayload::ForgetSession {
                target_session_id: id,
            },
        };
        let resp = d.dispatch(req, None);
        match resp.payload {
            ControlResult::Error { code, .. } => assert_eq!(code, ErrorCode::Invalid),
            other => panic!("expected Invalid error, got {other:?}"),
        }
    }

    #[test]
    fn forget_dead_session_succeeds() {
        let d = Daemon::new();
        let id = uuid::Uuid::new_v4();
        d.registry.insert(super::super::session::DaemonSession::new(
            id,
            "test".into(),
            SessionKind::Regular,
            std::path::PathBuf::from("/tmp"),
        ));
        d.registry.mark_dead(&id, Some(0));
        let req = ControlRequest {
            seq: 3,
            payload: ControlPayload::ForgetSession {
                target_session_id: id,
            },
        };
        let resp = d.dispatch(req, None);
        match resp.payload {
            ControlResult::Ack => {}
            other => panic!("expected Ack, got {other:?}"),
        }
    }
}
