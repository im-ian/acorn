//! Pseudoterminal (PTY) backend for Acorn.
//!
//! Manages a pool of PTY-backed child processes (typically `claude` CLI), keyed
//! by session UUID. Each session has:
//!   * a master writer used to forward stdin
//!   * a process child handle used to kill the process
//!   * a stop flag used to signal the reader task to exit cleanly
//!
//! Output bytes are read on a blocking thread, base64-encoded, and emitted to
//! the frontend via Tauri events:
//!   * `pty:output:{session_id}` — payload `{ "data": "<base64>" }`
//!   * `pty:exit:{session_id}` — payload `{ "code": Option<i32> }`

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dashmap::DashMap;
use parking_lot::Mutex;
use portable_pty::{
    Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const READ_BUFFER_SIZE: usize = 4096;

/// Per-session PTY state held by the manager.
struct PtyHandle {
    /// Master end of the PTY — used for resize and as the source of the writer.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Writer cloned from master on spawn — used for stdin forwarding.
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Killer cloned from the child process — safe to use across threads.
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// When set, the reader task will exit on its next loop iteration.
    stop: Arc<AtomicBool>,
}

/// Manages all live PTY sessions for the application.
#[derive(Default)]
pub struct PtyManager {
    handles: Arc<DashMap<Uuid, Arc<PtyHandle>>>,
}

#[derive(Serialize, Clone)]
struct OutputPayload {
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    code: Option<i32>,
}

impl PtyManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Spawn a new PTY-backed process for the given session.
    ///
    /// `cols`/`rows` of 0 fall back to 80x24.
    pub fn spawn<R: Runtime>(
        &self,
        app: AppHandle<R>,
        session_id: Uuid,
        cwd: PathBuf,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> AppResult<()> {
        if self.handles.contains_key(&session_id) {
            return Err(AppError::Pty(format!(
                "session already has an active pty: {session_id}"
            )));
        }

        let size = PtySize {
            cols: if cols == 0 { DEFAULT_COLS } else { cols },
            rows: if rows == 0 { DEFAULT_ROWS } else { rows },
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| AppError::Pty(format!("openpty failed: {e}")))?;

        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(arg);
        }
        cmd.cwd(&cwd);
        // Pretend the child PTY was not launched from Apple Terminal.
        //
        // When acorn itself is launched from Terminal.app the child shell
        // inherits `TERM_PROGRAM=Apple_Terminal` and `TERM_SESSION_ID=<UUID>`.
        // /etc/zshrc then sources `/etc/zshrc_Apple_Terminal`, which:
        //   - prints "Restored session: <date>" on every new PTY,
        //   - prints "Saving session...completed." (and sometimes
        //     "Deleting expired sessions...") on every exit,
        //   - writes per-session restore files under `~/.zsh_sessions/`
        //     keyed by the inherited `TERM_SESSION_ID`,
        //   - on exit, runs `rm $TERM_SESSION_ID.session`, which prints
        //     `rm: ... .session: No such file or directory` whenever the
        //     save was suppressed but the inherited session id had no
        //     corresponding file (e.g. `SHELL_SESSIONS_DISABLE=1` is set,
        //     or the parent Terminal.app already cleaned it up).
        //
        // None of this adds value inside acorn — acorn manages its own
        // session lifecycle. Removing `TERM_PROGRAM` makes the conditional
        // in /etc/zshrc fall through, so `zshrc_Apple_Terminal` is never
        // sourced; removing `TERM_SESSION_ID` ensures no leftover id leaks
        // into anything else (e.g. user .zshrc) that keys off it.
        // `SHELL_SESSIONS_DISABLE=1` is kept as belt-and-suspenders for
        // user shells that source the Apple Terminal hooks themselves.
        // `~/.zsh_history` (HISTFILE/HISTSIZE/SAVEHIST) is independent of
        // all of these and continues to work normally.
        cmd.env_remove("TERM_PROGRAM");
        cmd.env_remove("TERM_SESSION_ID");
        cmd.env("SHELL_SESSIONS_DISABLE", "1");
        for (k, v) in env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Pty(format!("spawn_command failed: {e}")))?;
        // Slave is no longer needed in this process; dropping it lets the child
        // own the pty slave fd and prevents EOF stalls when the child exits.
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(format!("take_writer failed: {e}")))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Pty(format!("try_clone_reader failed: {e}")))?;
        let killer = child.clone_killer();

        let stop = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            stop: stop.clone(),
        });

        self.handles.insert(session_id, handle);

        let app_for_reader = app.clone();
        let stop_for_reader = stop.clone();
        std::thread::Builder::new()
            .name(format!("acorn-pty-read-{session_id}"))
            .spawn(move || {
                read_loop(app_for_reader, session_id, reader, stop_for_reader);
            })
            .map_err(|e| AppError::Pty(format!("spawn reader thread: {e}")))?;

        let app_for_waiter = app;
        let manager_handles = Arc::clone(&self.handles);
        std::thread::Builder::new()
            .name(format!("acorn-pty-wait-{session_id}"))
            .spawn(move || {
                wait_loop(app_for_waiter, session_id, child, manager_handles, stop);
            })
            .map_err(|e| AppError::Pty(format!("spawn wait thread: {e}")))?;

        Ok(())
    }

    /// Forward raw bytes to the PTY master (stdin).
    pub fn write(&self, session_id: &Uuid, data: &[u8]) -> AppResult<()> {
        let handle = self
            .handles
            .get(session_id)
            .ok_or_else(|| AppError::Pty(format!("no pty for session {session_id}")))?
            .clone();
        let mut writer = handle.writer.lock();
        writer
            .write_all(data)
            .map_err(|e| AppError::Pty(format!("write failed: {e}")))?;
        writer
            .flush()
            .map_err(|e| AppError::Pty(format!("flush failed: {e}")))?;
        Ok(())
    }

    /// Resize the PTY window.
    pub fn resize(&self, session_id: &Uuid, cols: u16, rows: u16) -> AppResult<()> {
        let handle = self
            .handles
            .get(session_id)
            .ok_or_else(|| AppError::Pty(format!("no pty for session {session_id}")))?
            .clone();
        let size = PtySize {
            cols: if cols == 0 { DEFAULT_COLS } else { cols },
            rows: if rows == 0 { DEFAULT_ROWS } else { rows },
            pixel_width: 0,
            pixel_height: 0,
        };
        handle
            .master
            .lock()
            .resize(size)
            .map_err(|e| AppError::Pty(format!("resize failed: {e}")))?;
        Ok(())
    }

    /// Kill the child process and stop the reader task.
    pub fn kill(&self, session_id: &Uuid) -> AppResult<()> {
        let handle = self
            .handles
            .get(session_id)
            .ok_or_else(|| AppError::Pty(format!("no pty for session {session_id}")))?
            .clone();
        handle.stop.store(true, Ordering::SeqCst);
        handle
            .killer
            .lock()
            .kill()
            .map_err(|e| AppError::Pty(format!("kill failed: {e}")))?;
        Ok(())
    }

    /// Returns true if a PTY is currently registered for the given session.
    pub fn contains(&self, session_id: &Uuid) -> bool {
        self.handles.contains_key(session_id)
    }
}

fn read_loop<R: Runtime>(
    app: AppHandle<R>,
    session_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    stop: Arc<AtomicBool>,
) {
    let event = format!("pty:output:{session_id}");
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF — child closed the slave
            Ok(n) => {
                let payload = OutputPayload {
                    data: base64_encode(&buf[..n]),
                };
                if let Err(e) = app.emit(&event, payload) {
                    tracing::warn!(%session_id, error = %e, "failed to emit pty output");
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                tracing::warn!(%session_id, error = %e, "pty read error");
                break;
            }
        }
    }
}

fn wait_loop<R: Runtime>(
    app: AppHandle<R>,
    session_id: Uuid,
    mut child: Box<dyn Child + Send + Sync>,
    handles: Arc<DashMap<Uuid, Arc<PtyHandle>>>,
    stop: Arc<AtomicBool>,
) {
    let exit_event = format!("pty:exit:{session_id}");
    let code = match child.wait() {
        Ok(status) => Some(status.exit_code() as i32),
        Err(e) => {
            tracing::warn!(%session_id, error = %e, "pty wait error");
            None
        }
    };
    stop.store(true, Ordering::SeqCst);
    handles.remove(&session_id);
    if let Err(e) = app.emit(&exit_event, ExitPayload { code }) {
        tracing::warn!(%session_id, error = %e, "failed to emit pty exit");
    }
}

/// Minimal RFC 4648 base64 encoder. Avoids pulling in a runtime dep purely
/// for transport encoding of PTY chunks.
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encodes_empty_input() {
        assert_eq!(base64_encode(&[]), "");
    }

    #[test]
    fn base64_encodes_single_byte() {
        assert_eq!(base64_encode(b"f"), "Zg==");
    }

    #[test]
    fn base64_encodes_two_bytes() {
        assert_eq!(base64_encode(b"fo"), "Zm8=");
    }

    #[test]
    fn base64_encodes_three_bytes() {
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn base64_encodes_classic_man() {
        assert_eq!(base64_encode(b"Man"), "TWFu");
    }

    #[test]
    fn base64_encodes_long_input() {
        assert_eq!(
            base64_encode(b"hello world"),
            "aGVsbG8gd29ybGQ="
        );
    }
}
