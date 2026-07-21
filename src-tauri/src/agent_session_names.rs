//! Best-effort propagation of Acorn tab titles into provider-native sessions.
//!
//! Acorn remains the source of truth for its own tab title. Provider updates
//! run on one background worker so a slow or unavailable CLI never blocks a
//! rename, and successive renames are applied in the same order Acorn stored
//! them.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use acorn_agent::AgentKind;
use acorn_session::{Session, SessionKind, SessionMode, SessionOwner, SessionTitleSource};
use serde_json::{json, Value};

use crate::agent_resume::LiveTranscript;

const CODEX_RPC_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROVIDER_TITLE_BYTES: usize = 1_024;

struct TitleSyncRequest {
    target: LiveTranscript,
    title: String,
}

enum ReaderEvent {
    Line(String),
    Error(String),
    Eof,
}

/// Queue a provider-native title update without delaying or failing the Acorn
/// operation that produced it. Antigravity has no verified naming interface,
/// so it is intentionally left unchanged.
pub fn enqueue(target: LiveTranscript, title: impl Into<String>) {
    if target.kind == AgentKind::Antigravity {
        return;
    }

    let title = title.into().trim().to_string();
    if title.is_empty() {
        return;
    }
    if title.len() > MAX_PROVIDER_TITLE_BYTES {
        tracing::warn!(
            provider = target.kind.as_str(),
            transcript_id = %target.id,
            title_bytes = title.len(),
            "skipping provider session name sync because the title is too large"
        );
        return;
    }

    let Some(sender) = worker_sender() else {
        return;
    };
    if let Err(err) = sender.send(TitleSyncRequest { target, title }) {
        tracing::warn!(error = %err, "provider session name worker is unavailable");
    }
}

/// Propagate a title that already existed before Acorn discovered the native
/// session id. Manual names apply to the newly-bound conversation; generated
/// names apply only when they were generated from that exact transcript, so a
/// `/new` conversation never inherits the previous conversation's title.
pub fn enqueue_existing_title(session: &Session, target: LiveTranscript) {
    if should_sync_existing_title(session, &target.id) {
        enqueue(target, session.name.clone());
    }
}

fn should_sync_existing_title(session: &Session, transcript_id: &str) -> bool {
    if session.kind != SessionKind::Regular
        || session.mode != SessionMode::Terminal
        || !matches!(session.owner, SessionOwner::User)
    {
        return false;
    }
    match session.title_source {
        SessionTitleSource::Default => false,
        SessionTitleSource::Manual => true,
        SessionTitleSource::Generated => {
            session.generated_title_transcript_id.as_deref() == Some(transcript_id)
        }
    }
}

fn worker_sender() -> Option<&'static mpsc::Sender<TitleSyncRequest>> {
    static WORKER: OnceLock<Option<mpsc::Sender<TitleSyncRequest>>> = OnceLock::new();
    WORKER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel();
            match thread::Builder::new()
                .name("agent-session-name-sync".to_string())
                .spawn(move || worker(receiver))
            {
                Ok(_) => Some(sender),
                Err(err) => {
                    tracing::warn!(error = %err, "failed to start provider session name worker");
                    None
                }
            }
        })
        .as_ref()
}

fn worker(receiver: mpsc::Receiver<TitleSyncRequest>) {
    while let Ok(request) = receiver.recv() {
        if let Err(error) = sync_title(&request.target, &request.title) {
            tracing::warn!(
                provider = request.target.kind.as_str(),
                transcript_id = %request.target.id,
                error = %error,
                "failed to sync Acorn title to provider session"
            );
        }
    }
}

fn sync_title(target: &LiveTranscript, title: &str) -> Result<(), String> {
    let session_id = uuid::Uuid::parse_str(&target.id)
        .map(|id| id.to_string())
        .map_err(|_| "provider session id is not a UUID".to_string())?;

    match target.kind {
        AgentKind::Codex => sync_codex_title(&session_id, title),
        AgentKind::Claude => append_claude_title(&target.path, &session_id, title),
        AgentKind::Antigravity => Ok(()),
    }
}

/// Codex exposes thread naming through its app-server JSONL protocol. A fresh
/// short-lived server is used for each queued update; it writes the shared
/// Codex thread metadata read by the desktop app and then exits.
fn sync_codex_title(thread_id: &str, title: &str) -> Result<(), String> {
    let child = spawn_codex_app_server()?;
    run_codex_name_protocol(child, thread_id, title)
}

fn spawn_codex_app_server() -> Result<Child, String> {
    for attempt in 0..2 {
        let path = crate::cli_resolver::resolve("codex").map_err(|err| err.to_string())?;
        let mut command = Command::new(path);
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        crate::shell_env::apply_to_command(&mut command);

        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound && attempt == 0 => {
                crate::cli_resolver::invalidate("codex");
            }
            Err(err) => return Err(crate::cli_resolver::spawn_error("codex", err).to_string()),
        }
    }
    Err("failed to start Codex app server".to_string())
}

fn run_codex_name_protocol(mut child: Child, thread_id: &str, title: &str) -> Result<(), String> {
    let result = (|| {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app server stdout was not captured".to_string())?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app server stdin was not captured".to_string())?;
        let (event_tx, event_rx) = mpsc::channel();
        thread::Builder::new()
            .name("codex-name-rpc-reader".to_string())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(line) => {
                            if event_tx.send(ReaderEvent::Line(line)).is_err() {
                                return;
                            }
                        }
                        Err(err) => {
                            let _ = event_tx.send(ReaderEvent::Error(err.to_string()));
                            return;
                        }
                    }
                }
                let _ = event_tx.send(ReaderEvent::Eof);
            })
            .map_err(|err| format!("failed to start Codex response reader: {err}"))?;

        write_rpc_line(&mut stdin, &initialize_request())?;
        wait_for_rpc_response(&event_rx, 1, CODEX_RPC_TIMEOUT)?;

        write_rpc_line(&mut stdin, &json!({"method": "initialized", "params": {}}))?;
        write_rpc_line(&mut stdin, &set_name_request(thread_id, title))?;
        wait_for_rpc_response(&event_rx, 2, CODEX_RPC_TIMEOUT)
    })();

    // The protocol scope has closed stdin. Bound the lifetime of app-server
    // versions that keep running after the client disconnects.
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn initialize_request() -> Value {
    json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "acorn",
                "title": "Acorn",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": null
        }
    })
}

fn set_name_request(thread_id: &str, title: &str) -> Value {
    json!({
        "id": 2,
        "method": "thread/name/set",
        "params": {
            "threadId": thread_id,
            "name": title
        }
    })
}

fn write_rpc_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_vec(value)
        .map_err(|err| format!("failed to encode Codex request: {err}"))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .and_then(|_| stdin.flush())
        .map_err(|err| format!("failed to write Codex request: {err}"))
}

fn wait_for_rpc_response(
    receiver: &mpsc::Receiver<ReaderEvent>,
    request_id: u64,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "Codex app server timed out waiting for response {request_id}"
            ));
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
            Ok(ReaderEvent::Line(line)) => {
                if let Some(response) = parse_rpc_response(&line, request_id) {
                    return response;
                }
            }
            Ok(ReaderEvent::Error(error)) => {
                return Err(format!("failed to read Codex response: {error}"));
            }
            Ok(ReaderEvent::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!(
                    "Codex app server exited before response {request_id}"
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "Codex app server timed out waiting for response {request_id}"
                ));
            }
        }
    }
}

fn parse_rpc_response(line: &str, request_id: u64) -> Option<Result<(), String>> {
    let response: Value = serde_json::from_str(line).ok()?;
    if response.get("id").and_then(Value::as_u64) != Some(request_id) {
        return None;
    }
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| error.to_string());
        return Some(Err(format!(
            "Codex app server rejected the request: {message}"
        )));
    }
    Some(Ok(()))
}

/// Claude Code has no external rename command for an already-running session.
/// Its documented `/rename` feature is persisted as an append-only
/// `custom-title` transcript record, so Acorn writes the same record to the
/// already-resolved transcript. Existing conversation entries are never
/// rewritten.
fn append_claude_title(path: &Path, session_id: &str, title: &str) -> Result<(), String> {
    let expected_name = format!("{session_id}.jsonl");
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err("Claude transcript filename does not match its session id".to_string());
    }

    let path_metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("failed to inspect Claude transcript: {err}"))?;
    if !path_metadata.file_type().is_file() {
        return Err("Claude transcript path is not a regular file".to_string());
    }

    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("failed to open Claude transcript: {err}"))?;
    let opened_metadata = file
        .metadata()
        .map_err(|err| format!("failed to inspect opened Claude transcript: {err}"))?;
    if !opened_metadata.is_file() {
        return Err("opened Claude transcript is not a regular file".to_string());
    }
    #[cfg(unix)]
    if path_metadata.dev() != opened_metadata.dev() || path_metadata.ino() != opened_metadata.ino()
    {
        return Err("Claude transcript changed while it was being opened".to_string());
    }

    let needs_separator = if opened_metadata.len() == 0 {
        false
    } else {
        file.seek(SeekFrom::End(-1))
            .and_then(|_| {
                let mut byte = [0_u8; 1];
                file.read_exact(&mut byte).map(|_| byte[0] != b'\n')
            })
            .map_err(|err| format!("failed to inspect Claude transcript ending: {err}"))?
    };

    let mut record = Vec::new();
    if needs_separator {
        record.push(b'\n');
    }
    record.extend(
        serde_json::to_vec(&json!({
            "type": "custom-title",
            "customTitle": title,
            "sessionId": session_id
        }))
        .map_err(|err| format!("failed to encode Claude title record: {err}"))?,
    );
    record.push(b'\n');
    file.write_all(&record)
        .map_err(|err| format!("failed to append Claude title record: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn claude_target(path: &Path, id: &str) -> LiveTranscript {
        LiveTranscript {
            id: id.to_string(),
            path: path.to_path_buf(),
            kind: AgentKind::Claude,
        }
    }

    fn titled_session(source: SessionTitleSource) -> Session {
        let mut session = Session::new(
            "release fix".to_string(),
            PathBuf::from("/tmp/acorn"),
            PathBuf::from("/tmp/acorn"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.title_source = source;
        session
    }

    #[test]
    fn existing_manual_title_syncs_when_provider_binding_appears() {
        let session = titled_session(SessionTitleSource::Manual);

        assert!(should_sync_existing_title(
            &session,
            "019c1464-9f4e-7302-bc0f-81a1449fc365"
        ));
    }

    #[test]
    fn existing_generated_title_only_syncs_to_its_source_transcript() {
        let mut session = titled_session(SessionTitleSource::Generated);
        session.generated_title_transcript_id =
            Some("019c1464-9f4e-7302-bc0f-81a1449fc365".to_string());

        assert!(should_sync_existing_title(
            &session,
            "019c1464-9f4e-7302-bc0f-81a1449fc365"
        ));
        assert!(!should_sync_existing_title(
            &session,
            "019c1464-9f4e-7302-bc0f-81a1449fc366"
        ));
    }

    #[test]
    fn default_and_chat_titles_do_not_sync_on_provider_binding() {
        let default_session = titled_session(SessionTitleSource::Default);
        let mut chat_session = titled_session(SessionTitleSource::Manual);
        chat_session.mode = SessionMode::Chat;

        assert!(!should_sync_existing_title(
            &default_session,
            "019c1464-9f4e-7302-bc0f-81a1449fc365"
        ));
        assert!(!should_sync_existing_title(
            &chat_session,
            "019c1464-9f4e-7302-bc0f-81a1449fc365"
        ));
    }

    #[test]
    fn codex_set_name_request_uses_thread_name_rpc() {
        let request = set_name_request("019c1464-9f4e-7302-bc0f-81a1449fc365", "release fix");

        assert_eq!(request["method"], "thread/name/set");
        assert_eq!(
            request["params"]["threadId"],
            "019c1464-9f4e-7302-bc0f-81a1449fc365"
        );
        assert_eq!(request["params"]["name"], "release fix");
    }

    #[test]
    fn rpc_response_parser_ignores_notifications_and_reports_errors() {
        assert!(parse_rpc_response(r#"{"method":"thread/started","params":{}}"#, 2).is_none());
        assert!(parse_rpc_response(r#"{"id":2,"result":{}}"#, 2)
            .expect("matching response")
            .is_ok());
        let error = parse_rpc_response(
            r#"{"id":2,"error":{"code":-32600,"message":"no rollout found"}}"#,
            2,
        )
        .expect("matching response")
        .expect_err("server error");
        assert!(error.contains("no rollout found"));
    }

    #[test]
    fn claude_title_is_appended_without_rewriting_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let id = "019c1464-9f4e-7302-bc0f-81a1449fc365";
        let path = dir.path().join(format!("{id}.jsonl"));
        fs::write(&path, b"{\"type\":\"user\",\"message\":\"keep me\"}\n").unwrap();

        sync_title(&claude_target(&path, id), "fix \"quoted\" title").unwrap();

        let lines = fs::read_to_string(&path).unwrap();
        let mut lines = lines.lines();
        assert_eq!(lines.next(), Some(r#"{"type":"user","message":"keep me"}"#));
        let title: Value = serde_json::from_str(lines.next().expect("title record")).unwrap();
        assert_eq!(title["type"], "custom-title");
        assert_eq!(title["customTitle"], "fix \"quoted\" title");
        assert_eq!(title["sessionId"], id);
        assert!(lines.next().is_none());
    }

    #[test]
    fn claude_title_rejects_a_mismatched_transcript_filename() {
        let dir = tempfile::tempdir().unwrap();
        let id = "019c1464-9f4e-7302-bc0f-81a1449fc365";
        let path = dir.path().join("different.jsonl");
        fs::write(&path, b"{}\n").unwrap();

        let error = sync_title(&claude_target(&path, id), "title").unwrap_err();

        assert!(error.contains("filename"));
        assert_eq!(fs::read_to_string(path).unwrap(), "{}\n");
    }

    #[test]
    fn claude_title_separates_a_transcript_missing_its_final_newline() {
        let dir = tempfile::tempdir().unwrap();
        let id = "019c1464-9f4e-7302-bc0f-81a1449fc365";
        let path = dir.path().join(format!("{id}.jsonl"));
        fs::write(&path, b"{\"type\":\"user\"}").unwrap();

        sync_title(&claude_target(&path, id), "title").unwrap();

        let lines = fs::read_to_string(path).unwrap();
        assert_eq!(lines.lines().count(), 2);
        assert!(lines.starts_with("{\"type\":\"user\"}\n"));
        assert!(lines.ends_with('\n'));
    }

    #[cfg(unix)]
    #[test]
    fn claude_title_rejects_symlink_transcripts() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let id = "019c1464-9f4e-7302-bc0f-81a1449fc365";
        let target = dir.path().join("target.jsonl");
        let path = dir.path().join(format!("{id}.jsonl"));
        fs::write(&target, b"{}\n").unwrap();
        symlink(&target, &path).unwrap();

        let error = sync_title(&claude_target(&path, id), "title").unwrap_err();

        assert!(error.contains("regular file"));
        assert_eq!(fs::read_to_string(target).unwrap(), "{}\n");
    }
}
