use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::str;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::chat_runs::ChatCancellation;
use crate::cli_resolver;
use crate::error::{AppError, AppResult};
use acorn_platform::process::{configure_tree_root, ProcessTree};

const ONESHOT_TIMEOUT: Duration = Duration::from_secs(60);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const PIPE_CHANNEL_CAPACITY: usize = 32;
const MAX_AI_STDOUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_AI_STDERR_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionRequest {
    pub provider: AiProvider,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub ollama_model: Option<String>,
    #[serde(default)]
    pub llm_model: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Claude,
    Antigravity,
    Codex,
    Grok,
    Ollama,
    Llm,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTransport {
    Stdin,
    Argument,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAiCommand {
    pub command: &'static str,
    pub args: Vec<String>,
    pub prompt_transport: PromptTransport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandEnvironment {
    #[cfg(test)]
    Interactive,
    Passive,
}

pub enum AiProcessStreamEvent<'a> {
    Stdout(&'a str),
    Tick,
}

impl AiExecutionRequest {
    pub fn resolve(&self) -> AppResult<ResolvedAiCommand> {
        match self.provider {
            AiProvider::Claude => {
                let mut args = vec!["-p".into(), "--output-format".into(), "text".into()];
                append_native_model_and_effort_args(self, &mut args)?;
                Ok(ResolvedAiCommand {
                    command: "claude",
                    args,
                    prompt_transport: PromptTransport::Stdin,
                })
            }
            AiProvider::Antigravity => Ok(ResolvedAiCommand {
                command: "agy",
                args: vec!["-p".into()],
                prompt_transport: PromptTransport::Argument,
            }),
            AiProvider::Codex => {
                let mut args = vec!["exec".into(), "--skip-git-repo-check".into()];
                append_native_model_and_effort_args(self, &mut args)?;
                Ok(ResolvedAiCommand {
                    command: "codex",
                    args,
                    prompt_transport: PromptTransport::Stdin,
                })
            }
            AiProvider::Grok => {
                let mut args = vec![
                    "--no-auto-update".into(),
                    "--output-format".into(),
                    "plain".into(),
                ];
                append_native_model_and_effort_args(self, &mut args)?;
                args.push("-p".into());
                Ok(ResolvedAiCommand {
                    command: "grok",
                    args,
                    prompt_transport: PromptTransport::Argument,
                })
            }
            AiProvider::Ollama => {
                let model = normalize_model_arg(self.ollama_model.as_deref(), "llama3")?;
                Ok(ResolvedAiCommand {
                    command: "ollama",
                    args: vec!["run".into(), model],
                    prompt_transport: PromptTransport::Stdin,
                })
            }
            AiProvider::Llm => {
                let model = normalize_optional_model_arg(self.llm_model.as_deref())?;
                let args = match model {
                    Some(model) => vec!["-m".into(), model],
                    None => Vec::new(),
                };
                Ok(ResolvedAiCommand {
                    command: "llm",
                    args,
                    prompt_transport: PromptTransport::Stdin,
                })
            }
            AiProvider::Custom => Err(AppError::Other(
                "Custom AI commands are not available for native execution. Pick a built-in provider."
                    .to_string(),
            )),
        }
    }

    /// Resolve a provider for passive text generation such as session titles
    /// and suggested commit messages. Passive jobs are not user-authorized
    /// agent turns: they must accept the prompt over stdin, expose no tools or
    /// project customizations, and avoid provider-side session persistence.
    pub fn resolve_passive_text(&self) -> AppResult<ResolvedAiCommand> {
        let mut resolved = self.resolve()?;
        match self.provider {
            AiProvider::Claude => {
                resolved.args.extend([
                    "--safe-mode".to_string(),
                    "--tools".to_string(),
                    String::new(),
                    "--disable-slash-commands".to_string(),
                    "--no-chrome".to_string(),
                    "--no-session-persistence".to_string(),
                    "--permission-mode".to_string(),
                    "dontAsk".to_string(),
                ]);
            }
            AiProvider::Ollama => {
                // `ollama run` is a direct model invocation. Acorn does not
                // provide it with a tool registry or a resumable session.
            }
            AiProvider::Llm => {
                // LLM logs every prompt by default. These flags make this a
                // one-shot, non-persisted response and keep output collection
                // deterministic for the bounded runner.
                resolved
                    .args
                    .extend(["--no-log".to_string(), "--no-stream".to_string()]);
            }
            AiProvider::Codex | AiProvider::Antigravity | AiProvider::Grok => {
                return Err(AppError::Other(format!(
                    "{} cannot be used for passive text generation because its CLI does not expose a verified tool-free, non-persistent mode; choose Claude, Ollama, or LLM",
                    provider_label(self.provider)
                )));
            }
            AiProvider::Custom => unreachable!("custom providers fail in resolve"),
        }
        if resolved.prompt_transport != PromptTransport::Stdin {
            return Err(AppError::Other(format!(
                "{} cannot be used for passive text generation because it would expose the prompt in process arguments",
                provider_label(self.provider)
            )));
        }
        Ok(resolved)
    }
}

fn provider_label(provider: AiProvider) -> &'static str {
    match provider {
        AiProvider::Claude => "Claude",
        AiProvider::Antigravity => "Antigravity",
        AiProvider::Codex => "Codex",
        AiProvider::Grok => "Grok",
        AiProvider::Ollama => "Ollama",
        AiProvider::Llm => "LLM",
        AiProvider::Custom => "Custom AI",
    }
}

pub(crate) fn append_native_model_and_effort_args(
    request: &AiExecutionRequest,
    args: &mut Vec<String>,
) -> AppResult<()> {
    if let Some(model) = normalize_optional_model_arg(request.model.as_deref())? {
        match request.provider {
            AiProvider::Claude => {
                args.push("--model".to_string());
                args.push(model);
            }
            AiProvider::Codex | AiProvider::Grok => {
                args.push("-m".to_string());
                args.push(model);
            }
            _ => {}
        }
    }
    if let Some(effort) = normalize_effort_arg(request.effort.as_deref())? {
        match request.provider {
            AiProvider::Claude => {
                args.push("--effort".to_string());
                args.push(effort);
            }
            AiProvider::Codex => {
                args.push("-c".to_string());
                args.push(format!("model_reasoning_effort=\"{effort}\""));
            }
            AiProvider::Grok => {
                args.push("--effort".to_string());
                args.push(effort);
            }
            _ => {}
        }
    }
    Ok(())
}

fn normalize_model_arg(raw: Option<&str>, default: &str) -> AppResult<String> {
    normalize_optional_model_arg(raw).map(|model| model.unwrap_or_else(|| default.to_string()))
}

pub(crate) fn normalize_optional_model_arg(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let model = raw.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.len() > 128
        || model.starts_with('-')
        || !model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
    {
        return Err(AppError::Other(
            "AI model names may only contain letters, numbers, '.', '_', '-', ':', and '/'."
                .to_string(),
        ));
    }
    Ok(Some(model.to_string()))
}

pub(crate) fn normalize_effort_arg(raw: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let effort = raw.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return Ok(None);
    }
    if effort.len() > 32
        || effort.starts_with('-')
        || !effort
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err(AppError::Other(format!(
            "invalid reasoning effort '{effort}': expected a short CLI capability identifier"
        )));
    }
    Ok(Some(effort))
}

/// Execute an unprivileged, non-persistent model call in a fresh empty
/// directory. This is the only entry point passive text features should use.
pub fn run_passive_text(
    request: &AiExecutionRequest,
    prompt: &str,
    settings_label: &str,
) -> AppResult<String> {
    let resolved = request.resolve_passive_text()?;
    let working_directory = tempfile::Builder::new()
        .prefix("acorn-passive-ai-")
        .tempdir()
        .map_err(|error| {
            AppError::Other(format!(
                "failed to create a private passive AI working directory: {error}"
            ))
        })?;
    run_oneshot_in_dir_cancellable_with_transport_and_environment(
        resolved.command,
        &resolved.args,
        prompt,
        settings_label,
        Some(working_directory.path()),
        None,
        resolved.prompt_transport,
        CommandEnvironment::Passive,
    )
}

pub fn run_resolved_streaming_in_dir_cancellable<F>(
    resolved: &ResolvedAiCommand,
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    on_event: F,
) -> AppResult<String>
where
    F: FnMut(AiProcessStreamEvent<'_>),
{
    run_streaming_in_dir_cancellable_with_transport(
        resolved.command,
        &resolved.args,
        prompt,
        settings_label,
        cwd,
        cancellation,
        resolved.prompt_transport,
        on_event,
    )
}

#[cfg(test)]
fn run_oneshot_in_dir_cancellable_with_transport(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    prompt_transport: PromptTransport,
) -> AppResult<String> {
    run_oneshot_in_dir_cancellable_with_transport_and_environment(
        command,
        args,
        prompt,
        settings_label,
        cwd,
        cancellation,
        prompt_transport,
        CommandEnvironment::Interactive,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_oneshot_in_dir_cancellable_with_transport_and_environment(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    prompt_transport: PromptTransport,
    environment: CommandEnvironment,
) -> AppResult<String> {
    let resolved = resolve_ai_cli(command, settings_label)?;
    let mut command_args = args.to_vec();
    if prompt_transport == PromptTransport::Argument {
        command_args.push(prompt.to_string());
    }
    let mut command_builder = Command::new(&resolved);
    crate::shell_env::apply_to_command(&mut command_builder);
    if environment == CommandEnvironment::Passive {
        strip_acorn_authority_environment(&mut command_builder);
    }
    configure_tree_root(&mut command_builder);
    command_builder
        .args(&command_args)
        .stdin(match prompt_transport {
            PromptTransport::Stdin => Stdio::piped(),
            PromptTransport::Argument => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command_builder.current_dir(cwd);
    }
    let mut child = command_builder.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            cli_resolver::invalidate(command);
            AppError::Other(format!(
                "`{command}` not found. Install the configured AI CLI or change the provider in {settings_label}."
            ))
        } else {
            AppError::Other(format!("failed to invoke {command}: {e}"))
        }
    })?;
    let process_tree = track_child_tree(command, &mut child)?;

    if prompt_transport == PromptTransport::Stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| AppError::Other(format!("failed to write to {command}: {e}")))?;
        } else {
            return Err(AppError::Other(format!("{command} stdin missing")));
        }
    }

    let output = wait_with_timeout(command, child, process_tree, ONESHOT_TIMEOUT, cancellation)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("{command} exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn strip_acorn_authority_environment(command: &mut Command) {
    let mut keys = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_os_string()))
        .filter(|key| key.to_string_lossy().starts_with("ACORN_"))
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    for key in keys {
        command.env_remove(key);
    }
}

fn run_streaming_in_dir_cancellable_with_transport<F>(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    prompt_transport: PromptTransport,
    mut on_event: F,
) -> AppResult<String>
where
    F: FnMut(AiProcessStreamEvent<'_>),
{
    let resolved = resolve_ai_cli(command, settings_label)?;
    let mut command_args = args.to_vec();
    if prompt_transport == PromptTransport::Argument {
        command_args.push(prompt.to_string());
    }
    let mut command_builder = Command::new(&resolved);
    crate::shell_env::apply_to_command(&mut command_builder);
    configure_tree_root(&mut command_builder);
    command_builder
        .args(&command_args)
        .stdin(match prompt_transport {
            PromptTransport::Stdin => Stdio::piped(),
            PromptTransport::Argument => Stdio::null(),
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command_builder.current_dir(cwd);
    }
    let mut child = command_builder.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            cli_resolver::invalidate(command);
            AppError::Other(format!(
                "`{command}` not found. Install the configured AI CLI or change the provider in {settings_label}."
            ))
        } else {
            AppError::Other(format!("failed to invoke {command}: {e}"))
        }
    })?;
    let process_tree = track_child_tree(command, &mut child)?;

    if prompt_transport == PromptTransport::Stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| AppError::Other(format!("failed to write to {command}: {e}")))?;
        } else {
            return Err(AppError::Other(format!("{command} stdin missing")));
        }
    }

    let output = wait_with_timeout_streaming(
        command,
        child,
        process_tree,
        None,
        cancellation,
        &mut on_event,
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            format!("{command} exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(msg));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn resolve_ai_cli(command: &str, settings_label: &str) -> AppResult<std::path::PathBuf> {
    cli_resolver::resolve(command)
        .map_err(|error| ai_cli_resolution_error(command, settings_label, error))
}

fn ai_cli_resolution_error(command: &str, settings_label: &str, error: AppError) -> AppError {
    AppError::Other(format!(
        "AI CLI discovery failed for `{command}`: {error}; change the provider in {settings_label} if this command is unavailable."
    ))
}

fn wait_with_timeout(
    command: &str,
    mut child: std::process::Child,
    process_tree: Arc<ProcessTree>,
    timeout: Duration,
    cancellation: Option<ChatCancellation>,
) -> AppResult<Output> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stdout missing")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stderr missing")))?;

    let (pipe_tx, pipe_rx) = mpsc::sync_channel(PIPE_CHANNEL_CAPACITY);
    spawn_pipe_reader(PipeKind::Stdout, stdout, pipe_tx.clone());
    spawn_pipe_reader(PipeKind::Stderr, stderr, pipe_tx);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;

    let started = Instant::now();
    let status = if let Some(cancellation) = cancellation {
        cancellation.set_child(child, Arc::clone(&process_tree));
        let status = loop {
            if let Err(err) = drain_pipe_events(
                command,
                &pipe_rx,
                &mut stdout,
                &mut stderr,
                &mut stdout_open,
                &mut stderr_open,
            ) {
                let _ = process_tree.terminate();
                cancellation.kill_and_wait();
                cancellation.clear_child();
                return Err(err);
            }
            if cancellation.is_cancelled() {
                let _ = process_tree.terminate();
                cancellation.kill_and_wait();
                let drain_result = drain_pipe_events_until_closed(
                    command,
                    &pipe_rx,
                    &mut stdout,
                    &mut stderr,
                    &mut stdout_open,
                    &mut stderr_open,
                    PIPE_DRAIN_TIMEOUT,
                );
                cancellation.clear_child();
                drain_result?;
                return Err(AppError::Other(format!("{command} cancelled")));
            }
            match cancellation.try_wait(command)? {
                Some(status) => break status,
                None if started.elapsed() >= timeout => {
                    let _ = process_tree.terminate();
                    cancellation.kill_and_wait();
                    let drain_result = drain_pipe_events_until_closed(
                        command,
                        &pipe_rx,
                        &mut stdout,
                        &mut stderr,
                        &mut stdout_open,
                        &mut stderr_open,
                        PIPE_DRAIN_TIMEOUT,
                    );
                    cancellation.clear_child();
                    drain_result?;
                    return Err(AppError::Other(format!(
                        "{command} timed out after {} seconds",
                        timeout.as_secs()
                    )));
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        };
        cancellation.clear_child();
        status
    } else {
        loop {
            if let Err(err) = drain_pipe_events(
                command,
                &pipe_rx,
                &mut stdout,
                &mut stderr,
                &mut stdout_open,
                &mut stderr_open,
            ) {
                let _ = process_tree.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
            match child
                .try_wait()
                .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))?
            {
                Some(status) => break status,
                None if started.elapsed() >= timeout => {
                    let _ = process_tree.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    drain_pipe_events_until_closed(
                        command,
                        &pipe_rx,
                        &mut stdout,
                        &mut stderr,
                        &mut stdout_open,
                        &mut stderr_open,
                        PIPE_DRAIN_TIMEOUT,
                    )?;
                    return Err(AppError::Other(format!(
                        "{command} timed out after {} seconds",
                        timeout.as_secs()
                    )));
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    };

    if stdout_open || stderr_open {
        let _ = process_tree.terminate();
    }
    drain_pipe_events_until_closed(
        command,
        &pipe_rx,
        &mut stdout,
        &mut stderr,
        &mut stdout_open,
        &mut stderr_open,
        PIPE_DRAIN_TIMEOUT,
    )?;
    if stdout_open || stderr_open {
        tracing::warn!(
            command,
            stdout_open,
            stderr_open,
            "AI one-shot pipe reader did not finish after child exit"
        );
    }

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn track_child_tree(command: &str, child: &mut std::process::Child) -> AppResult<Arc<ProcessTree>> {
    ProcessTree::from_std_child(child)
        .map(Arc::new)
        .map_err(|err| {
            let _ = child.kill();
            let _ = child.wait();
            AppError::Other(format!("failed to track {command} process tree: {err}"))
        })
}

#[derive(Clone, Copy)]
enum PipeKind {
    Stdout,
    Stderr,
}

enum PipeEvent {
    Chunk(PipeKind, io::Result<Vec<u8>>),
    Done(PipeKind),
}

fn spawn_pipe_reader<R>(kind: PipeKind, mut reader: R, tx: SyncSender<PipeEvent>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(PipeEvent::Done(kind));
                    break;
                }
                Ok(n) => {
                    if tx
                        .send(PipeEvent::Chunk(kind, Ok(buf[..n].to_vec())))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.send(PipeEvent::Chunk(kind, Err(err)));
                    let _ = tx.send(PipeEvent::Done(kind));
                    break;
                }
            }
        }
    });
}

impl PipeKind {
    fn label(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }

    fn byte_limit(self) -> usize {
        match self {
            Self::Stdout => MAX_AI_STDOUT_BYTES,
            Self::Stderr => MAX_AI_STDERR_BYTES,
        }
    }
}

fn append_pipe_chunk(
    command: &str,
    kind: PipeKind,
    destination: &mut Vec<u8>,
    bytes: &[u8],
) -> AppResult<()> {
    append_chunk_with_limit(command, kind.label(), destination, bytes, kind.byte_limit())
}

fn append_chunk_with_limit(
    command: &str,
    stream: &str,
    destination: &mut Vec<u8>,
    bytes: &[u8],
    limit: usize,
) -> AppResult<()> {
    if bytes.len() > limit.saturating_sub(destination.len()) {
        return Err(AppError::Other(format!(
            "{command} {stream} exceeded the {limit} byte output limit"
        )));
    }
    destination.extend_from_slice(bytes);
    Ok(())
}

fn process_pipe_event(
    command: &str,
    event: PipeEvent,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    stdout_open: &mut bool,
    stderr_open: &mut bool,
) -> AppResult<()> {
    match event {
        PipeEvent::Chunk(kind, Ok(bytes)) => match kind {
            PipeKind::Stdout => append_pipe_chunk(command, kind, stdout, &bytes)?,
            PipeKind::Stderr => append_pipe_chunk(command, kind, stderr, &bytes)?,
        },
        PipeEvent::Chunk(kind, Err(err)) => {
            return Err(AppError::Other(format!(
                "failed reading {command} {}: {err}",
                kind.label()
            )));
        }
        PipeEvent::Done(PipeKind::Stdout) => *stdout_open = false,
        PipeEvent::Done(PipeKind::Stderr) => *stderr_open = false,
    }
    Ok(())
}

fn drain_pipe_events(
    command: &str,
    rx: &Receiver<PipeEvent>,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    stdout_open: &mut bool,
    stderr_open: &mut bool,
) -> AppResult<()> {
    loop {
        match rx.try_recv() {
            Ok(event) => {
                process_pipe_event(command, event, stdout, stderr, stdout_open, stderr_open)?
            }
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn drain_pipe_events_until_closed(
    command: &str,
    rx: &Receiver<PipeEvent>,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    stdout_open: &mut bool,
    stderr_open: &mut bool,
    timeout: Duration,
) -> AppResult<()> {
    let deadline = Instant::now() + timeout;
    while *stdout_open || *stderr_open {
        match rx.try_recv() {
            Ok(event) => {
                process_pipe_event(command, event, stdout, stderr, stdout_open, stderr_open)?
            }
            Err(TryRecvError::Empty) => {
                let now = Instant::now();
                if now >= deadline {
                    return Ok(());
                }
                let remaining = deadline.saturating_duration_since(now);
                let wait = remaining.min(Duration::from_millis(25));
                match rx.recv_timeout(wait) {
                    Ok(event) => process_pipe_event(
                        command,
                        event,
                        stdout,
                        stderr,
                        stdout_open,
                        stderr_open,
                    )?,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                }
            }
            Err(TryRecvError::Disconnected) => return Ok(()),
        }
    }
    Ok(())
}

struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match str::from_utf8(&self.pending) {
                Ok(valid) => {
                    out.push_str(valid);
                    self.pending.clear();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = str::from_utf8(&self.pending[..valid_up_to])
                            .expect("valid_up_to must end at a utf8 boundary");
                        out.push_str(valid);
                        self.pending.drain(..valid_up_to);
                    }
                    if let Some(error_len) = err.error_len() {
                        out.push_str(&String::from_utf8_lossy(&self.pending[..error_len]));
                        self.pending.drain(..error_len);
                    } else {
                        break;
                    }
                }
            }
        }
        out
    }

    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let trailing = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        trailing
    }
}

fn process_streaming_pipe_event<F>(
    command: &str,
    event: PipeEvent,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    stdout_open: &mut bool,
    stderr_open: &mut bool,
    decoder: &mut Utf8ChunkDecoder,
    on_event: &mut F,
) -> AppResult<()>
where
    F: FnMut(AiProcessStreamEvent<'_>),
{
    match event {
        PipeEvent::Chunk(PipeKind::Stdout, Ok(bytes)) => {
            if bytes.is_empty() {
                return Ok(());
            }
            append_pipe_chunk(command, PipeKind::Stdout, stdout, &bytes)?;
            let text = decoder.push(&bytes);
            if !text.is_empty() {
                on_event(AiProcessStreamEvent::Stdout(&text));
            }
        }
        PipeEvent::Chunk(PipeKind::Stderr, Ok(bytes)) => {
            append_pipe_chunk(command, PipeKind::Stderr, stderr, &bytes)?;
        }
        PipeEvent::Chunk(kind, Err(err)) => {
            return Err(AppError::Other(format!(
                "failed reading {command} {}: {err}",
                kind.label()
            )));
        }
        PipeEvent::Done(PipeKind::Stdout) => *stdout_open = false,
        PipeEvent::Done(PipeKind::Stderr) => *stderr_open = false,
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn drain_streaming_pipe_events<F>(
    command: &str,
    rx: &Receiver<PipeEvent>,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    stdout_open: &mut bool,
    stderr_open: &mut bool,
    decoder: &mut Utf8ChunkDecoder,
    on_event: &mut F,
) -> AppResult<()>
where
    F: FnMut(AiProcessStreamEvent<'_>),
{
    loop {
        match rx.try_recv() {
            Ok(event) => process_streaming_pipe_event(
                command,
                event,
                stdout,
                stderr,
                stdout_open,
                stderr_open,
                decoder,
                on_event,
            )?,
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn drain_streaming_pipe_events_until_closed<F>(
    command: &str,
    rx: &Receiver<PipeEvent>,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    stdout_open: &mut bool,
    stderr_open: &mut bool,
    decoder: &mut Utf8ChunkDecoder,
    on_event: &mut F,
    timeout: Duration,
) -> AppResult<()>
where
    F: FnMut(AiProcessStreamEvent<'_>),
{
    let deadline = Instant::now() + timeout;
    while *stdout_open || *stderr_open {
        match rx.try_recv() {
            Ok(event) => process_streaming_pipe_event(
                command,
                event,
                stdout,
                stderr,
                stdout_open,
                stderr_open,
                decoder,
                on_event,
            )?,
            Err(TryRecvError::Empty) => {
                let now = Instant::now();
                if now >= deadline {
                    return Ok(());
                }
                let remaining = deadline.saturating_duration_since(now);
                let wait = remaining.min(Duration::from_millis(25));
                match rx.recv_timeout(wait) {
                    Ok(event) => process_streaming_pipe_event(
                        command,
                        event,
                        stdout,
                        stderr,
                        stdout_open,
                        stderr_open,
                        decoder,
                        on_event,
                    )?,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
                }
            }
            Err(TryRecvError::Disconnected) => return Ok(()),
        }
    }
    Ok(())
}

fn wait_with_timeout_streaming<F>(
    command: &str,
    mut child: std::process::Child,
    process_tree: Arc<ProcessTree>,
    timeout: Option<Duration>,
    cancellation: Option<ChatCancellation>,
    on_event: &mut F,
) -> AppResult<Output>
where
    F: FnMut(AiProcessStreamEvent<'_>),
{
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stdout missing")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stderr missing")))?;

    let (pipe_tx, pipe_rx) = mpsc::sync_channel(PIPE_CHANNEL_CAPACITY);
    spawn_pipe_reader(PipeKind::Stdout, stdout, pipe_tx.clone());
    spawn_pipe_reader(PipeKind::Stderr, stderr, pipe_tx);

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;
    let mut decoder = Utf8ChunkDecoder::new();
    let started = Instant::now();
    let status = if let Some(cancellation) = cancellation {
        cancellation.set_child(child, Arc::clone(&process_tree));
        let status = loop {
            if let Err(err) = drain_streaming_pipe_events(
                command,
                &pipe_rx,
                &mut stdout,
                &mut stderr,
                &mut stdout_open,
                &mut stderr_open,
                &mut decoder,
                on_event,
            ) {
                let _ = process_tree.terminate();
                cancellation.kill_and_wait();
                cancellation.clear_child();
                return Err(err);
            }
            on_event(AiProcessStreamEvent::Tick);
            if cancellation.is_cancelled() {
                let _ = process_tree.terminate();
                cancellation.kill_and_wait();
                let drain_result = drain_streaming_pipe_events_until_closed(
                    command,
                    &pipe_rx,
                    &mut stdout,
                    &mut stderr,
                    &mut stdout_open,
                    &mut stderr_open,
                    &mut decoder,
                    on_event,
                    PIPE_DRAIN_TIMEOUT,
                );
                cancellation.clear_child();
                drain_result?;
                return Err(AppError::Other(format!("{command} cancelled")));
            }
            match cancellation.try_wait(command)? {
                Some(status) => break status,
                None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                    let _ = process_tree.terminate();
                    cancellation.kill_and_wait();
                    let drain_result = drain_streaming_pipe_events_until_closed(
                        command,
                        &pipe_rx,
                        &mut stdout,
                        &mut stderr,
                        &mut stdout_open,
                        &mut stderr_open,
                        &mut decoder,
                        on_event,
                        PIPE_DRAIN_TIMEOUT,
                    );
                    cancellation.clear_child();
                    drain_result?;
                    let timeout = timeout.expect("timeout checked as some");
                    return Err(AppError::Other(format!(
                        "{command} timed out after {} seconds",
                        timeout.as_secs()
                    )));
                }
                None => thread::sleep(Duration::from_millis(25)),
            }
        };
        cancellation.clear_child();
        status
    } else {
        loop {
            if let Err(err) = drain_streaming_pipe_events(
                command,
                &pipe_rx,
                &mut stdout,
                &mut stderr,
                &mut stdout_open,
                &mut stderr_open,
                &mut decoder,
                on_event,
            ) {
                let _ = process_tree.terminate();
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
            on_event(AiProcessStreamEvent::Tick);
            match child
                .try_wait()
                .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))?
            {
                Some(status) => break status,
                None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                    let _ = process_tree.terminate();
                    let _ = child.kill();
                    let _ = child.wait();
                    drain_streaming_pipe_events_until_closed(
                        command,
                        &pipe_rx,
                        &mut stdout,
                        &mut stderr,
                        &mut stdout_open,
                        &mut stderr_open,
                        &mut decoder,
                        on_event,
                        PIPE_DRAIN_TIMEOUT,
                    )?;
                    let timeout = timeout.expect("timeout checked as some");
                    return Err(AppError::Other(format!(
                        "{command} timed out after {} seconds",
                        timeout.as_secs()
                    )));
                }
                None => thread::sleep(Duration::from_millis(25)),
            }
        }
    };

    if stdout_open || stderr_open {
        let _ = process_tree.terminate();
    }
    drain_streaming_pipe_events_until_closed(
        command,
        &pipe_rx,
        &mut stdout,
        &mut stderr,
        &mut stdout_open,
        &mut stderr_open,
        &mut decoder,
        on_event,
        PIPE_DRAIN_TIMEOUT,
    )?;
    if stdout_open || stderr_open {
        tracing::warn!(
            command,
            stdout_open,
            stderr_open,
            "AI streaming pipe reader did not finish after child exit"
        );
    }
    on_event(AiProcessStreamEvent::Tick);
    let trailing = decoder.finish();
    if !trailing.is_empty() {
        on_event(AiProcessStreamEvent::Stdout(&trailing));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_output_rejects_chunks_past_limit_without_growing_buffer() {
        let mut output = b"1234".to_vec();
        append_chunk_with_limit("test-ai", "stdout", &mut output, b"56", 6).unwrap();
        let err = append_chunk_with_limit("test-ai", "stdout", &mut output, b"7", 6)
            .expect_err("output beyond the configured limit must fail");

        assert_eq!(output, b"123456");
        assert!(err.to_string().contains("exceeded the 6 byte output limit"));
    }

    #[test]
    fn ai_cli_resolution_error_preserves_the_original_diagnostic() {
        let error = ai_cli_resolution_error(
            "codex",
            "Agent settings",
            AppError::Other(
                "failed to read login shell configuration: permission denied".to_string(),
            ),
        );
        let message = error.to_string();

        assert!(message.contains("AI CLI discovery failed for `codex`"));
        assert!(message.contains("permission denied"));
        assert!(message.contains("failed to read login shell configuration"));
        assert!(message.contains("Agent settings"));
    }

    #[test]
    fn resolves_known_ai_provider_commands() {
        let req = AiExecutionRequest {
            provider: AiProvider::Codex,
            model: None,
            effort: None,
            ollama_model: None,
            llm_model: None,
        };

        assert_eq!(
            req.resolve().unwrap(),
            ResolvedAiCommand {
                command: "codex",
                args: vec!["exec".to_string(), "--skip-git-repo-check".to_string(),],
                prompt_transport: PromptTransport::Stdin,
            }
        );
    }

    #[test]
    fn resolves_codex_model_and_reasoning_effort() {
        let req = AiExecutionRequest {
            provider: AiProvider::Codex,
            model: Some("gpt-5.4".to_string()),
            effort: Some("xhigh".to_string()),
            ollama_model: None,
            llm_model: None,
        };

        assert_eq!(
            req.resolve().unwrap().args,
            vec![
                "exec",
                "--skip-git-repo-check",
                "-m",
                "gpt-5.4",
                "-c",
                "model_reasoning_effort=\"xhigh\"",
            ]
        );
    }

    #[test]
    fn resolves_claude_model_and_effort() {
        let req = AiExecutionRequest {
            provider: AiProvider::Claude,
            model: Some("claude-opus-4-1".to_string()),
            effort: Some("max".to_string()),
            ollama_model: None,
            llm_model: None,
        };

        assert_eq!(
            req.resolve().unwrap().args,
            vec![
                "-p",
                "--output-format",
                "text",
                "--model",
                "claude-opus-4-1",
                "--effort",
                "max",
            ]
        );
    }

    #[test]
    fn passive_claude_is_tool_free_non_persistent_and_stdin_only() {
        let request = AiExecutionRequest {
            provider: AiProvider::Claude,
            model: Some("claude-opus-4-1".to_string()),
            effort: None,
            ollama_model: None,
            llm_model: None,
        };

        let resolved = request.resolve_passive_text().unwrap();
        assert_eq!(resolved.prompt_transport, PromptTransport::Stdin);
        for required in [
            "--safe-mode",
            "--tools",
            "--disable-slash-commands",
            "--no-chrome",
            "--no-session-persistence",
            "--permission-mode",
            "dontAsk",
        ] {
            assert!(resolved.args.iter().any(|argument| argument == required));
        }
        let tools = resolved
            .args
            .iter()
            .position(|argument| argument == "--tools")
            .unwrap();
        assert_eq!(resolved.args.get(tools + 1).map(String::as_str), Some(""));
    }

    #[test]
    fn passive_llm_disables_default_logging() {
        let request = AiExecutionRequest {
            provider: AiProvider::Llm,
            model: None,
            effort: None,
            ollama_model: None,
            llm_model: Some("gpt-4o-mini".to_string()),
        };

        let resolved = request.resolve_passive_text().unwrap();
        assert_eq!(resolved.prompt_transport, PromptTransport::Stdin);
        assert!(resolved.args.iter().any(|argument| argument == "--no-log"));
        assert!(resolved
            .args
            .iter()
            .any(|argument| argument == "--no-stream"));
    }

    #[test]
    fn passive_generation_rejects_agent_clis_without_tool_free_mode() {
        for provider in [AiProvider::Codex, AiProvider::Antigravity, AiProvider::Grok] {
            let request = AiExecutionRequest {
                provider,
                model: None,
                effort: None,
                ollama_model: None,
                llm_model: None,
            };
            let error = request
                .resolve_passive_text()
                .expect_err("agent provider must fail closed");
            assert!(error.to_string().contains("tool-free, non-persistent"));
        }
    }

    #[test]
    fn passive_environment_removes_acorn_authority_values() {
        let mut command = Command::new("ignored");
        command
            .env("ACORN_TEST_AUTHORITY", "secret")
            .env("SAFE_VALUE", "visible");

        strip_acorn_authority_environment(&mut command);

        let env = command
            .get_envs()
            .map(|(key, value)| (key.to_string_lossy().into_owned(), value))
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(env.get("ACORN_TEST_AUTHORITY"), Some(&None));
        assert_eq!(
            env.get("SAFE_VALUE")
                .and_then(|value| value.map(|value| value.to_string_lossy().into_owned())),
            Some("visible".to_string())
        );
    }

    #[test]
    fn accepts_new_cli_advertised_effort_identifiers() {
        let req = AiExecutionRequest {
            provider: AiProvider::Codex,
            model: None,
            effort: Some("ultra".to_string()),
            ollama_model: None,
            llm_model: None,
        };

        assert!(req.resolve().is_ok());
    }

    #[test]
    fn rejects_unsafe_effort_identifiers() {
        let req = AiExecutionRequest {
            provider: AiProvider::Codex,
            model: None,
            effort: Some("high\" model=\"other".to_string()),
            ollama_model: None,
            llm_model: None,
        };

        assert!(req.resolve().is_err());
    }

    #[test]
    fn resolves_antigravity_prompt_as_print_argument() {
        let req = AiExecutionRequest {
            provider: AiProvider::Antigravity,
            model: None,
            effort: None,
            ollama_model: None,
            llm_model: None,
        };

        assert_eq!(
            req.resolve().unwrap(),
            ResolvedAiCommand {
                command: "agy",
                args: vec!["-p".to_string()],
                prompt_transport: PromptTransport::Argument,
            }
        );
    }

    #[test]
    fn resolves_grok_headless_prompt_with_model_and_effort() {
        let req = AiExecutionRequest {
            provider: AiProvider::Grok,
            model: Some("grok-code-fast-1".to_string()),
            effort: Some("high".to_string()),
            ollama_model: None,
            llm_model: None,
        };

        assert_eq!(
            req.resolve().unwrap(),
            ResolvedAiCommand {
                command: "grok",
                args: vec![
                    "--no-auto-update".to_string(),
                    "--output-format".to_string(),
                    "plain".to_string(),
                    "-m".to_string(),
                    "grok-code-fast-1".to_string(),
                    "--effort".to_string(),
                    "high".to_string(),
                    "-p".to_string(),
                ],
                prompt_transport: PromptTransport::Argument,
            }
        );
    }

    #[test]
    fn rejects_custom_ai_commands() {
        let req = AiExecutionRequest {
            provider: AiProvider::Custom,
            model: None,
            effort: None,
            ollama_model: None,
            llm_model: None,
        };

        assert!(req.resolve().is_err());
    }

    #[test]
    fn rejects_model_names_that_can_be_interpreted_as_options() {
        let req = AiExecutionRequest {
            provider: AiProvider::Ollama,
            model: None,
            effort: None,
            ollama_model: Some("--help".to_string()),
            llm_model: None,
        };

        assert!(req.resolve().is_err());
    }

    #[test]
    fn runs_oneshot_in_requested_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        let output = run_oneshot_in_dir_cancellable_with_transport(
            "pwd",
            &[],
            "",
            "test settings",
            Some(dir.path()),
            None,
            PromptTransport::Stdin,
        )
        .unwrap();
        let observed = std::path::PathBuf::from(output.trim())
            .canonicalize()
            .unwrap();
        let expected = dir.path().canonicalize().unwrap();

        assert_eq!(observed, expected);
    }

    #[test]
    fn runs_prompt_as_argument_when_requested() {
        let args = vec![
            "-c".to_string(),
            "printf 'arg=%s stdin=%s' \"$1\" \"$(cat)\"".to_string(),
            "sh".to_string(),
        ];
        let output = run_oneshot_in_dir_cancellable_with_transport(
            "/bin/sh",
            &args,
            "hello",
            "test settings",
            None,
            None,
            PromptTransport::Argument,
        )
        .unwrap();

        assert_eq!(output, "arg=hello stdin=");
    }

    #[test]
    fn runs_prompt_through_stdin_when_requested() {
        let args = vec![
            "-c".to_string(),
            "printf 'arg=%s stdin=%s' \"${1-}\" \"$(cat)\"".to_string(),
            "sh".to_string(),
        ];
        let output = run_oneshot_in_dir_cancellable_with_transport(
            "/bin/sh",
            &args,
            "hello",
            "test settings",
            None,
            None,
            PromptTransport::Stdin,
        )
        .unwrap();

        assert_eq!(output, "arg= stdin=hello");
    }

    #[cfg(unix)]
    #[test]
    fn oneshot_returns_when_background_child_inherits_stdout() {
        let args = vec!["-c".to_string(), "printf done; (sleep 30) &".to_string()];

        let started = std::time::Instant::now();
        let output = run_oneshot_in_dir_cancellable_with_transport(
            "/bin/sh",
            &args,
            "",
            "test settings",
            None,
            None,
            PromptTransport::Stdin,
        )
        .unwrap();

        assert_eq!(output, "done");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "one-shot call waited for an inherited stdout pipe to close"
        );
    }

    #[test]
    fn streams_stdout_chunks_before_returning() {
        let args = vec![
            "-c".to_string(),
            "printf one; sleep 0.05; printf two".to_string(),
        ];
        let mut chunks = Vec::new();
        let output = run_streaming_in_dir_cancellable_with_transport(
            "/bin/sh",
            &args,
            "",
            "test settings",
            None,
            None,
            PromptTransport::Stdin,
            |event| {
                if let AiProcessStreamEvent::Stdout(chunk) = event {
                    chunks.push(chunk.to_string());
                }
            },
        )
        .unwrap();

        assert_eq!(output, "onetwo");
        assert_eq!(chunks.concat(), "onetwo");
        assert!(!chunks.is_empty());
    }

    #[test]
    fn streaming_reports_ticks_while_stdout_is_idle() {
        let args = vec!["-c".to_string(), "sleep 0.08; printf done".to_string()];
        let mut ticks = 0usize;

        let output = run_streaming_in_dir_cancellable_with_transport(
            "/bin/sh",
            &args,
            "",
            "test settings",
            None,
            None,
            PromptTransport::Stdin,
            |event| {
                if matches!(event, AiProcessStreamEvent::Tick) {
                    ticks += 1;
                }
            },
        )
        .unwrap();

        assert_eq!(output, "done");
        assert!(ticks > 0);
    }

    #[cfg(unix)]
    #[test]
    fn streaming_returns_when_background_child_inherits_stdout() {
        let args = vec!["-c".to_string(), "printf done; (sleep 30) &".to_string()];
        let mut chunks = Vec::new();

        let started = std::time::Instant::now();
        let output = run_streaming_in_dir_cancellable_with_transport(
            "/bin/sh",
            &args,
            "",
            "test settings",
            None,
            None,
            PromptTransport::Stdin,
            |event| {
                if let AiProcessStreamEvent::Stdout(chunk) = event {
                    chunks.push(chunk.to_string());
                }
            },
        )
        .unwrap();

        assert_eq!(output, "done");
        assert_eq!(chunks.concat(), "done");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "streaming call waited for an inherited stdout pipe to close"
        );
    }
}
