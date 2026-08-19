//! `acornd` — Acorn background daemon and CLI surface.
//!
//! Multiple modes, all dispatched by `clap`:
//!
//! ```text
//! acornd                    # default → daemon foreground (alias of `serve --foreground`)
//! acornd serve              # daemon mode (foreground)
//! acornd serve --detach     # daemon mode, detach into the background
//! acornd status             # CLI: probe a running daemon, print version + counts
//! acornd list-sessions      # CLI: enumerate same-project sessions
//! ```
//!
//! The CLI subcommands cover the operations the daemon protocol exposes
//! directly. Operations that require coordination with the running
//! Acorn app (e.g. focus a tab in the UI) stay on the legacy
//! `acorn-ipc` CLI for now.

use std::io;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::process::{Command as ProcessCommand, Stdio};

use clap::{Parser, Subcommand};

use acorn_daemon as daemon;
use acorn_lib::pty_env;

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
        /// Detach from the spawning terminal or process. The default is
        /// foreground so `acornd` is straightforward to debug from a shell.
        /// The Acorn app passes `--detach` so the daemon survives the app
        /// exiting.
        #[arg(long)]
        detach: bool,
        /// Executable path of the Acorn app that started this daemon. Used only
        /// to authenticate the released pre-token protocol during upgrades.
        #[arg(long, hide = true)]
        app_executable: Option<PathBuf>,
    },
    /// Probe a running daemon. Exits non-zero if no daemon answered.
    Status,
    /// List sessions currently tracked by the daemon.
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
    /// Kill a target session's PTY child. The daemon detaches the
    /// session registry row once the child exits.
    KillSession {
        /// Target session UUID.
        #[arg(short = 't', long = "target")]
        target: String,
    },
    /// Permanently drop a non-live session's daemon-side metadata. The
    /// daemon refuses if the session is still alive — kill it first.
    ForgetSession {
        /// Target session UUID.
        #[arg(short = 't', long = "target")]
        target: String,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve {
        detach: false,
        app_executable: None,
    }) {
        Command::Serve {
            detach,
            app_executable,
        } => match run_serve(detach, app_executable) {
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
    }
}

fn run_serve(detach: bool, app_executable: Option<PathBuf>) -> io::Result<()> {
    // 1) Detach BEFORE doing anything thread-spawning. fork() after we have
    //    spawned tokio / tracing threads is undefined behavior on Unix, and
    //    the Windows re-exec must not inherit initialized daemon state.
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
    #[cfg(windows)]
    if detach {
        spawn_detached_windows(app_executable.as_deref())?;
        return Ok(());
    }
    #[cfg(not(any(unix, windows)))]
    if detach {
        return Err(io::Error::other(
            "--detach not supported on this platform yet",
        ));
    }

    // 2) Install crash handler so a panic produces a usable bug report.
    daemon::crash::install(env!("CARGO_PKG_VERSION"));

    // 3) Init tracing into the rotating log file. Falls back to stderr
    //    if the file cannot be opened — better than silent loss.
    init_tracing();

    // 4) Acquire the singleton lock.
    let pid_lock = match daemon::lifecycle::try_acquire_pid_lock()? {
        daemon::lifecycle::PidLock::Acquired(guard) => guard,
        daemon::lifecycle::PidLock::AlreadyHeld(pid) => {
            let message = pid.map_or_else(
                || "daemon already running".to_owned(),
                |pid| format!("daemon already running (pid {pid})"),
            );
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, message));
        }
    };
    let auth_token = daemon::auth::load_or_create()?;

    // 5) Bind sockets.
    let listeners = daemon::socket::bind_both()?;
    let control_path = listeners.control_path.clone();
    let stream_path = listeners.stream_path.clone();

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        control = %control_path.display(),
        stream = %stream_path.display(),
        "acornd serving"
    );

    // 6) Run the daemon. Blocks until shutdown.
    //
    // `env_applier` wires the same layered shell-env policy (`pty_env`
    // + `shell_env`) the in-process spawn path uses, so PTYs created
    // through the daemon receive identical TERM/LANG/PATH layering.
    // Keeping the closure in this binary (host crate) avoids pulling
    // host-only modules into the `acorn-daemon` leaf crate.
    let env_applier: daemon::pty::EnvApplier = Arc::new(pty_env::apply_layered_env);
    let daemon_handle = daemon::server::Daemon::new(
        env!("CARGO_PKG_VERSION"),
        auth_token,
        app_executable,
        env_applier,
    );
    let serve_result = daemon_handle.serve(listeners);

    // 7) Cleanup on the way out. Always reached on graceful shutdown;
    //    on a panic the crash hook fires first, then unwinding hits
    //    these via destructors.
    daemon::socket::cleanup_paths(&control_path, &stream_path);
    drop(pid_lock);
    tracing::info!("acornd exited");

    serve_result
}

/// Build the Windows daemon re-exec command. Unlike Unix, Windows has no
/// safe post-startup `fork`, so `--detach` starts a fresh foreground daemon
/// process without forwarding `--detach` (which also prevents recursion).
#[cfg(windows)]
fn detached_windows_command(executable: &Path, app_executable: Option<&Path>) -> ProcessCommand {
    use std::os::windows::process::CommandExt;

    // Win32 process creation flags from winbase.h. `DETACHED_PROCESS` avoids
    // inheriting the app's console, while `CREATE_NEW_PROCESS_GROUP` keeps
    // console control events aimed at the app from reaching the daemon.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    let mut command = ProcessCommand::new(executable);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    if let Some(app_executable) = app_executable {
        command.arg("--app-executable").arg(app_executable);
    }
    command
}

#[cfg(windows)]
fn spawn_detached_windows(app_executable: Option<&Path>) -> io::Result<()> {
    let executable = std::env::current_exe()?;
    detached_windows_command(&executable, app_executable).spawn()?;
    Ok(())
}

fn run_status() -> ExitCode {
    match daemon::client::probe_status() {
        Ok(Some(snap)) => {
            println!(
                "running\nversion={}\nuptime={}s\nsessions={}/{}",
                terminal_safe_field(&snap.daemon_version),
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
    let resp =
        match daemon::client::one_shot_from_session(daemon::protocol::ControlPayload::ListSessions)
        {
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
                println!(
                    "{:36}  {:6}  {:6}  {}",
                    s.id,
                    kind,
                    state,
                    terminal_safe_field(&s.name)
                );
            }
            ExitCode::SUCCESS
        }
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {}", terminal_safe_field(&message));
            ExitCode::from(1)
        }
        other => {
            eprintln!(
                "unexpected response: {}",
                terminal_safe_field(&format!("{other:?}"))
            );
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
    let resp =
        match daemon::client::one_shot_from_session(daemon::protocol::ControlPayload::SendInput {
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
            eprintln!("daemon error ({code:?}): {}", terminal_safe_field(&message));
            error_code_to_exit(code)
        }
        other => {
            eprintln!(
                "unexpected response: {}",
                terminal_safe_field(&format!("{other:?}"))
            );
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
    let resp =
        match daemon::client::one_shot_from_session(daemon::protocol::ControlPayload::ReadBuffer {
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
        daemon::protocol::ControlResult::Buffer { data_b64, .. } => {
            match base64_decode(&data_b64) {
                Ok(bytes) => {
                    use std::io::Write;
                    let _ = std::io::stdout().write_all(&bytes);
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("acornd read-buffer: bad base64 from daemon: {e}");
                    ExitCode::from(1)
                }
            }
        }
        daemon::protocol::ControlResult::Error { code, message } => {
            eprintln!("daemon error ({code:?}): {}", terminal_safe_field(&message));
            error_code_to_exit(code)
        }
        other => {
            eprintln!(
                "unexpected response: {}",
                terminal_safe_field(&format!("{other:?}"))
            );
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
    let resp =
        match daemon::client::one_shot_from_session(daemon::protocol::ControlPayload::KillSession {
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
            eprintln!("daemon error ({code:?}): {}", terminal_safe_field(&message));
            error_code_to_exit(code)
        }
        other => {
            eprintln!(
                "unexpected response: {}",
                terminal_safe_field(&format!("{other:?}"))
            );
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
    let resp = match daemon::client::one_shot_from_session(
        daemon::protocol::ControlPayload::ForgetSession {
            target_session_id: target_id,
        },
    ) {
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
            eprintln!("daemon error ({code:?}): {}", terminal_safe_field(&message));
            error_code_to_exit(code)
        }
        other => {
            eprintln!(
                "unexpected response: {}",
                terminal_safe_field(&format!("{other:?}"))
            );
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

fn terminal_safe_field(value: &str) -> String {
    let mut safe = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_control()
            || matches!(
                character,
                '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            )
        {
            match character {
                '\n' => safe.push_str("\\n"),
                '\r' => safe.push_str("\\r"),
                '\t' => safe.push_str("\\t"),
                _ => safe.push_str(&format!("\\u{{{:x}}}", u32::from(character))),
            }
        } else {
            safe.push(character);
        }
    }
    safe
}

fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
    for chunk in bytes.chunks(4) {
        if chunk.len() != 4 {
            return Err("bad base64 length".into());
        }
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        let v0 = val(chunk[0])?;
        let v1 = val(chunk[1])?;
        let v2 = if pad >= 2 { 0 } else { val(chunk[2])? };
        let v3 = if pad >= 1 { 0 } else { val(chunk[3])? };
        let n =
            (u32::from(v0) << 18) | (u32::from(v1) << 12) | (u32::from(v2) << 6) | u32::from(v3);
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

#[cfg(test)]
mod terminal_output_tests {
    use super::{terminal_safe_field, Cli, Command};
    use clap::Parser;
    use std::path::PathBuf;

    #[test]
    fn terminal_fields_escape_controls_and_bidi_overrides() {
        assert_eq!(
            terminal_safe_field("session\n\u{1b}[2J\u{202e}"),
            "session\\n\\u{1b}[2J\\u{202e}"
        );
        assert_eq!(terminal_safe_field("한글 이름"), "한글 이름");
    }

    #[test]
    fn serve_accepts_hidden_app_executable_trust_path() {
        let cli = Cli::try_parse_from([
            "acornd",
            "serve",
            "--detach",
            "--app-executable",
            "/Applications/Acorn.app/Contents/MacOS/acorn",
        ])
        .unwrap();

        match cli.command.unwrap() {
            Command::Serve {
                detach,
                app_executable,
            } => {
                assert!(detach);
                assert_eq!(
                    app_executable,
                    Some(PathBuf::from(
                        "/Applications/Acorn.app/Contents/MacOS/acorn"
                    ))
                );
            }
            other => panic!("expected serve command, got {other:?}"),
        }
    }
}

#[cfg(all(test, windows))]
mod windows_detach_tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn detached_reexec_enters_foreground_serve_without_recursing() {
        let executable = Path::new(r"C:\Program Files\Acorn\acornd.exe");
        let app_executable = Path::new(r"C:\Program Files\Acorn\acorn.exe");
        let command = detached_windows_command(executable, Some(app_executable));

        assert_eq!(command.get_program(), executable.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                OsStr::new("serve"),
                OsStr::new("--app-executable"),
                app_executable.as_os_str(),
            ]
        );
    }
}
