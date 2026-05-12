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
