use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use acorn_session::{Project, Session, SessionStore};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

const SESSIONS_FILE: &str = "sessions.json";
const SESSIONS_TMP_FILE: &str = "sessions.json.tmp";
const PROJECTS_FILE: &str = "projects.json";
const PROJECTS_TMP_FILE: &str = "projects.json.tmp";
const CHAT_SESSIONS_DIR: &str = "chat-sessions";
pub const CHAT_SESSION_SCHEMA_VERSION: u32 = 1;
static SESSION_SAVE_LOCK: Mutex<()> = Mutex::new(());

fn lock_session_save() -> MutexGuard<'static, ()> {
    SESSION_SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn utc_now() -> DateTime<Utc> {
    Utc::now()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatSessionState {
    pub schema_version: u32,
    pub session_id: String,
    #[serde(default)]
    pub session: ChatSession,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub turns: Vec<ChatTurn>,
    #[serde(default)]
    pub provider_threads: Vec<ProviderThread>,
    #[serde(default)]
    pub context_snapshots: Vec<ContextSnapshot>,
    #[serde(default)]
    pub memory: SessionMemory,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ChatSessionState {
    fn empty(session_id: Uuid) -> Self {
        let now = Utc::now();
        Self {
            schema_version: CHAT_SESSION_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            session: ChatSession {
                id: session_id.to_string(),
                workspace_path: None,
                title: None,
                active_provider: None,
                active_model: None,
                created_at: now,
                updated_at: now,
            },
            provider: None,
            model: None,
            messages: Vec::new(),
            turns: Vec::new(),
            provider_threads: Vec::new(),
            context_snapshots: Vec::new(),
            memory: SessionMemory {
                session_id: session_id.to_string(),
                summary: None,
                important_decisions: Vec::new(),
                facts: Vec::new(),
                through_message_id: None,
                updated_at: now,
            },
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_model: Option<String>,
    #[serde(default = "utc_now")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "utc_now")]
    pub updated_at: DateTime<Utc>,
}

impl Default for ChatSession {
    fn default() -> Self {
        let now = Utc::now();
        Self {
            id: String::new(),
            workspace_path: None,
            title: None,
            active_provider: None,
            active_model: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub role: ChatRole,
    pub content: String,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ChatMessageStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatMessageStatus {
    Pending,
    Streaming,
    Complete,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatTurn {
    pub id: String,
    pub session_id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub status: ChatTurnStatus,
    pub user_message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_message_id: Option<String>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatTurnStatus {
    Pending,
    Running,
    Complete,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderThread {
    pub session_id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response_id: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextSnapshot {
    pub turn_id: String,
    pub session_id: String,
    pub provider: String,
    pub mode: ContextSnapshotMode,
    #[serde(default)]
    pub included_message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_id: Option<String>,
    pub prompt_or_payload: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextSnapshotMode {
    NativeThread,
    CompiledContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionMemory {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub important_decisions: Vec<String>,
    #[serde(default)]
    pub facts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through_message_id: Option<String>,
    #[serde(default = "utc_now")]
    pub updated_at: DateTime<Utc>,
}

impl Default for SessionMemory {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            summary: None,
            important_decisions: Vec::new(),
            facts: Vec::new(),
            through_message_id: None,
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatMessagePatch {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub status: Option<ChatMessageStatus>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

/// Side-channel a corrupt persistence file before we mask it with an empty
/// in-memory store. Without this the only evidence of a parse failure is a
/// log line that scrolls away. The backup name embeds a unix timestamp so
/// repeated boots do not overwrite earlier evidence.
fn backup_corrupt_file(path: &Path) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let mut name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("data.json")
        .to_string();
    name.push_str(&format!(".broken-{ts}"));
    let backup = path.with_file_name(name);
    if let Err(err) = fs::copy(path, &backup) {
        tracing::warn!(
            error = %err,
            path = %path.display(),
            "failed to back up corrupt persistence file"
        );
    } else {
        tracing::warn!(
            backup = %backup.display(),
            "backed up corrupt persistence file"
        );
    }
}

fn copy_legacy_file_if_missing(
    legacy_base: &Path,
    profile_dir: &Path,
    file_name: &str,
) -> std::io::Result<()> {
    let source = legacy_base.join(file_name);
    let target = profile_dir.join(file_name);
    if target.exists() || !source.is_file() {
        return Ok(());
    }
    fs::copy(source, target)?;
    Ok(())
}

fn data_dir_override_is_set() -> bool {
    std::env::var(acorn_paths::ENV_DATA_DIR_OVERRIDE)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

fn should_migrate_legacy_prod_files() -> AppResult<bool> {
    if data_dir_override_is_set() {
        return Ok(false);
    }
    Ok(acorn_paths::effective_profile()? == acorn_paths::PROD_PROFILE)
}

fn migrate_legacy_prod_files(profile_dir: &Path) -> AppResult<()> {
    if !should_migrate_legacy_prod_files()? {
        return Ok(());
    }
    let legacy_base = acorn_paths::base_data_dir()?;
    if legacy_base == profile_dir {
        return Ok(());
    }
    copy_legacy_file_if_missing(&legacy_base, profile_dir, SESSIONS_FILE)?;
    copy_legacy_file_if_missing(&legacy_base, profile_dir, PROJECTS_FILE)?;
    Ok(())
}

/// Resolve the application's data directory, creating it if missing.
///
/// Runtime state lives under the stable `io.im-ian.acorn` app dir, split by
/// `ACORN_PROFILE` or by the build default (`dev` for debug, `prod` for
/// release). `ACORN_DATA_DIR` can still redirect the whole tree for tests.
pub fn data_dir() -> AppResult<PathBuf> {
    let dir = acorn_paths::data_dir()?;
    migrate_legacy_prod_files(&dir)?;
    Ok(dir)
}

fn sessions_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(SESSIONS_FILE))
}

fn sessions_tmp_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(SESSIONS_TMP_FILE))
}

/// Load sessions from disk. Returns an empty Vec on any recoverable failure
/// (missing file, IO error, parse error) — these are logged but not propagated.
/// Boot uses `load_sessions_with_status` instead so it can branch on cleanliness;
/// this thin wrapper exists for tests and external callers that do not care.
#[allow(dead_code)]
pub fn load_sessions() -> AppResult<Vec<Session>> {
    Ok(load_sessions_with_status()?.0)
}

/// Same as `load_sessions` but also reports whether the load was clean.
/// `clean = false` means the file existed but could not be read or parsed —
/// a signal that downstream wipe-on-empty paths (scrollback prune, frontend
/// pane reconciliation) should hold off rather than treat the empty result
/// as authoritative. A missing file is considered clean (legitimate empty).
pub fn load_sessions_with_status() -> AppResult<(Vec<Session>, bool)> {
    let path = sessions_path()?;
    if !path.exists() {
        tracing::info!(path = %path.display(), "sessions file missing, starting empty");
        return Ok((Vec::new(), true));
    }

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read sessions file");
            return Ok((Vec::new(), false));
        }
    };

    match serde_json::from_slice::<Vec<Session>>(&bytes) {
        Ok(sessions) => {
            tracing::info!(count = sessions.len(), "loaded sessions from disk");
            Ok((sessions, true))
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse sessions file");
            backup_corrupt_file(&path);
            Ok((Vec::new(), false))
        }
    }
}

/// Persist the latest session-store snapshot atomically. The process-wide gate
/// is acquired before taking the snapshot and held through rename, so delayed
/// save requests re-read current state instead of overwriting a newer lifecycle
/// claim with a stale caller-owned vector. It also protects the shared temp
/// path from concurrent in-process writers.
pub fn save_sessions(sessions: &SessionStore) -> AppResult<()> {
    let final_path = sessions_path()?;
    let tmp_path = sessions_tmp_path()?;
    save_session_store_to_paths(sessions, &final_path, &tmp_path)
}

fn save_session_store_to_paths(
    sessions: &SessionStore,
    final_path: &Path,
    tmp_path: &Path,
) -> AppResult<()> {
    let _save_guard = lock_session_save();
    let sessions = sessions.list();
    let payload = serde_json::to_vec_pretty(&sessions)
        .map_err(|err| AppError::Other(format!("failed to serialize sessions: {err}")))?;

    fs::write(tmp_path, &payload)?;
    fs::rename(tmp_path, final_path)?;
    tracing::info!(
        count = sessions.len(),
        path = %final_path.display(),
        "saved sessions to disk"
    );
    Ok(())
}

fn projects_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(PROJECTS_FILE))
}

fn projects_tmp_path() -> AppResult<PathBuf> {
    Ok(data_dir()?.join(PROJECTS_TMP_FILE))
}

#[allow(dead_code)]
pub fn load_projects() -> AppResult<Vec<Project>> {
    Ok(load_projects_with_status()?.0)
}

pub fn load_projects_with_status() -> AppResult<(Vec<Project>, bool)> {
    let path = projects_path()?;
    if !path.exists() {
        tracing::info!(path = %path.display(), "projects file missing, starting empty");
        return Ok((Vec::new(), true));
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to read projects file");
            return Ok((Vec::new(), false));
        }
    };
    match serde_json::from_slice::<Vec<Project>>(&bytes) {
        Ok(projects) => {
            tracing::info!(count = projects.len(), "loaded projects from disk");
            Ok((projects, true))
        }
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "failed to parse projects file");
            backup_corrupt_file(&path);
            Ok((Vec::new(), false))
        }
    }
}

pub fn save_projects(projects: &[Project]) -> AppResult<()> {
    let final_path = projects_path()?;
    let tmp_path = projects_tmp_path()?;
    let payload = serde_json::to_vec_pretty(projects)
        .map_err(|err| AppError::Other(format!("failed to serialize projects: {err}")))?;
    fs::write(&tmp_path, &payload)?;
    fs::rename(&tmp_path, &final_path)?;
    tracing::info!(
        count = projects.len(),
        path = %final_path.display(),
        "saved projects to disk"
    );
    Ok(())
}

fn parse_chat_session_id(session_id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(session_id)
        .map_err(|_| AppError::Other(format!("invalid session id: {session_id}")))
}

fn validate_chat_message(message: &ChatMessage) -> AppResult<()> {
    if message.id.trim().is_empty() {
        return Err(AppError::Other(
            "chat message id must not be empty".to_string(),
        ));
    }
    Ok(())
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

fn validate_chat_session_state(mut state: ChatSessionState) -> AppResult<(Uuid, ChatSessionState)> {
    if state.schema_version != CHAT_SESSION_SCHEMA_VERSION {
        return Err(AppError::Other(format!(
            "unsupported chat session schema_version: {}",
            state.schema_version
        )));
    }
    let session_id = parse_chat_session_id(&state.session_id)?;
    state.session_id = session_id.to_string();
    if state.session.id.trim().is_empty() {
        state.session.id = session_id.to_string();
    }
    if state.session.id != session_id.to_string() {
        return Err(AppError::Other(format!(
            "chat session metadata id mismatch: expected {session_id}, got {}",
            state.session.id
        )));
    }
    state.provider = normalize_optional_string(state.provider);
    state.model = normalize_optional_string(state.model);
    if state.session.active_provider.is_none() {
        state.session.active_provider = state.provider.clone();
    }
    if state.session.active_model.is_none() {
        state.session.active_model = state.model.clone();
    }
    if state.provider.is_none() {
        state.provider = state.session.active_provider.clone();
    }
    if state.model.is_none() {
        state.model = state.session.active_model.clone();
    }
    state.session.active_provider = normalize_optional_string(state.session.active_provider);
    state.session.active_model = normalize_optional_string(state.session.active_model);
    state.session.workspace_path = normalize_optional_string(state.session.workspace_path);
    state.session.title = normalize_optional_string(state.session.title);
    state.session.updated_at = state.updated_at;

    for message in &mut state.messages {
        validate_chat_message(message)?;
        match message.session_id.as_deref().map(str::trim) {
            Some(existing) if !existing.is_empty() && existing != session_id.to_string() => {
                return Err(AppError::Other(format!(
                    "chat message session id mismatch: expected {session_id}, got {existing}"
                )));
            }
            _ => message.session_id = Some(session_id.to_string()),
        }
        message.turn_id = normalize_optional_string(message.turn_id.take());
    }
    for turn in &mut state.turns {
        if turn.id.trim().is_empty() {
            return Err(AppError::Other(
                "chat turn id must not be empty".to_string(),
            ));
        }
        if turn.session_id.trim().is_empty() {
            turn.session_id = session_id.to_string();
        }
        if turn.session_id != session_id.to_string() {
            return Err(AppError::Other(format!(
                "chat turn session id mismatch: expected {session_id}, got {}",
                turn.session_id
            )));
        }
        turn.provider = turn.provider.trim().to_string();
        if turn.provider.is_empty() {
            return Err(AppError::Other(
                "chat turn provider must not be empty".to_string(),
            ));
        }
        turn.model = normalize_optional_string(turn.model.take());
        turn.assistant_message_id = normalize_optional_string(turn.assistant_message_id.take());
        turn.error = normalize_optional_string(turn.error.take());
    }
    for thread in &mut state.provider_threads {
        if thread.session_id.trim().is_empty() {
            thread.session_id = session_id.to_string();
        }
        if thread.session_id != session_id.to_string() {
            return Err(AppError::Other(format!(
                "provider thread session id mismatch: expected {session_id}, got {}",
                thread.session_id
            )));
        }
        thread.provider = thread.provider.trim().to_string();
        if thread.provider.is_empty() {
            return Err(AppError::Other(
                "provider thread provider must not be empty".to_string(),
            ));
        }
        thread.model = normalize_optional_string(thread.model.take());
        thread.native_thread_id = normalize_optional_string(thread.native_thread_id.take());
        thread.resume_token = normalize_optional_string(thread.resume_token.take());
        thread.last_response_id = normalize_optional_string(thread.last_response_id.take());
    }
    for snapshot in &mut state.context_snapshots {
        if snapshot.turn_id.trim().is_empty() {
            return Err(AppError::Other(
                "context snapshot turn id must not be empty".to_string(),
            ));
        }
        if snapshot.session_id.trim().is_empty() {
            snapshot.session_id = session_id.to_string();
        }
        if snapshot.session_id != session_id.to_string() {
            return Err(AppError::Other(format!(
                "context snapshot session id mismatch: expected {session_id}, got {}",
                snapshot.session_id
            )));
        }
        snapshot.provider = snapshot.provider.trim().to_string();
        if snapshot.provider.is_empty() {
            return Err(AppError::Other(
                "context snapshot provider must not be empty".to_string(),
            ));
        }
        snapshot.summary_id = normalize_optional_string(snapshot.summary_id.take());
    }
    if state.memory.session_id.trim().is_empty() {
        state.memory.session_id = session_id.to_string();
    }
    if state.memory.session_id != session_id.to_string() {
        return Err(AppError::Other(format!(
            "session memory id mismatch: expected {session_id}, got {}",
            state.memory.session_id
        )));
    }
    Ok((session_id, state))
}

fn chat_sessions_dir_for_data_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(CHAT_SESSIONS_DIR)
}

fn chat_session_path_for_data_dir(base_dir: &Path, session_id: &Uuid) -> PathBuf {
    chat_sessions_dir_for_data_dir(base_dir).join(format!("{session_id}.json"))
}

pub fn load_chat_session_state(session_id: &str) -> AppResult<ChatSessionState> {
    load_chat_session_state_from_dir(&data_dir()?, session_id)
}

fn load_chat_session_state_from_dir(
    base_dir: &Path,
    session_id: &str,
) -> AppResult<ChatSessionState> {
    let session_id = parse_chat_session_id(session_id)?;
    let path = chat_session_path_for_data_dir(base_dir, &session_id);
    if !path.exists() {
        return Ok(ChatSessionState::empty(session_id));
    }

    let bytes = fs::read(&path)?;
    let state = serde_json::from_slice::<ChatSessionState>(&bytes).map_err(|err| {
        backup_corrupt_file(&path);
        AppError::Other(format!("failed to parse chat session state: {err}"))
    })?;
    let (stored_session_id, state) = validate_chat_session_state(state)?;
    if stored_session_id != session_id {
        return Err(AppError::Other(format!(
            "chat session id mismatch: expected {session_id}, got {stored_session_id}"
        )));
    }
    Ok(state)
}

pub fn save_chat_session_state(state: ChatSessionState) -> AppResult<ChatSessionState> {
    save_chat_session_state_to_dir(&data_dir()?, state)
}

fn save_chat_session_state_to_dir(
    base_dir: &Path,
    state: ChatSessionState,
) -> AppResult<ChatSessionState> {
    let (session_id, state) = validate_chat_session_state(state)?;
    let dir = chat_sessions_dir_for_data_dir(base_dir);
    fs::create_dir_all(&dir)?;
    let final_path = chat_session_path_for_data_dir(base_dir, &session_id);
    let tmp_path = final_path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(&state)
        .map_err(|err| AppError::Other(format!("failed to serialize chat session: {err}")))?;
    fs::write(&tmp_path, payload)?;
    fs::rename(&tmp_path, &final_path)?;
    tracing::info!(
        session_id = %session_id,
        path = %final_path.display(),
        "saved chat session state"
    );
    Ok(state)
}

pub fn append_chat_message(session_id: &str, message: ChatMessage) -> AppResult<ChatSessionState> {
    append_chat_message_in_dir(&data_dir()?, session_id, message)
}

fn append_chat_message_in_dir(
    base_dir: &Path,
    session_id: &str,
    message: ChatMessage,
) -> AppResult<ChatSessionState> {
    validate_chat_message(&message)?;
    let mut state = load_chat_session_state_from_dir(base_dir, session_id)?;
    state.messages.push(message);
    state.updated_at = Utc::now();
    save_chat_session_state_to_dir(base_dir, state)
}

pub fn update_chat_message(
    session_id: &str,
    message_id: &str,
    patch: ChatMessagePatch,
) -> AppResult<ChatSessionState> {
    update_chat_message_in_dir(&data_dir()?, session_id, message_id, patch)
}

fn update_chat_message_in_dir(
    base_dir: &Path,
    session_id: &str,
    message_id: &str,
    patch: ChatMessagePatch,
) -> AppResult<ChatSessionState> {
    if message_id.trim().is_empty() {
        return Err(AppError::Other(
            "chat message id must not be empty".to_string(),
        ));
    }
    let mut state = load_chat_session_state_from_dir(base_dir, session_id)?;
    let message = state
        .messages
        .iter_mut()
        .find(|message| message.id == message_id)
        .ok_or_else(|| AppError::Other(format!("chat message not found: {message_id}")))?;
    if let Some(content) = patch.content {
        message.content = content;
    }
    if let Some(status) = patch.status {
        message.status = Some(status);
    }
    if let Some(metadata) = patch.metadata {
        message.metadata = Some(metadata);
    }
    state.updated_at = Utc::now();
    save_chat_session_state_to_dir(base_dir, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Barrier, Mutex};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn persistence_test_session(name: &str) -> Session {
        Session::new(
            name.to_string(),
            "/tmp/acorn-persistence-test".into(),
            "/tmp/acorn-persistence-test".into(),
            "main".to_string(),
            false,
            acorn_session::SessionKind::Regular,
        )
    }

    #[test]
    fn concurrent_session_store_saves_leave_a_complete_parseable_snapshot() {
        let dir = tempfile::tempdir().expect("temp dir");
        let final_path = Arc::new(dir.path().join(SESSIONS_FILE));
        let tmp_path = Arc::new(dir.path().join(SESSIONS_TMP_FILE));
        let store = acorn_session::SessionStore::new();
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();

        for index in 0..8 {
            let final_path = final_path.clone();
            let tmp_path = tmp_path.clone();
            let store = store.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                store.insert(persistence_test_session(&format!("session-{index}")));
                save_session_store_to_paths(&store, &final_path, &tmp_path)
            }));
        }

        for worker in workers {
            worker
                .join()
                .expect("save worker did not panic")
                .expect("concurrent save succeeds");
        }

        let saved: Vec<Session> = serde_json::from_slice(
            &fs::read(final_path.as_ref()).expect("saved sessions file exists"),
        )
        .expect("saved sessions parse");
        assert_eq!(saved.len(), 8);
        assert!(!tmp_path.exists());
    }

    #[test]
    fn delayed_session_save_resnapshots_a_newer_native_claim() {
        let dir = tempfile::tempdir().expect("temp dir");
        let final_path = dir.path().join(SESSIONS_FILE);
        let tmp_path = dir.path().join(SESSIONS_TMP_FILE);
        let store = acorn_session::SessionStore::new();
        let session = store.insert(persistence_test_session("native-claim"));
        let save_gate = lock_session_save();
        let (started_tx, started_rx) = mpsc::channel();
        let save_store = store.clone();
        let save_final_path = final_path.clone();
        let save_tmp_path = tmp_path.clone();
        let delayed_save = std::thread::spawn(move || {
            started_tx.send(()).expect("signal delayed save");
            save_session_store_to_paths(&save_store, &save_final_path, &save_tmp_path)
        });
        started_rx.recv().expect("delayed save started");

        store
            .apply_native_status(
                &session.id,
                acorn_session::SessionAgentProvider::Codex,
                acorn_session::SessionStatus::Working,
            )
            .expect("native claim applies");
        drop(save_gate);
        delayed_save
            .join()
            .expect("delayed save did not panic")
            .expect("delayed save succeeds");

        let saved: Vec<Session> =
            serde_json::from_slice(&fs::read(final_path).expect("saved sessions file exists"))
                .expect("saved sessions parse");
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].status, acorn_session::SessionStatus::Working);
        assert!(saved[0].hook_active);
        assert_eq!(
            saved[0].hook_provider,
            Some(acorn_session::SessionAgentProvider::Codex)
        );
    }

    #[test]
    fn cleared_hook_ownership_survives_save_and_reload() {
        let dir = tempfile::tempdir().expect("temp dir");
        let final_path = dir.path().join(SESSIONS_FILE);
        let tmp_path = dir.path().join(SESSIONS_TMP_FILE);
        let store = acorn_session::SessionStore::new();
        let session = store.insert(persistence_test_session("cleared-owner"));
        store
            .apply_native_status(
                &session.id,
                acorn_session::SessionAgentProvider::Claude,
                acorn_session::SessionStatus::WaitingForInput,
            )
            .expect("native claim applies");
        let (_, _, hook_revision, lifecycle_revision) = store
            .lifecycle_snapshot(&session.id)
            .expect("session exists");
        assert!(store
            .clear_hook_ownership_if_revision(&session.id, hook_revision, lifecycle_revision,)
            .expect("ownership clear applies"));

        save_session_store_to_paths(&store, &final_path, &tmp_path)
            .expect("cleared ownership saves");
        let saved: Vec<Session> =
            serde_json::from_slice(&fs::read(final_path).expect("saved sessions file exists"))
                .expect("saved sessions parse");

        assert_eq!(saved.len(), 1);
        assert!(!saved[0].hook_active);
        assert_eq!(saved[0].hook_provider, None);
    }

    #[test]
    fn data_dir_is_resolvable() {
        let dir = data_dir().expect("data dir resolves");
        assert!(dir.exists(), "data dir should be created");
    }

    #[test]
    fn load_sessions_returns_empty_when_missing() {
        let sessions = load_sessions().expect("load should not error on missing file");
        // Cannot assert empty without test isolation — at least confirm it returns.
        let _ = sessions;
    }

    #[test]
    fn backup_corrupt_file_writes_sibling_with_broken_suffix() {
        let tmp = std::env::temp_dir().join(format!(
            "acorn-persist-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("sessions.json");
        fs::write(&path, b"not json").unwrap();
        backup_corrupt_file(&path);
        let entries: Vec<_> = fs::read_dir(&tmp)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            entries
                .iter()
                .any(|n| n.starts_with("sessions.json.broken-")),
            "expected a sessions.json.broken-* file, got {entries:?}"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copies_legacy_persistence_file_only_when_profile_missing() {
        let tmp = std::env::temp_dir().join(format!(
            "acorn-persist-migrate-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let legacy = tmp.join("legacy");
        let profile = tmp.join("profile");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&profile).unwrap();

        fs::write(legacy.join(SESSIONS_FILE), b"legacy").unwrap();
        copy_legacy_file_if_missing(&legacy, &profile, SESSIONS_FILE).unwrap();
        assert_eq!(fs::read(profile.join(SESSIONS_FILE)).unwrap(), b"legacy");

        fs::write(legacy.join(PROJECTS_FILE), b"legacy-projects").unwrap();
        fs::write(profile.join(PROJECTS_FILE), b"profile-projects").unwrap();
        copy_legacy_file_if_missing(&legacy, &profile, PROJECTS_FILE).unwrap();
        assert_eq!(
            fs::read(profile.join(PROJECTS_FILE)).unwrap(),
            b"profile-projects"
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn legacy_migration_skips_explicit_data_dir_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        unsafe {
            std::env::set_var(
                acorn_paths::ENV_DATA_DIR_OVERRIDE,
                "/tmp/acorn-explicit-data-dir",
            );
            std::env::remove_var(acorn_paths::ENV_PROFILE);
        }

        assert!(!should_migrate_legacy_prod_files().unwrap());

        unsafe { std::env::remove_var(acorn_paths::ENV_DATA_DIR_OVERRIDE) };
    }

    #[test]
    fn remembered_project_parent_folder_round_trips_and_clears() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("projects");

        save_last_project_parent_folder_to_dir(tmp.path(), &parent).unwrap();
        assert_eq!(
            load_last_project_parent_folder_from_dir(tmp.path()).unwrap(),
            Some(parent)
        );

        clear_last_project_parent_folder_from_dir(tmp.path()).unwrap();
        assert_eq!(
            load_last_project_parent_folder_from_dir(tmp.path()).unwrap(),
            None
        );
    }

    #[test]
    fn missing_chat_state_returns_empty_state() {
        let tmp = tempfile::tempdir().unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();

        let state = load_chat_session_state_from_dir(tmp.path(), &session_id).unwrap();

        assert_eq!(state.schema_version, CHAT_SESSION_SCHEMA_VERSION);
        assert_eq!(state.session_id, session_id);
        assert_eq!(state.session.id, session_id);
        assert!(state.messages.is_empty());
        assert!(state.turns.is_empty());
        assert!(state.provider_threads.is_empty());
        assert!(state.context_snapshots.is_empty());
        assert!(state.memory.summary.is_none());
        assert_eq!(state.provider, None);
        assert_eq!(state.model, None);
    }

    #[test]
    fn existing_flat_chat_session_loads_into_runtime_shape_without_loss() {
        let tmp = tempfile::tempdir().unwrap();
        let session_id = uuid::Uuid::new_v4();
        let dir = chat_sessions_dir_for_data_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            chat_session_path_for_data_dir(tmp.path(), &session_id),
            serde_json::json!({
                "schema_version": CHAT_SESSION_SCHEMA_VERSION,
                "session_id": session_id.to_string(),
                "provider": "codex",
                "model": null,
                "messages": [
                    {
                        "id": "legacy-user",
                        "role": "user",
                        "content": "old question",
                        "created_at": "2026-01-01T00:00:00Z",
                        "status": "complete"
                    },
                    {
                        "id": "legacy-assistant",
                        "role": "assistant",
                        "content": "old answer",
                        "created_at": "2026-01-01T00:00:01Z",
                        "status": "complete",
                        "metadata": { "provider": "codex" }
                    }
                ],
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:01Z"
            })
            .to_string(),
        )
        .unwrap();

        let state = load_chat_session_state_from_dir(tmp.path(), &session_id.to_string()).unwrap();

        let session_id_text = session_id.to_string();
        assert_eq!(state.session.id.as_str(), session_id_text.as_str());
        assert_eq!(state.session.active_provider.as_deref(), Some("codex"));
        assert_eq!(state.messages.len(), 2);
        assert_eq!(state.messages[0].content, "old question");
        assert_eq!(
            state.messages[0].session_id.as_deref(),
            Some(session_id_text.as_str())
        );
        assert!(state.turns.is_empty());
        assert!(state.context_snapshots.is_empty());
    }

    #[test]
    fn appended_chat_message_survives_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut message = ChatMessage {
            id: "msg-1".to_string(),
            session_id: None,
            turn_id: None,
            role: ChatRole::User,
            content: "hello".to_string(),
            created_at: chrono::Utc::now(),
            status: Some(ChatMessageStatus::Complete),
            metadata: None,
        };

        append_chat_message_in_dir(tmp.path(), &session_id, message.clone()).unwrap();
        let reloaded = load_chat_session_state_from_dir(tmp.path(), &session_id).unwrap();

        message.session_id = Some(session_id);
        assert_eq!(reloaded.messages, vec![message]);
    }

    #[test]
    fn updated_chat_message_survives_reload() {
        let tmp = tempfile::tempdir().unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let message = ChatMessage {
            id: "msg-1".to_string(),
            session_id: None,
            turn_id: None,
            role: ChatRole::Assistant,
            content: "hel".to_string(),
            created_at: chrono::Utc::now(),
            status: Some(ChatMessageStatus::Streaming),
            metadata: None,
        };
        append_chat_message_in_dir(tmp.path(), &session_id, message).unwrap();

        update_chat_message_in_dir(
            tmp.path(),
            &session_id,
            "msg-1",
            ChatMessagePatch {
                content: Some("hello".to_string()),
                status: Some(ChatMessageStatus::Complete),
                metadata: Some(serde_json::json!({ "finish_reason": "stop" })),
            },
        )
        .unwrap();
        let reloaded = load_chat_session_state_from_dir(tmp.path(), &session_id).unwrap();

        assert_eq!(reloaded.messages[0].content, "hello");
        assert_eq!(
            reloaded.messages[0].status,
            Some(ChatMessageStatus::Complete)
        );
        assert_eq!(
            reloaded.messages[0]
                .metadata
                .as_ref()
                .and_then(|value| value.get("finish_reason"))
                .and_then(|value| value.as_str()),
            Some("stop")
        );
    }

    #[test]
    fn chat_session_id_must_be_uuid_not_path() {
        let tmp = tempfile::tempdir().unwrap();

        let result = load_chat_session_state_from_dir(tmp.path(), "../sessions");

        assert!(
            matches!(result, Err(AppError::Other(message)) if message.contains("invalid session id"))
        );
        assert!(!tmp.path().join("sessions.json").exists());
    }
}
