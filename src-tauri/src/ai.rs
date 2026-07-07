use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::str;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::chat_runs::ChatCancellation;
use crate::cli_resolver;
use crate::error::{AppError, AppResult};

const ONESHOT_TIMEOUT: Duration = Duration::from_secs(60);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiExecutionRequest {
    pub provider: AiProvider,
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

impl AiExecutionRequest {
    pub fn resolve(&self) -> AppResult<ResolvedAiCommand> {
        match self.provider {
            AiProvider::Claude => Ok(ResolvedAiCommand {
                command: "claude",
                args: vec!["-p".into(), "--output-format".into(), "text".into()],
                prompt_transport: PromptTransport::Stdin,
            }),
            AiProvider::Antigravity => Ok(ResolvedAiCommand {
                command: "agy",
                args: vec!["-p".into()],
                prompt_transport: PromptTransport::Argument,
            }),
            AiProvider::Codex => Ok(ResolvedAiCommand {
                command: "codex",
                args: vec!["exec".into(), "--skip-git-repo-check".into()],
                prompt_transport: PromptTransport::Stdin,
            }),
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
}

fn normalize_model_arg(raw: Option<&str>, default: &str) -> AppResult<String> {
    normalize_optional_model_arg(raw).map(|model| model.unwrap_or_else(|| default.to_string()))
}

fn normalize_optional_model_arg(raw: Option<&str>) -> AppResult<Option<String>> {
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

pub fn run_resolved_oneshot(
    resolved: &ResolvedAiCommand,
    prompt: &str,
    settings_label: &str,
) -> AppResult<String> {
    run_resolved_oneshot_in_dir(resolved, prompt, settings_label, None)
}

pub fn run_resolved_oneshot_in_dir(
    resolved: &ResolvedAiCommand,
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
) -> AppResult<String> {
    run_resolved_oneshot_in_dir_cancellable(resolved, prompt, settings_label, cwd, None)
}

pub fn run_resolved_oneshot_in_dir_cancellable(
    resolved: &ResolvedAiCommand,
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
) -> AppResult<String> {
    run_oneshot_in_dir_cancellable_with_transport(
        resolved.command,
        &resolved.args,
        prompt,
        settings_label,
        cwd,
        cancellation,
        resolved.prompt_transport,
    )
}

pub fn run_resolved_streaming_in_dir_cancellable<F>(
    resolved: &ResolvedAiCommand,
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    on_stdout_chunk: F,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    run_streaming_in_dir_cancellable_with_transport(
        resolved.command,
        &resolved.args,
        prompt,
        settings_label,
        cwd,
        cancellation,
        resolved.prompt_transport,
        on_stdout_chunk,
    )
}

fn run_oneshot_in_dir_cancellable_with_transport(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    prompt_transport: PromptTransport,
) -> AppResult<String> {
    let resolved = cli_resolver::resolve(command).map_err(|_| {
        AppError::Other(format!(
            "`{command}` not found. Install the configured AI CLI or change the provider in {settings_label}."
        ))
    })?;
    let mut command_args = args.to_vec();
    if prompt_transport == PromptTransport::Argument {
        command_args.push(prompt.to_string());
    }
    let mut command_builder = Command::new(&resolved);
    crate::shell_env::apply_to_command(&mut command_builder);
    isolate_child_process_group(&mut command_builder);
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

    if prompt_transport == PromptTransport::Stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| AppError::Other(format!("failed to write to {command}: {e}")))?;
        } else {
            return Err(AppError::Other(format!("{command} stdin missing")));
        }
    }

    let output = wait_with_timeout(command, child, ONESHOT_TIMEOUT, cancellation)?;

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

fn run_streaming_in_dir_cancellable_with_transport<F>(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
    prompt_transport: PromptTransport,
    mut on_stdout_chunk: F,
) -> AppResult<String>
where
    F: FnMut(&str),
{
    let resolved = cli_resolver::resolve(command).map_err(|_| {
        AppError::Other(format!(
            "`{command}` not found. Install the configured AI CLI or change the provider in {settings_label}."
        ))
    })?;
    let mut command_args = args.to_vec();
    if prompt_transport == PromptTransport::Argument {
        command_args.push(prompt.to_string());
    }
    let mut command_builder = Command::new(&resolved);
    crate::shell_env::apply_to_command(&mut command_builder);
    isolate_child_process_group(&mut command_builder);
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

    if prompt_transport == PromptTransport::Stdin {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| AppError::Other(format!("failed to write to {command}: {e}")))?;
        } else {
            return Err(AppError::Other(format!("{command} stdin missing")));
        }
    }

    let output =
        wait_with_timeout_streaming(command, child, None, cancellation, &mut on_stdout_chunk)?;

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

fn wait_with_timeout(
    command: &str,
    mut child: std::process::Child,
    timeout: Duration,
    cancellation: Option<ChatCancellation>,
) -> AppResult<Output> {
    let child_id = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stdout missing")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stderr missing")))?;

    let (pipe_tx, pipe_rx) = mpsc::channel();
    spawn_pipe_reader(PipeKind::Stdout, stdout, pipe_tx.clone());
    spawn_pipe_reader(PipeKind::Stderr, stderr, pipe_tx);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_open = true;
    let mut stderr_open = true;

    let started = Instant::now();
    let status = if let Some(cancellation) = cancellation {
        cancellation.set_child(child);
        let status = loop {
            drain_pipe_events(
                command,
                &pipe_rx,
                &mut stdout,
                &mut stderr,
                &mut stdout_open,
                &mut stderr_open,
            )?;
            if cancellation.is_cancelled() {
                terminate_child_process_group(child_id);
                cancellation.kill_and_wait();
                drain_pipe_events_until_closed(
                    command,
                    &pipe_rx,
                    &mut stdout,
                    &mut stderr,
                    &mut stdout_open,
                    &mut stderr_open,
                    PIPE_DRAIN_TIMEOUT,
                )?;
                cancellation.clear_child();
                return Err(AppError::Other(format!("{command} cancelled")));
            }
            match cancellation.try_wait(command)? {
                Some(status) => break status,
                None if started.elapsed() >= timeout => {
                    terminate_child_process_group(child_id);
                    cancellation.kill_and_wait();
                    drain_pipe_events_until_closed(
                        command,
                        &pipe_rx,
                        &mut stdout,
                        &mut stderr,
                        &mut stdout_open,
                        &mut stderr_open,
                        PIPE_DRAIN_TIMEOUT,
                    )?;
                    cancellation.clear_child();
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
            drain_pipe_events(
                command,
                &pipe_rx,
                &mut stdout,
                &mut stderr,
                &mut stdout_open,
                &mut stderr_open,
            )?;
            match child
                .try_wait()
                .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))?
            {
                Some(status) => break status,
                None if started.elapsed() >= timeout => {
                    terminate_child_process_group(child_id);
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
        terminate_child_process_group(child_id);
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

#[cfg(unix)]
fn isolate_child_process_group(command: &mut Command) {
    command.process_group(0);
}

#[cfg(not(unix))]
fn isolate_child_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_child_process_group(child_id: u32) {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    let Ok(raw_child_id) = i32::try_from(child_id) else {
        return;
    };
    let process_group = Pid::from_raw(-raw_child_id);
    let _ = kill(process_group, Signal::SIGTERM);
    thread::sleep(Duration::from_millis(50));
    let _ = kill(process_group, Signal::SIGKILL);
}

#[cfg(not(unix))]
fn terminate_child_process_group(_child_id: u32) {}

#[derive(Clone, Copy)]
enum PipeKind {
    Stdout,
    Stderr,
}

enum PipeEvent {
    Chunk(PipeKind, io::Result<Vec<u8>>),
    Done(PipeKind),
}

fn spawn_pipe_reader<R>(kind: PipeKind, mut reader: R, tx: mpsc::Sender<PipeEvent>)
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
            PipeKind::Stdout => stdout.extend_from_slice(&bytes),
            PipeKind::Stderr => stderr.extend_from_slice(&bytes),
        },
        PipeEvent::Chunk(kind, Err(err)) => {
            let stream = match kind {
                PipeKind::Stdout => "stdout",
                PipeKind::Stderr => "stderr",
            };
            return Err(AppError::Other(format!(
                "failed reading {command} {stream}: {err}"
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

fn process_stdout_chunk<F>(
    command: &str,
    chunk: io::Result<Vec<u8>>,
    stdout: &mut Vec<u8>,
    decoder: &mut Utf8ChunkDecoder,
    on_stdout_chunk: &mut F,
) -> AppResult<()>
where
    F: FnMut(&str),
{
    let chunk =
        chunk.map_err(|e| AppError::Other(format!("failed reading {command} stdout: {e}")))?;
    if chunk.is_empty() {
        return Ok(());
    }
    stdout.extend_from_slice(&chunk);
    let text = decoder.push(&chunk);
    if !text.is_empty() {
        on_stdout_chunk(&text);
    }
    Ok(())
}

fn drain_stdout_chunks<F>(
    command: &str,
    stdout_rx: &Receiver<io::Result<Vec<u8>>>,
    stdout: &mut Vec<u8>,
    decoder: &mut Utf8ChunkDecoder,
    on_stdout_chunk: &mut F,
) -> AppResult<()>
where
    F: FnMut(&str),
{
    loop {
        match stdout_rx.try_recv() {
            Ok(chunk) => process_stdout_chunk(command, chunk, stdout, decoder, on_stdout_chunk)?,
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn wait_with_timeout_streaming<F>(
    command: &str,
    mut child: std::process::Child,
    timeout: Option<Duration>,
    cancellation: Option<ChatCancellation>,
    on_stdout_chunk: &mut F,
) -> AppResult<Output>
where
    F: FnMut(&str),
{
    let child_id = child.id();
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stdout missing")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other(format!("{command} stderr missing")))?;

    let (stdout_tx, stdout_rx) = mpsc::channel();
    let stdout_reader = thread::spawn(move || {
        let mut reader = stdout_pipe;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdout_tx.send(Ok(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = stdout_tx.send(Err(err));
                    break;
                }
            }
        }
    });
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr;
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map(|_| buf)
    });

    let mut stdout = Vec::new();
    let mut decoder = Utf8ChunkDecoder::new();
    let started = Instant::now();
    let status = if let Some(cancellation) = cancellation {
        cancellation.set_child(child);
        let status = loop {
            drain_stdout_chunks(
                command,
                &stdout_rx,
                &mut stdout,
                &mut decoder,
                on_stdout_chunk,
            )?;
            if cancellation.is_cancelled() {
                terminate_child_process_group(child_id);
                cancellation.kill_and_wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                cancellation.clear_child();
                return Err(AppError::Other(format!("{command} cancelled")));
            }
            match cancellation.try_wait(command)? {
                Some(status) => break status,
                None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                    terminate_child_process_group(child_id);
                    cancellation.kill_and_wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    cancellation.clear_child();
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
            drain_stdout_chunks(
                command,
                &stdout_rx,
                &mut stdout,
                &mut decoder,
                on_stdout_chunk,
            )?;
            match child
                .try_wait()
                .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))?
            {
                Some(status) => break status,
                None if timeout.is_some_and(|timeout| started.elapsed() >= timeout) => {
                    terminate_child_process_group(child_id);
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
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

    if !stdout_reader.is_finished() || !stderr_reader.is_finished() {
        terminate_child_process_group(child_id);
    }
    stdout_reader
        .join()
        .map_err(|_| AppError::Other(format!("{command} stdout reader failed")))?;
    drain_stdout_chunks(
        command,
        &stdout_rx,
        &mut stdout,
        &mut decoder,
        on_stdout_chunk,
    )?;
    let trailing = decoder.finish();
    if !trailing.is_empty() {
        on_stdout_chunk(&trailing);
    }
    let stderr = stderr_reader
        .join()
        .map_err(|_| AppError::Other(format!("{command} stderr reader failed")))?
        .map_err(|e| AppError::Other(format!("failed reading {command} stderr: {e}")))?;

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
    fn resolves_known_ai_provider_commands() {
        let req = AiExecutionRequest {
            provider: AiProvider::Codex,
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
    fn resolves_antigravity_prompt_as_print_argument() {
        let req = AiExecutionRequest {
            provider: AiProvider::Antigravity,
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
    fn rejects_custom_ai_commands() {
        let req = AiExecutionRequest {
            provider: AiProvider::Custom,
            ollama_model: None,
            llm_model: None,
        };

        assert!(req.resolve().is_err());
    }

    #[test]
    fn rejects_model_names_that_can_be_interpreted_as_options() {
        let req = AiExecutionRequest {
            provider: AiProvider::Ollama,
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
            |chunk| chunks.push(chunk.to_string()),
        )
        .unwrap();

        assert_eq!(output, "onetwo");
        assert_eq!(chunks.concat(), "onetwo");
        assert!(!chunks.is_empty());
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
            |chunk| chunks.push(chunk.to_string()),
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
