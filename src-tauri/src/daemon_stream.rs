//! App-side stream attachment to a daemon-managed PTY.
//!
//! Bridges the daemon's per-session stream socket to the Tauri event bus
//! the frontend already listens on (`pty:output:{uuid}` / `pty:exit:{uuid}`),
//! so `commands::pty_spawn` can route through the daemon without the
//! frontend `Terminal.tsx` knowing whether a session is daemon-managed
//! or in-process.
//!
//! Each attach owns one background thread that reads `StreamFrame`s
//! line-by-line, re-emits the byte chunks as Tauri events, and exits on
//! a clean `Exit` frame or socket close. A second thread (input/resize)
//! is intentionally NOT spawned — keystrokes and resizes go through the
//! control socket via `daemon_bridge::send_input` / `resize`, which is a
//! single short RPC round-trip per event and avoids managing two
//! per-session sockets on the app side.

use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use dashmap::DashMap;
use interprocess::local_socket::Stream;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use crate::daemon::protocol::{ClientRole, Hello, StreamAttach, StreamFrame};
use crate::daemon::socket;

/// Same sticky window the in-process PtyManager uses for the
/// post-command "still waiting on you" NeedsInput cue. Mirrors
/// `pty::NEEDS_INPUT_STICKY` so daemon-managed and in-process
/// sessions show identical UI behavior.
const NEEDS_INPUT_STICKY: std::time::Duration = std::time::Duration::from_secs(5);

/// Per-session attachment handle. Dropping the handle does not stop the
/// pump; call `stop()` first, otherwise the reader thread keeps draining
/// the socket until the daemon emits an `Exit` frame or the connection
/// closes.
pub struct StreamAttachment {
    stop: Arc<AtomicBool>,
    /// OS process id of the daemon-side PTY child captured at spawn /
    /// attach. Used by status polling to walk descendants for
    /// shell-mode classification (Running / NeedsInput / Idle).
    pub pid: Option<u32>,
    /// Previous "has live descendant" sample. Drives the
    /// Running → NeedsInput transition the same way
    /// `PtyHandle.had_child` does for in-process sessions.
    had_child: AtomicBool,
    /// Deadline for the sticky NeedsInput cue. Cleared by an input
    /// write or by the next status poll past the deadline.
    needs_input_until: Mutex<Option<Instant>>,
}

impl StreamAttachment {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// App-wide registry of live stream attachments, keyed by the Acorn
/// session UUID (which equals the daemon session UUID — see
/// `daemon_bridge::spawn`). Stored on `AppState` so `pty_spawn` can
/// detect "already attached" and skip the re-attach round-trip on tab
/// activation, and so `pty_kill` can release the attachment cleanly.
#[derive(Default)]
pub struct StreamRegistry {
    inner: Arc<DashMap<Uuid, Arc<StreamAttachment>>>,
}

impl StreamRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn contains(&self, id: &Uuid) -> bool {
        self.inner.contains_key(id)
    }

    /// Stop and remove the attachment for a session. Idempotent — a
    /// missing key is a no-op so `pty_kill` does not need to check
    /// presence first.
    pub fn drop_attachment(&self, id: &Uuid) {
        if let Some((_, handle)) = self.inner.remove(id) {
            handle.stop();
        }
    }

    /// Look up the immediate PTY child pid for a daemon-managed
    /// session. Mirrors `PtyManager::child_pid` so status polling can
    /// stay routing-agnostic.
    pub fn pid(&self, id: &Uuid) -> Option<u32> {
        self.inner.get(id).and_then(|r| r.value().pid)
    }

    /// Drive the shell-mode state machine the same way the in-process
    /// path does: fold a fresh `has_child_now` against the previous
    /// observation and the sticky NeedsInput deadline. Returns `None`
    /// when no attachment exists for `id` so the caller can treat that
    /// as Idle.
    pub fn update_shell_state(
        &self,
        id: &Uuid,
        has_child_now: bool,
    ) -> Option<crate::pty::ShellHint> {
        use crate::pty::ShellHint;
        let handle = self.inner.get(id)?.value().clone();
        let had_child = handle.had_child.swap(has_child_now, Ordering::SeqCst);
        let mut sticky = handle.needs_input_until.lock();
        let hint = if has_child_now {
            *sticky = None;
            ShellHint::Running
        } else if had_child {
            *sticky = Some(Instant::now() + NEEDS_INPUT_STICKY);
            ShellHint::NeedsInput
        } else {
            match *sticky {
                Some(deadline) if Instant::now() < deadline => ShellHint::NeedsInput,
                _ => {
                    *sticky = None;
                    ShellHint::Idle
                }
            }
        };
        Some(hint)
    }

    fn insert(&self, id: Uuid, handle: Arc<StreamAttachment>) {
        if let Some((_, old)) = self.inner.remove(&id) {
            old.stop();
        }
        self.inner.insert(id, handle);
    }
}

/// Payload shape the frontend Terminal listens for on `pty:output:{uuid}`.
/// Matches `crate::pty::OutputPayload` (private to that module, hence
/// duplicated here — same key name `data`, same base64 value, so a
/// daemon-attached terminal is byte-equivalent to an in-process one).
#[derive(Serialize, Clone)]
struct OutputPayload {
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    code: Option<i32>,
}

/// Open a stream attachment for `session_id`. The daemon must already
/// have a live PTY under this UUID; if not, the reader thread receives
/// an immediate `Exit` frame and the attachment self-cleans.
///
/// `replay_scrollback` defaults to true so a tab reopened after Acorn
/// restart sees the last screen contents the daemon recorded.
pub fn attach<R: Runtime>(
    app: AppHandle<R>,
    registry: Arc<StreamRegistry>,
    session_id: Uuid,
    pid: Option<u32>,
    replay_scrollback: bool,
) -> std::io::Result<()> {
    let mut conn = socket::connect_stream()?;

    // Handshake: Hello → server Hello → StreamAttach.
    let hello = Hello::current(ClientRole::Stream);
    writeln!(
        conn,
        "{}",
        serde_json::to_string(&hello).map_err(std::io::Error::other)?
    )?;
    conn.flush()?;
    // Drain the daemon's hello so subsequent reads land on stream
    // frames. We do not validate it further — the connect+major-version
    // check already succeeded, the rest is telemetry.
    let mut reader = BufReader::new(conn);
    let mut buf = String::new();
    reader.read_line(&mut buf)?;

    let attach = StreamAttach {
        session_id,
        replay_scrollback,
    };
    {
        let writer = reader.get_mut();
        writeln!(
            writer,
            "{}",
            serde_json::to_string(&attach).map_err(std::io::Error::other)?
        )?;
        writer.flush()?;
    }

    let stop = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(StreamAttachment {
        stop: stop.clone(),
        pid,
        had_child: AtomicBool::new(false),
        needs_input_until: Mutex::new(None),
    });
    registry.insert(session_id, handle);

    let registry_for_thread = Arc::clone(&registry);
    std::thread::Builder::new()
        .name(format!("acorn-daemon-stream-{session_id}"))
        .spawn(move || {
            pump_loop(app, registry_for_thread, session_id, reader, stop);
        })?;
    Ok(())
}

fn pump_loop<R: Runtime>(
    app: AppHandle<R>,
    registry: Arc<StreamRegistry>,
    session_id: Uuid,
    mut reader: BufReader<Stream>,
    stop: Arc<AtomicBool>,
) {
    let out_event = format!("pty:output:{session_id}");
    let exit_event = format!("pty:exit:{session_id}");
    let mut line = String::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                // Daemon closed the connection without an Exit frame —
                // could be a daemon shutdown or a crash. Emit an Exit
                // with no code so the frontend's listener cleanly
                // transitions to the exited state instead of hanging
                // waiting for output.
                let _ = app.emit(&exit_event, ExitPayload { code: None });
                break;
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(%session_id, error = %err, "daemon stream read error");
                let _ = app.emit(&exit_event, ExitPayload { code: None });
                break;
            }
        }
        let frame: StreamFrame = match serde_json::from_str(line.trim()) {
            Ok(f) => f,
            Err(err) => {
                tracing::warn!(%session_id, error = %err, raw = %line.trim(), "bad daemon stream frame");
                continue;
            }
        };
        match frame {
            StreamFrame::Output { data_b64 } => {
                if let Err(err) = app.emit(&out_event, OutputPayload { data: data_b64 }) {
                    tracing::warn!(%session_id, error = %err, "failed to emit pty output");
                }
            }
            StreamFrame::Exit { code } => {
                let _ = app.emit(&exit_event, ExitPayload { code });
                break;
            }
            StreamFrame::ServerNote { message } => {
                tracing::info!(%session_id, %message, "daemon stream note");
            }
            // Daemon-bound frames received from the daemon would be a
            // protocol mistake; drop silently rather than fail the
            // whole stream.
            StreamFrame::Input { .. }
            | StreamFrame::Resize { .. }
            | StreamFrame::ClientNote { .. } => {}
        }
    }
    registry.drop_attachment(&session_id);
}
