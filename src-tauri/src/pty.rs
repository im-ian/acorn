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

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

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
/// Hard cap on the per-session in-memory tail buffer used by the
/// `acorn-ipc read-buffer` command. Sized to roughly match xterm.js's
/// configured scrollback so the buffer the CLI can read mirrors what the
/// user sees in the terminal. The frontend already persists its own
/// scrollback to disk on a debounce; this ring lives purely in RAM.
const TAIL_BUFFER_CAP: usize = 4 * 1024 * 1024;
/// How long a "just-finished a command" cue lingers as `NeedsInput` on the
/// Sidebar dot before we let it fall back to `Idle`. Long enough to actually
/// catch the user's eye after a transient command (`ls`, `git status`),
/// short enough that an abandoned shell does not look perpetually pending.
const NEEDS_INPUT_STICKY: Duration = Duration::from_secs(5);

/// Coarse classification of a shell-mode session's liveness, derived purely
/// from "does the PTY child have any descendant processes right now?".
/// Mirrors the `SessionStatus` variants the Sidebar dot already knows how to
/// render — we keep this enum private to the backend so the
/// transcript-driven detector can map it without leaking shell-specific
/// vocabulary into the public session status type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellHint {
    Running,
    NeedsInput,
    Idle,
}

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
    /// PID of the spawned PTY child. Captured at spawn time because the
    /// `Child` handle moves into the wait thread. `None` if the platform
    /// did not return one (portable-pty allows that).
    pid: Option<u32>,
    /// Whether the previous liveness poll observed a live descendant of the
    /// PTY child. The Idle→Running and Running→NeedsInput edges drive the
    /// Sidebar status dot for shell-mode sessions.
    had_child: AtomicBool,
    /// Deadline for the post-command "still waiting on you" cue. Set when the
    /// last descendant exits, cleared on the next user keystroke or when the
    /// deadline passes.
    needs_input_until: Mutex<Option<Instant>>,
    /// Rolling tail of raw PTY output bytes. Appended by `read_loop` before
    /// the bytes are base64-encoded and emitted to the frontend; consumed
    /// out of band by `tail_bytes` for the IPC `read-buffer` command.
    /// Capped at `TAIL_BUFFER_CAP` — older bytes are dropped from the
    /// front when the cap is hit.
    tail_buf: Mutex<VecDeque<u8>>,
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
        // Suppress macOS zsh's per-session restore (`/etc/zshrc_Apple_Terminal`).
        // When acorn is launched from Terminal.app the child PTY inherits
        // `TERM_PROGRAM=Apple_Terminal` and zsh treats every fresh PTY as a
        // resumable Terminal.app session, printing "Restored session: ..."
        // / "Saving session...completed." and writing per-session files into
        // `~/.zsh_sessions/`. acorn manages its own session lifecycle and
        // does not want zsh layering its own on top. `~/.zsh_history`
        // (HISTFILE) is unaffected — only the dirstack/last-commands
        // restore feature is disabled.
        //
        // Set this *before* applying the user-provided env so a user can
        // still opt back in by passing `SHELL_SESSIONS_DISABLE=0`.
        cmd.env("SHELL_SESSIONS_DISABLE", "1");

        // Layered env applied lowest-to-highest priority. Each layer skips
        // keys that a higher-priority layer would overwrite, so the user's
        // dotfile (C) wins over our locale guess (B) wins over our
        // render-capability declaration (A) — and the caller's explicit
        // `env` argument trumps everything. This mirrors how Terminal.app /
        // iTerm2 inject TERM and LANG before the shell runs while still
        // letting `~/.zshenv` override.
        let shell_env = crate::shell_env::resolve();
        let mut applied: std::collections::HashSet<String> = env.keys().cloned().collect();

        // (A) Render capability — TERM advertises what xterm.js renders, so
        // zsh's terminfo lookups (used by zsh-autosuggestions for cursor
        // save/restore) and color-aware CLIs (claude, fzf, …) emit
        // sequences we can actually paint. Without this, GUI-launched
        // acorn inherits an empty TERM and color/redraw goes wrong.
        const RENDER_CAPABILITY: &[(&str, &str)] = &[
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
        ];
        for (k, v) in RENDER_CAPABILITY {
            if !applied.contains(*k) && !shell_env.contains_key(*k) {
                cmd.env(k, v);
                applied.insert((*k).to_string());
            }
        }

        // (B) System locale — Terminal.app's "Set locale environment
        // variables on startup" injects LANG from the user's macOS
        // Language & Region preference. We do the same so PTY children
        // start with a UTF-8 locale even on a fresh macOS install with
        // no LANG in any dotfile.
        if !applied.contains("LANG") && !shell_env.contains_key("LANG") {
            let lang = crate::shell_env::system_locale_lang()
                .unwrap_or_else(|| "en_US.UTF-8".to_string());
            cmd.env("LANG", &lang);
            applied.insert("LANG".to_string());
        }

        // (C) Dotfile-set environment captured from the user's login shell
        // (`~/.zshenv` / `~/.zprofile` / `~/.zshrc`). Honors anything the
        // user explicitly exported — LANG, EDITOR, PAGER, TZ, etc. —
        // without acorn having to know each shell's rc-file conventions.
        for (k, v) in &shell_env {
            if !applied.contains(k) {
                cmd.env(k, v);
                applied.insert(k.clone());
            }
        }

        // (caller) Frontend-supplied env wins over everything above. Lets a
        // future per-session settings UI (or a test harness) force-override
        // any value we'd otherwise pick.
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
        let pid = child.process_id();

        let stop = Arc::new(AtomicBool::new(false));
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            stop: stop.clone(),
            pid,
            had_child: AtomicBool::new(false),
            needs_input_until: Mutex::new(None),
            tail_buf: Mutex::new(VecDeque::with_capacity(READ_BUFFER_SIZE)),
        });

        self.handles.insert(session_id, Arc::clone(&handle));

        let app_for_reader = app.clone();
        let stop_for_reader = stop.clone();
        let handle_for_reader = Arc::clone(&handle);
        std::thread::Builder::new()
            .name(format!("acorn-pty-read-{session_id}"))
            .spawn(move || {
                read_loop(
                    app_for_reader,
                    session_id,
                    reader,
                    stop_for_reader,
                    handle_for_reader,
                );
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
        // The user typed — they've moved on from the previous "command just
        // exited" cue, so suppress the sticky NeedsInput before the next
        // liveness poll lands.
        drop(writer);
        *handle.needs_input_until.lock() = None;
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

    /// PID of the immediate PTY child for a session, if known. Used by the
    /// frontend to discover the actual current working directory of the
    /// running process (and any descendants), so the right panel can follow
    /// `claude --worktree` / interactive `cd` instead of staying pinned to
    /// the cwd we set at spawn time.
    pub fn child_pid(&self, session_id: &Uuid) -> Option<u32> {
        self.handles.get(session_id).and_then(|h| h.pid)
    }

    /// Per-poll state machine for shell-mode liveness. The caller has just
    /// computed `has_child_now` from a process-table snapshot; we fold it
    /// against the previous observation and the sticky NeedsInput deadline
    /// to produce the hint the Sidebar dot should show.
    ///
    /// Returns `None` when the session has no live PTY (e.g. exited between
    /// the snapshot and this call) — the caller should treat that as Idle.
    pub fn update_shell_state(
        &self,
        session_id: &Uuid,
        has_child_now: bool,
    ) -> Option<ShellHint> {
        let handle = self.handles.get(session_id)?.clone();
        let had_child = handle.had_child.swap(has_child_now, Ordering::SeqCst);
        let mut sticky = handle.needs_input_until.lock();
        let hint = if has_child_now {
            *sticky = None;
            ShellHint::Running
        } else if had_child {
            // Just transitioned from "child running" → "no child"; arm the
            // sticky window so a quick command surfaces NeedsInput before
            // the next poll erases the signal.
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

    /// Drop the sticky NeedsInput cue, if any. Exposed so callers other than
    /// `write` (e.g. a future "user focused the terminal" hook) can also
    /// dismiss the cue without typing.
    #[allow(dead_code)]
    pub fn clear_needs_input(&self, session_id: &Uuid) {
        if let Some(handle) = self.handles.get(session_id) {
            *handle.needs_input_until.lock() = None;
        }
    }

    /// Snapshot up to `max_bytes` of the most recent PTY output for the
    /// given session. Returns `Some((bytes, truncated))` when a PTY exists
    /// for the session (`truncated` indicates whether the underlying tail
    /// buffer held more bytes than were returned), or `None` when the
    /// session has no live PTY. Pure read — does not drain the buffer.
    pub fn tail_bytes(
        &self,
        session_id: &Uuid,
        max_bytes: usize,
    ) -> Option<(Vec<u8>, bool)> {
        let handle = self.handles.get(session_id)?.clone();
        let buf = handle.tail_buf.lock();
        let total = buf.len();
        let take = max_bytes.min(total);
        // Take the *tail* of the ring, since that is the freshest output
        // the user (and any agent reading via IPC) would expect to see.
        let start = total - take;
        let slice: Vec<u8> = buf.iter().skip(start).copied().collect();
        Some((slice, total > take))
    }
}

fn read_loop<R: Runtime>(
    app: AppHandle<R>,
    session_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    stop: Arc<AtomicBool>,
    handle: Arc<PtyHandle>,
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
                push_tail(&handle.tail_buf, &buf[..n]);
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

/// Append `chunk` to the per-session tail ring buffer, evicting bytes from
/// the front when the cap is exceeded so the buffer can never grow past
/// `TAIL_BUFFER_CAP` bytes. Pure data movement — `Mutex` is the only
/// synchronization point, no allocation in the steady state once the
/// buffer has reached its cap.
fn push_tail(tail: &Mutex<VecDeque<u8>>, chunk: &[u8]) {
    let mut buf = tail.lock();
    let overflow = buf.len() + chunk.len();
    if overflow > TAIL_BUFFER_CAP {
        let drop_n = overflow - TAIL_BUFFER_CAP;
        if drop_n >= buf.len() {
            buf.clear();
        } else {
            buf.drain(..drop_n);
        }
    }
    buf.extend(chunk.iter().copied());
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

    #[test]
    fn push_tail_keeps_recent_bytes_when_cap_exceeded() {
        let tail: Mutex<VecDeque<u8>> = Mutex::new(VecDeque::new());
        // Push twice the cap; expect exactly TAIL_BUFFER_CAP bytes left,
        // and those bytes should be the tail half of what we pushed.
        let cap = TAIL_BUFFER_CAP;
        let chunk_a = vec![1u8; cap];
        let chunk_b = vec![2u8; cap];
        push_tail(&tail, &chunk_a);
        push_tail(&tail, &chunk_b);
        let buf = tail.lock();
        assert_eq!(buf.len(), cap);
        // After eviction the buffer should be all 2s — the older 1s were
        // dropped because they fell off the front.
        assert!(buf.iter().all(|&b| b == 2));
    }

    #[test]
    fn push_tail_handles_chunks_smaller_than_cap() {
        let tail: Mutex<VecDeque<u8>> = Mutex::new(VecDeque::new());
        push_tail(&tail, b"hello");
        push_tail(&tail, b" world");
        let buf = tail.lock();
        let collected: Vec<u8> = buf.iter().copied().collect();
        assert_eq!(&collected, b"hello world");
    }
}
