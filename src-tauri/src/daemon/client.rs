//! Daemon client helpers used both by the `acornd` CLI subcommands and by
//! the Acorn app's Tauri command shims.
//!
//! Wire shape mirrors `server::handle_control_conn`: every connection
//! opens with a `Hello` exchange, then a sequence of `ControlRequest` →
//! `ControlResponse` round-trips. The one-shot variants below open a
//! fresh connection per call; the app uses `ControlConn::persistent` so
//! its long-lived session-management traffic does not pay handshake
//! overhead per request.

use std::io::{self, BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use interprocess::TryClone;
use interprocess::local_socket::Stream;

use super::protocol::{
    ClientRole, ControlPayload, ControlRequest, ControlResponse, ControlResult, Hello,
    StatusSnapshot,
};
use super::socket;

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

        let mut hello = Hello::current(ClientRole::ControlPersistent);
        hello.client_name = Some(client_name.into());
        writeln!(writer, "{}", serde_json::to_string(&hello).map_err(io::Error::other)?)?;
        writer.flush()?;
        // Read server hello.
        let mut buf = String::new();
        reader.read_line(&mut buf)?;
        // Currently we do not enforce server hello details — the server
        // already validated ours and will close the connection if its
        // own version is too far ahead. Future versions may inspect
        // `client_name` or feature flags here.

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
        if self.reader.read_line(&mut buf)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "daemon closed"));
        }
        serde_json::from_str(buf.trim()).map_err(io::Error::other)
    }
}

/// Open a fresh connection, send one request, and close. Used by the
/// `acornd` CLI subcommands and by app probes that do not want to pin a
/// long-lived connection (e.g. status polling from the StatusBar).
pub fn one_shot(payload: ControlPayload) -> io::Result<ControlResponse> {
    let conn = socket::connect_control()?;
    let mut writer = conn.try_clone()?;
    let mut reader = BufReader::new(conn);

    let hello = Hello::current(ClientRole::ControlOneShot);
    writeln!(writer, "{}", serde_json::to_string(&hello).map_err(io::Error::other)?)?;
    writer.flush()?;
    let mut buf = String::new();
    reader.read_line(&mut buf)?;
    // Server hello consumed (not currently inspected).

    let req = ControlRequest { seq: 1, payload };
    writeln!(writer, "{}", serde_json::to_string(&req).map_err(io::Error::other)?)?;
    writer.flush()?;
    buf.clear();
    if reader.read_line(&mut buf)? == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "daemon closed"));
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
