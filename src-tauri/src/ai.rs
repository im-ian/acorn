use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::cli_resolver;
use crate::error::{AppError, AppResult};

const ONESHOT_TIMEOUT: Duration = Duration::from_secs(60);

pub fn run_oneshot(
    command: &str,
    args: &[String],
    prompt: &str,
    settings_label: &str,
) -> AppResult<String> {
    let resolved = cli_resolver::resolve(command).map_err(|_| {
        AppError::Other(format!(
            "`{command}` not found. Install the configured AI CLI or change the provider in {settings_label}."
        ))
    })?;
    let mut child = Command::new(&resolved)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
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

    let output = wait_with_timeout(command, child, ONESHOT_TIMEOUT)?;

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
    let status = loop {
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
