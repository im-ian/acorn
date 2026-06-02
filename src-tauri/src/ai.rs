use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::chat_runs::ChatCancellation;
use crate::cli_resolver;
use crate::error::{AppError, AppResult};

const ONESHOT_TIMEOUT: Duration = Duration::from_secs(60);

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAiCommand {
    pub command: &'static str,
    pub args: Vec<String>,
}

impl AiExecutionRequest {
    pub fn resolve(&self) -> AppResult<ResolvedAiCommand> {
        match self.provider {
            AiProvider::Claude => Ok(ResolvedAiCommand {
                command: "claude",
                args: vec!["-p".into(), "--output-format".into(), "text".into()],
            }),
            AiProvider::Antigravity => Ok(ResolvedAiCommand {
                command: "agy",
                args: vec!["-p".into()],
            }),
            AiProvider::Codex => Ok(ResolvedAiCommand {
                command: "codex",
                args: vec!["exec".into()],
            }),
            AiProvider::Ollama => {
                let model = normalize_model_arg(self.ollama_model.as_deref(), "llama3")?;
                Ok(ResolvedAiCommand {
                    command: "ollama",
                    args: vec!["run".into(), model],
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

pub fn run_oneshot(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
) -> AppResult<String> {
    run_oneshot_in_dir(command, args, prompt, settings_label, None)
}

pub fn run_oneshot_in_dir(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
) -> AppResult<String> {
    run_oneshot_in_dir_cancellable(command, args, prompt, settings_label, cwd, None)
}

pub fn run_oneshot_in_dir_cancellable(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
    cwd: Option<&Path>,
    cancellation: Option<ChatCancellation>,
) -> AppResult<String> {
    let resolved = cli_resolver::resolve(command).map_err(|_| {
        AppError::Other(format!(
            "`{command}` not found. Install the configured AI CLI or change the provider in {settings_label}."
        ))
    })?;
    let mut command_builder = Command::new(&resolved);
    command_builder
        .args(args)
        .stdin(Stdio::piped())
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

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|e| AppError::Other(format!("failed to write to {command}: {e}")))?;
    } else {
        return Err(AppError::Other(format!("{command} stdin missing")));
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

fn wait_with_timeout(
    command: &str,
    mut child: std::process::Child,
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

    let stdout_reader = thread::spawn(move || {
        let mut reader = stdout;
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map(|_| buf)
    });
    let stderr_reader = thread::spawn(move || {
        let mut reader = stderr;
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map(|_| buf)
    });

    let started = Instant::now();
    let status = if let Some(cancellation) = cancellation {
        cancellation.set_child(child);
        let status = loop {
            if cancellation.is_cancelled() {
                cancellation.kill_and_wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                cancellation.clear_child();
                return Err(AppError::Other(format!("{command} cancelled")));
            }
            match cancellation.try_wait(command)? {
                Some(status) => break status,
                None if started.elapsed() >= timeout => {
                    cancellation.kill_and_wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
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
            match child
                .try_wait()
                .map_err(|e| AppError::Other(format!("failed waiting for {command}: {e}")))?
            {
                Some(status) => break status,
                None if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(AppError::Other(format!(
                        "{command} timed out after {} seconds",
                        timeout.as_secs()
                    )));
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| AppError::Other(format!("{command} stdout reader failed")))?
        .map_err(|e| AppError::Other(format!("failed reading {command} stdout: {e}")))?;
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
                args: vec!["exec".to_string()],
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
        let output = run_oneshot_in_dir("pwd", &[], "", "test settings", Some(dir.path())).unwrap();
        let observed = std::path::PathBuf::from(output.trim())
            .canonicalize()
            .unwrap();
        let expected = dir.path().canonicalize().unwrap();

        assert_eq!(observed, expected);
    }
}
