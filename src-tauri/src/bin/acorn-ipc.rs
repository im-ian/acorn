//! `acorn-ipc` — command-line client for the in-app IPC server.
//!
//! Run from inside a control session's PTY: the spawning code in
//! `commands::pty_spawn` injects `ACORN_SESSION_ID` and `ACORN_IPC_SOCKET`
//! into the environment so this binary can locate the server and identify
//! itself without flags.
//!
//! Exits non-zero on protocol errors so it composes cleanly in shell scripts;
//! the exit code maps the server's `ErrorCode` so callers can branch on the
//! specific failure mode (`2` = unauthorized, `3` = not-found, etc.).

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::ExitCode;

use base64::Engine;
use clap::{Parser, Subcommand};

#[path = "../ipc/proto.rs"]
mod proto;
#[path = "../ipc/socket_path.rs"]
mod socket_path;

use proto::{Envelope, ErrorCode, Request, Response, SessionSummary, PROTOCOL_VERSION};

const ENV_SESSION_ID: &str = "ACORN_SESSION_ID";

#[derive(Parser)]
#[command(
    name = "acorn-ipc",
    about = "Talk to a running Acorn app from inside a control session.",
    long_about = "acorn-ipc speaks to the in-app IPC server over a Unix \
                  socket. The control session that launched this process \
                  exports ACORN_SESSION_ID and ACORN_IPC_SOCKET into its \
                  PTY environment — leave those alone unless you know what \
                  you're doing."
)]
struct Cli {
    /// Print responses as raw JSON instead of the default table/text. Useful
    /// for piping into `jq` or other tooling.
    #[arg(long, global = true)]
    json: bool,

    /// Override the socket path. Falls back to `$ACORN_IPC_SOCKET`, then to
    /// the platform data-dir default. Mostly useful for testing.
    #[arg(long, global = true, value_name = "PATH")]
    socket: Option<PathBuf>,

    /// Override the source session id. Falls back to `$ACORN_SESSION_ID`.
    #[arg(long, global = true, value_name = "UUID")]
    source: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List the sessions in your project, including this control session.
    ListSessions,
    /// Send raw keys to a target session. `<DATA>` is forwarded verbatim;
    /// use `--raw-base64` when the input contains control bytes that the
    /// shell would otherwise interpret.
    SendKeys {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Literal data to send (UTF-8). Pass `\n` for a newline, etc.
        /// Mutually exclusive with `--raw-base64`.
        #[arg(short = 'd', long = "data")]
        data: Option<String>,
        /// Pre-encoded base64 bytes. Overrides `--data` when set.
        #[arg(long = "raw-base64")]
        raw_base64: Option<String>,
        /// Append a `\n` after the data. Convenient for one-shot commands.
        #[arg(long)]
        enter: bool,
    },
    /// Print the recent output of a target session.
    ReadBuffer {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Max bytes to fetch from the session's tail buffer (server cap: 4 MiB).
        #[arg(long, default_value_t = 65_536)]
        max_bytes: usize,
    },
    /// Create a new regular session in this project.
    NewSession {
        /// Display name for the new session.
        name: String,
        /// Create the session inside a fresh git worktree.
        #[arg(long)]
        isolated: bool,
    },
    /// Focus a session in the app UI.
    SelectSession {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
    },
    /// Kill a session (close the PTY, drop the session from state).
    KillSession {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let source = match cli
        .source
        .clone()
        .or_else(|| std::env::var(ENV_SESSION_ID).ok())
    {
        Some(s) if !s.is_empty() => s,
        _ => {
            eprintln!(
                "acorn-ipc: ACORN_SESSION_ID is unset. Run me from inside a control session, \
                 or pass --source <uuid>.",
            );
            return ExitCode::from(map_error_exit(ErrorCode::Unauthorized));
        }
    };

    let socket_path = match cli.socket.clone() {
        Some(p) => p,
        None => match socket_path::resolve() {
            Ok(p) => p,
            Err(err) => {
                eprintln!("acorn-ipc: could not resolve socket path: {err}");
                return ExitCode::from(map_error_exit(ErrorCode::Internal));
            }
        },
    };

    let json = cli.json;
    let request = match build_request(&cli.command) {
        Ok(r) => r,
        Err(msg) => {
            eprintln!("acorn-ipc: {msg}");
            return ExitCode::from(map_error_exit(ErrorCode::Invalid));
        }
    };

    let envelope = Envelope {
        protocol_version: PROTOCOL_VERSION,
        source_session_id: source,
        request,
    };

    let response = match send(&socket_path, &envelope) {
        Ok(r) => r,
        Err(err) => {
            eprintln!(
                "acorn-ipc: could not reach the Acorn IPC server at {}: {err}",
                socket_path.display()
            );
            return ExitCode::from(map_error_exit(ErrorCode::Internal));
        }
    };

    render(&response, json)
}

fn build_request(cmd: &Command) -> Result<Request, String> {
    Ok(match cmd {
        Command::ListSessions => Request::ListSessions,
        Command::SendKeys {
            target,
            data,
            raw_base64,
            enter,
        } => {
            let data_b64 = match (raw_base64, data) {
                (Some(b64), _) => b64.clone(),
                (None, Some(d)) => {
                    let mut bytes = d.as_bytes().to_vec();
                    if *enter {
                        bytes.push(b'\n');
                    }
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                }
                (None, None) => {
                    if *enter {
                        base64::engine::general_purpose::STANDARD.encode(b"\n")
                    } else {
                        return Err(
                            "send-keys needs --data, --raw-base64, or --enter".to_string()
                        );
                    }
                }
            };
            Request::SendKeys {
                target_session_id: target.clone(),
                data_b64,
            }
        }
        Command::ReadBuffer { target, max_bytes } => Request::ReadBuffer {
            target_session_id: target.clone(),
            max_bytes: Some(*max_bytes),
        },
        Command::NewSession { name, isolated } => Request::NewSession {
            name: name.clone(),
            isolated: *isolated,
        },
        Command::SelectSession { target } => Request::SelectSession {
            target_session_id: target.clone(),
        },
        Command::KillSession { target } => Request::KillSession {
            target_session_id: target.clone(),
        },
    })
}

fn send(path: &std::path::Path, envelope: &Envelope) -> Result<Response, String> {
    let mut stream =
        UnixStream::connect(path).map_err(|e| format!("connect: {e}"))?;
    let mut payload = serde_json::to_vec(envelope).map_err(|e| format!("encode: {e}"))?;
    payload.push(b'\n');
    stream.write_all(&payload).map_err(|e| format!("write: {e}"))?;
    stream.flush().map_err(|e| format!("flush: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(line.trim_end()).map_err(|e| format!("decode: {e}"))
}

fn render(response: &Response, json: bool) -> ExitCode {
    if json {
        match serde_json::to_string_pretty(response) {
            Ok(s) => println!("{s}"),
            Err(err) => {
                eprintln!("acorn-ipc: failed to re-serialize response: {err}");
                return ExitCode::from(map_error_exit(ErrorCode::Internal));
            }
        }
        return match response {
            Response::Error { code, .. } => ExitCode::from(map_error_exit(*code)),
            _ => ExitCode::SUCCESS,
        };
    }
    match response {
        Response::Sessions { sessions } => {
            print_sessions(sessions);
            ExitCode::SUCCESS
        }
        Response::Ack => ExitCode::SUCCESS,
        Response::Buffer { data_b64, truncated } => {
            match base64::engine::general_purpose::STANDARD.decode(data_b64) {
                Ok(bytes) => {
                    let _ = std::io::stdout().write_all(&bytes);
                }
                Err(err) => {
                    eprintln!("acorn-ipc: server returned invalid base64: {err}");
                    return ExitCode::from(map_error_exit(ErrorCode::Internal));
                }
            }
            if *truncated {
                eprintln!("(truncated — pass --max-bytes <N> for more)");
            }
            ExitCode::SUCCESS
        }
        Response::SessionCreated { session_id } => {
            println!("{session_id}");
            ExitCode::SUCCESS
        }
        Response::Error { code, message } => {
            eprintln!("acorn-ipc: {message}");
            ExitCode::from(map_error_exit(*code))
        }
    }
}

fn print_sessions(sessions: &[SessionSummary]) {
    if sessions.is_empty() {
        println!("(no sessions)");
        return;
    }
    let id_w = sessions.iter().map(|s| s.id.len()).max().unwrap_or(8);
    let name_w = sessions.iter().map(|s| s.name.len()).max().unwrap_or(8).max(4);
    let kind_w = sessions
        .iter()
        .map(|s| s.kind.len())
        .max()
        .unwrap_or(7)
        .max(4);
    let status_w = sessions
        .iter()
        .map(|s| s.status.len())
        .max()
        .unwrap_or(6)
        .max(6);
    println!(
        "{marker} {id:<id_w$}  {name:<name_w$}  {kind:<kind_w$}  {status:<status_w$}  branch",
        marker = " ",
        id = "ID",
        name = "NAME",
        kind = "KIND",
        status = "STATUS",
    );
    for s in sessions {
        let marker = if s.is_source { "*" } else { " " };
        println!(
            "{marker} {id:<id_w$}  {name:<name_w$}  {kind:<kind_w$}  {status:<status_w$}  {branch}",
            marker = marker,
            id = s.id,
            name = s.name,
            kind = s.kind,
            status = s.status,
            branch = s.branch,
        );
    }
}

/// Maps the server's `ErrorCode` to a stable shell exit code so scripts can
/// branch on the specific failure mode without parsing JSON.
fn map_error_exit(code: ErrorCode) -> u8 {
    match code {
        ErrorCode::Unauthorized => 2,
        ErrorCode::NotFound => 3,
        ErrorCode::OutOfScope => 4,
        ErrorCode::Invalid => 5,
        ErrorCode::Internal => 6,
    }
}

