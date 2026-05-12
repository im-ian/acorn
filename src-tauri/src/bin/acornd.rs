//! `acornd` — Acorn background daemon and CLI surface.
//!
//! Multiple modes, all dispatched by `clap`:
//!
//! ```text
//! acornd                    # default → daemon foreground (alias of `serve --foreground`)
//! acornd serve              # daemon mode (foreground)
//! acornd serve --detach     # daemon mode, fork into the background (Unix)
//! acornd status             # CLI: probe a running daemon, print version + counts
//! acornd list-sessions      # CLI: enumerate sessions
//! acornd shutdown           # CLI: ask daemon to quit gracefully
//! ```
//!
//! Future subcommands (`create-tab`, `send-keys`, `select-session`, etc.)
//! will land in Sprint 3 alongside the `acorn-ipc` removal. For now this
//! binary establishes the surface and the daemon serve path; the CLI
//! gestures here are the minimum needed for app probes / smoke tests.

use std::io;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use acorn_lib::daemon;

#[derive(Parser, Debug)]
#[command(
    name = "acornd",
    about = "Acorn background daemon and CLI surface",
    version,
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run the daemon. Default when no subcommand is given.
    Serve {
        /// Detach from the controlling terminal (Unix only). The default
        /// is foreground so `acornd` is straightforward to debug from a
        /// shell. The Acorn app passes `--detach` when spawning the
        /// daemon as a background process so the daemon survives the
        /// app exiting.
        #[arg(long)]
        detach: bool,
    },
    /// Probe a running daemon. Exits non-zero if no daemon answered.
    Status,
    /// List sessions tracked by the daemon (alive + dead).
    ListSessions,
    /// Forward keystrokes to a target session's PTY stdin. The `<DATA>`
    /// is sent byte-for-byte; the terminal's line discipline handles
    /// any interpretation. Use `--enter` to append a carriage return so
    /// a one-liner submits cleanly (matches a real keyboard's Enter).
    SendKeys {
        /// Target session UUID.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Literal data (UTF-8). Mutually exclusive with `--raw-base64`.
        #[arg(short = 'd', long = "data")]
        data: Option<String>,
        /// Pre-encoded base64 bytes. Use when the input contains
        /// control sequences the calling shell would interpret.
        #[arg(long = "raw-base64")]
        raw_base64: Option<String>,
        /// Append a carriage return (0x0D) after the data — what a real
        /// keyboard sends when you press Enter. Not `\n` (0x0A): a
        /// literal newline would be typed into the line buffer instead
        /// of submitting.
        #[arg(long)]
        enter: bool,
    },
    /// Print the tail of a target session's PTY output ring buffer.
    ReadBuffer {
        /// Target session UUID.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Maximum bytes to fetch from the session's tail buffer.
        #[arg(long, default_value_t = 65_536)]
        max_bytes: usize,
    },
    /// Kill a target session's PTY child. The session metadata stays
    /// in the daemon registry until `forget`; ghost UI lets the user
    /// resume the agent (e.g. claude `--resume`) or delete.
    KillSession {
        /// Target session UUID.
        #[arg(short = 't', long = "target")]
        target: String,
    },
    /// Permanently drop a (dead) session's daemon-side metadata. The
    /// daemon refuses if the session is still alive — kill it first.
    ForgetSession {
        /// Target session UUID.
        #[arg(short = 't', long = "target")]
        target: String,
    },
    /// Ask the daemon to shut down gracefully (kills every PTY, exits).
    Shutdown,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve { detach: false }) {
        Command::Serve { detach } => match run_serve(detach) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("acornd: {err}");
                ExitCode::from(1)
            }
        },
        Command::Status => run_status(),
        Command::ListSessions => run_list_sessions(),
        Command::SendKeys {
            target,
            data,
            raw_base64,
            enter,
        } => run_send_keys(&target, data.as_deref(), raw_base64.as_deref(), enter),
        Command::ReadBuffer { target, max_bytes } => run_read_buffer(&target, max_bytes),
        Command::KillSession { target } => run_kill_session(&target),
        Command::ForgetSession { target } => run_forget_session(&target),
        Command::Shutdown => run_shutdown(),
    }
}

fn run_serve(detach: bool) -> io::Result<()> {
    // 1) Detach BEFORE doing anything thread-spawning. fork() after we have
    //    spawned tokio / tracing threads is undefined behavior on Unix.
    #[cfg(unix)]
    if detach {
        match daemon::lifecycle::detach_into_own_session()? {
            daemon::lifecycle::DetachStatus::ParentExited
            | daemon::lifecycle::DetachStatus::IntermediateExited => {
                // We are NOT the grandchild — exit immediately and let
                // the grandchild continue as the actual daemon. Skip
                // destructors that could fight with the live grandchild.
                std::process::exit(0);
            }
            daemon::lifecycle::DetachStatus::Detached => {}
        }
    }
    #[cfg(not(unix))]
    if detach {
        return Err(io::Error::other(
            "--detach not supported on this platform yet",
        ));
    }

    // 2) Install crash handler so a panic produces a usable bug report.
    daemon::crash::install();

    // 3) Init tracing into the rotating log file. Falls back to stderr
    //    if the file cannot be opened — better than silent loss.
    init_tracing();

    // 4) Acquire the singleton lock.
    let pid_path = match daemon::lifecycle::try_acquire_pid_lock()? {
        daemon::lifecycle::PidLock::Acquired(path) => path,
        daemon::lifecycle::PidLock::AlreadyHeld(pid) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("daemon already running (pid {pid})"),
            ));
        }
    };

    // 5) Bind sockets.
    let listeners = match daemon::socket::bind_both() {
        Ok(l) => l,
        Err(e) => {
            daemon::lifecycle::release_pid_lock(&pid_path);
            return Err(e);
        }
    };
    let control_path = listeners.control_path.clone();
    let stream_path = listeners.stream_path.clone();

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        control = %control_path.display(),
        stream = %stream_path.display(),
        "acornd serving"
    );

    // 6) Run the daemon. Blocks until shutdown.
    let daemon_handle = daemon::server::Daemon::new();
    let serve_result = daemon_handle.serve(listeners);

    // 7) Cleanup on the way out. Always reached on graceful shutdown;
    //    on a panic the crash hook fires first, then unwinding hits
    //    these via destructors.
    daemon::socket::cleanup_paths(&control_path, &stream_path);
    daemon::lifecycle::release_pid_lock(&pid_path);
    tracing::info!("acornd exited");

    serve_result
}

fn run_status() -> ExitCode {
    match daemon::client::probe_status() {
        Ok(Some(snap)) => {
            println!(
                "running\nversion={}\nuptime={}s\nsessions={}/{}",
                snap.daemon_version,
                snap.uptime_seconds,
                snap.session_count_alive,
                snap.session_count_total
            );
            ExitCode::SUCCESS
        }
        Ok(None) => {
            println!("not running");
            ExitCode::from(2)
        }
        Err(err) => {
            eprintln!("acornd status: {err}");
            ExitCode::from(1)
        }
    }
}

fn run_list_sessions() -> ExitCode {
    let resp = match daemon::client::one_shot(daemon::protocol::ControlPayload::ListSessions) {
        Ok(r) => r,
        Err(err) => {
            eprintln!("acornd list-sessions: {err}");
            return ExitCode::from(1);
        }
    };
    match resp.payload {
        daemon::protocol::ControlResult::Sessions { sessions } => {
            if sessions.is_empty() {
                println!("(no sessions)");
                return ExitCode::SUCCESS;
            }
            println!("{:36}  {:6}  {:6}  name", "id", "kind", "state");
            for s in sessions {
                let kind = match s.kind {
                    daemon::protocol::SessionKind::Regular => "reg",
                    daemon::protocol::SessionKind::Control => "ctrl",
                };
                let state = if s.alive { "alive" } else { "dead" };
                println!("{:36}  {:6}  {:6}  {}", s.id, kind, state, s.name);
            }
            ExitCode::SUCCESS
        }
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {message}");
            ExitCode::from(1)
        }
        other => {
            eprintln!("unexpected response: {other:?}");
            ExitCode::from(1)
        }
    }
}

fn run_send_keys(
    target: &str,
    data: Option<&str>,
    raw_base64: Option<&str>,
    enter: bool,
) -> ExitCode {
    let target_id = match uuid::Uuid::parse_str(target) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("acornd send-keys: invalid target UUID: {e}");
            return ExitCode::from(2);
        }
    };
    let mut bytes: Vec<u8> = if let Some(b64) = raw_base64 {
        match base64_decode(b64) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("acornd send-keys: invalid base64: {e}");
                return ExitCode::from(2);
            }
        }
    } else if let Some(text) = data {
        text.as_bytes().to_vec()
    } else {
        eprintln!("acornd send-keys: provide --data or --raw-base64");
        return ExitCode::from(2);
    };
    if enter {
        // 0x0D (CR) — what a physical keyboard sends. See SendKeys docs
        // for why this is not 0x0A.
        bytes.push(b'\r');
    }
    let data_b64 = base64_encode(&bytes);
    let resp = match daemon::client::one_shot(daemon::protocol::ControlPayload::SendInput {
        target_session_id: target_id,
        data_b64,
    }) {
        Ok(r) => r,
        Err(err) => {
            eprintln!("acornd send-keys: {err}");
            return ExitCode::from(1);
        }
    };
    match resp.payload {
        daemon::protocol::ControlResult::Ack => ExitCode::SUCCESS,
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {message}");
            error_code_to_exit(code)
        }
        other => {
            eprintln!("unexpected response: {other:?}");
            ExitCode::from(1)
        }
    }
}

fn run_read_buffer(target: &str, max_bytes: usize) -> ExitCode {
    let target_id = match uuid::Uuid::parse_str(target) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("acornd read-buffer: invalid target UUID: {e}");
            return ExitCode::from(2);
        }
    };
    let resp = match daemon::client::one_shot(daemon::protocol::ControlPayload::ReadBuffer {
        target_session_id: target_id,
        max_bytes: Some(max_bytes),
    }) {
        Ok(r) => r,
        Err(err) => {
            eprintln!("acornd read-buffer: {err}");
            return ExitCode::from(1);
        }
    };
    match resp.payload {
        daemon::protocol::ControlResult::Buffer { data_b64, .. } => match base64_decode(&data_b64) {
            Ok(bytes) => {
                use std::io::Write;
                let _ = std::io::stdout().write_all(&bytes);
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("acornd read-buffer: bad base64 from daemon: {e}");
                ExitCode::from(1)
            }
        },
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {message}");
            error_code_to_exit(code)
        }
        other => {
            eprintln!("unexpected response: {other:?}");
            ExitCode::from(1)
        }
    }
}

fn run_kill_session(target: &str) -> ExitCode {
    let target_id = match uuid::Uuid::parse_str(target) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("acornd kill-session: invalid target UUID: {e}");
            return ExitCode::from(2);
        }
    };
    let resp = match daemon::client::one_shot(daemon::protocol::ControlPayload::KillSession {
        target_session_id: target_id,
    }) {
        Ok(r) => r,
        Err(err) => {
            eprintln!("acornd kill-session: {err}");
            return ExitCode::from(1);
        }
    };
    match resp.payload {
        daemon::protocol::ControlResult::Ack => {
            println!("killed");
            ExitCode::SUCCESS
        }
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {message}");
            error_code_to_exit(code)
        }
        other => {
            eprintln!("unexpected response: {other:?}");
            ExitCode::from(1)
        }
    }
}

fn run_forget_session(target: &str) -> ExitCode {
    let target_id = match uuid::Uuid::parse_str(target) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("acornd forget-session: invalid target UUID: {e}");
            return ExitCode::from(2);
        }
    };
    let resp = match daemon::client::one_shot(daemon::protocol::ControlPayload::ForgetSession {
        target_session_id: target_id,
    }) {
        Ok(r) => r,
        Err(err) => {
            eprintln!("acornd forget-session: {err}");
            return ExitCode::from(1);
        }
    };
    match resp.payload {
        daemon::protocol::ControlResult::Ack => {
            println!("forgotten");
            ExitCode::SUCCESS
        }
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {message}");
            error_code_to_exit(code)
        }
        other => {
            eprintln!("unexpected response: {other:?}");
            ExitCode::from(1)
        }
    }
}

/// Map daemon `ErrorCode` onto stable, shell-script-friendly exit codes.
/// Same mapping the legacy `acorn-ipc` used so authors who relied on
/// `[ $? -eq 3 ]` for not-found do not have to update scripts.
fn error_code_to_exit(code: daemon::protocol::ErrorCode) -> ExitCode {
    use daemon::protocol::ErrorCode;
    match code {
        ErrorCode::Unauthorized => ExitCode::from(2),
        ErrorCode::NotFound => ExitCode::from(3),
        ErrorCode::OutOfScope => ExitCode::from(4),
        ErrorCode::Invalid => ExitCode::from(5),
        ErrorCode::ProtocolMismatch => ExitCode::from(6),
        ErrorCode::Internal => ExitCode::from(1),
    }
}

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
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
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

fn run_shutdown() -> ExitCode {
    match daemon::client::one_shot(daemon::protocol::ControlPayload::Shutdown) {
        Ok(resp) => match resp.payload {
            daemon::protocol::ControlResult::Ack => {
                println!("shutdown acknowledged");
                ExitCode::SUCCESS
            }
            daemon::protocol::ControlResult::Error { code, message } => {
                eprintln!("daemon error ({code:?}): {message}");
                ExitCode::from(1)
            }
            other => {
                eprintln!("unexpected response: {other:?}");
                ExitCode::from(1)
            }
        },
        Err(err) => {
            eprintln!("acornd shutdown: {err}");
            ExitCode::from(1)
        }
    }
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    match daemon::logging::RotatingFile::open_default() {
        Ok(writer) => {
            // `RotatingFile` impls `Write` on `&RotatingFile`. tracing-subscriber's
            // `with_writer` wants a factory returning a writer; the simplest
            // path is to leak the writer into a `'static` reference so the
            // factory can hand out clones of `&RotatingFile`. Leaking is fine
            // for a daemon — the resource lives for the process lifetime
            // either way.
            let leaked: &'static daemon::logging::RotatingFile = Box::leak(Box::new(writer));
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(move || leaked)
                .with_ansi(false)
                .init();
        }
        Err(e) => {
            eprintln!("acornd: failed to open log file, using stderr: {e}");
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_ansi(false)
                .init();
        }
    }
}
