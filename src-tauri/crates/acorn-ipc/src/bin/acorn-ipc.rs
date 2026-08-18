//! `acorn-ipc` — command-line client for the in-app IPC server.
//!
//! Run from inside an Acorn PTY: the spawning code in `commands::pty_spawn`
//! injects Acorn identity/path environment so this binary can locate the
//! server and identify itself without flags. Commands require a control source
//! session created explicitly by Acorn; repository code in a regular session
//! cannot promote itself.
//!
//! Exits non-zero on protocol errors so it composes cleanly in shell scripts;
//! the exit code maps the server's `ErrorCode` so callers can branch on the
//! specific failure mode (`2` = unauthorized, `3` = not-found, etc.).

#[cfg(test)]
use std::io::BufRead;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use base64::Engine;
use clap::{Parser, Subcommand};

use acorn_ipc::proto::{
    Envelope, ErrorCode, NewSessionOwner, Request, Response, SessionSummary, WorkspaceSummary,
    MAX_REQUEST_FRAME_BYTES, MAX_RESPONSE_FRAME_BYTES, PROTOCOL_VERSION,
};
use acorn_ipc::socket_path;
use acorn_local_ipc::StreamTrait as _;

const ENV_SESSION_ID: &str = "ACORN_SESSION_ID";
const ENV_RESUME_TOKEN: &str = "ACORN_RESUME_TOKEN";
const ENV_IPC_CAPABILITY: &str = "ACORN_IPC_CAPABILITY";
const ENV_WORKSPACE_ID: &str = "ACORN_WORKSPACE_ID";
const ENV_WORKSPACE_PATH: &str = "ACORN_WORKSPACE_PATH";
const ENV_WORKSPACE_NAME: &str = "ACORN_WORKSPACE_NAME";
const IPC_IO_TIMEOUT: Duration = Duration::from_secs(2);
const IPC_IO_POLL_INTERVAL: Duration = Duration::from_millis(5);

#[derive(Parser)]
#[command(
    name = "acorn-ipc",
    about = "Talk to a running Acorn app from inside an Acorn terminal.",
    long_about = "acorn-ipc speaks to the in-app server over private local \
                  IPC. Acorn terminals export session identity and endpoint \
                  paths into their PTY environment. Acorn must create the \
                  terminal as a control session before commands are authorized."
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

    /// Override the source session id. Falls back to `$ACORN_SESSION_ID`,
    /// then `$ACORN_RESUME_TOKEN`.
    #[arg(long, global = true, value_name = "UUID")]
    source: Option<String>,

    /// Override the PTY capability. Falls back to `$ACORN_IPC_CAPABILITY`.
    /// Intended for protocol tests; normal terminals receive it from Acorn.
    #[arg(long, global = true, value_name = "TOKEN")]
    capability: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Confirm that this Acorn terminal already has control authority.
    PromoteSelf,
    /// Print the Acorn control-session context an agent should load.
    Context,
    /// List the sessions in your project, including this control session.
    ListSessions,
    /// List frontend workspaces in your project.
    ListWorkspaces,
    /// Send raw keys to a target session. `<DATA>` is forwarded verbatim;
    /// use `--raw-base64` when the input contains control bytes that the
    /// shell would otherwise interpret.
    SendKeys {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Literal data to send (UTF-8). Forwarded byte-for-byte; the
        /// terminal's line discipline is responsible for any
        /// interpretation. Mutually exclusive with `--raw-base64`.
        #[arg(short = 'd', long = "data")]
        data: Option<String>,
        /// Pre-encoded base64 bytes. Overrides `--data` when set.
        #[arg(long = "raw-base64")]
        raw_base64: Option<String>,
        /// Append a carriage return (`\r`, 0x0D) after the data — the
        /// same byte a real keyboard sends when you press Enter. The
        /// TTY line discipline then translates it to a line submission
        /// (in cooked mode) or passes it through (in raw mode), which
        /// is what callers usually want. Note: this is *not* `\n`
        /// (0x0A); a literal newline would be inserted into the input
        /// buffer instead of submitting the line, so a one-shot
        /// "type a command and press Enter" would just type the
        /// command across two lines and never run it.
        #[arg(long)]
        enter: bool,
        /// Allow touching a user-owned session or one owned by another control
        /// session. Use only for direct user requests.
        #[arg(long = "allow-foreign")]
        allow_foreign: bool,
    },
    /// Print the recent output of a target session.
    ReadBuffer {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Max bytes to fetch from the session's tail buffer (server cap: 4 MiB).
        #[arg(long, default_value_t = 65_536)]
        max_bytes: usize,
        /// Allow reading a user-owned session or one owned by another control
        /// session. Use only for direct user requests.
        #[arg(long = "allow-foreign")]
        allow_foreign: bool,
    },
    /// Create a new regular session in this project.
    NewSession {
        /// Display name for the new session.
        name: String,
        /// Create the session inside a fresh git worktree.
        #[arg(long)]
        isolated: bool,
        /// Existing workspace cwd to create the session in. Use `current`
        /// to reuse the workspace context Acorn injected into this PTY.
        #[arg(long, value_name = "PATH|current")]
        workspace: Option<String>,
        /// Frontend workspace id for exact sidebar placement. Usually paired
        /// with `--workspace`; `--workspace current` fills this automatically.
        #[arg(long = "workspace-id", value_name = "ID")]
        workspace_id: Option<String>,
        /// Assign ownership for the created session: `me` (default) marks it as
        /// this controller's worker; `user` opts out of controller ownership.
        #[arg(long, value_parser = ["me", "user"])]
        owner: Option<String>,
    },
    /// Focus a session in the app UI.
    SelectSession {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Allow focusing a user-owned session or one owned by another control
        /// session. Use only for direct user requests.
        #[arg(long = "allow-foreign")]
        allow_foreign: bool,
    },
    /// Kill a session (close the PTY, drop the session from state).
    KillSession {
        /// UUID of the target session.
        #[arg(short = 't', long = "target")]
        target: String,
        /// Allow killing a user-owned session or one owned by another control
        /// session. Use only for direct user requests.
        #[arg(long = "allow-foreign")]
        allow_foreign: bool,
    },
    /// Report IPC reachability: socket path, file presence, and whether
    /// the in-app server accepts connections. No source session id required.
    Status,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

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

    // `status` is the one command that runs without an authorized source —
    // it is a pure connectivity probe, so we handle it before the auth gate.
    if matches!(cli.command, Command::Status) {
        return run_status(&socket_path, cli.json);
    }

    let source = match resolve_source_id(cli.source.clone()) {
        Some(s) if !s.is_empty() => s,
        _ => {
            eprintln!(
                "acorn-ipc: source session id is unset. Run me from inside an Acorn session, \
                 or pass --source <uuid>.",
            );
            return ExitCode::from(map_error_exit(ErrorCode::Unauthorized));
        }
    };

    let json = cli.json;
    let session_capability = match cli
        .capability
        .clone()
        .or_else(|| std::env::var(ENV_IPC_CAPABILITY).ok())
    {
        Some(value) if !value.trim().is_empty() => value,
        _ => {
            eprintln!(
                "acorn-ipc: session capability is unset. Run me from inside the source Acorn terminal."
            );
            return ExitCode::from(map_error_exit(ErrorCode::Unauthorized));
        }
    };
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
        session_capability,
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
    build_request_with_workspace_env(cmd, current_workspace_env())
}

fn build_request_with_workspace_env(
    cmd: &Command,
    workspace_env: WorkspaceEnv,
) -> Result<Request, String> {
    Ok(match cmd {
        Command::PromoteSelf => Request::PromoteSelf,
        Command::Context => Request::Context,
        Command::ListSessions => Request::ListSessions,
        Command::ListWorkspaces => Request::ListWorkspaces,
        Command::SendKeys {
            target,
            data,
            raw_base64,
            enter,
            allow_foreign,
        } => {
            let data_b64 = match (raw_base64, data) {
                (Some(b64), _) => b64.clone(),
                (None, Some(d)) => {
                    let mut bytes = d.as_bytes().to_vec();
                    if *enter {
                        bytes.push(b'\r');
                    }
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                }
                (None, None) => {
                    if *enter {
                        base64::engine::general_purpose::STANDARD.encode(b"\r")
                    } else {
                        return Err("send-keys needs --data, --raw-base64, or --enter".to_string());
                    }
                }
            };
            Request::SendKeys {
                target_session_id: target.clone(),
                data_b64,
                allow_foreign: *allow_foreign,
            }
        }
        Command::ReadBuffer {
            target,
            max_bytes,
            allow_foreign,
        } => Request::ReadBuffer {
            target_session_id: target.clone(),
            max_bytes: Some(*max_bytes),
            allow_foreign: *allow_foreign,
        },
        Command::NewSession {
            name,
            isolated,
            workspace,
            workspace_id,
            owner,
        } => {
            let (workspace_path, workspace_id) =
                resolve_new_session_workspace(workspace, workspace_id, workspace_env)?;
            Request::NewSession {
                name: name.clone(),
                isolated: *isolated,
                workspace_path,
                workspace_id,
                owner: match owner.as_deref() {
                    Some("user") => Some(NewSessionOwner::User),
                    Some("me") | None => None,
                    Some(other) => return Err(format!("unsupported --owner value: {other}")),
                },
            }
        }
        Command::SelectSession {
            target,
            allow_foreign,
        } => Request::SelectSession {
            target_session_id: target.clone(),
            allow_foreign: *allow_foreign,
        },
        Command::KillSession {
            target,
            allow_foreign,
        } => Request::KillSession {
            target_session_id: target.clone(),
            allow_foreign: *allow_foreign,
        },
        Command::Status => {
            // Routed before `build_request` in `main`. Reaching here means
            // the dispatch chain is wired wrong, not a user error.
            return Err("status is handled out-of-band; this is a bug".to_string());
        }
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct WorkspaceEnv {
    id: Option<String>,
    path: Option<String>,
    name: Option<String>,
}

fn current_workspace_env() -> WorkspaceEnv {
    WorkspaceEnv {
        id: non_empty_env(ENV_WORKSPACE_ID),
        path: non_empty_env(ENV_WORKSPACE_PATH),
        name: non_empty_env(ENV_WORKSPACE_NAME),
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().and_then(non_empty_string)
}

fn non_empty_string(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn resolve_new_session_workspace(
    workspace: &Option<String>,
    explicit_workspace_id: &Option<String>,
    workspace_env: WorkspaceEnv,
) -> Result<(Option<String>, Option<String>), String> {
    let workspace_id = explicit_workspace_id.clone().and_then(non_empty_string);
    let Some(workspace) = workspace.as_ref().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }) else {
        return Ok((None, workspace_id));
    };
    if workspace == "current" {
        let path = workspace_env.path;
        let id = workspace_id.or(workspace_env.id);
        if path.is_none() && id.is_none() {
            return Err(
                "`--workspace current` needs ACORN_WORKSPACE_PATH or ACORN_WORKSPACE_ID"
                    .to_string(),
            );
        }
        return Ok((path, id));
    }
    Ok((Some(workspace), workspace_id))
}

fn resolve_source_id(explicit: Option<String>) -> Option<String> {
    resolve_source_id_from(
        explicit,
        std::env::var(ENV_SESSION_ID).ok(),
        std::env::var(ENV_RESUME_TOKEN).ok(),
    )
}

fn resolve_source_id_from(
    explicit: Option<String>,
    session_env: Option<String>,
    resume_env: Option<String>,
) -> Option<String> {
    [explicit, session_env, resume_env]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
}

/// Probe the IPC socket and print a short reachability report. Connection
/// failure is *not* a CLI error — the whole point of `status` is to surface
/// down servers, so we exit 0 in both branches and let callers parse the
/// output (or the `reachable` JSON field).
fn run_status(socket_path: &Path, json: bool) -> ExitCode {
    let exists = acorn_local_ipc::marker_exists(socket_path);
    let (reachable, error) = match acorn_local_ipc::connect(socket_path) {
        Ok(stream) => {
            let verified = acorn_local_ipc::peer_process_id(&stream)
                .ok()
                .is_some_and(|pid| {
                    acorn_platform::process::pid_executable_name_matches(pid, "acorn")
                });
            drop(stream);
            if verified {
                (true, None)
            } else {
                (
                    false,
                    Some("socket peer is not the Acorn application".to_string()),
                )
            }
        }
        Err(err) => (false, Some(err.to_string())),
    };
    let source_env = resolve_source_id(None);
    let workspace_env = current_workspace_env();
    if json {
        let payload = serde_json::json!({
            "socket_path": socket_path.display().to_string(),
            "socket_file_exists": exists,
            "reachable": reachable,
            "error": error,
            "protocol_version": PROTOCOL_VERSION,
            "source_session_id_env": source_env,
            "workspace_id_env": workspace_env.id,
            "workspace_path_env": workspace_env.path,
            "workspace_name_env": workspace_env.name,
        });
        match serde_json::to_string_pretty(&payload) {
            Ok(s) => println!("{s}"),
            Err(err) => {
                eprintln!("acorn-ipc: failed to encode status: {err}");
                return ExitCode::from(map_error_exit(ErrorCode::Internal));
            }
        }
        return ExitCode::SUCCESS;
    }
    println!(
        "socket:           {}",
        terminal_safe_field(&socket_path.display().to_string())
    );
    println!(
        "socket file:      {}",
        if exists { "present" } else { "missing" }
    );
    if reachable {
        println!("reachable:        yes");
    } else {
        let reason = error.as_deref().unwrap_or("unknown");
        println!("reachable:        no ({})", terminal_safe_field(reason));
    }
    println!("protocol version: {PROTOCOL_VERSION}");
    println!(
        "source env:       {}",
        terminal_safe_field(source_env.as_deref().unwrap_or("(unset)"))
    );
    println!(
        "workspace id:     {}",
        terminal_safe_field(workspace_env.id.as_deref().unwrap_or("(unset)"))
    );
    println!(
        "workspace path:   {}",
        terminal_safe_field(workspace_env.path.as_deref().unwrap_or("(unset)"))
    );
    println!(
        "workspace name:   {}",
        terminal_safe_field(workspace_env.name.as_deref().unwrap_or("(unset)"))
    );
    ExitCode::SUCCESS
}

fn send(path: &std::path::Path, envelope: &Envelope) -> Result<Response, String> {
    let mut stream = acorn_local_ipc::connect(path).map_err(|e| format!("connect: {e}"))?;
    let peer_pid =
        acorn_local_ipc::peer_process_id(&stream).map_err(|e| format!("identify server: {e}"))?;
    if !acorn_platform::process::pid_executable_name_matches(peer_pid, "acorn") {
        return Err(format!(
            "server process {peer_pid} is not the Acorn application"
        ));
    }
    stream
        .set_nonblocking(true)
        .map_err(|e| format!("set nonblocking: {e}"))?;
    let mut payload = serde_json::to_vec(envelope).map_err(|e| format!("encode: {e}"))?;
    payload.push(b'\n');
    if payload.len() > MAX_REQUEST_FRAME_BYTES {
        return Err(format!(
            "request exceeds {MAX_REQUEST_FRAME_BYTES}-byte protocol limit"
        ));
    }
    write_all_with_deadline(&mut stream, &payload, IPC_IO_TIMEOUT)?;
    let line = read_response_with_deadline(&mut stream, IPC_IO_TIMEOUT)?;
    serde_json::from_str(line.trim_end()).map_err(|e| format!("decode: {e}"))
}

fn write_all_with_deadline<W: Write>(
    writer: &mut W,
    bytes: &[u8],
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let mut offset = 0;
    while offset < bytes.len() {
        match writer.write(&bytes[offset..]) {
            Ok(0) => return Err("write: connection closed".into()),
            Ok(written) => offset += written,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("write: IPC request timed out".into());
                }
                std::thread::sleep(IPC_IO_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("write: {error}")),
        }
    }
    loop {
        match writer.flush() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("flush: IPC request timed out".into());
                }
                std::thread::sleep(IPC_IO_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("flush: {error}")),
        }
    }
}

fn read_response_with_deadline<R: Read>(
    reader: &mut R,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) if bytes.is_empty() => return Err("read: connection closed".into()),
            Ok(0) => break,
            Ok(read) => {
                let newline = chunk[..read].iter().position(|byte| *byte == b'\n');
                let take = newline.map_or(read, |index| index + 1);
                bytes.extend_from_slice(&chunk[..take]);
                if bytes.len() > MAX_RESPONSE_FRAME_BYTES {
                    return Err(format!(
                        "response exceeds {MAX_RESPONSE_FRAME_BYTES}-byte protocol limit"
                    ));
                }
                if newline.is_some() {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("read: IPC response timed out".into());
                }
                std::thread::sleep(IPC_IO_POLL_INTERVAL);
            }
            Err(error) => return Err(format!("read: {error}")),
        }
    }
    String::from_utf8(bytes).map_err(|error| format!("read: response is not UTF-8: {error}"))
}

#[cfg(test)]
fn read_response_line<R: BufRead>(reader: &mut R) -> Result<String, String> {
    let mut line = String::new();
    let mut limited = Read::take(reader, (MAX_RESPONSE_FRAME_BYTES + 1) as u64);
    limited
        .read_line(&mut line)
        .map_err(|error| format!("read: {error}"))?;
    if line.len() > MAX_RESPONSE_FRAME_BYTES {
        return Err(format!(
            "response exceeds {MAX_RESPONSE_FRAME_BYTES}-byte protocol limit"
        ));
    }
    Ok(line)
}

fn terminal_safe_field(value: &str) -> String {
    terminal_safe_text(value, false)
}

fn terminal_safe_multiline(value: &str) -> String {
    terminal_safe_text(value, true)
}

fn terminal_safe_text(value: &str, preserve_newlines: bool) -> String {
    let mut safe = String::with_capacity(value.len());
    for character in value.chars() {
        if preserve_newlines && character == '\n' {
            safe.push('\n');
        } else if terminal_unsafe_character(character) {
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

fn terminal_unsafe_character(value: char) -> bool {
    value.is_control()
        || matches!(
            value,
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
        )
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
        Response::Context { text } => {
            println!("{}", terminal_safe_multiline(text));
            ExitCode::SUCCESS
        }
        Response::Sessions { sessions } => {
            print_sessions(sessions);
            ExitCode::SUCCESS
        }
        Response::Workspaces { workspaces } => {
            print_workspaces(workspaces);
            ExitCode::SUCCESS
        }
        Response::Ack => ExitCode::SUCCESS,
        Response::Buffer {
            data_b64,
            truncated,
        } => {
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
        Response::SelfPromoted {
            session_id,
            already_control,
            context,
        } => {
            if *already_control {
                println!(
                    "session {} is already a control session",
                    terminal_safe_field(session_id)
                );
            } else {
                println!(
                    "promoted session {} to control session",
                    terminal_safe_field(session_id)
                );
            }
            println!();
            println!("{}", terminal_safe_multiline(context));
            ExitCode::SUCCESS
        }
        Response::Error { code, message } => {
            eprintln!("acorn-ipc: {}", terminal_safe_field(message));
            ExitCode::from(map_error_exit(*code))
        }
    }
}

fn print_sessions(sessions: &[SessionSummary]) {
    if sessions.is_empty() {
        println!("(no sessions)");
        return;
    }
    let rows = sessions
        .iter()
        .map(|session| {
            (
                terminal_safe_field(&session.id),
                terminal_safe_field(&session.name),
                terminal_safe_field(&session.kind),
                terminal_safe_field(&session.owner),
                terminal_safe_field(&session.status),
                terminal_safe_field(printable_workspace_path(session)),
                terminal_safe_field(&session.branch),
            )
        })
        .collect::<Vec<_>>();
    let id_w = rows
        .iter()
        .map(|row| row.0.chars().count())
        .max()
        .unwrap_or(8);
    let name_w = rows
        .iter()
        .map(|row| row.1.chars().count())
        .max()
        .unwrap_or(8)
        .max(4);
    let kind_w = rows
        .iter()
        .map(|row| row.2.chars().count())
        .max()
        .unwrap_or(7)
        .max(4);
    let owner_w = rows
        .iter()
        .map(|row| row.3.chars().count())
        .max()
        .unwrap_or(5)
        .max(5);
    let status_w = rows
        .iter()
        .map(|row| row.4.chars().count())
        .max()
        .unwrap_or(6)
        .max(6);
    let workspace_w = rows
        .iter()
        .map(|row| row.5.chars().count())
        .max()
        .unwrap_or(9)
        .max(9);
    println!(
        "  {mine:<4}  {id:<id_w$}  {name:<name_w$}  {kind:<kind_w$}  {owner:<owner_w$}  {status:<status_w$}  {workspace:<workspace_w$}  branch",
        mine = "MINE",
        id = "ID",
        name = "NAME",
        kind = "KIND",
        owner = "OWNER",
        status = "STATUS",
        workspace = "WORKSPACE",
    );
    for (s, row) in sessions.iter().zip(rows) {
        let marker = if s.is_source { "*" } else { " " };
        let mine = if s.owned_by_me { "yes" } else { "no" };
        println!(
            "{marker} {mine:<4}  {id:<id_w$}  {name:<name_w$}  {kind:<kind_w$}  {owner:<owner_w$}  {status:<status_w$}  {workspace:<workspace_w$}  {branch}",
            marker = marker,
            mine = mine,
            id = row.0,
            name = row.1,
            kind = row.2,
            owner = row.3,
            status = row.4,
            workspace = row.5,
            branch = row.6,
        );
    }
}

fn printable_workspace_path(session: &SessionSummary) -> &str {
    if session.workspace_path.trim().is_empty() {
        "-"
    } else {
        &session.workspace_path
    }
}

fn print_workspaces(workspaces: &[WorkspaceSummary]) {
    if workspaces.is_empty() {
        println!("(no workspaces)");
        return;
    }
    let rows = workspaces
        .iter()
        .map(|workspace| {
            (
                terminal_safe_field(&workspace.id),
                terminal_safe_field(&workspace.name),
                terminal_safe_field(&workspace.workspace_path),
            )
        })
        .collect::<Vec<_>>();
    let id_w = rows
        .iter()
        .map(|row| row.0.chars().count())
        .max()
        .unwrap_or(2)
        .max(2);
    let name_w = rows
        .iter()
        .map(|row| row.1.chars().count())
        .max()
        .unwrap_or(4)
        .max(4);
    let workspace_w = rows
        .iter()
        .map(|row| row.2.chars().count())
        .max()
        .unwrap_or(9)
        .max(9);
    println!(
        "  {source:<6}  {active:<6}  {sessions:<8}  {id:<id_w$}  {name:<name_w$}  {workspace:<workspace_w$}",
        source = "SOURCE",
        active = "ACTIVE",
        sessions = "SESSIONS",
        id = "ID",
        name = "NAME",
        workspace = "WORKSPACE",
    );
    for (workspace, row) in workspaces.iter().zip(rows) {
        let marker = if workspace.is_default { "*" } else { " " };
        let source = if workspace.source { "yes" } else { "no" };
        let active = if workspace.active { "yes" } else { "no" };
        println!(
            "{marker} {source:<6}  {active:<6}  {sessions:<8}  {id:<id_w$}  {name:<name_w$}  {workspace_path:<workspace_w$}",
            marker = marker,
            source = source,
            active = active,
            sessions = workspace.session_count,
            id = row.0,
            name = row.1,
            workspace_path = row.2,
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
        ErrorCode::ForeignSession => 7,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    fn decode(b64: &str) -> Vec<u8> {
        STANDARD.decode(b64).expect("valid base64")
    }

    #[test]
    fn response_reader_enforces_the_shared_frame_limit() {
        let mut exact = vec![b'x'; MAX_RESPONSE_FRAME_BYTES - 1];
        exact.push(b'\n');
        assert_eq!(
            read_response_line(&mut std::io::Cursor::new(exact))
                .expect("exact response")
                .len(),
            MAX_RESPONSE_FRAME_BYTES
        );

        let mut oversized = vec![b'x'; MAX_RESPONSE_FRAME_BYTES];
        oversized.push(b'\n');
        let error = read_response_line(&mut std::io::Cursor::new(oversized))
            .expect_err("oversized response must fail");
        assert!(error.contains("protocol limit"));
    }

    #[test]
    fn terminal_text_escapes_control_and_bidi_override_characters() {
        assert_eq!(
            terminal_safe_field("name\n\u{1b}[2J\u{202e}"),
            "name\\n\\u{1b}[2J\\u{202e}"
        );
        assert_eq!(
            terminal_safe_multiline("line one\nline two\r"),
            "line one\nline two\\r"
        );
        assert_eq!(terminal_safe_field("한글 이름"), "한글 이름");
    }

    fn send_keys_request(
        data: Option<&str>,
        raw_base64: Option<&str>,
        enter: bool,
    ) -> Result<Request, String> {
        build_request(&Command::SendKeys {
            target: "00000000-0000-0000-0000-000000000001".to_string(),
            data: data.map(str::to_string),
            raw_base64: raw_base64.map(str::to_string),
            enter,
            allow_foreign: false,
        })
    }

    #[test]
    fn enter_flag_appends_carriage_return_not_newline() {
        // Regression guard: a real keyboard Enter sends CR (0x0D), which
        // the TTY line discipline interprets as "submit this line". LF
        // (0x0A) is a *content* newline — the shell appends it to the
        // line buffer instead of running the command. The user-visible
        // symptom is "the text shows up but Enter doesn't fire".
        let req = send_keys_request(Some("ls"), None, true).expect("build");
        let Request::SendKeys { data_b64, .. } = req else {
            panic!("expected SendKeys");
        };
        let bytes = decode(&data_b64);
        assert_eq!(bytes, b"ls\r");
        assert!(!bytes.contains(&b'\n'), "must not append LF");
    }

    #[test]
    fn enter_only_sends_lone_carriage_return() {
        let req = send_keys_request(None, None, true).expect("build");
        let Request::SendKeys { data_b64, .. } = req else {
            panic!("expected SendKeys");
        };
        assert_eq!(decode(&data_b64), b"\r");
    }

    #[test]
    fn data_alone_is_forwarded_verbatim_with_no_terminator() {
        // --data without --enter must not silently add a line submission;
        // callers that want one are expected to pass --enter explicitly.
        let req = send_keys_request(Some("hello"), None, false).expect("build");
        let Request::SendKeys { data_b64, .. } = req else {
            panic!("expected SendKeys");
        };
        assert_eq!(decode(&data_b64), b"hello");
    }

    #[test]
    fn raw_base64_wins_over_data() {
        // Documented precedence: when both are set, --raw-base64 takes
        // the wire payload verbatim and --enter is ignored on this path
        // (the caller already controls the bytes).
        let payload = STANDARD.encode(b"\x03"); // Ctrl-C
        let req = send_keys_request(Some("ignored"), Some(&payload), true).expect("build");
        let Request::SendKeys { data_b64, .. } = req else {
            panic!("expected SendKeys");
        };
        assert_eq!(decode(&data_b64), b"\x03");
    }

    #[test]
    fn missing_inputs_returns_error() {
        let result = send_keys_request(None, None, false);
        let msg = result.expect_err("should reject no-op invocation");
        assert!(msg.contains("--data"), "error should mention --data");
        assert!(msg.contains("--enter"), "error should mention --enter");
    }

    #[test]
    fn context_command_builds_context_request() {
        let req = build_request(&Command::Context).expect("build");
        assert!(matches!(req, Request::Context));
    }

    #[test]
    fn list_workspaces_command_builds_request() {
        let req = build_request(&Command::ListWorkspaces).expect("build");
        assert!(matches!(req, Request::ListWorkspaces));
    }

    #[test]
    fn promote_self_command_builds_request() {
        let req = build_request(&Command::PromoteSelf).expect("build");
        assert!(matches!(req, Request::PromoteSelf));
    }

    #[test]
    fn source_resolution_falls_back_to_resume_token() {
        let source = resolve_source_id_from(
            None,
            None,
            Some("00000000-0000-0000-0000-000000000123".to_string()),
        );
        assert_eq!(
            source.as_deref(),
            Some("00000000-0000-0000-0000-000000000123")
        );
    }

    #[test]
    fn new_session_owner_user_is_forwarded() {
        let req = build_request(&Command::NewSession {
            name: "worker".to_string(),
            isolated: false,
            workspace: None,
            workspace_id: None,
            owner: Some("user".to_string()),
        })
        .expect("build");
        match req {
            Request::NewSession { owner, .. } => {
                assert_eq!(owner, Some(NewSessionOwner::User));
            }
            other => panic!("expected new-session, got {other:?}"),
        }
    }

    #[test]
    fn new_session_workspace_current_uses_env_hints() {
        let req = build_request_with_workspace_env(
            &Command::NewSession {
                name: "worker".to_string(),
                isolated: false,
                workspace: Some("current".to_string()),
                workspace_id: None,
                owner: None,
            },
            WorkspaceEnv {
                id: Some("project-folder:/repo:abc".to_string()),
                path: Some("/repo/packages/web".to_string()),
                name: Some("web".to_string()),
            },
        )
        .expect("build");
        match req {
            Request::NewSession {
                workspace_path,
                workspace_id,
                ..
            } => {
                assert_eq!(workspace_path.as_deref(), Some("/repo/packages/web"));
                assert_eq!(workspace_id.as_deref(), Some("project-folder:/repo:abc"));
            }
            other => panic!("expected new-session, got {other:?}"),
        }
    }

    #[test]
    fn new_session_workspace_current_requires_env_hints() {
        let result = build_request_with_workspace_env(
            &Command::NewSession {
                name: "worker".to_string(),
                isolated: false,
                workspace: Some("current".to_string()),
                workspace_id: None,
                owner: None,
            },
            WorkspaceEnv::default(),
        );
        let msg = result.expect_err("current workspace without env should fail");
        assert!(msg.contains("ACORN_WORKSPACE"));
    }

    #[test]
    fn send_keys_allow_foreign_is_forwarded() {
        let req = build_request(&Command::SendKeys {
            target: "00000000-0000-0000-0000-000000000001".to_string(),
            data: Some("ls".to_string()),
            raw_base64: None,
            enter: true,
            allow_foreign: true,
        })
        .expect("build");
        match req {
            Request::SendKeys { allow_foreign, .. } => assert!(allow_foreign),
            other => panic!("expected send-keys, got {other:?}"),
        }
    }
}
