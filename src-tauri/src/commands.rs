use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Runtime, State};
use uuid::Uuid;

use crate::agent_history::{self, AgentHistoryItem};
use crate::agent_resume;
use crate::error::{AppError, AppResult};
use crate::git_ops::{self, CommitInfo, DiffImages, DiffPayload, StagedFile};
use crate::persistence;
use crate::project_settings::{self, ProjectSettings, ProjectSettingsRecord};
use crate::pull_requests::{
    self, GeneratedCommitMessage, IssueDetailListing, IssueListing, IssueStateFilter, MergeMethod,
    PrStateFilter, PullRequestDetailListing, PullRequestDiffListing, PullRequestListing,
    WorkflowRunDetailListing, WorkflowRunsListing,
};
use crate::state::{AppState, PendingSessionRemoval};
use crate::todos::{self, TodoItem};
use crate::worktree;
use acorn_agent::AgentKind;
use acorn_session::scrollback;
use acorn_session::status as session_status;
use acorn_session::status::StatusReason as SessionStatusReason;
use acorn_session::{
    AgentStatusSource, Project, Session, SessionAgentProvider, SessionKind, SessionMode,
    SessionOwner, SessionStatus,
};
use acorn_transcript::{assistant_message_text, collapse_preview};

use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;

const CHAT_SESSION_STATE_CHANGED_EVENT: &str = "acorn:chat-session-state-changed";
const WORKTREE_IN_USE_BY_OTHER_SESSIONS: &str =
    "Close other sessions using this worktree before removing it.";
const CODEX_TOOL_PROCESS_START_TOLERANCE: std::time::Duration = std::time::Duration::from_secs(1);
const MAX_CODEX_REPAIR_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CLAUDE_FORK_PROJECT_ENTRIES: usize = 10_000;
const MAX_CLAUDE_FORK_TRANSCRIPT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
struct ClaudeForkLimits {
    max_project_entries: usize,
    max_transcript_bytes: u64,
}

const DEFAULT_CLAUDE_FORK_LIMITS: ClaudeForkLimits = ClaudeForkLimits {
    max_project_entries: MAX_CLAUDE_FORK_PROJECT_ENTRIES,
    max_transcript_bytes: MAX_CLAUDE_FORK_TRANSCRIPT_BYTES,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRemoval {
    pub token: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub git_common_dir: String,
    pub session_ids: Vec<String>,
}

impl SessionRemoval {
    fn new(worktree: &worktree::RemovedWorktree, sessions: &[Session]) -> Self {
        Self {
            token: worktree.token.clone(),
            repo_path: worktree.repo_path.clone(),
            worktree_path: worktree.worktree_path.clone(),
            git_common_dir: worktree.git_common_dir.clone(),
            session_ids: sessions
                .iter()
                .map(|session| session.id.to_string())
                .collect(),
        }
    }
}

async fn run_blocking<T, F>(label: &'static str, f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(format!("{label} task failed: {e}")))?
}

async fn stage_remove_linked_worktree_blocking(
    repo_path: PathBuf,
    worktree_path: PathBuf,
) -> AppResult<Option<worktree::RemovedWorktree>> {
    run_blocking("stage linked worktree removal", move || {
        stage_remove_linked_worktree_at_path(&repo_path, &worktree_path)
    })
    .await
}

async fn stage_remove_linked_worktree_and_sessions_blocking(
    state: AppState,
    repo_path: PathBuf,
    worktree_path: PathBuf,
) -> AppResult<Option<worktree::RemovedWorktree>> {
    run_blocking("stage linked worktree removal with sessions", move || {
        stage_remove_linked_worktree_at_path_and_sessions(&state, &repo_path, &worktree_path)
    })
    .await
}

async fn restore_removed_worktree_blocking(
    token: String,
    repo_path: String,
    worktree_path: String,
    git_common_dir: String,
) -> AppResult<()> {
    run_blocking("restore removed worktree", move || {
        worktree::restore_removed_worktree(
            Path::new(&repo_path),
            Path::new(&worktree_path),
            &token,
            Path::new(&git_common_dir),
        )
    })
    .await
}

async fn discard_removed_worktree_blocking(
    token: String,
    repo_path: String,
    worktree_path: String,
    git_common_dir: String,
) -> AppResult<()> {
    run_blocking("discard removed worktree", move || {
        worktree::discard_removed_worktree(
            Path::new(&repo_path),
            Path::new(&worktree_path),
            &token,
            Path::new(&git_common_dir),
        )
    })
    .await
}

fn pending_session_removal_matches(
    pending: &PendingSessionRemoval,
    repo_path: &str,
    worktree_path: &str,
    git_common_dir: &str,
) -> bool {
    pending.worktree.repo_path == repo_path
        && pending.worktree.worktree_path == worktree_path
        && pending.worktree.git_common_dir == git_common_dir
}

fn take_pending_session_removal(
    state: &AppState,
    token: &str,
    repo_path: &str,
    worktree_path: &str,
    git_common_dir: &str,
) -> AppResult<PendingSessionRemoval> {
    let mut pending_removals = state.pending_session_removals.lock();
    let pending = pending_removals
        .remove(token)
        .ok_or_else(|| AppError::Other("removed session backup is not available".to_string()))?;
    if pending_session_removal_matches(&pending, repo_path, worktree_path, git_common_dir) {
        return Ok(pending);
    }
    pending_removals.insert(token.to_string(), pending);
    Err(AppError::Other(
        "removed session backup does not match the requested worktree".to_string(),
    ))
}

fn restore_pending_session_removal(
    state: &AppState,
    token: &str,
    repo_path: &str,
    worktree_path: &str,
    git_common_dir: &str,
) -> AppResult<()> {
    let pending =
        take_pending_session_removal(state, token, repo_path, worktree_path, git_common_dir)?;

    if pending
        .sessions
        .iter()
        .any(|session| state.sessions.get(&session.id).is_ok())
    {
        state
            .pending_session_removals
            .lock()
            .insert(token.to_string(), pending);
        return Err(AppError::Other(
            "one or more removed sessions already exist".to_string(),
        ));
    }

    if let Err(error) = worktree::restore_removed_worktree(
        Path::new(repo_path),
        Path::new(worktree_path),
        token,
        Path::new(git_common_dir),
    ) {
        state
            .pending_session_removals
            .lock()
            .insert(token.to_string(), pending);
        return Err(error);
    }

    for mut session in pending.sessions {
        session.status = SessionStatus::Ready;
        session.updated_at = chrono::Utc::now();
        session.daemon_session_id = None;
        session.hook_active = false;
        session.hook_provider = None;
        session.in_worktree = false;
        session.agent_provider = None;
        session.agent_transcript_id = None;
        if session.project_scoped {
            state.projects.ensure(
                session.repo_path.clone(),
                project_basename(&session.repo_path),
            );
        }
        state.sessions.insert(session);
    }
    Ok(())
}

fn discard_pending_session_removal(
    state: &AppState,
    token: &str,
    repo_path: &str,
    worktree_path: &str,
    git_common_dir: &str,
) -> AppResult<()> {
    let pending =
        take_pending_session_removal(state, token, repo_path, worktree_path, git_common_dir)?;
    if let Err(error) = worktree::discard_removed_worktree(
        Path::new(repo_path),
        Path::new(worktree_path),
        token,
        Path::new(git_common_dir),
    ) {
        state
            .pending_session_removals
            .lock()
            .insert(token.to_string(), pending);
        return Err(error);
    }
    if let Ok(dir) = persistence::data_dir() {
        for session in pending.sessions {
            scrollback::delete(&dir, &session.id.to_string()).ok();
        }
    }
    Ok(())
}

fn canonical_existing_path(path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() {
        return Err(AppError::InvalidPath("absolute path required".into()));
    }
    path.canonicalize().map_err(AppError::from)
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn registered_project_roots(state: &AppState) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = state
        .projects
        .list()
        .into_iter()
        .filter_map(|project| project.repo_path.canonicalize().ok())
        .collect();
    roots.sort();
    roots.dedup();
    roots
}

fn authorize_registered_project_root(state: &AppState, repo: &Path) -> AppResult<PathBuf> {
    let repo = canonical_existing_path(repo)?;
    registered_project_roots(state)
        .into_iter()
        .find(|root| root == &repo)
        .ok_or_else(|| {
            AppError::InvalidPath(format!("project is not registered: {}", repo.display()))
        })
}

fn authorize_project_session_cwd(repo: &Path, cwd: &Path) -> AppResult<()> {
    if path_is_inside(cwd, repo) {
        return Ok(());
    }
    if worktree::list_worktree_paths(repo)?
        .into_iter()
        .filter_map(|path| path.canonicalize().ok())
        .any(|worktree| path_is_inside(cwd, &worktree))
    {
        return Ok(());
    }
    Err(AppError::InvalidPath(format!(
        "cwd is outside the registered project and its worktrees: {}",
        cwd.display()
    )))
}

fn authorize_local_session_root(path: &Path) -> AppResult<PathBuf> {
    let path = canonical_existing_path(path)?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| AppError::InvalidPath("HOME is not available".into()))?
        .canonicalize()?;
    if path == home {
        Ok(path)
    } else {
        Err(AppError::InvalidPath(format!(
            "local sessions may only start in HOME: {}",
            path.display()
        )))
    }
}

fn authorize_session_cwd(state: &AppState, session: &Session, cwd: &Path) -> AppResult<PathBuf> {
    let cwd = canonical_existing_path(cwd)?;
    let session_root = canonical_existing_path(&session.worktree_path)?;
    if session.project_scoped == false {
        if path_is_inside(&cwd, &session_root) {
            return Ok(cwd);
        }
        return Err(AppError::InvalidPath(format!(
            "cwd is outside the local session root: {}",
            cwd.display()
        )));
    }

    let repo = authorize_registered_project_root(state, &session.repo_path)?;
    if path_is_inside(&cwd, &repo) || path_is_inside(&cwd, &session_root) {
        Ok(cwd)
    } else {
        Err(AppError::InvalidPath(format!(
            "cwd is outside the session project roots: {}",
            cwd.display()
        )))
    }
}

fn remember_folder_grant(state: &AppState, path: &Path) -> AppResult<PathBuf> {
    let path = canonical_existing_path(path)?;
    let mut grants = state.folder_grants.lock();
    if !grants.iter().any(|granted| granted == &path) {
        grants.push(path.clone());
    }
    Ok(path)
}

fn folder_granted(state: &AppState, path: &Path) -> AppResult<PathBuf> {
    let path = canonical_existing_path(path)?;
    if state
        .folder_grants
        .lock()
        .iter()
        .any(|granted| granted == &path)
    {
        Ok(path)
    } else {
        Err(AppError::InvalidPath(format!(
            "folder was not selected through Acorn: {}",
            path.display()
        )))
    }
}

async fn pick_folder_path<R: Runtime>(
    app: &AppHandle<R>,
    title: Option<String>,
) -> AppResult<Option<PathBuf>> {
    let mut dialog = app.dialog().file();
    if let Some(title) = title.and_then(|title| {
        let title = title.trim().to_string();
        if title.is_empty() {
            None
        } else {
            Some(title)
        }
    }) {
        dialog = dialog.set_title(title);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |path| {
        let selected_path = path
            .map(|path| {
                path.into_path()
                    .map_err(|err| AppError::Other(err.to_string()))
            })
            .transpose();
        let _ = tx.send(selected_path);
    });
    rx.await
        .map_err(|_| AppError::Other("folder picker closed before returning".to_string()))?
}

fn validate_editor_command(command: &str, args: &[String]) -> AppResult<String> {
    let command = command.trim();
    if command.is_empty() {
        return Err(AppError::Other(
            "editor command must not be empty".to_string(),
        ));
    }
    if command.contains('/') || command.contains('\\') {
        return Err(AppError::Other(
            "editor command must be one of Acorn's known editor binaries".to_string(),
        ));
    }
    let allowed = matches!(
        command,
        "code"
            | "code-insiders"
            | "cursor"
            | "zed"
            | "subl"
            | "mate"
            | "bbedit"
            | "vim"
            | "nvim"
            | "nano"
            | "emacs"
            | "idea"
            | "webstorm"
            | "pycharm"
            | "goland"
            | "clion"
            | "phpstorm"
            | "rubymine"
            | "rider"
    );
    if !allowed {
        return Err(AppError::Other(format!(
            "editor command is not allowed: {command}"
        )));
    }
    for arg in args {
        if !matches!(
            arg.as_str(),
            "--wait" | "-w" | "--reuse-window" | "--new-window" | "--goto" | "-n" | "--new"
        ) {
            return Err(AppError::Other(format!(
                "editor argument is not allowed: {arg}"
            )));
        }
    }
    Ok(command.to_string())
}

fn inject_agent_hook_env(
    effective_env: &mut HashMap<String, String>,
    session: &Session,
    hooks: Option<&crate::agent_hooks::AgentHookServer>,
) {
    // A known provider that can't use hooks opts out entirely. An unknown
    // provider still gets the channel: a plain terminal session only learns
    // its provider once the status poll spots a live agent in the process
    // tree — long after the PTY (and its fixed environment) has spawned. If
    // the hook env were withheld until then, `claude`/`codex` launched inside
    // a terminal would never register hooks, and status would fall back to
    // transcript polling, which cannot see turn completion after the
    // `end_turn` line scrolls out of the tail window. The per-provider
    // wrapper shim only activates hooks when an actual agent binary runs, and
    // the notify script reports its own provider, so injecting the channel
    // ahead of classification is safe.
    if let Some(provider) = session.agent_provider {
        if !provider.supports_hooks() {
            return;
        }
    }

    let Some(hooks) = hooks else {
        return;
    };

    // This marker is the one-shot proof that a wrapper was reached directly
    // from a newly spawned Acorn PTY. Wrappers consume it before launching the
    // provider, so descendants cannot promote themselves to hook owners.
    // A control session can launch another Acorn app from inside an existing
    // provider invocation. The new PTY is nevertheless a fresh ownership
    // boundary, so do not inherit the outer wrapper's token, nesting depth,
    // or Codex recorder. Preserve recorder variables when there was no outer
    // Acorn invocation marker because those may be caller-owned settings.
    let inherited_agent_invocation = effective_env.contains_key("ACORN_AGENT_INVOCATION_TOKEN")
        || effective_env.contains_key("ACORN_AGENT_INVOCATION_DEPTH");
    effective_env.remove("ACORN_AGENT_INVOCATION_TOKEN");
    effective_env.remove("ACORN_AGENT_INVOCATION_DEPTH");
    if inherited_agent_invocation {
        effective_env.remove("CODEX_TUI_RECORD_SESSION");
        effective_env.remove("CODEX_TUI_SESSION_LOG_PATH");
        effective_env.remove("ACORN_CODEX_NATIVE_HOOKS_ENABLED");
    }
    effective_env.insert("ACORN_AGENT_INVOCATION_ROOT".to_string(), "1".to_string());
    effective_env
        .entry("ACORN_AGENT_HOOK_URL".to_string())
        .or_insert_with(|| hooks.hook_url().to_string());
    effective_env
        .entry("ACORN_AGENT_HOOK_TOKEN".to_string())
        .or_insert_with(|| hooks.token().to_string());
    effective_env
        .entry("ACORN_AGENT_HOOK_SESSION_ID".to_string())
        .or_insert_with(|| session.id.to_string());

    // Provider-specific metadata only when the provider is already known; the
    // notify scripts hardcode their own provider so this stays optional.
    if let Some(provider) = session.agent_provider {
        effective_env
            .entry("ACORN_AGENT_HOOK_PROVIDER".to_string())
            .or_insert_with(|| provider.hook_provider_env_value().to_string());
    }
}

fn authorize_chat_session(state: &AppState, session_id: &str) -> AppResult<Session> {
    let id = Uuid::parse_str(session_id)
        .map_err(|_| AppError::Other(format!("invalid session id: {session_id}")))?;
    let session = state.sessions.get(&id)?;
    if session.mode != SessionMode::Chat {
        return Err(AppError::Other(format!(
            "session is not chat mode: {session_id}"
        )));
    }
    Ok(session)
}

fn chat_provider_label(ai: &crate::ai::AiExecutionRequest) -> &'static str {
    match ai.provider {
        crate::ai::AiProvider::Claude => "claude",
        crate::ai::AiProvider::Antigravity => "antigravity",
        crate::ai::AiProvider::Codex => "codex",
        crate::ai::AiProvider::Ollama => "ollama",
        crate::ai::AiProvider::Llm => "llm",
        crate::ai::AiProvider::Custom => "custom",
    }
}

fn chat_provider_metadata(provider: &str) -> serde_json::Value {
    serde_json::json!({ "provider": provider })
}

fn chat_message_metadata(
    provider: &str,
    turn_id: &str,
    mode: persistence::ContextSnapshotMode,
) -> serde_json::Value {
    serde_json::json!({
        "provider": provider,
        "turn_id": turn_id,
        "context_mode": context_snapshot_mode_label(mode),
    })
}

fn context_snapshot_mode_label(mode: persistence::ContextSnapshotMode) -> &'static str {
    match mode {
        persistence::ContextSnapshotMode::NativeThread => "native_thread",
        persistence::ContextSnapshotMode::CompiledContext => "compiled_context",
    }
}

fn backfill_missing_assistant_provider_metadata(chat_state: &mut persistence::ChatSessionState) {
    let Some(provider) = chat_state
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
        .map(str::to_string)
    else {
        return;
    };

    for message in &mut chat_state.messages {
        if message.role != persistence::ChatRole::Assistant {
            continue;
        }
        match message.metadata.as_mut() {
            Some(serde_json::Value::Object(metadata)) => {
                metadata
                    .entry("provider")
                    .or_insert_with(|| serde_json::Value::String(provider.clone()));
            }
            Some(serde_json::Value::Null) | None => {
                message.metadata = Some(chat_provider_metadata(&provider));
            }
            Some(_) => {}
        }
    }
}

fn chat_model_label(ai: &crate::ai::AiExecutionRequest) -> Option<String> {
    match ai.provider {
        crate::ai::AiProvider::Ollama => ai.ollama_model.clone(),
        crate::ai::AiProvider::Llm => ai.llm_model.clone(),
        _ => None,
    }
    .and_then(|model| {
        let model = model.trim().to_string();
        if model.is_empty() {
            None
        } else {
            Some(model)
        }
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ChatProviderCapabilities {
    pub native_thread: bool,
    pub streaming: bool,
    pub attachments: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CompiledContext {
    pub included_message_ids: Vec<String>,
    pub summary_id: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ChatProviderInput {
    pub thread: Option<persistence::ProviderThread>,
    pub message: persistence::ChatMessage,
    pub context: Option<CompiledContext>,
    pub model: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderResponse {
    pub content: String,
    pub native_thread_id: Option<String>,
    pub resume_token: Option<String>,
    pub last_response_id: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

pub(crate) trait ChatProviderAdapter {
    fn capabilities(&self) -> ChatProviderCapabilities;
    fn send_message(&self, input: ChatProviderInput) -> AppResult<ProviderResponse>;
    fn send_message_streaming(
        &self,
        input: ChatProviderInput,
        on_event: &mut dyn FnMut(ChatProviderStreamEvent),
    ) -> AppResult<ProviderResponse> {
        let _ = on_event;
        self.send_message(input)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ChatProviderStreamEvent {
    AssistantTextDelta(String),
    Activity(ChatActivityPatch),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChatActivityPatch {
    id: String,
    kind: persistence::ChatActivityKind,
    title: Option<String>,
    detail: Option<String>,
    status: persistence::ChatActivityStatus,
}

fn ignore_chat_streaming_event(_: ChatProviderStreamEvent) {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatCliOutputMode {
    Text,
    ClaudeStreamJson,
    CodexJson,
}

struct ChatCliOutputParser {
    mode: ChatCliOutputMode,
    pending_line: String,
    emitted_text: String,
    final_text: Option<String>,
    usage: Option<serde_json::Value>,
    claude_message_id: Option<String>,
    claude_blocks: HashMap<u64, ClaudePartialBlock>,
}

struct ClaudePartialBlock {
    id: String,
    kind: persistence::ChatActivityKind,
    title: String,
    detail: String,
    input_json: String,
}

impl ChatCliOutputParser {
    fn new(mode: ChatCliOutputMode) -> Self {
        Self {
            mode,
            pending_line: String::new(),
            emitted_text: String::new(),
            final_text: None,
            usage: None,
            claude_message_id: None,
            claude_blocks: HashMap::new(),
        }
    }

    fn push_chunk(&mut self, chunk: &str, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        match self.mode {
            ChatCliOutputMode::Text => self.emit_delta(chunk, on_event),
            ChatCliOutputMode::ClaudeStreamJson | ChatCliOutputMode::CodexJson => {
                self.pending_line.push_str(chunk);
                while let Some(newline) = self.pending_line.find('\n') {
                    let line = self.pending_line[..newline].to_string();
                    self.pending_line.drain(..=newline);
                    self.process_json_line(&line, on_event);
                }
            }
        }
    }

    fn finish(&mut self, raw: &str) -> String {
        if self.mode == ChatCliOutputMode::Text {
            return raw.trim().to_string();
        }
        let mut ignore_event = ignore_chat_streaming_event;
        self.flush_pending(&mut ignore_event);
        self.final_text
            .as_deref()
            .unwrap_or(self.emitted_text.as_str())
            .trim()
            .to_string()
    }

    fn flush_pending(&mut self, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        if self.pending_line.trim().is_empty() {
            self.pending_line.clear();
            return;
        }
        let line = std::mem::take(&mut self.pending_line);
        self.process_json_line(&line, on_event);
    }

    fn process_json_line(&mut self, line: &str, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        if let Some(usage) = extract_chat_stream_usage(self.mode, &value) {
            self.usage = Some(usage);
        }
        let mut activities = if self.mode == ChatCliOutputMode::ClaudeStreamJson {
            self.extract_claude_partial_activities(&value)
        } else {
            Vec::new()
        };
        activities.extend(extract_chat_stream_activities(self.mode, &value));
        for activity in activities {
            on_event(ChatProviderStreamEvent::Activity(activity));
        }
        let Some(event) = extract_chat_stream_text(self.mode, &value) else {
            return;
        };
        if event.is_final {
            self.final_text = Some(event.text.clone());
        }
        self.emit_text_candidate(&event, on_event);
    }

    fn emit_text_candidate(
        &mut self,
        event: &ChatStreamTextEvent,
        on_event: &mut dyn FnMut(ChatProviderStreamEvent),
    ) {
        let text = event.text.as_str();
        if text.is_empty() {
            return;
        }
        if let Some(delta) = text.strip_prefix(&self.emitted_text) {
            self.emit_delta(delta, on_event);
        } else if event.is_final {
            // Persist normalized final text from finish() without briefly
            // appending a divergent duplicate to the live stream.
        } else if event.boundary != ChatStreamTextBoundary::Delta {
            let separator = message_boundary_separator(&self.emitted_text, text);
            if !separator.is_empty() {
                self.emit_delta(separator, on_event);
            }
            self.emit_delta(text, on_event);
        } else {
            self.emit_delta(text, on_event);
        }
    }

    fn emit_delta(&mut self, delta: &str, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        if delta.is_empty() {
            return;
        }
        self.emitted_text.push_str(delta);
        on_event(ChatProviderStreamEvent::AssistantTextDelta(
            delta.to_string(),
        ));
    }

    fn provider_metadata(&self) -> Option<serde_json::Value> {
        self.usage
            .as_ref()
            .map(|usage| serde_json::json!({ "usage": usage }))
    }

    fn extract_claude_partial_activities(
        &mut self,
        value: &serde_json::Value,
    ) -> Vec<ChatActivityPatch> {
        if value.get("type").and_then(serde_json::Value::as_str) != Some("stream_event") {
            return Vec::new();
        }
        let Some(event) = value.get("event") else {
            return Vec::new();
        };
        let event_type = event.get("type").and_then(serde_json::Value::as_str);
        match event_type {
            Some("message_start") => {
                self.claude_message_id = event
                    .get("message")
                    .and_then(|message| message.get("id"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                self.claude_blocks.clear();
                Vec::new()
            }
            Some("content_block_start") => {
                let Some(index) = event.get("index").and_then(serde_json::Value::as_u64) else {
                    return Vec::new();
                };
                let Some(block) = event.get("content_block") else {
                    return Vec::new();
                };
                let Some(block_type) = block.get("type").and_then(serde_json::Value::as_str) else {
                    return Vec::new();
                };
                let message_id = self.claude_message_id.as_deref().unwrap_or("assistant");
                let partial = match block_type {
                    "thinking" | "redacted_thinking" => ClaudePartialBlock {
                        id: format!("claude:{message_id}:reasoning:{index}"),
                        kind: persistence::ChatActivityKind::Reasoning,
                        title: "Reasoning".to_string(),
                        detail: block
                            .get("thinking")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input_json: String::new(),
                    },
                    "tool_use" | "server_tool_use" => {
                        let name = block
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Tool");
                        ClaudePartialBlock {
                            id: block
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("claude:{message_id}:tool:{index}")),
                            kind: tool_activity_kind(name),
                            title: humanize_activity_name(name),
                            detail: tool_input_detail(block.get("input")).unwrap_or_default(),
                            input_json: String::new(),
                        }
                    }
                    _ => return Vec::new(),
                };
                let patch =
                    claude_partial_block_patch(&partial, persistence::ChatActivityStatus::Running);
                self.claude_blocks.insert(index, partial);
                vec![patch]
            }
            Some("content_block_delta") => {
                let Some(index) = event.get("index").and_then(serde_json::Value::as_u64) else {
                    return Vec::new();
                };
                let Some(delta) = event.get("delta") else {
                    return Vec::new();
                };
                let delta_type = delta.get("type").and_then(serde_json::Value::as_str);
                if delta_type == Some("thinking_delta") && !self.claude_blocks.contains_key(&index)
                {
                    let message_id = self.claude_message_id.as_deref().unwrap_or("assistant");
                    self.claude_blocks.insert(
                        index,
                        ClaudePartialBlock {
                            id: format!("claude:{message_id}:reasoning:{index}"),
                            kind: persistence::ChatActivityKind::Reasoning,
                            title: "Reasoning".to_string(),
                            detail: String::new(),
                            input_json: String::new(),
                        },
                    );
                }
                let Some(partial) = self.claude_blocks.get_mut(&index) else {
                    return Vec::new();
                };
                match delta_type {
                    Some("thinking_delta") => {
                        if let Some(fragment) =
                            delta.get("thinking").and_then(serde_json::Value::as_str)
                        {
                            append_limited_activity_text(&mut partial.detail, fragment);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(fragment) = delta
                            .get("partial_json")
                            .and_then(serde_json::Value::as_str)
                        {
                            append_limited_tool_input_json(&mut partial.input_json, fragment);
                        }
                    }
                    _ => return Vec::new(),
                }
                vec![claude_partial_block_patch(
                    partial,
                    persistence::ChatActivityStatus::Running,
                )]
            }
            Some("content_block_stop") => {
                let Some(index) = event.get("index").and_then(serde_json::Value::as_u64) else {
                    return Vec::new();
                };
                let Some(mut partial) = self.claude_blocks.remove(&index) else {
                    return Vec::new();
                };
                if partial.kind != persistence::ChatActivityKind::Reasoning
                    && !partial.input_json.is_empty()
                {
                    partial.detail = serde_json::from_str::<serde_json::Value>(&partial.input_json)
                        .ok()
                        .as_ref()
                        .and_then(|input| tool_input_detail(Some(input)))
                        .unwrap_or_default();
                }
                let status = if partial.kind == persistence::ChatActivityKind::Reasoning {
                    persistence::ChatActivityStatus::Complete
                } else {
                    persistence::ChatActivityStatus::Running
                };
                vec![claude_partial_block_patch(&partial, status)]
            }
            _ => Vec::new(),
        }
    }
}

fn claude_partial_block_patch(
    partial: &ClaudePartialBlock,
    status: persistence::ChatActivityStatus,
) -> ChatActivityPatch {
    ChatActivityPatch {
        id: partial.id.clone(),
        kind: partial.kind,
        title: Some(partial.title.clone()),
        detail: activity_detail(Some(&partial.detail)),
        status,
    }
}

fn append_limited_activity_text(target: &mut String, fragment: &str) {
    let remaining = MAX_CHAT_ACTIVITY_DETAIL_CHARS.saturating_sub(target.chars().count());
    if remaining > 0 {
        target.extend(fragment.chars().take(remaining));
    }
}

const MAX_CHAT_TOOL_INPUT_JSON_CHARS: usize = 16_000;

fn append_limited_tool_input_json(target: &mut String, fragment: &str) {
    let remaining = MAX_CHAT_TOOL_INPUT_JSON_CHARS.saturating_sub(target.chars().count());
    if remaining > 0 {
        target.extend(fragment.chars().take(remaining));
    }
}

struct ChatStreamTextEvent {
    text: String,
    boundary: ChatStreamTextBoundary,
    is_final: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatStreamTextBoundary {
    Delta,
    Snapshot,
    Message,
}

fn message_boundary_separator(previous: &str, next: &str) -> &'static str {
    if previous.is_empty()
        || previous.ends_with('\n')
        || next.starts_with('\n')
        || previous.ends_with(' ')
        || next.starts_with(' ')
    {
        ""
    } else {
        "\n\n"
    }
}

fn extract_chat_stream_text(
    mode: ChatCliOutputMode,
    value: &serde_json::Value,
) -> Option<ChatStreamTextEvent> {
    match mode {
        ChatCliOutputMode::Text => None,
        ChatCliOutputMode::ClaudeStreamJson => extract_claude_stream_text(value),
        ChatCliOutputMode::CodexJson => extract_codex_stream_text(value),
    }
}

fn extract_chat_stream_usage(
    mode: ChatCliOutputMode,
    value: &serde_json::Value,
) -> Option<serde_json::Value> {
    match mode {
        ChatCliOutputMode::Text => None,
        ChatCliOutputMode::ClaudeStreamJson => extract_claude_stream_usage(value),
        ChatCliOutputMode::CodexJson => extract_codex_stream_usage(value),
    }
}

fn extract_claude_stream_usage(value: &serde_json::Value) -> Option<serde_json::Value> {
    value
        .get("usage")
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("usage"))
        })
        .or_else(|| {
            value
                .get("event")
                .and_then(|event| event.get("message"))
                .and_then(|message| message.get("usage"))
        })
        .cloned()
}

fn extract_codex_stream_usage(value: &serde_json::Value) -> Option<serde_json::Value> {
    extract_codex_event_usage(value)
        .or_else(|| value.get("msg").and_then(extract_codex_event_usage))
        .or_else(|| value.get("payload").and_then(extract_codex_event_usage))
}

fn extract_codex_event_usage(value: &serde_json::Value) -> Option<serde_json::Value> {
    let event_type = value.get("type").and_then(serde_json::Value::as_str);
    if event_type == Some("token_count") {
        return value
            .get("info")
            .and_then(|info| info.get("total_token_usage").or(Some(info)))
            .cloned();
    }
    value.get("usage").cloned()
}

const MAX_CHAT_ACTIVITY_DETAIL_CHARS: usize = 4_000;
const MAX_CHAT_ACTIVITY_ID_CHARS: usize = 512;
const MAX_CHAT_ACTIVITY_TITLE_CHARS: usize = 200;
const MAX_CHAT_TURN_ACTIVITIES: usize = 512;

fn extract_chat_stream_activities(
    mode: ChatCliOutputMode,
    value: &serde_json::Value,
) -> Vec<ChatActivityPatch> {
    match mode {
        ChatCliOutputMode::Text => Vec::new(),
        ChatCliOutputMode::ClaudeStreamJson => extract_claude_stream_activities(value),
        ChatCliOutputMode::CodexJson => extract_codex_stream_activities(value),
    }
}

fn extract_claude_stream_activities(value: &serde_json::Value) -> Vec<ChatActivityPatch> {
    let event_type = value.get("type").and_then(serde_json::Value::as_str);
    match event_type {
        Some("assistant") => {
            let Some(message) = value.get("message") else {
                return Vec::new();
            };
            let message_id = message
                .get("id")
                .or_else(|| value.get("uuid"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("assistant");
            let block_status = if message
                .get("stop_reason")
                .is_some_and(|reason| !reason.is_null())
            {
                persistence::ChatActivityStatus::Complete
            } else {
                persistence::ChatActivityStatus::Running
            };
            message
                .get("content")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .take(MAX_CHAT_TURN_ACTIVITIES)
                .enumerate()
                .filter_map(|(index, block)| {
                    let block_type = block.get("type").and_then(serde_json::Value::as_str)?;
                    match block_type {
                        "thinking" | "redacted_thinking" => Some(ChatActivityPatch {
                            id: format!("claude:{message_id}:reasoning:{index}"),
                            kind: persistence::ChatActivityKind::Reasoning,
                            title: Some("Reasoning".to_string()),
                            detail: activity_detail(
                                block
                                    .get("thinking")
                                    .or_else(|| block.get("text"))
                                    .and_then(json_display_text)
                                    .as_deref(),
                            ),
                            status: block_status,
                        }),
                        "tool_use" | "server_tool_use" => {
                            let name = block
                                .get("name")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("Tool");
                            let id = block
                                .get("id")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("claude:{message_id}:tool:{index}"));
                            Some(ChatActivityPatch {
                                id,
                                kind: tool_activity_kind(name),
                                title: Some(humanize_activity_name(name)),
                                detail: tool_input_detail(block.get("input")),
                                status: persistence::ChatActivityStatus::Running,
                            })
                        }
                        _ => None,
                    }
                })
                .collect()
        }
        Some("user") => value
            .get("message")
            .and_then(|message| message.get("content"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_CHAT_TURN_ACTIVITIES)
            .filter_map(|block| {
                if block.get("type").and_then(serde_json::Value::as_str) != Some("tool_result") {
                    return None;
                }
                let id = block
                    .get("tool_use_id")
                    .and_then(serde_json::Value::as_str)?
                    .to_string();
                let is_error = block
                    .get("is_error")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                Some(ChatActivityPatch {
                    id,
                    kind: persistence::ChatActivityKind::Tool,
                    title: None,
                    detail: None,
                    status: if is_error {
                        persistence::ChatActivityStatus::Error
                    } else {
                        persistence::ChatActivityStatus::Complete
                    },
                })
            })
            .collect(),
        Some("tool_progress") => {
            let Some(id) = value.get("tool_use_id").and_then(serde_json::Value::as_str) else {
                return Vec::new();
            };
            vec![ChatActivityPatch {
                id: id.to_string(),
                kind: persistence::ChatActivityKind::Tool,
                title: value
                    .get("tool_name")
                    .and_then(serde_json::Value::as_str)
                    .map(humanize_activity_name),
                detail: None,
                status: persistence::ChatActivityStatus::Running,
            }]
        }
        Some("tool_use_summary") => {
            let summary = value
                .get("summary")
                .and_then(serde_json::Value::as_str)
                .and_then(|summary| activity_detail(Some(summary)));
            value
                .get("preceding_tool_use_ids")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .take(MAX_CHAT_TURN_ACTIVITIES)
                .filter_map(serde_json::Value::as_str)
                .map(|id| ChatActivityPatch {
                    id: id.to_string(),
                    kind: persistence::ChatActivityKind::Tool,
                    title: None,
                    detail: summary.clone(),
                    status: persistence::ChatActivityStatus::Complete,
                })
                .collect()
        }
        Some("result") => value
            .get("permission_denials")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .take(MAX_CHAT_TURN_ACTIVITIES)
            .filter_map(|denial| {
                let id = denial
                    .get("tool_use_id")
                    .or_else(|| denial.get("id"))
                    .and_then(serde_json::Value::as_str)?;
                Some(ChatActivityPatch {
                    id: id.to_string(),
                    kind: persistence::ChatActivityKind::Tool,
                    title: denial
                        .get("tool_name")
                        .and_then(serde_json::Value::as_str)
                        .map(humanize_activity_name),
                    detail: denial
                        .get("message")
                        .and_then(json_display_text)
                        .and_then(|detail| activity_detail(Some(&detail))),
                    status: persistence::ChatActivityStatus::Error,
                })
            })
            .collect(),
        Some("system") => extract_claude_system_activity(value).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn extract_claude_system_activity(value: &serde_json::Value) -> Option<ChatActivityPatch> {
    let subtype = value.get("subtype").and_then(serde_json::Value::as_str)?;
    let id = value
        .get("task_id")
        .or_else(|| value.get("tool_use_id"))
        .or_else(|| value.get("uuid"))
        .and_then(serde_json::Value::as_str)?;
    match subtype {
        "task_started" | "task_progress" | "task_notification" => {
            let status = match value.get("status").and_then(serde_json::Value::as_str) {
                Some("failed") => persistence::ChatActivityStatus::Error,
                Some("stopped") => persistence::ChatActivityStatus::Cancelled,
                Some("completed") => persistence::ChatActivityStatus::Complete,
                _ => persistence::ChatActivityStatus::Running,
            };
            Some(ChatActivityPatch {
                id: format!("claude:task:{id}"),
                kind: persistence::ChatActivityKind::Tool,
                title: Some("Background task".to_string()),
                detail: value
                    .get("summary")
                    .or_else(|| value.get("description"))
                    .and_then(json_display_text)
                    .and_then(|detail| activity_detail(Some(&detail))),
                status,
            })
        }
        "permission_denied" => Some(ChatActivityPatch {
            id: id.to_string(),
            kind: persistence::ChatActivityKind::Tool,
            title: value
                .get("tool_name")
                .and_then(serde_json::Value::as_str)
                .map(humanize_activity_name),
            detail: value
                .get("message")
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status: persistence::ChatActivityStatus::Error,
        }),
        _ => None,
    }
}

fn extract_codex_stream_activities(value: &serde_json::Value) -> Vec<ChatActivityPatch> {
    let outer_type = value.get("type").and_then(serde_json::Value::as_str);
    if matches!(
        outer_type,
        Some("item.started" | "item.updated" | "item.completed")
    ) {
        return value
            .get("item")
            .and_then(|item| codex_item_activity(outer_type.unwrap_or_default(), item))
            .into_iter()
            .collect();
    }

    let event = value
        .get("msg")
        .filter(|event| event.is_object())
        .or_else(|| value.get("payload").filter(|event| event.is_object()))
        .unwrap_or(value);
    codex_legacy_activity(event).into_iter().collect()
}

fn codex_item_activity(outer_type: &str, item: &serde_json::Value) -> Option<ChatActivityPatch> {
    let item_type = item.get("type").and_then(serde_json::Value::as_str)?;
    if item_type == "agent_message" {
        return None;
    }
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex:{item_type}"));
    let status = codex_activity_status(outer_type, item);
    let patch = match item_type {
        "reasoning" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::Reasoning,
            title: Some("Reasoning".to_string()),
            detail: item
                .get("text")
                .or_else(|| item.get("summary"))
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status,
        },
        "command_execution" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::Command,
            title: Some("Command".to_string()),
            detail: item
                .get("command")
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status,
        },
        "file_change" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::FileChange,
            title: Some("File changes".to_string()),
            detail: codex_file_change_detail(item),
            status,
        },
        "mcp_tool_call" => {
            let server = item
                .get("server")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("MCP");
            let tool = item
                .get("tool")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("tool");
            ChatActivityPatch {
                id,
                kind: persistence::ChatActivityKind::Tool,
                title: Some(format!("{server} · {tool}")),
                detail: None,
                status,
            }
        }
        "collab_tool_call" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::Tool,
            title: Some("Sub-agent".to_string()),
            detail: item
                .get("tool")
                .and_then(json_display_text)
                .map(|detail| humanize_activity_name(&detail))
                .and_then(|detail| activity_detail(Some(&detail))),
            status,
        },
        "web_search" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::WebSearch,
            title: Some("Web search".to_string()),
            detail: item
                .get("query")
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status,
        },
        "todo_list" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::Plan,
            title: Some("Plan".to_string()),
            detail: codex_todo_detail(item),
            status,
        },
        "error" => ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::Tool,
            title: Some("Provider error".to_string()),
            detail: item
                .get("message")
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status: persistence::ChatActivityStatus::Error,
        },
        _ => return None,
    };
    Some(patch)
}

fn codex_activity_status(
    outer_type: &str,
    item: &serde_json::Value,
) -> persistence::ChatActivityStatus {
    match item.get("status").and_then(serde_json::Value::as_str) {
        Some("failed" | "error" | "declined") => persistence::ChatActivityStatus::Error,
        Some("cancelled") => persistence::ChatActivityStatus::Cancelled,
        Some("completed") => persistence::ChatActivityStatus::Complete,
        Some("in_progress") => persistence::ChatActivityStatus::Running,
        _ if outer_type == "item.completed" => persistence::ChatActivityStatus::Complete,
        _ => persistence::ChatActivityStatus::Running,
    }
}

fn codex_legacy_activity(event: &serde_json::Value) -> Option<ChatActivityPatch> {
    let event_type = event.get("type").and_then(serde_json::Value::as_str)?;
    let id = event
        .get("call_id")
        .or_else(|| event.get("id"))
        .or_else(|| event.get("turn_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex:{event_type}"));
    let is_error = event
        .get("success")
        .and_then(serde_json::Value::as_bool)
        .is_some_and(|success| !success)
        || matches!(
            event.get("status").and_then(serde_json::Value::as_str),
            Some("failed" | "error" | "declined")
        );
    let ending = event_type.ends_with("_end") || event_type.ends_with("_complete");
    let status = if is_error {
        persistence::ChatActivityStatus::Error
    } else if ending {
        persistence::ChatActivityStatus::Complete
    } else {
        persistence::ChatActivityStatus::Running
    };

    match event_type {
        "reasoning" => Some(ChatActivityPatch {
            id: format!("{id}:reasoning"),
            kind: persistence::ChatActivityKind::Reasoning,
            title: Some("Reasoning".to_string()),
            detail: event
                .get("text")
                .or_else(|| event.get("summary"))
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status: persistence::ChatActivityStatus::Complete,
        }),
        "exec_command_begin" | "exec_command_end" => Some(ChatActivityPatch {
            id,
            kind: persistence::ChatActivityKind::Command,
            title: Some("Command".to_string()),
            detail: event
                .get("command")
                .or_else(|| event.get("cmd"))
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail))),
            status,
        }),
        "patch_apply_begin" | "patch_apply_end" | "apply_patch_begin" | "apply_patch_end" => {
            Some(ChatActivityPatch {
                id,
                kind: persistence::ChatActivityKind::FileChange,
                title: Some("File changes".to_string()),
                detail: codex_file_change_detail(event),
                status,
            })
        }
        "mcp_tool_call_begin" | "mcp_tool_call_end" => {
            let invocation = event.get("invocation").unwrap_or(event);
            let server = invocation
                .get("server")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("MCP");
            let tool = invocation
                .get("tool")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("tool");
            Some(ChatActivityPatch {
                id,
                kind: persistence::ChatActivityKind::Tool,
                title: Some(format!("{server} · {tool}")),
                detail: None,
                status,
            })
        }
        "function_call" | "custom_tool_call" => {
            let name = event
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Tool");
            Some(ChatActivityPatch {
                id,
                kind: tool_activity_kind(name),
                title: Some(humanize_activity_name(name)),
                detail: tool_input_detail(event.get("arguments").or_else(|| event.get("input"))),
                status,
            })
        }
        _ => None,
    }
}

fn codex_file_change_detail(value: &serde_json::Value) -> Option<String> {
    let mut paths = Vec::new();
    if let Some(changes) = value.get("changes").and_then(serde_json::Value::as_array) {
        for change in changes.iter().take(20) {
            if let Some(path) = change.get("path").and_then(serde_json::Value::as_str) {
                paths.push(path.to_string());
            }
        }
    } else if let Some(changes) = value.get("changes").and_then(serde_json::Value::as_object) {
        paths.extend(changes.keys().take(20).cloned());
    }
    activity_detail((!paths.is_empty()).then(|| paths.join("\n")).as_deref())
}

fn codex_todo_detail(value: &serde_json::Value) -> Option<String> {
    let items = value.get("items")?.as_array()?;
    let lines = items
        .iter()
        .take(30)
        .filter_map(|item| {
            let text = item.get("text").and_then(serde_json::Value::as_str)?;
            let marker = if item
                .get("completed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                "[x]"
            } else {
                "[ ]"
            };
            Some(format!("{marker} {text}"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    activity_detail(Some(&lines))
}

fn tool_activity_kind(name: &str) -> persistence::ChatActivityKind {
    let normalized = name.to_ascii_lowercase();
    if normalized.contains("bash")
        || normalized.contains("shell")
        || normalized.contains("command")
        || normalized == "exec"
    {
        persistence::ChatActivityKind::Command
    } else if normalized.contains("search") || normalized.contains("grep") {
        persistence::ChatActivityKind::WebSearch
    } else if normalized.contains("write")
        || normalized.contains("edit")
        || normalized.contains("patch")
    {
        persistence::ChatActivityKind::FileChange
    } else {
        persistence::ChatActivityKind::Tool
    }
}

fn tool_input_detail(input: Option<&serde_json::Value>) -> Option<String> {
    let input = input?;
    if let Some(text) = input.as_str() {
        return activity_detail(json_display_text(input).as_deref().or(Some(text)));
    }
    let object = input.as_object()?;
    const SAFE_DETAIL_KEYS: &[&str] = &[
        "command",
        "cmd",
        "file_path",
        "path",
        "AbsolutePath",
        "DirectoryPath",
        "pattern",
        "query",
        "url",
        "description",
        "toolAction",
        "toolSummary",
    ];
    SAFE_DETAIL_KEYS.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(json_display_text)
            .and_then(|detail| activity_detail(Some(&detail)))
    })
}

fn json_display_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.starts_with('"') && trimmed.ends_with('"') {
                serde_json::from_str::<String>(trimmed)
                    .ok()
                    .or_else(|| Some(trimmed.to_string()))
            } else if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Array(values) => {
            let text = values
                .iter()
                .filter_map(|value| {
                    value
                        .get("text")
                        .and_then(json_display_text)
                        .or_else(|| json_display_text(value))
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn activity_detail(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    let mut detail = value
        .chars()
        .take(MAX_CHAT_ACTIVITY_DETAIL_CHARS)
        .collect::<String>();
    if value.chars().count() > MAX_CHAT_ACTIVITY_DETAIL_CHARS {
        detail.push('…');
    }
    Some(detail)
}

fn humanize_activity_name(value: &str) -> String {
    let mut out = String::new();
    let mut previous_lowercase = false;
    for ch in value.trim().chars() {
        if ch == '_' || ch == '-' {
            if !out.ends_with(' ') {
                out.push(' ');
            }
            previous_lowercase = false;
            continue;
        }
        if ch.is_ascii_uppercase() && previous_lowercase {
            out.push(' ');
        }
        out.push(ch);
        previous_lowercase = ch.is_ascii_lowercase();
    }
    let compact = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        "Tool".to_string()
    } else {
        compact
    }
}

fn extract_claude_stream_text(value: &serde_json::Value) -> Option<ChatStreamTextEvent> {
    let event_type = value.get("type").and_then(serde_json::Value::as_str);
    match event_type {
        Some("assistant") => {
            assistant_message_text(value.get("message")?).map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Snapshot,
                is_final: false,
            })
        }
        Some("result") => string_field(value, &["result"])
            .or_else(|| string_field(value, &["message"]))
            .map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Snapshot,
                is_final: true,
            }),
        Some("content_block_delta") | Some("text_delta") | Some("partial") => {
            json_delta_text(value).map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Delta,
                is_final: false,
            })
        }
        Some("stream_event") => {
            let event = value.get("event")?;
            if event.get("type").and_then(serde_json::Value::as_str) != Some("content_block_delta")
                || event
                    .get("delta")
                    .and_then(|delta| delta.get("type"))
                    .and_then(serde_json::Value::as_str)
                    != Some("text_delta")
            {
                return None;
            }
            json_delta_text(event).map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Delta,
                is_final: false,
            })
        }
        _ => None,
    }
}

fn extract_codex_stream_text(value: &serde_json::Value) -> Option<ChatStreamTextEvent> {
    if matches!(
        value.get("type").and_then(serde_json::Value::as_str),
        Some("item.started" | "item.updated" | "item.completed")
    ) {
        let item = value.get("item")?;
        if item.get("type").and_then(serde_json::Value::as_str) == Some("agent_message") {
            return item
                .get("text")
                .and_then(serde_json::Value::as_str)
                .map(|text| ChatStreamTextEvent {
                    text: text.to_string(),
                    boundary: ChatStreamTextBoundary::Message,
                    is_final: false,
                });
        }
    }
    if let Some(event) = extract_codex_event_text(value) {
        return Some(event);
    }
    value
        .get("msg")
        .and_then(extract_codex_event_text)
        .or_else(|| value.get("payload").and_then(extract_codex_event_text))
}

fn extract_codex_event_text(value: &serde_json::Value) -> Option<ChatStreamTextEvent> {
    let event_type = value.get("type").and_then(serde_json::Value::as_str);
    match event_type {
        Some("agent_message_content_delta") => {
            json_delta_text(value).map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Delta,
                is_final: false,
            })
        }
        Some("agent_message") => string_field(value, &["message"])
            .or_else(|| string_field(value, &["text"]))
            .or_else(|| assistant_message_text(value))
            .map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Message,
                is_final: false,
            }),
        Some("response_item") | Some("raw_response_item") => value
            .get("payload")
            .and_then(assistant_message_text)
            .map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Message,
                is_final: false,
            }),
        Some("turn_complete") | Some("task_complete") => {
            string_field(value, &["last_agent_message"]).map(|text| ChatStreamTextEvent {
                text,
                boundary: ChatStreamTextBoundary::Snapshot,
                is_final: true,
            })
        }
        _ => None,
    }
}

fn json_delta_text(value: &serde_json::Value) -> Option<String> {
    string_field(value, &["delta"])
        .or_else(|| string_field(value, &["delta", "text"]))
        .or_else(|| string_field(value, &["delta", "content"]))
        .or_else(|| string_field(value, &["text"]))
        .or_else(|| string_field(value, &["content"]))
}

fn string_field(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_str().map(str::to_string)
}

fn chat_message_metadata_provider(message: &persistence::ChatMessage) -> Option<&str> {
    message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("provider"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
}

fn latest_empty_codex_assistant_message_index(
    state: &persistence::ChatSessionState,
) -> Option<usize> {
    let index = state.messages.len().checked_sub(1)?;
    let message = &state.messages[index];
    if message.role != persistence::ChatRole::Assistant || !message.content.trim().is_empty() {
        return None;
    }
    if message.status != Some(persistence::ChatMessageStatus::Complete) {
        return None;
    }
    let provider = chat_message_metadata_provider(message).or(state.provider.as_deref());
    if provider != Some("codex") {
        return None;
    }
    Some(index)
}

fn codex_provider_thread_cursor(state: &persistence::ChatSessionState) -> Option<String> {
    state
        .provider_threads
        .iter()
        .rev()
        .filter(|thread| thread.provider == "codex")
        .find_map(|thread| {
            thread
                .resume_token
                .as_deref()
                .or(thread.native_thread_id.as_deref())
                .or(thread.last_response_id.as_deref())
                .map(str::trim)
                .filter(|cursor| !cursor.is_empty())
                .map(str::to_string)
        })
}

fn latest_codex_agent_message_from_transcript(path: &Path) -> io::Result<Option<String>> {
    let tail = acorn_transcript::read_tail(path, MAX_CODEX_REPAIR_TAIL_BYTES)?;
    let mut latest_agent_message = None;
    let mut saw_empty_final = false;

    for line in tail.text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(event) = extract_codex_stream_text(&value) {
            let text = event.text.trim();
            if event.is_final {
                if text.is_empty() {
                    saw_empty_final = true;
                    continue;
                }
                if saw_empty_final {
                    return Ok(latest_agent_message);
                }
                return Ok(Some(text.to_string()));
            }
            if latest_agent_message.is_none()
                && event.boundary != ChatStreamTextBoundary::Delta
                && !text.is_empty()
            {
                latest_agent_message = Some(text.to_string());
            }
        }
        if is_codex_user_message_event(&value) {
            return Ok(latest_agent_message);
        }
    }

    Ok(latest_agent_message)
}

fn is_codex_user_message_event(value: &serde_json::Value) -> bool {
    is_codex_user_message_event_value(value)
        || value
            .get("msg")
            .is_some_and(is_codex_user_message_event_value)
        || value
            .get("payload")
            .is_some_and(is_codex_user_message_event_value)
}

fn is_codex_user_message_event_value(value: &serde_json::Value) -> bool {
    match codex_event_type(value) {
        Some("user_message") => true,
        Some("response_item") | Some("raw_response_item") => value
            .get("payload")
            .is_some_and(is_codex_user_response_payload),
        _ => false,
    }
}

fn is_codex_user_response_payload(value: &serde_json::Value) -> bool {
    codex_event_type(value) == Some("message")
        && value
            .get("role")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|role| role == "user")
}

fn codex_event_type(value: &serde_json::Value) -> Option<&str> {
    value.get("type").and_then(serde_json::Value::as_str)
}

fn backfill_latest_empty_codex_assistant_message_from_path(
    state: &mut persistence::ChatSessionState,
    path: &Path,
) -> bool {
    let Some(index) = latest_empty_codex_assistant_message_index(state) else {
        return false;
    };
    let Ok(Some(content)) = latest_codex_agent_message_from_transcript(path) else {
        return false;
    };
    state.messages[index].content = content;
    true
}

fn backfill_latest_empty_codex_assistant_message(
    state: &mut persistence::ChatSessionState,
) -> bool {
    let Some(cursor) = codex_provider_thread_cursor(state) else {
        return false;
    };
    let Some(path) = acorn_transcript::locate_codex_transcript(&cursor) else {
        return false;
    };
    backfill_latest_empty_codex_assistant_message_from_path(state, &path)
}

const ANTIGRAVITY_TRANSCRIPT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const ANTIGRAVITY_TRANSCRIPT_DISCOVERY_INTERVAL: Duration = Duration::from_millis(500);
const MAX_ANTIGRAVITY_TRANSCRIPT_READ_BYTES: u64 = 1024 * 1024;
const MAX_ANTIGRAVITY_TRANSCRIPT_LINE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ANTIGRAVITY_FINISH_POLLS: usize = 8;

struct AntigravityTranscriptFollower {
    cwd: PathBuf,
    process_start: SystemTime,
    path: Option<PathBuf>,
    offset: u64,
    pending_bytes: Vec<u8>,
    discard_until_newline: bool,
    last_poll: Option<Instant>,
    last_discovery: Option<Instant>,
    line_sequence: u64,
    pending_tools: VecDeque<(String, persistence::ChatActivityKind)>,
}

impl AntigravityTranscriptFollower {
    fn new(cwd: PathBuf, resume_token: Option<&str>, process_start: SystemTime) -> Self {
        let path = resume_token.and_then(acorn_transcript::locate_antigravity_transcript);
        let offset = path
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Self {
            cwd,
            process_start,
            path,
            offset,
            pending_bytes: Vec::new(),
            discard_until_newline: false,
            last_poll: None,
            last_discovery: None,
            line_sequence: 0,
            pending_tools: VecDeque::new(),
        }
    }

    fn poll(&mut self, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        let now = Instant::now();
        if self
            .last_poll
            .is_some_and(|last| now.duration_since(last) < ANTIGRAVITY_TRANSCRIPT_POLL_INTERVAL)
        {
            return;
        }
        self.last_poll = Some(now);
        self.poll_now(on_event);
    }

    fn poll_now(&mut self, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        if self.path.is_none() {
            let now = Instant::now();
            if self.last_discovery.is_some_and(|last| {
                now.duration_since(last) < ANTIGRAVITY_TRANSCRIPT_DISCOVERY_INTERVAL
            }) {
                return;
            }
            self.last_discovery = Some(now);
            self.path = acorn_transcript::find_agent_run_transcript(
                &self.cwd,
                AgentKind::Antigravity,
                self.process_start,
            )
            .map(|(path, _)| path);
        }
        let Some(path) = self.path.clone() else {
            return;
        };
        let Ok(mut file) = std::fs::File::open(&path) else {
            return;
        };
        let Ok(metadata) = file.metadata() else {
            return;
        };
        if !metadata.file_type().is_file() {
            return;
        }
        if metadata.len() < self.offset {
            self.offset = 0;
            self.pending_bytes.clear();
            self.discard_until_newline = false;
            self.line_sequence = 0;
            self.pending_tools.clear();
        }
        let available = metadata.len().saturating_sub(self.offset);
        if available == 0 || file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut bytes = Vec::new();
        if file
            .take(available.min(MAX_ANTIGRAVITY_TRANSCRIPT_READ_BYTES))
            .read_to_end(&mut bytes)
            .is_err()
        {
            return;
        }
        self.offset = self.offset.saturating_add(bytes.len() as u64);
        self.consume_bytes(&bytes, on_event);
    }

    fn finish(&mut self, on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        self.last_discovery = None;
        for _ in 0..MAX_ANTIGRAVITY_FINISH_POLLS {
            let previous_path = self.path.clone();
            let previous_offset = self.offset;
            self.poll_now(on_event);
            if self.path == previous_path && self.offset == previous_offset {
                break;
            }
        }
        if !self.discard_until_newline && !self.pending_bytes.is_empty() {
            let line = std::mem::take(&mut self.pending_bytes);
            self.process_line(&line, on_event);
        }
    }

    fn consume_bytes(
        &mut self,
        mut bytes: &[u8],
        on_event: &mut dyn FnMut(ChatProviderStreamEvent),
    ) {
        if self.discard_until_newline {
            let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') else {
                return;
            };
            bytes = &bytes[newline + 1..];
            self.discard_until_newline = false;
        }
        self.pending_bytes.extend_from_slice(bytes);
        while let Some(newline) = self.pending_bytes.iter().position(|byte| *byte == b'\n') {
            let mut line = self.pending_bytes.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.len() <= MAX_ANTIGRAVITY_TRANSCRIPT_LINE_BYTES {
                self.process_line(&line, on_event);
            }
        }
        if self.pending_bytes.len() > MAX_ANTIGRAVITY_TRANSCRIPT_LINE_BYTES {
            self.pending_bytes.clear();
            self.discard_until_newline = true;
        }
    }

    fn process_line(&mut self, line: &[u8], on_event: &mut dyn FnMut(ChatProviderStreamEvent)) {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            return;
        };
        let line_type = value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if matches!(line_type, "" | "USER_INPUT" | "CONVERSATION_HISTORY") {
            return;
        }
        self.line_sequence = self.line_sequence.saturating_add(1);
        let step = value
            .get("step_index")
            .and_then(serde_json::Value::as_u64)
            .map(|step| step.to_string())
            .unwrap_or_else(|| self.line_sequence.to_string());
        let line_type_upper = line_type.to_ascii_uppercase();
        let provider_status = value
            .get("status")
            .and_then(serde_json::Value::as_str)
            .map(str::to_ascii_uppercase);
        let status = match provider_status.as_deref() {
            Some("ERROR" | "FAILED") => persistence::ChatActivityStatus::Error,
            Some("CANCELLED" | "CANCELED" | "STOPPED") => {
                persistence::ChatActivityStatus::Cancelled
            }
            _ if line_type_upper.contains("ERROR") => persistence::ChatActivityStatus::Error,
            _ => persistence::ChatActivityStatus::Complete,
        };

        if line_type == "PLANNER_RESPONSE" {
            let thinking = value
                .get("thinking")
                .and_then(json_display_text)
                .and_then(|detail| activity_detail(Some(&detail)));
            let has_thinking = thinking.is_some();
            if thinking.is_some() {
                on_event(ChatProviderStreamEvent::Activity(ChatActivityPatch {
                    id: format!("antigravity:{step}:reasoning"),
                    kind: persistence::ChatActivityKind::Reasoning,
                    title: Some("Reasoning".to_string()),
                    detail: thinking,
                    status: persistence::ChatActivityStatus::Complete,
                }));
            }
            let tool_calls = value
                .get("tool_calls")
                .and_then(serde_json::Value::as_array);
            if let Some(tool_calls) = tool_calls.filter(|calls| !calls.is_empty()) {
                if !has_thinking {
                    if let Some(detail) = value
                        .get("content")
                        .and_then(json_display_text)
                        .and_then(|detail| activity_detail(Some(&detail)))
                    {
                        on_event(ChatProviderStreamEvent::Activity(ChatActivityPatch {
                            id: format!("antigravity:{step}:reasoning"),
                            kind: persistence::ChatActivityKind::Reasoning,
                            title: Some("Reasoning".to_string()),
                            detail: Some(detail),
                            status: persistence::ChatActivityStatus::Complete,
                        }));
                    }
                }
                for (index, tool_call) in tool_calls
                    .iter()
                    .take(MAX_CHAT_TURN_ACTIVITIES.saturating_sub(self.pending_tools.len()))
                    .enumerate()
                {
                    let name = tool_call
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Tool");
                    let id = format!("antigravity:{step}:tool:{index}");
                    let kind = tool_activity_kind(name);
                    let args = tool_call.get("args");
                    let title = args
                        .and_then(|args| args.get("toolAction"))
                        .or_else(|| args.and_then(|args| args.get("toolSummary")))
                        .and_then(json_display_text)
                        .unwrap_or_else(|| humanize_activity_name(name));
                    on_event(ChatProviderStreamEvent::Activity(ChatActivityPatch {
                        id: id.clone(),
                        kind,
                        title: Some(title),
                        detail: tool_input_detail(args),
                        status: persistence::ChatActivityStatus::Running,
                    }));
                    self.pending_tools.push_back((id, kind));
                }
            } else if status == persistence::ChatActivityStatus::Error {
                on_event(ChatProviderStreamEvent::Activity(ChatActivityPatch {
                    id: format!("antigravity:{step}:error"),
                    kind: persistence::ChatActivityKind::Tool,
                    title: Some("Provider error".to_string()),
                    detail: value
                        .get("content")
                        .and_then(json_display_text)
                        .and_then(|detail| activity_detail(Some(&detail))),
                    status,
                }));
            }
            return;
        }

        if let Some((id, kind)) = self.pending_tools.pop_front() {
            on_event(ChatProviderStreamEvent::Activity(ChatActivityPatch {
                id,
                kind,
                title: None,
                detail: None,
                status,
            }));
        } else {
            on_event(ChatProviderStreamEvent::Activity(ChatActivityPatch {
                id: format!("antigravity:{step}:{line_type}"),
                kind: tool_activity_kind(line_type),
                title: Some(humanize_activity_name(line_type)),
                detail: None,
                status,
            }));
        }
    }
}

struct CliChatProviderAdapter {
    ai: crate::ai::AiExecutionRequest,
    cwd: PathBuf,
    cancellation: Option<crate::chat_runs::ChatCancellation>,
}

impl ChatProviderAdapter for CliChatProviderAdapter {
    fn capabilities(&self) -> ChatProviderCapabilities {
        ChatProviderCapabilities {
            native_thread: matches!(
                self.ai.provider,
                crate::ai::AiProvider::Claude
                    | crate::ai::AiProvider::Codex
                    | crate::ai::AiProvider::Antigravity
            ),
            streaming: true,
            attachments: false,
        }
    }

    fn send_message(&self, input: ChatProviderInput) -> AppResult<ProviderResponse> {
        let mut ignore_event: fn(ChatProviderStreamEvent) = ignore_chat_streaming_event;
        self.send_message_streaming(input, &mut ignore_event)
    }

    fn send_message_streaming(
        &self,
        input: ChatProviderInput,
        on_event: &mut dyn FnMut(ChatProviderStreamEvent),
    ) -> AppResult<ProviderResponse> {
        let invocation = resolve_chat_cli_invocation(&self.ai, &input)?;
        let started_at = SystemTime::now();
        let mut output_parser = ChatCliOutputParser::new(invocation.output_mode);
        let mut antigravity_follower = (self.ai.provider == crate::ai::AiProvider::Antigravity)
            .then(|| {
                AntigravityTranscriptFollower::new(
                    self.cwd.clone(),
                    invocation.resume_token.as_deref(),
                    started_at,
                )
            });
        let raw = crate::ai::run_resolved_streaming_in_dir_cancellable(
            &invocation.cli,
            &invocation.prompt,
            "Settings → Agents",
            Some(&self.cwd),
            self.cancellation.clone(),
            |event| match event {
                crate::ai::AiProcessStreamEvent::Stdout(chunk) => {
                    output_parser.push_chunk(chunk, on_event);
                }
                crate::ai::AiProcessStreamEvent::Tick => {
                    if let Some(follower) = antigravity_follower.as_mut() {
                        follower.poll(on_event);
                    }
                }
            },
        );
        if let Some(follower) = antigravity_follower.as_mut() {
            follower.finish(on_event);
        }
        output_parser.flush_pending(on_event);
        let raw = raw?;
        let content = output_parser.finish(&raw);
        let discovered_thread_id = invocation.transcript_discovery.and_then(|kind| {
            acorn_transcript::find_completed_agent_run(&self.cwd, kind, started_at)
        });
        let native_thread_id = invocation.native_thread_id.or(discovered_thread_id);
        let resume_token = invocation.resume_token.or_else(|| native_thread_id.clone());
        Ok(ProviderResponse {
            content,
            native_thread_id,
            resume_token,
            last_response_id: None,
            metadata: output_parser.provider_metadata(),
        })
    }
}

#[derive(Debug, Clone)]
struct ChatCliInvocation {
    cli: crate::ai::ResolvedAiCommand,
    prompt: String,
    native_thread_id: Option<String>,
    resume_token: Option<String>,
    transcript_discovery: Option<AgentKind>,
    output_mode: ChatCliOutputMode,
}

fn provider_thread_resume_cursor(thread: Option<&persistence::ProviderThread>) -> Option<String> {
    thread.and_then(|thread| {
        thread
            .resume_token
            .as_deref()
            .or(thread.native_thread_id.as_deref())
            .or(thread.last_response_id.as_deref())
            .map(str::trim)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_string)
    })
}

fn chat_prompt_for_provider_input(input: &ChatProviderInput) -> String {
    input
        .context
        .as_ref()
        .map(|context| context.prompt.clone())
        .unwrap_or_else(|| input.message.content.clone())
}

fn resolve_chat_cli_invocation(
    ai: &crate::ai::AiExecutionRequest,
    input: &ChatProviderInput,
) -> AppResult<ChatCliInvocation> {
    let _requested_model = input.model.as_deref();
    let prompt = chat_prompt_for_provider_input(input);
    let cursor = provider_thread_resume_cursor(input.thread.as_ref());
    match ai.provider {
        crate::ai::AiProvider::Claude => {
            let mut args = vec![
                "-p".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--include-partial-messages".to_string(),
            ];
            let thread_id = match cursor {
                Some(cursor) => {
                    args.push("--resume".to_string());
                    args.push(cursor.clone());
                    cursor
                }
                None => {
                    let thread_id = Uuid::new_v4().to_string();
                    args.push("--session-id".to_string());
                    args.push(thread_id.clone());
                    thread_id
                }
            };
            Ok(ChatCliInvocation {
                cli: crate::ai::ResolvedAiCommand {
                    command: "claude",
                    args,
                    prompt_transport: crate::ai::PromptTransport::Stdin,
                },
                prompt,
                native_thread_id: Some(thread_id.clone()),
                resume_token: Some(thread_id),
                transcript_discovery: None,
                output_mode: ChatCliOutputMode::ClaudeStreamJson,
            })
        }
        crate::ai::AiProvider::Codex => {
            if let Some(cursor) = cursor {
                Ok(ChatCliInvocation {
                    cli: crate::ai::ResolvedAiCommand {
                        command: "codex",
                        args: vec![
                            "exec".to_string(),
                            "--skip-git-repo-check".to_string(),
                            "--json".to_string(),
                            "resume".to_string(),
                            cursor.clone(),
                            "-".to_string(),
                        ],
                        prompt_transport: crate::ai::PromptTransport::Stdin,
                    },
                    prompt,
                    native_thread_id: Some(cursor.clone()),
                    resume_token: Some(cursor),
                    transcript_discovery: None,
                    output_mode: ChatCliOutputMode::CodexJson,
                })
            } else {
                Ok(ChatCliInvocation {
                    cli: crate::ai::ResolvedAiCommand {
                        command: "codex",
                        args: vec![
                            "exec".to_string(),
                            "--skip-git-repo-check".to_string(),
                            "--json".to_string(),
                        ],
                        prompt_transport: crate::ai::PromptTransport::Stdin,
                    },
                    prompt,
                    native_thread_id: None,
                    resume_token: None,
                    transcript_discovery: Some(AgentKind::Codex),
                    output_mode: ChatCliOutputMode::CodexJson,
                })
            }
        }
        crate::ai::AiProvider::Antigravity => {
            if let Some(cursor) = cursor {
                Ok(ChatCliInvocation {
                    cli: crate::ai::ResolvedAiCommand {
                        command: "agy",
                        args: vec![
                            "--conversation".to_string(),
                            cursor.clone(),
                            "-p".to_string(),
                        ],
                        prompt_transport: crate::ai::PromptTransport::Argument,
                    },
                    prompt,
                    native_thread_id: Some(cursor.clone()),
                    resume_token: Some(cursor),
                    transcript_discovery: None,
                    output_mode: ChatCliOutputMode::Text,
                })
            } else {
                let resolved = ai.resolve()?;
                Ok(ChatCliInvocation {
                    cli: resolved,
                    prompt,
                    native_thread_id: None,
                    resume_token: None,
                    transcript_discovery: Some(AgentKind::Antigravity),
                    output_mode: ChatCliOutputMode::Text,
                })
            }
        }
        _ => {
            let resolved = ai.resolve()?;
            Ok(ChatCliInvocation {
                cli: resolved,
                prompt,
                native_thread_id: None,
                resume_token: None,
                transcript_discovery: None,
                output_mode: ChatCliOutputMode::Text,
            })
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ChatContextOptions {
    pub recent_message_limit: usize,
    pub max_context_chars: usize,
    pub summary_threshold_chars: usize,
}

impl Default for ChatContextOptions {
    fn default() -> Self {
        Self {
            recent_message_limit: 12,
            max_context_chars: 12_000,
            summary_threshold_chars: 8_000,
        }
    }
}

fn chat_role_label(role: persistence::ChatRole) -> &'static str {
    match role {
        persistence::ChatRole::System => "system",
        persistence::ChatRole::User => "user",
        persistence::ChatRole::Assistant => "assistant",
        persistence::ChatRole::Tool => "tool",
    }
}

pub(crate) fn build_chat_execution_context(
    state: &persistence::ChatSessionState,
    current_user_message_id: &str,
    options: ChatContextOptions,
) -> AppResult<CompiledContext> {
    if !state
        .messages
        .iter()
        .any(|message| message.id == current_user_message_id)
    {
        return Err(AppError::Other(format!(
            "current user message not found: {current_user_message_id}"
        )));
    }

    let total_message_chars: usize = state
        .messages
        .iter()
        .map(|message| message.content.chars().count())
        .sum();
    let recent_limit = if total_message_chars <= options.summary_threshold_chars {
        state.messages.len().max(1)
    } else {
        options.recent_message_limit.max(1)
    };

    let mut selected = Vec::new();
    let mut selected_chars = 0usize;
    for message in state.messages.iter().rev() {
        let message_chars = message.content.chars().count();
        let must_include = message.id == current_user_message_id;
        let would_exceed_limit = selected.len() >= recent_limit
            || (selected_chars + message_chars > options.max_context_chars && !selected.is_empty());
        if !must_include && would_exceed_limit {
            continue;
        }
        selected.push(message);
        selected_chars += message_chars;
        if selected.len() >= recent_limit
            && selected.iter().any(|m| m.id == current_user_message_id)
        {
            break;
        }
    }
    selected.reverse();

    let mut prompt = String::from(
        "You are responding inside Acorn native chat mode.\n\
Use the compact execution context below. Acorn owns the visible transcript; \
provider-native hidden state is only available when a provider thread is supplied.\n\n",
    );
    if let Some(summary) = state
        .memory
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        prompt.push_str("Session summary:\n");
        prompt.push_str(summary);
        prompt.push_str("\n\n");
    }
    if !state.memory.important_decisions.is_empty() {
        prompt.push_str("Important decisions:\n");
        for decision in &state.memory.important_decisions {
            prompt.push_str("- ");
            prompt.push_str(decision);
            prompt.push('\n');
        }
        prompt.push('\n');
    }
    if !state.memory.facts.is_empty() {
        prompt.push_str("Facts:\n");
        for fact in &state.memory.facts {
            prompt.push_str("- ");
            prompt.push_str(fact);
            prompt.push('\n');
        }
        prompt.push('\n');
    }
    prompt.push_str("Recent messages:\n");
    let mut included_message_ids = Vec::new();
    for message in selected {
        included_message_ids.push(message.id.clone());
        prompt.push_str(chat_role_label(message.role));
        prompt.push_str(" [");
        prompt.push_str(&message.id);
        prompt.push_str("]:\n");
        prompt.push_str(&message.content);
        prompt.push_str("\n\n");
    }

    if prompt.chars().count() > options.max_context_chars {
        let keep_from = prompt
            .char_indices()
            .nth(prompt.chars().count() - options.max_context_chars)
            .map(|(idx, _)| idx)
            .unwrap_or(0);
        prompt = format!(
            "You are responding inside Acorn native chat mode.\n\
The compact context was truncated to fit the execution budget.\n\n{}",
            &prompt[keep_from..]
        );
    }

    Ok(CompiledContext {
        included_message_ids,
        summary_id: state.memory.through_message_id.clone(),
        prompt,
    })
}

fn apply_acorn_session_metadata(chat_state: &mut persistence::ChatSessionState, session: &Session) {
    chat_state.session.id = session.id.to_string();
    chat_state.session.workspace_path = Some(session.worktree_path.to_string_lossy().into_owned());
    chat_state.session.title = Some(session.name.clone());
}

fn provider_thread_has_cursor(thread: &persistence::ProviderThread) -> bool {
    thread.native_thread_id.is_some()
        || thread.resume_token.is_some()
        || thread.last_response_id.is_some()
}

fn provider_thread_index(
    state: &mut persistence::ChatSessionState,
    provider: &str,
    model: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
) -> usize {
    if let Some(index) = state
        .provider_threads
        .iter()
        .position(|thread| thread.provider == provider && thread.model.as_deref() == model)
    {
        return index;
    }
    state.provider_threads.push(persistence::ProviderThread {
        session_id: state.session_id.clone(),
        provider: provider.to_string(),
        model: model.map(str::to_string),
        native_thread_id: None,
        resume_token: None,
        last_response_id: None,
        updated_at: now,
    });
    state.provider_threads.len() - 1
}

fn native_thread_payload(
    thread: &persistence::ProviderThread,
    message: &persistence::ChatMessage,
) -> String {
    serde_json::json!({
        "thread": {
            "provider": thread.provider,
            "model": thread.model,
            "native_thread_id": thread.native_thread_id,
            "resume_token": thread.resume_token,
            "last_response_id": thread.last_response_id,
        },
        "message": {
            "id": message.id,
            "role": chat_role_label(message.role),
            "content": message.content,
        }
    })
    .to_string()
}

#[derive(Debug, Clone)]
pub(crate) struct StartedChatTurn {
    pub state: persistence::ChatSessionState,
    pub input: ChatProviderInput,
    turn_id: String,
    assistant_message_id: String,
    provider: String,
    model: Option<String>,
    thread_index: usize,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct ChatTurnRunResult {
    pub pending_state: persistence::ChatSessionState,
    pub final_state: persistence::ChatSessionState,
}

enum ChatTurnFinish {
    Response(ProviderResponse),
    Error(String),
    Cancelled,
}

struct ChatRetryBranch {
    state: persistence::ChatSessionState,
    content: String,
}

fn start_chat_turn(
    mut chat_state: persistence::ChatSessionState,
    session: Option<&Session>,
    ai: &crate::ai::AiExecutionRequest,
    content: String,
    capabilities: ChatProviderCapabilities,
    options: ChatContextOptions,
) -> AppResult<StartedChatTurn> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::Other(
            "chat message must not be empty".to_string(),
        ));
    }

    if let Some(session) = session {
        apply_acorn_session_metadata(&mut chat_state, session);
    }
    backfill_missing_assistant_provider_metadata(&mut chat_state);

    let provider = chat_provider_label(ai).to_string();
    let model = chat_model_label(ai);
    let now = chrono::Utc::now();
    chat_state.provider = Some(provider.clone());
    chat_state.model = model.clone();
    chat_state.session.active_provider = Some(provider.clone());
    chat_state.session.active_model = model.clone();
    chat_state.session.updated_at = now;
    chat_state.memory.session_id = chat_state.session_id.clone();

    let turn_id = Uuid::new_v4().to_string();
    let user_message_id = Uuid::new_v4().to_string();
    let assistant_message_id = Uuid::new_v4().to_string();
    let user_message = persistence::ChatMessage {
        id: user_message_id.clone(),
        session_id: Some(chat_state.session_id.clone()),
        turn_id: Some(turn_id.clone()),
        role: persistence::ChatRole::User,
        content,
        created_at: now,
        status: Some(persistence::ChatMessageStatus::Complete),
        metadata: Some(chat_provider_metadata(&provider)),
    };
    chat_state.messages.push(user_message.clone());

    let thread_index = provider_thread_index(&mut chat_state, &provider, model.as_deref(), now);
    let thread = chat_state.provider_threads[thread_index].clone();
    let use_native_thread = capabilities.native_thread && provider_thread_has_cursor(&thread);
    let (mode, context, prompt_or_payload, included_message_ids, summary_id) = if use_native_thread
    {
        (
            persistence::ContextSnapshotMode::NativeThread,
            None,
            native_thread_payload(&thread, &user_message),
            vec![user_message_id.clone()],
            None,
        )
    } else {
        let context = build_chat_execution_context(&chat_state, &user_message_id, options)?;
        let prompt = context.prompt.clone();
        let included = context.included_message_ids.clone();
        let summary_id = context.summary_id.clone();
        (
            persistence::ContextSnapshotMode::CompiledContext,
            Some(context),
            prompt,
            included,
            summary_id,
        )
    };

    chat_state.turns.push(persistence::ChatTurn {
        id: turn_id.clone(),
        session_id: chat_state.session_id.clone(),
        provider: provider.clone(),
        model: model.clone(),
        status: persistence::ChatTurnStatus::Running,
        user_message_id: user_message_id.clone(),
        assistant_message_id: Some(assistant_message_id.clone()),
        started_at: now,
        completed_at: None,
        error: None,
        activities: Vec::new(),
    });
    chat_state
        .context_snapshots
        .push(persistence::ContextSnapshot {
            turn_id: turn_id.clone(),
            session_id: chat_state.session_id.clone(),
            provider: provider.clone(),
            mode,
            included_message_ids,
            summary_id,
            prompt_or_payload,
            created_at: now,
        });
    chat_state.messages.push(persistence::ChatMessage {
        id: assistant_message_id.clone(),
        session_id: Some(chat_state.session_id.clone()),
        turn_id: Some(turn_id.clone()),
        role: persistence::ChatRole::Assistant,
        content: String::new(),
        created_at: now,
        status: Some(persistence::ChatMessageStatus::Pending),
        metadata: Some(chat_message_metadata(&provider, &turn_id, mode)),
    });
    chat_state.updated_at = now;

    Ok(StartedChatTurn {
        state: chat_state,
        input: ChatProviderInput {
            thread: Some(thread),
            message: user_message,
            context,
            model: model.clone(),
        },
        turn_id,
        assistant_message_id,
        provider,
        model,
        thread_index,
    })
}

fn finish_chat_turn(
    mut started: StartedChatTurn,
    finish: ChatTurnFinish,
) -> persistence::ChatSessionState {
    let completed_at = chrono::Utc::now();
    let (content, message_status, turn_status, response, error) = match finish {
        ChatTurnFinish::Response(response) => (
            response.content.trim().to_string(),
            persistence::ChatMessageStatus::Complete,
            persistence::ChatTurnStatus::Complete,
            Some(response),
            None,
        ),
        ChatTurnFinish::Error(message) => (
            message.clone(),
            persistence::ChatMessageStatus::Error,
            persistence::ChatTurnStatus::Error,
            None,
            Some(message),
        ),
        ChatTurnFinish::Cancelled => (
            "Cancelled".to_string(),
            persistence::ChatMessageStatus::Cancelled,
            persistence::ChatTurnStatus::Cancelled,
            None,
            None,
        ),
    };

    if let Some(message) = started
        .state
        .messages
        .iter_mut()
        .find(|message| message.id == started.assistant_message_id)
    {
        message.content = content;
        message.created_at = completed_at;
        message.status = Some(message_status);
        if let Some(metadata) = message
            .metadata
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
        {
            if let Some(response) = &response {
                if let Some(provider_metadata) = &response.metadata {
                    metadata.insert("provider_response".to_string(), provider_metadata.clone());
                }
            }
        }
    }

    if let Some(turn) = started
        .state
        .turns
        .iter_mut()
        .find(|turn| turn.id == started.turn_id)
    {
        finish_running_chat_activities(&mut turn.activities, turn_status, completed_at);
        turn.status = turn_status;
        turn.completed_at = Some(completed_at);
        turn.error = error;
    }

    if let Some(response) = response {
        if let Some(thread) = started.state.provider_threads.get_mut(started.thread_index) {
            if thread.provider == started.provider && thread.model == started.model {
                if response.native_thread_id.is_some() {
                    thread.native_thread_id = response.native_thread_id;
                }
                if response.resume_token.is_some() {
                    thread.resume_token = response.resume_token;
                }
                if response.last_response_id.is_some() {
                    thread.last_response_id = response.last_response_id;
                }
                thread.updated_at = completed_at;
            }
        }
    }
    started.state.session.updated_at = completed_at;
    started.state.updated_at = completed_at;
    started.state
}

fn append_streaming_chat_chunk(
    chat_state: &mut persistence::ChatSessionState,
    assistant_message_id: &str,
    chunk: &str,
) -> bool {
    if chunk.is_empty() {
        return false;
    }
    let Some(message) = chat_state
        .messages
        .iter_mut()
        .find(|message| message.id == assistant_message_id)
    else {
        return false;
    };
    if message.role != persistence::ChatRole::Assistant {
        return false;
    }
    message.content.push_str(chunk);
    if matches!(
        message.status,
        Some(persistence::ChatMessageStatus::Pending)
            | Some(persistence::ChatMessageStatus::Streaming)
    ) {
        message.status = Some(persistence::ChatMessageStatus::Streaming);
    }
    let now = chrono::Utc::now();
    chat_state.session.updated_at = now;
    chat_state.updated_at = now;
    true
}

fn upsert_chat_activity(
    chat_state: &mut persistence::ChatSessionState,
    turn_id: &str,
    mut patch: ChatActivityPatch,
) -> bool {
    patch.id = patch
        .id
        .trim()
        .chars()
        .take(MAX_CHAT_ACTIVITY_ID_CHARS)
        .collect();
    if patch.id.is_empty() {
        return false;
    }
    patch.title = patch.title.and_then(|title| {
        let title = title
            .trim()
            .chars()
            .take(MAX_CHAT_ACTIVITY_TITLE_CHARS)
            .collect::<String>();
        (!title.is_empty()).then_some(title)
    });
    patch.detail = patch
        .detail
        .as_deref()
        .and_then(|detail| activity_detail(Some(detail)));

    let Some(turn) = chat_state.turns.iter_mut().find(|turn| turn.id == turn_id) else {
        return false;
    };
    let now = chrono::Utc::now();
    if let Some(activity) = turn
        .activities
        .iter_mut()
        .find(|activity| activity.id == patch.id)
    {
        if let Some(title) = patch.title {
            activity.title = title;
        }
        if let Some(detail) = patch.detail {
            activity.detail = Some(detail);
        }
        activity.status = patch.status;
        activity.completed_at = match patch.status {
            persistence::ChatActivityStatus::Running => None,
            _ => Some(now),
        };
    } else {
        if turn.activities.len() >= MAX_CHAT_TURN_ACTIVITIES {
            return false;
        }
        let title = patch
            .title
            .unwrap_or_else(|| default_chat_activity_title(patch.kind).to_string());
        turn.activities.push(persistence::ChatActivity {
            id: patch.id,
            kind: patch.kind,
            title,
            detail: patch.detail,
            status: patch.status,
            started_at: now,
            completed_at: match patch.status {
                persistence::ChatActivityStatus::Running => None,
                _ => Some(now),
            },
        });
    }
    chat_state.session.updated_at = now;
    chat_state.updated_at = now;
    true
}

fn default_chat_activity_title(kind: persistence::ChatActivityKind) -> &'static str {
    match kind {
        persistence::ChatActivityKind::Reasoning => "Reasoning",
        persistence::ChatActivityKind::Tool => "Tool",
        persistence::ChatActivityKind::Command => "Command",
        persistence::ChatActivityKind::FileChange => "File changes",
        persistence::ChatActivityKind::WebSearch => "Web search",
        persistence::ChatActivityKind::Plan => "Plan",
    }
}

fn finish_running_chat_activities(
    activities: &mut [persistence::ChatActivity],
    turn_status: persistence::ChatTurnStatus,
    completed_at: chrono::DateTime<chrono::Utc>,
) {
    let status = match turn_status {
        persistence::ChatTurnStatus::Error => persistence::ChatActivityStatus::Error,
        persistence::ChatTurnStatus::Cancelled => persistence::ChatActivityStatus::Cancelled,
        _ => persistence::ChatActivityStatus::Complete,
    };
    for activity in activities {
        if activity.status == persistence::ChatActivityStatus::Running {
            activity.status = status;
            activity.completed_at = Some(completed_at);
        }
    }
}

fn chat_turn_finish_from_result(
    provider_result: AppResult<ProviderResponse>,
    was_cancelled: bool,
) -> ChatTurnFinish {
    if was_cancelled {
        return ChatTurnFinish::Cancelled;
    }
    match provider_result {
        Ok(response) => ChatTurnFinish::Response(response),
        Err(err) => ChatTurnFinish::Error(err.to_string()),
    }
}

fn cancel_chat_turn_in_state(
    mut chat_state: persistence::ChatSessionState,
    turn_id: &str,
) -> (persistence::ChatSessionState, bool) {
    let completed_at = chrono::Utc::now();
    let mut changed = false;

    if let Some(turn) = chat_state.turns.iter_mut().find(|turn| turn.id == turn_id) {
        if matches!(
            turn.status,
            persistence::ChatTurnStatus::Pending | persistence::ChatTurnStatus::Running
        ) {
            finish_running_chat_activities(
                &mut turn.activities,
                persistence::ChatTurnStatus::Cancelled,
                completed_at,
            );
            turn.status = persistence::ChatTurnStatus::Cancelled;
            turn.completed_at = Some(completed_at);
            turn.error = None;
            changed = true;
        }
    }

    for message in &mut chat_state.messages {
        if message.turn_id.as_deref() != Some(turn_id)
            || message.role != persistence::ChatRole::Assistant
        {
            continue;
        }
        if matches!(
            message.status,
            Some(persistence::ChatMessageStatus::Pending)
                | Some(persistence::ChatMessageStatus::Streaming)
        ) {
            message.content = "Cancelled".to_string();
            message.created_at = completed_at;
            message.status = Some(persistence::ChatMessageStatus::Cancelled);
            changed = true;
        }
    }

    if changed {
        chat_state.session.updated_at = completed_at;
        chat_state.updated_at = completed_at;
    }

    (chat_state, changed)
}

fn chat_state_has_running_message(chat_state: &persistence::ChatSessionState) -> bool {
    chat_state.messages.iter().any(|message| {
        matches!(
            message.status,
            Some(persistence::ChatMessageStatus::Pending)
                | Some(persistence::ChatMessageStatus::Streaming)
        )
    }) || chat_state.turns.iter().any(|turn| {
        matches!(
            turn.status,
            persistence::ChatTurnStatus::Pending | persistence::ChatTurnStatus::Running
        )
    })
}

fn ensure_chat_session_has_no_active_run(state: &AppState, session_id: &Uuid) -> AppResult<()> {
    if state.chat_runs.is_active(session_id) {
        return Err(AppError::Other(
            "cannot modify chat messages while a response is running".to_string(),
        ));
    }
    Ok(())
}

fn reset_chat_branch_hidden_context(chat_state: &mut persistence::ChatSessionState) {
    let remaining_message_ids = chat_state
        .messages
        .iter()
        .map(|message| message.id.clone())
        .collect::<HashSet<_>>();
    chat_state.turns.retain(|turn| {
        remaining_message_ids.contains(&turn.user_message_id)
            && turn
                .assistant_message_id
                .as_ref()
                .is_none_or(|id| remaining_message_ids.contains(id))
    });
    let remaining_turn_ids = chat_state
        .turns
        .iter()
        .map(|turn| turn.id.clone())
        .collect::<HashSet<_>>();
    chat_state
        .context_snapshots
        .retain(|snapshot| remaining_turn_ids.contains(&snapshot.turn_id));
    chat_state.provider_threads.clear();
    chat_state.memory = persistence::SessionMemory {
        session_id: chat_state.session_id.clone(),
        summary: None,
        important_decisions: Vec::new(),
        facts: Vec::new(),
        through_message_id: None,
        updated_at: chrono::Utc::now(),
    };
}

fn truncate_chat_state_before_message_index(
    mut chat_state: persistence::ChatSessionState,
    index: usize,
) -> persistence::ChatSessionState {
    chat_state.messages.truncate(index);
    reset_chat_branch_hidden_context(&mut chat_state);
    let now = chrono::Utc::now();
    chat_state.session.updated_at = now;
    chat_state.updated_at = now;
    chat_state
}

fn chat_message_index(
    chat_state: &persistence::ChatSessionState,
    message_id: &str,
) -> AppResult<usize> {
    chat_state
        .messages
        .iter()
        .position(|message| message.id == message_id)
        .ok_or_else(|| AppError::Other(format!("chat message not found: {message_id}")))
}

fn ensure_last_chat_message(
    chat_state: &persistence::ChatSessionState,
    message_id: &str,
    action: &str,
) -> AppResult<usize> {
    let index = chat_message_index(chat_state, message_id)?;
    if index + 1 != chat_state.messages.len() {
        return Err(AppError::Other(format!(
            "can {action} only the last chat message"
        )));
    }
    Ok(index)
}

fn delete_chat_branch_from_message(
    chat_state: persistence::ChatSessionState,
    message_id: &str,
) -> AppResult<persistence::ChatSessionState> {
    if chat_state_has_running_message(&chat_state) {
        return Err(AppError::Other(
            "cannot delete chat messages while a response is running".to_string(),
        ));
    }
    let index = ensure_last_chat_message(&chat_state, message_id, "delete")?;
    Ok(truncate_chat_state_before_message_index(chat_state, index))
}

fn retry_anchor_index(
    chat_state: &persistence::ChatSessionState,
    message_id: &str,
) -> AppResult<usize> {
    let index = chat_state
        .messages
        .iter()
        .position(|message| message.id == message_id)
        .ok_or_else(|| AppError::Other(format!("chat message not found: {message_id}")))?;
    match chat_state.messages[index].role {
        persistence::ChatRole::User => Ok(index),
        persistence::ChatRole::Assistant => chat_state.messages[..index]
            .iter()
            .rposition(|message| message.role == persistence::ChatRole::User)
            .ok_or_else(|| {
                AppError::Other(format!(
                    "assistant message has no user message to retry: {message_id}"
                ))
            }),
        _ => Err(AppError::Other(
            "only user and assistant messages can be retried".to_string(),
        )),
    }
}

fn prepare_chat_retry_branch(
    chat_state: persistence::ChatSessionState,
    message_id: &str,
    replacement_content: Option<String>,
) -> AppResult<ChatRetryBranch> {
    if chat_state_has_running_message(&chat_state) {
        return Err(AppError::Other(
            "cannot retry chat messages while a response is running".to_string(),
        ));
    }
    ensure_last_chat_message(&chat_state, message_id, "retry")?;
    let anchor_index = retry_anchor_index(&chat_state, message_id)?;
    let content = replacement_content
        .unwrap_or_else(|| chat_state.messages[anchor_index].content.clone())
        .trim()
        .to_string();
    if content.is_empty() {
        return Err(AppError::Other(
            "chat message must not be empty".to_string(),
        ));
    }
    Ok(ChatRetryBranch {
        state: truncate_chat_state_before_message_index(chat_state, anchor_index),
        content,
    })
}

fn chat_session_status_for_message_status(status: persistence::ChatMessageStatus) -> SessionStatus {
    match status {
        persistence::ChatMessageStatus::Pending | persistence::ChatMessageStatus::Streaming => {
            SessionStatus::Working
        }
        persistence::ChatMessageStatus::Complete | persistence::ChatMessageStatus::Cancelled => {
            SessionStatus::Ready
        }
        persistence::ChatMessageStatus::Error => SessionStatus::Errored,
    }
}

fn chat_session_status_for_state(chat_state: &persistence::ChatSessionState) -> SessionStatus {
    if chat_state_has_running_message(chat_state) {
        return SessionStatus::Working;
    }
    let last_message = chat_state.messages.last();
    let last_turn = chat_state.turns.last();
    if last_message
        .and_then(|message| message.status)
        .is_some_and(|status| status == persistence::ChatMessageStatus::Error)
        || last_turn.is_some_and(|turn| turn.status == persistence::ChatTurnStatus::Error)
    {
        SessionStatus::Errored
    } else {
        SessionStatus::Ready
    }
}

#[cfg(test)]
pub(crate) fn run_chat_turn_for_test(
    state: persistence::ChatSessionState,
    ai: crate::ai::AiExecutionRequest,
    content: String,
    adapter: &dyn ChatProviderAdapter,
) -> AppResult<ChatTurnRunResult> {
    let started = start_chat_turn(
        state,
        None,
        &ai,
        content,
        adapter.capabilities(),
        ChatContextOptions::default(),
    )?;
    let pending_state = started.state.clone();
    let provider_result = adapter.send_message(started.input.clone());
    let final_state = finish_chat_turn(
        started,
        chat_turn_finish_from_result(provider_result, false),
    );
    Ok(ChatTurnRunResult {
        pending_state,
        final_state,
    })
}

#[derive(Clone, Serialize)]
pub struct ChatSessionStateChangedPayload {
    pub session_id: String,
    pub state: persistence::ChatSessionState,
}

fn emit_chat_session_state_changed<R: Runtime>(
    app: &AppHandle<R>,
    state: &persistence::ChatSessionState,
) {
    if let Err(err) = app.emit(
        CHAT_SESSION_STATE_CHANGED_EVENT,
        ChatSessionStateChangedPayload {
            session_id: state.session_id.clone(),
            state: state.clone(),
        },
    ) {
        tracing::warn!(
            error = %err,
            session_id = %state.session_id,
            event = CHAT_SESSION_STATE_CHANGED_EVENT,
            "failed to emit chat session state change"
        );
    }
}

#[derive(Serialize)]
pub struct AcornIpcStatus {
    /// Filesystem path to the `acorn-ipc` binary that ships next to the
    /// running app. Empty when we couldn't resolve `current_exe` — should
    /// never happen in a packaged build but is handled gracefully for dev.
    pub bundled_path: String,
    /// True when the bundled binary actually exists at `bundled_path`. False
    /// in dev mode before `cargo build -p acorn-ipc --bin acorn-ipc` has run.
    pub bundled_exists: bool,
    /// Canonical Unix-socket path used by the IPC server.
    pub socket_path: String,
    /// True when the in-process IPC listener is currently running. Read
    /// directly from the shutdown handle in `AppState`, so this is
    /// authoritative — no socket round-trip needed.
    pub server_running: bool,
    /// Common shim locations the user might have installed to. Each entry
    /// includes whether the file is present so the Settings UI can show a
    /// "Installed" / "Not installed" badge without round-tripping back to
    /// the backend on every render.
    pub shim_paths: Vec<AcornIpcShim>,
}

#[derive(Serialize)]
pub struct AcornIpcShim {
    pub path: String,
    pub exists: bool,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct FolderPermissionWarmupResult {
    pub id: &'static str,
    pub path: String,
    pub status: &'static str,
    pub error: Option<String>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct MacosPermissionResetResult {
    pub id: &'static str,
    pub service: &'static str,
    pub status: &'static str,
    pub error: Option<String>,
}

#[derive(Clone, Copy)]
struct MacosTccService {
    id: &'static str,
    service: &'static str,
}

const MACOS_FOLDER_TCC_SERVICES: &[MacosTccService] = &[
    MacosTccService {
        id: "desktop",
        service: "SystemPolicyDesktopFolder",
    },
    MacosTccService {
        id: "documents",
        service: "SystemPolicyDocumentsFolder",
    },
    MacosTccService {
        id: "downloads",
        service: "SystemPolicyDownloadsFolder",
    },
];

const MACOS_DEVELOPER_TCC_SERVICES: &[MacosTccService] = &[
    MacosTccService {
        id: "desktop",
        service: "SystemPolicyDesktopFolder",
    },
    MacosTccService {
        id: "documents",
        service: "SystemPolicyDocumentsFolder",
    },
    MacosTccService {
        id: "downloads",
        service: "SystemPolicyDownloadsFolder",
    },
    MacosTccService {
        id: "screen_capture",
        service: "ScreenCapture",
    },
    MacosTccService {
        id: "accessibility",
        service: "Accessibility",
    },
    MacosTccService {
        id: "automation",
        service: "AppleEvents",
    },
    MacosTccService {
        id: "input_monitoring",
        service: "ListenEvent",
    },
    MacosTccService {
        id: "app_data",
        service: "SystemPolicyAppData",
    },
    MacosTccService {
        id: "developer_tools",
        service: "DeveloperTool",
    },
];

#[tauri::command]
pub async fn warm_macos_folder_permissions() -> AppResult<Vec<FolderPermissionWarmupResult>> {
    run_blocking("warm_macos_folder_permissions", move || {
        Ok(warm_macos_folder_permissions_inner())
    })
    .await
}

#[tauri::command]
pub async fn reset_macos_folder_permissions<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    let bundle_id = app.config().identifier.clone();
    run_blocking("reset_macos_folder_permissions", move || {
        reset_macos_folder_permissions_inner(&bundle_id)
    })
    .await
}

#[tauri::command]
pub async fn reset_macos_developer_permissions<R: Runtime>(
    app: AppHandle<R>,
) -> AppResult<Vec<MacosPermissionResetResult>> {
    let bundle_id = app.config().identifier.clone();
    run_blocking("reset_macos_developer_permissions", move || {
        Ok(reset_macos_developer_permissions_inner(&bundle_id))
    })
    .await
}

fn warm_macos_folder_permissions_inner() -> Vec<FolderPermissionWarmupResult> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }

    protected_folder_candidates()
        .into_iter()
        .map(|(id, path)| probe_folder_permission(id, path))
        .collect()
}

fn reset_macos_folder_permissions_inner(bundle_id: &str) -> AppResult<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }

    let failures: Vec<String> = MACOS_FOLDER_TCC_SERVICES
        .iter()
        .filter_map(|service| {
            reset_macos_tcc_service(service.service, bundle_id)
                .err()
                .map(|err| format!("{}: {err}", service.service))
        })
        .collect();

    if failures.is_empty() {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "failed to reset macOS folder permissions: {}",
            failures.join("; ")
        )))
    }
}

fn reset_macos_developer_permissions_inner(bundle_id: &str) -> Vec<MacosPermissionResetResult> {
    if !cfg!(target_os = "macos") {
        return MACOS_DEVELOPER_TCC_SERVICES
            .iter()
            .map(|service| MacosPermissionResetResult {
                id: service.id,
                service: service.service,
                status: "skipped",
                error: None,
            })
            .collect();
    }

    MACOS_DEVELOPER_TCC_SERVICES
        .iter()
        .map(
            |service| match reset_macos_tcc_service(service.service, bundle_id) {
                Ok(()) => MacosPermissionResetResult {
                    id: service.id,
                    service: service.service,
                    status: "reset",
                    error: None,
                },
                Err(err) => MacosPermissionResetResult {
                    id: service.id,
                    service: service.service,
                    status: "error",
                    error: Some(err.to_string()),
                },
            },
        )
        .collect()
}

fn reset_macos_tcc_service(service: &'static str, bundle_id: &str) -> AppResult<()> {
    match std::process::Command::new("/usr/bin/tccutil")
        .args(["reset", service, bundle_id])
        .output()
    {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let message = if stderr.is_empty() { stdout } else { stderr };
            Err(AppError::Other(if message.is_empty() {
                format!("tccutil exited with status {}", output.status)
            } else {
                message
            }))
        }
        Err(err) => Err(AppError::Io(err)),
    }
}

fn protected_folder_candidates() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let modern_icloud = home
        .join("Library")
        .join("CloudStorage")
        .join("iCloud Drive");
    let legacy_icloud = home
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs");
    let icloud = match modern_icloud.try_exists() {
        Ok(true) | Err(_) => modern_icloud,
        Ok(false) => legacy_icloud,
    };

    vec![
        ("desktop", home.join("Desktop")),
        ("documents", home.join("Documents")),
        ("downloads", home.join("Downloads")),
        ("icloud", icloud),
    ]
}

fn probe_folder_permission(id: &'static str, path: PathBuf) -> FolderPermissionWarmupResult {
    let rendered = path.display().to_string();
    match path.try_exists() {
        Ok(true) => {}
        Ok(false) => return folder_permission_missing(id, rendered),
        Err(err) => return folder_permission_error(id, rendered, err),
    };

    match std::fs::read_dir(&path) {
        Ok(entries) => {
            folder_permission_from_first_entry(id, rendered, entries.map(|entry| entry.map(|_| ())))
        }
        Err(err) => folder_permission_error(id, rendered, err),
    }
}

fn folder_permission_from_first_entry<I>(
    id: &'static str,
    path: String,
    mut entries: I,
) -> FolderPermissionWarmupResult
where
    I: Iterator<Item = io::Result<()>>,
{
    match entries.next() {
        Some(Err(err)) => folder_permission_error(id, path, err),
        Some(Ok(())) | None => FolderPermissionWarmupResult {
            id,
            path,
            status: "ok",
            error: None,
        },
    }
}

fn folder_permission_missing(id: &'static str, path: String) -> FolderPermissionWarmupResult {
    FolderPermissionWarmupResult {
        id,
        path,
        status: "missing",
        error: None,
    }
}

fn folder_permission_error(
    id: &'static str,
    path: String,
    err: io::Error,
) -> FolderPermissionWarmupResult {
    let status = if err.kind() == io::ErrorKind::PermissionDenied {
        "denied"
    } else {
        "error"
    };
    FolderPermissionWarmupResult {
        id,
        path,
        status,
        error: Some(err.to_string()),
    }
}

/// Inspect the runtime environment for the `acorn-ipc` CLI: where the
/// app-bundled binary lives, whether it exists yet, and whether the user
/// has already installed a shim into one of the standard `$PATH` locations.
/// Used by the Sessions tab's "Control sessions" section to render an
/// install hint with a copyable shell command.
#[tauri::command]
pub fn get_acorn_ipc_status(state: State<'_, AppState>) -> AcornIpcStatus {
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("acorn-ipc")));
    let bundled_path = bundled
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let bundled_exists = bundled.as_ref().map(|p| p.exists()).unwrap_or(false);
    let socket_path = acorn_ipc::socket_path::resolve().unwrap_or_default();
    let server_running = state
        .ipc_handle
        .lock()
        .as_ref()
        .map(|h| h.is_running())
        .unwrap_or(false);
    let shim_paths = standard_shim_paths()
        .into_iter()
        .map(|p| AcornIpcShim {
            exists: p.exists(),
            path: p.display().to_string(),
        })
        .collect();
    AcornIpcStatus {
        bundled_path,
        bundled_exists,
        socket_path: socket_path.display().to_string(),
        server_running,
        shim_paths,
    }
}

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    let mut fonts = BTreeSet::new();
    let mut remaining = 8_000usize;

    for dir in system_font_dirs() {
        collect_font_names(&dir, &mut fonts, &mut remaining);
        if remaining == 0 {
            break;
        }
    }

    fonts.into_iter().collect()
}

#[tauri::command]
pub async fn list_agent_history(
    repo_path: String,
    limit: Option<usize>,
) -> AppResult<Vec<AgentHistoryItem>> {
    run_blocking("list_agent_history", move || {
        agent_history::list_agent_history(PathBuf::from(repo_path), limit)
    })
    .await
}

#[tauri::command]
pub async fn agent_transcript_summary(
    repo_path: String,
    transcript_id: String,
) -> AppResult<Option<agent_history::AgentTranscriptSummary>> {
    run_blocking("agent_transcript_summary", move || {
        agent_history::agent_transcript_summary(PathBuf::from(repo_path), transcript_id)
    })
    .await
}

#[tauri::command]
pub async fn agent_transcript_summary_at_path(
    repo_path: String,
    provider: agent_history::AgentHistoryProvider,
    id: String,
    transcript_path: String,
) -> AppResult<Option<agent_history::AgentTranscriptSummary>> {
    run_blocking("agent_transcript_summary_at_path", move || {
        agent_history::agent_transcript_summary_at_path(
            PathBuf::from(repo_path),
            provider,
            id,
            PathBuf::from(transcript_path),
        )
    })
    .await
}

#[tauri::command]
pub async fn list_unscoped_agent_history(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> AppResult<Vec<AgentHistoryItem>> {
    let project_paths = state
        .projects
        .list()
        .into_iter()
        .map(|project| PathBuf::from(project.repo_path))
        .collect();
    run_blocking("list_unscoped_agent_history", move || {
        agent_history::list_unscoped_agent_history(project_paths, limit)
    })
    .await
}

#[tauri::command]
pub fn trash_agent_history_transcript(
    provider: agent_history::AgentHistoryProvider,
    id: String,
    transcript_path: String,
) -> AppResult<()> {
    agent_history::trash_agent_history_transcript(provider, id, PathBuf::from(transcript_path))
}

/// Stop the running IPC listener (if any) and spawn a fresh one. Used by
/// the Settings → Control sessions "Restart" button when the socket has
/// gone stale (e.g. socket file removed under the app's feet). The signal
/// → poll → exit cycle takes up to `ACCEPT_POLL_INTERVAL_MS`; we wait
/// twice that before rebinding so the previous listener has dropped its
/// file descriptor.
#[tauri::command]
pub fn ipc_restart<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let previous = state.ipc_handle.lock().take();
    if let Some(handle) = previous {
        handle.signal_stop();
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let new_handle = crate::ipc::server::start(app.clone(), state.inner().clone());
    let started = new_handle.is_some();
    *state.ipc_handle.lock() = new_handle;
    if started {
        Ok(())
    } else {
        Err("ipc server failed to start; see app logs for details".to_string())
    }
}

#[tauri::command]
pub fn ipc_list_workspaces_response(
    state: State<'_, AppState>,
    response: crate::ipc::workspaces::ListWorkspacesResponsePayload,
) -> Result<(), String> {
    let sender = state
        .ipc_workspace_requests
        .lock()
        .remove(&response.request_id)
        .ok_or_else(|| format!("no pending IPC workspace request {}", response.request_id))?;
    let result = match response.error {
        Some(error) => Err(error),
        None => Ok(response.workspaces),
    };
    sender
        .send(result)
        .map_err(|_| "IPC workspace request receiver dropped".to_string())
}

/// Locations a user might symlink the CLI into, in priority order. The
/// first one that exists is the canonical install for this user. Kept
/// macOS/Linux-only because the IPC server is Unix-socket based — Windows
/// is not supported yet.
fn standard_shim_paths() -> Vec<PathBuf> {
    let mut out = vec![
        PathBuf::from("/usr/local/bin/acorn-ipc"),
        PathBuf::from("/opt/homebrew/bin/acorn-ipc"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        out.push(PathBuf::from(&home).join(".local/bin/acorn-ipc"));
        out.push(PathBuf::from(&home).join("bin/acorn-ipc"));
    }
    out
}

fn system_font_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/System/Library/Fonts"),
        PathBuf::from("/Library/Fonts"),
        PathBuf::from("/usr/share/fonts"),
        PathBuf::from("/usr/local/share/fonts"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        dirs.push(home.join("Library/Fonts"));
        dirs.push(home.join(".local/share/fonts"));
        dirs.push(home.join(".fonts"));
    }
    dirs
}

fn collect_font_names(dir: &Path, fonts: &mut BTreeSet<String>, remaining: &mut usize) {
    if *remaining == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        if *remaining == 0 {
            return;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_font_names(&path, fonts, remaining);
            continue;
        }
        if !file_type.is_file() || !is_font_file(&path) {
            continue;
        }
        *remaining -= 1;
        if let Some(name) = font_name_from_path(&path) {
            fonts.insert(name);
        }
    }
}

fn is_font_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("ttf" | "otf" | "ttc")
    )
}

fn font_name_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let mut words: Vec<&str> = stem
        .split(['-', '_', ' '])
        .filter(|part| !part.is_empty())
        .collect();
    while words
        .last()
        .map(|word| is_style_suffix(word))
        .unwrap_or(false)
    {
        words.pop();
    }
    let name = words.join(" ");
    let cleaned = name.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn is_style_suffix(word: &str) -> bool {
    let normalized = word
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>();
    if is_style_suffix_base(&normalized) {
        return true;
    }
    for suffix in ["italic", "oblique"] {
        if let Some(base) = normalized.strip_suffix(suffix) {
            return is_style_suffix_base(base);
        }
    }
    false
}

fn is_style_suffix_base(word: &str) -> bool {
    matches!(
        word,
        "black"
            | "bold"
            | "book"
            | "condensed"
            | "demi"
            | "demibold"
            | "expanded"
            | "extra"
            | "extrabold"
            | "extralight"
            | "heavy"
            | "italic"
            | "light"
            | "medium"
            | "oblique"
            | "regular"
            | "roman"
            | "semi"
            | "semibold"
            | "thin"
            | "ultra"
            | "ultrabold"
            | "ultralight"
    )
}

fn persist(state: &AppState) {
    persist_sessions(state);
    if let Err(e) = persistence::save_projects(&state.projects.list()) {
        tracing::warn!("failed to persist projects: {e}");
    }
}

fn persist_sessions(state: &AppState) {
    if let Err(e) = persistence::save_sessions(&state.sessions) {
        tracing::warn!("failed to persist sessions: {e}");
    }
}

fn project_basename(repo_path: &std::path::Path) -> String {
    repo_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_else(|| repo_path.to_str().unwrap_or("project"))
        .to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadStatus {
    pub sessions_clean: bool,
    pub projects_clean: bool,
}

/// Report whether boot-time persistence loads were clean. Frontend consults
/// this once at startup to decide whether the empty-list reconcile path is
/// safe (clean = true) or a likely sign of disk corruption (clean = false).
#[tauri::command]
pub fn load_status(state: State<'_, AppState>) -> LoadStatus {
    LoadStatus {
        sessions_clean: state
            .sessions_loaded_cleanly
            .load(std::sync::atomic::Ordering::SeqCst),
        projects_clean: state
            .projects_loaded_cleanly
            .load(std::sync::atomic::Ordering::SeqCst),
    }
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<Session> {
    reconcile_stale_worktrees(&state);
    state
        .sessions
        .list()
        .into_iter()
        .map(enrich_session)
        .collect()
}

/// Sweep sessions whose linked worktree directory has vanished (e.g. the
/// agent pruned its worktree on exit) and re-point them at the project's
/// main repo. Without this, every subsequent git op (`list_commits`,
/// `list_staged`, `diff_*`) for that session bubbles a raw `ensure_repo`
/// failure ("could not find git repository from '<missing-path>'") into
/// the UI. Only touches sessions where the parent project still exists,
/// so a temporarily unmounted repo doesn't trip the cleanup.
fn reconcile_stale_worktrees(state: &AppState) {
    let mut dirty = false;
    for session in state.sessions.list() {
        if session.worktree_path == session.repo_path {
            continue;
        }
        if !session.repo_path.exists() {
            continue;
        }
        if session.worktree_path.exists() {
            continue;
        }
        if state
            .sessions
            .reconcile_missing_worktree(&session.id)
            .is_ok()
        {
            dirty = true;
        }
    }
    if dirty {
        persist(state);
    }
}

/// Attach derived fields (`branch`, `in_worktree`) computed from the
/// session's current on-disk state. Pure: never mutates the persisted
/// store. Called on every Session leaving the backend so the frontend
/// sees fresh values without a second round-trip.
fn enrich_session(mut s: Session) -> Session {
    if let Ok(branch) = worktree::current_branch(&s.worktree_path) {
        s.branch = branch;
    }
    s.in_worktree = worktree::is_linked_worktree_root(&s.worktree_path);
    let live = crate::agent_resume::live_transcript(s.id);
    s.agent_transcript_id = live.as_ref().map(|transcript| transcript.id.clone());
    s
}

static MEMORY_PROBE: Mutex<Option<System>> = Mutex::new(None);

#[derive(serde::Serialize)]
pub struct MemoryProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    /// Full command line (executable + args), space-joined. May be empty when
    /// the kernel doesn't expose argv (sandboxing, permission, kernel proc).
    pub command_line: String,
    pub bytes: u64,
    pub depth: u32,
}

#[derive(Clone)]
struct ProcessMemorySnapshot {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    command_line: String,
    bytes: u64,
}

#[cfg(test)]
impl ProcessMemorySnapshot {
    fn new(pid: u32, parent_pid: Option<u32>, name: &str, bytes: u64) -> Self {
        Self {
            pid,
            parent_pid,
            name: name.to_string(),
            command_line: name.to_string(),
            bytes,
        }
    }
}

/// Best-effort process display name. `proc.name()` is unreliable on macOS —
/// it can return a stale or truncated name (e.g. shows the launcher shell
/// instead of the actual binary, or a 15-char truncation). Prefer the
/// executable file name, then the first `cmd` token, then the raw `name()`.
fn process_display_name(proc: &sysinfo::Process) -> String {
    if let Some(exe) = proc.exe() {
        if let Some(file) = exe.file_name().and_then(|s| s.to_str()) {
            if !file.is_empty() {
                return file.to_string();
            }
        }
    }
    if let Some(first) = proc.cmd().first() {
        let s = first.to_string_lossy();
        let basename = std::path::Path::new(s.as_ref())
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(s.as_ref());
        if !basename.is_empty() {
            return basename.to_string();
        }
    }
    proc.name().to_string_lossy().into_owned()
}

fn process_command_line(proc: &sysinfo::Process) -> String {
    let parts: Vec<String> = proc
        .cmd()
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    parts.join(" ")
}

fn should_remove_local_project_mirror(removed: &Session, remaining: &[Session]) -> bool {
    !removed.project_scoped
        && !remaining
            .iter()
            .any(|session| session.project_scoped && session.repo_path == removed.repo_path)
}

fn process_memory_snapshot(pid: Pid, proc: &sysinfo::Process) -> ProcessMemorySnapshot {
    ProcessMemorySnapshot {
        pid: pid.as_u32(),
        parent_pid: proc.parent().map(|p| p.as_u32()),
        name: process_display_name(proc),
        command_line: process_command_line(proc),
        bytes: proc.memory(),
    }
}

#[derive(serde::Serialize)]
pub struct MemoryUsage {
    /// Total resident set size in bytes — app process tree plus known sidecars.
    pub bytes: u64,
    pub processes: Vec<MemoryProcess>,
}

fn basename(s: &str) -> &str {
    s.rsplit('/').next().unwrap_or(s)
}

fn snapshot_basename_matches(snapshot: &ProcessMemorySnapshot, target: &str) -> bool {
    if basename(&snapshot.name) == target {
        return true;
    }
    snapshot
        .command_line
        .split_whitespace()
        .next()
        .map(|first| basename(first) == target)
        .unwrap_or(false)
}

fn daemon_pid_from_status_sessions_or_pidfile(
    state: &State<'_, AppState>,
    snapshots_by_pid: &HashMap<u32, &ProcessMemorySnapshot>,
) -> Option<u32> {
    match state.daemon_bridge.status() {
        Ok(snapshot) => snapshot
            .pid
            .or_else(|| {
                let session_pids: Vec<u32> = state
                    .daemon_bridge
                    .list_sessions()
                    .ok()?
                    .into_iter()
                    .filter_map(|session| session.pid)
                    .collect();
                infer_acornd_root_from_session_pids(snapshots_by_pid, &session_pids)
            })
            .or_else(daemon_pid_from_pidfile),
        Err(_) => daemon_pid_from_pidfile(),
    }
}

fn daemon_pid_from_pidfile() -> Option<u32> {
    let path = acorn_daemon::paths::pid_file_path().ok()?;
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn memory_root_pids(
    snapshots_by_pid: &HashMap<u32, &ProcessMemorySnapshot>,
    app_pid: u32,
    daemon_pid: Option<u32>,
) -> Vec<u32> {
    let mut roots = vec![app_pid];
    if let Some(pid) = daemon_pid {
        if snapshots_by_pid
            .get(&pid)
            .map(|snapshot| snapshot_basename_matches(snapshot, "acornd"))
            .unwrap_or(false)
        {
            roots.push(pid);
        }
    }
    roots
}

fn infer_acornd_root_from_session_pids(
    snapshots_by_pid: &HashMap<u32, &ProcessMemorySnapshot>,
    session_pids: &[u32],
) -> Option<u32> {
    for session_pid in session_pids {
        let mut pid = Some(*session_pid);
        let mut visited: HashSet<u32> = HashSet::new();
        while let Some(current) = pid {
            if !visited.insert(current) {
                break;
            }
            let Some(snapshot) = snapshots_by_pid.get(&current) else {
                break;
            };
            if snapshot_basename_matches(snapshot, "acornd") {
                return Some(current);
            }
            pid = snapshot.parent_pid;
        }
    }
    None
}

fn collect_memory_usage_from_roots(
    snapshots: &[ProcessMemorySnapshot],
    root_pids: &[u32],
) -> MemoryUsage {
    let by_pid: HashMap<u32, &ProcessMemorySnapshot> =
        snapshots.iter().map(|p| (p.pid, p)).collect();
    let mut children_of: HashMap<u32, Vec<u32>> = HashMap::new();
    for snapshot in snapshots {
        if let Some(parent_pid) = snapshot.parent_pid {
            children_of
                .entry(parent_pid)
                .or_default()
                .push(snapshot.pid);
        }
    }

    let mut processes: Vec<MemoryProcess> = Vec::new();
    let mut total: u64 = 0;
    let mut frontier: Vec<(u32, u32)> = root_pids.iter().rev().map(|pid| (*pid, 0)).collect();
    let mut visited: HashSet<u32> = HashSet::new();

    while let Some((pid, depth)) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        let Some(snapshot) = by_pid.get(&pid) else {
            continue;
        };
        total = total.saturating_add(snapshot.bytes);
        processes.push(MemoryProcess {
            pid,
            parent_pid: snapshot.parent_pid,
            name: snapshot.name.clone(),
            command_line: snapshot.command_line.clone(),
            bytes: snapshot.bytes,
            depth,
        });
        if let Some(children) = children_of.get(&pid) {
            for child_pid in children.iter().rev() {
                if !visited.contains(child_pid) {
                    frontier.push((*child_pid, depth + 1));
                }
            }
        }
    }

    processes.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    MemoryUsage {
        bytes: total,
        processes,
    }
}

#[tauri::command]
pub fn get_memory_usage(state: State<'_, AppState>) -> MemoryUsage {
    // Recover a poisoned probe rather than panicking the command: the
    // cached `System` is refreshed from scratch below either way.
    let mut guard = MEMORY_PROBE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let refresh = ProcessRefreshKind::nothing()
        .with_memory()
        .with_exe(UpdateKind::Always)
        .with_cmd(UpdateKind::Always);
    let sys = guard.get_or_insert_with(|| {
        System::new_with_specifics(RefreshKind::nothing().with_processes(refresh))
    });
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);

    let snapshots: Vec<ProcessMemorySnapshot> = sys
        .processes()
        .iter()
        .map(|(pid, proc)| process_memory_snapshot(*pid, proc))
        .collect();
    let snapshots_by_pid: HashMap<u32, &ProcessMemorySnapshot> =
        snapshots.iter().map(|p| (p.pid, p)).collect();
    let root_pids = memory_root_pids(
        &snapshots_by_pid,
        std::process::id(),
        daemon_pid_from_status_sessions_or_pidfile(&state, &snapshots_by_pid),
    );

    collect_memory_usage_from_roots(&snapshots, &root_pids)
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, AppState>,
    name: String,
    repo_path: String,
    cwd_path: Option<String>,
    isolated: Option<bool>,
    kind: Option<SessionKind>,
    agent_provider: Option<SessionAgentProvider>,
    project_scoped: Option<bool>,
    mode: Option<SessionMode>,
) -> AppResult<Session> {
    create_session_inner(
        state.inner(),
        name,
        PathBuf::from(repo_path),
        cwd_path.map(PathBuf::from),
        isolated.unwrap_or(false),
        kind.unwrap_or_default(),
        agent_provider,
        project_scoped.unwrap_or(true),
        mode.unwrap_or_default(),
        false,
    )
}

#[tauri::command]
pub async fn create_session_from_dialog<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
    isolated: Option<bool>,
    kind: Option<SessionKind>,
    agent_provider: Option<SessionAgentProvider>,
    project_scoped: Option<bool>,
    mode: Option<SessionMode>,
    title: Option<String>,
) -> AppResult<Option<Session>> {
    let Some(selected_path) = pick_folder_path(&app, title).await? else {
        return Ok(None);
    };
    Ok(Some(create_session_inner(
        state.inner(),
        name,
        selected_path,
        None,
        isolated.unwrap_or(false),
        kind.unwrap_or_default(),
        agent_provider,
        project_scoped.unwrap_or(true),
        mode.unwrap_or_default(),
        true,
    )?))
}

fn create_session_inner(
    state: &AppState,
    mut name: String,
    selected_path: PathBuf,
    cwd_path: Option<PathBuf>,
    isolated: bool,
    kind: SessionKind,
    agent_provider: Option<SessionAgentProvider>,
    project_scoped: bool,
    mode: SessionMode,
    allow_project_registration: bool,
) -> AppResult<Session> {
    let selected_path = canonical_existing_path(&selected_path)?;
    let cwd_path = cwd_path
        .map(|path| canonical_existing_path(&path))
        .transpose()?;
    let repo = if project_scoped || isolated {
        let repo = worktree::project_root_for_path(&selected_path)?;
        if allow_project_registration {
            state.projects.ensure(repo.clone(), project_basename(&repo));
        } else {
            authorize_registered_project_root(state, &repo)?;
        }
        if !isolated {
            if let Some(cwd) = cwd_path.as_deref() {
                authorize_project_session_cwd(&repo, cwd)?;
            }
        }
        repo
    } else {
        let root = authorize_local_session_root(&selected_path)?;
        if let Some(cwd) = cwd_path.as_deref() {
            authorize_local_session_root(cwd)?;
        }
        root
    };
    let worktree_path = if isolated {
        if name.trim().is_empty() {
            name = project_basename(&repo);
        }
        let base = sanitize_worktree_name(&name);
        let (_safe_name, path) = create_unique_worktree(&repo, &base)?;
        path
    } else {
        cwd_path.unwrap_or(selected_path)
    };
    if name.trim().is_empty() {
        name = project_basename(&worktree_path);
    }
    let branch = worktree::current_branch(&worktree_path).unwrap_or_else(|_| "HEAD".to_string());
    let mut session = Session::new(name, repo.clone(), worktree_path, branch, isolated, kind);
    session.project_scoped = project_scoped;
    session.auto_title_enabled = Some(auto_title_enabled_for_new_session(
        kind,
        mode,
        agent_provider,
    ));
    session.agent_provider = agent_provider;
    session.mode = mode;
    let inserted = state.sessions.insert(session);
    if project_scoped {
        state.projects.ensure(repo.clone(), project_basename(&repo));
    }
    persist(state);
    Ok(enrich_session(inserted))
}

fn auto_title_enabled_for_new_session(
    kind: SessionKind,
    mode: SessionMode,
    agent_provider: Option<SessionAgentProvider>,
) -> bool {
    kind == SessionKind::Regular && (mode == SessionMode::Chat || agent_provider.is_some())
}

#[tauri::command]
pub async fn load_chat_session_state(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let session_id = session.id.to_string();
    let mut chat_state = run_blocking("load chat session state", move || {
        persistence::load_chat_session_state(&session_id)
    })
    .await?;
    apply_acorn_session_metadata(&mut chat_state, &session);
    if backfill_latest_empty_codex_assistant_message(&mut chat_state) {
        let repaired_state = chat_state.clone();
        match run_blocking("save repaired chat session state", move || {
            persistence::save_chat_session_state(repaired_state)
        })
        .await
        {
            Ok(saved) => {
                chat_state = saved;
                apply_acorn_session_metadata(&mut chat_state, &session);
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    session_id = %chat_state.session_id,
                    "failed to persist repaired chat session state"
                );
            }
        }
    }
    Ok(chat_state)
}

#[tauri::command]
pub async fn save_chat_session_state(
    state: State<'_, AppState>,
    mut chat_state: persistence::ChatSessionState,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &chat_state.session_id)?;
    chat_state.session_id = session.id.to_string();
    apply_acorn_session_metadata(&mut chat_state, &session);
    run_blocking("save chat session state", move || {
        persistence::save_chat_session_state(chat_state)
    })
    .await
}

#[tauri::command]
pub async fn append_chat_message(
    state: State<'_, AppState>,
    session_id: String,
    message: persistence::ChatMessage,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let session_id = session.id.to_string();
    run_blocking("append chat message", move || {
        persistence::append_chat_message(&session_id, message)
    })
    .await
}

#[tauri::command]
pub async fn update_chat_message(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
    patch: persistence::ChatMessagePatch,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let session_id = session.id.to_string();
    run_blocking("update chat message", move || {
        persistence::update_chat_message(&session_id, &message_id, patch)
    })
    .await
}

#[tauri::command]
pub async fn send_chat_message<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    ai: crate::ai::AiExecutionRequest,
    content: String,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let app_state = state.inner().clone();
    run_blocking("send chat message", move || {
        send_chat_message_inner(&app, &app_state, session, ai, content)
    })
    .await
}

fn send_chat_message_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    ai: crate::ai::AiExecutionRequest,
    content: String,
) -> AppResult<persistence::ChatSessionState> {
    let chat_state = persistence::load_chat_session_state(&session.id.to_string())?;
    send_chat_message_from_state_inner(app, state, session, ai, content, chat_state)
}

fn send_chat_message_from_state_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    ai: crate::ai::AiExecutionRequest,
    content: String,
    chat_state: persistence::ChatSessionState,
) -> AppResult<persistence::ChatSessionState> {
    let mut adapter = CliChatProviderAdapter {
        ai: ai.clone(),
        cwd: session.worktree_path.clone(),
        cancellation: None,
    };
    let mut started = start_chat_turn(
        chat_state,
        Some(&session),
        &ai,
        content,
        adapter.capabilities(),
        ChatContextOptions::default(),
    )?;
    let cancellation = state.chat_runs.start(session.id, started.turn_id.clone())?;
    adapter.cancellation = Some(cancellation.clone());
    match persistence::save_chat_session_state(started.state) {
        Ok(saved) => {
            started.state = saved;
        }
        Err(err) => {
            state.chat_runs.finish(&session.id, &started.turn_id);
            return Err(err);
        }
    }
    state.sessions.update_status(
        &session.id,
        chat_session_status_for_message_status(persistence::ChatMessageStatus::Pending),
    )?;
    persist(state);
    emit_chat_session_state_changed(app, &started.state);

    let provider_input = started.input.clone();
    let assistant_message_id = started.assistant_message_id.clone();
    let provider_result = if adapter.capabilities().streaming {
        let turn_id = started.turn_id.clone();
        let mut on_event = |event| {
            let changed = match event {
                ChatProviderStreamEvent::AssistantTextDelta(chunk) => {
                    append_streaming_chat_chunk(&mut started.state, &assistant_message_id, &chunk)
                }
                ChatProviderStreamEvent::Activity(activity) => {
                    upsert_chat_activity(&mut started.state, &turn_id, activity)
                }
            };
            if changed {
                emit_chat_session_state_changed(app, &started.state);
            }
        };
        adapter.send_message_streaming(provider_input, &mut on_event)
    } else {
        adapter.send_message(provider_input)
    };
    let was_cancelled = cancellation.is_cancelled();
    state.chat_runs.finish(&session.id, &started.turn_id);
    let final_session_status = chat_session_status_for_message_status(if was_cancelled {
        persistence::ChatMessageStatus::Cancelled
    } else if provider_result.is_ok() {
        persistence::ChatMessageStatus::Complete
    } else {
        persistence::ChatMessageStatus::Error
    });
    let chat_state = finish_chat_turn(
        started,
        chat_turn_finish_from_result(provider_result, was_cancelled),
    );
    let chat_state = persistence::save_chat_session_state(chat_state)?;
    state
        .sessions
        .update_status(&session.id, final_session_status)?;
    persist(state);
    emit_chat_session_state_changed(app, &chat_state);
    Ok(chat_state)
}

#[tauri::command]
pub async fn retry_chat_message<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    ai: crate::ai::AiExecutionRequest,
    message_id: String,
    content: Option<String>,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let app_state = state.inner().clone();
    run_blocking("retry chat message", move || {
        retry_chat_message_inner(&app, &app_state, session, ai, message_id, content)
    })
    .await
}

fn retry_chat_message_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    ai: crate::ai::AiExecutionRequest,
    message_id: String,
    content: Option<String>,
) -> AppResult<persistence::ChatSessionState> {
    ensure_chat_session_has_no_active_run(state, &session.id)?;
    let chat_state = persistence::load_chat_session_state(&session.id.to_string())?;
    let branch = prepare_chat_retry_branch(chat_state, &message_id, content)?;
    send_chat_message_from_state_inner(app, state, session, ai, branch.content, branch.state)
}

#[tauri::command]
pub async fn delete_chat_message<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let app_state = state.inner().clone();
    run_blocking("delete chat message", move || {
        delete_chat_message_inner(&app, &app_state, session, message_id)
    })
    .await
}

fn delete_chat_message_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
    message_id: String,
) -> AppResult<persistence::ChatSessionState> {
    ensure_chat_session_has_no_active_run(state, &session.id)?;
    let chat_state = persistence::load_chat_session_state(&session.id.to_string())?;
    let mut chat_state = delete_chat_branch_from_message(chat_state, &message_id)?;
    apply_acorn_session_metadata(&mut chat_state, &session);
    let chat_state = persistence::save_chat_session_state(chat_state)?;
    state
        .sessions
        .update_status(&session.id, chat_session_status_for_state(&chat_state))?;
    persist(state);
    emit_chat_session_state_changed(app, &chat_state);
    Ok(chat_state)
}

#[tauri::command]
pub async fn cancel_chat_message<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<persistence::ChatSessionState> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    let app_state = state.inner().clone();
    run_blocking("cancel chat message", move || {
        cancel_chat_message_inner(&app, &app_state, session)
    })
    .await
}

fn cancel_chat_message_inner<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    session: Session,
) -> AppResult<persistence::ChatSessionState> {
    let session_id = session.id.to_string();
    let Some(cancellation) = state.chat_runs.cancel(&session.id) else {
        let mut chat_state = persistence::load_chat_session_state(&session_id)?;
        apply_acorn_session_metadata(&mut chat_state, &session);
        return Ok(chat_state);
    };

    let chat_state = persistence::load_chat_session_state(&session_id)?;
    let (mut chat_state, changed) = cancel_chat_turn_in_state(chat_state, cancellation.turn_id());
    apply_acorn_session_metadata(&mut chat_state, &session);
    if !changed {
        return Ok(chat_state);
    }

    let chat_state = persistence::save_chat_session_state(chat_state)?;
    state.sessions.update_status(
        &session.id,
        chat_session_status_for_message_status(persistence::ChatMessageStatus::Cancelled),
    )?;
    persist(state);
    emit_chat_session_state_changed(app, &chat_state);
    Ok(chat_state)
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Vec<Project> {
    state.projects.list()
}

#[tauri::command]
pub async fn add_project<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    title: Option<String>,
) -> AppResult<Option<Project>> {
    let Some(path) = pick_folder_path(&app, title).await? else {
        return Ok(None);
    };
    let path = worktree::project_root_for_path(&path)?;
    let project = state.projects.ensure(path.clone(), project_basename(&path));
    persist(&state);
    Ok(Some(project))
}

#[tauri::command]
pub async fn select_project_parent_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let Some(path) = pick_folder_path(&app, title).await? else {
        return Ok(None);
    };
    let path = remember_folder_grant(state.inner(), &path)?;
    if let Err(err) = persistence::save_last_project_parent_folder(&path) {
        tracing::warn!(
            error = %err,
            path = %path.display(),
            "failed to remember project parent folder"
        );
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn get_last_project_parent_folder(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let data_dir = persistence::data_dir()?;
    get_last_project_parent_folder_from_dir(state.inner(), &data_dir)
}

fn get_last_project_parent_folder_from_dir(
    state: &AppState,
    data_dir: &Path,
) -> AppResult<Option<String>> {
    let remembered = match persistence::load_last_project_parent_folder_from_dir(data_dir) {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!(error = %err, "failed to load remembered project parent folder");
            if let Err(clear_err) = persistence::clear_last_project_parent_folder_from_dir(data_dir)
            {
                tracing::warn!(
                    error = %clear_err,
                    "failed to clear invalid remembered project parent folder"
                );
            }
            return Ok(None);
        }
    };
    let Some(path) = remembered else {
        return Ok(None);
    };

    if !path.is_dir() {
        if let Err(err) = persistence::clear_last_project_parent_folder_from_dir(data_dir) {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "failed to clear missing remembered project parent folder"
            );
        }
        return Ok(None);
    }

    match remember_folder_grant(state, &path) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(err) => {
            tracing::warn!(
                error = %err,
                path = %path.display(),
                "remembered project parent folder is no longer accessible"
            );
            if let Err(clear_err) = persistence::clear_last_project_parent_folder_from_dir(data_dir)
            {
                tracing::warn!(
                    error = %clear_err,
                    "failed to clear inaccessible remembered project parent folder"
                );
            }
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn create_new_project(
    state: State<'_, AppState>,
    parent_path: String,
    name: String,
    ignore_safe_name: Option<bool>,
    init_commit: Option<bool>,
) -> AppResult<Project> {
    let name = validate_new_project_name(&name, ignore_safe_name.unwrap_or(false))?;
    let parent = PathBuf::from(&parent_path);
    if !parent.is_dir() {
        return Err(AppError::InvalidPath(parent_path));
    }
    let parent = folder_granted(state.inner(), &parent)?;
    let target = parent.join(name);
    if target.exists() {
        return Err(AppError::Other(format!(
            "project directory already exists: {}",
            target.display()
        )));
    }

    std::fs::create_dir(&target)?;
    let repo = match git2::Repository::init(&target) {
        Ok(repo) => repo,
        Err(err) => {
            let _ = std::fs::remove_dir(&target);
            return Err(AppError::Git(err));
        }
    };
    // `Repository::init` leaves HEAD unborn (no commit), so `refs/heads/<default>`
    // does not exist yet and any op that resolves HEAD — worktree creation, the
    // GitHub menu — fails with "reference 'refs/heads/master' not found". Seeding
    // an empty initial commit makes a brand-new project immediately usable; the
    // caller can opt out to keep an unborn HEAD (defaults on).
    if init_commit.unwrap_or(true) {
        if let Err(err) = seed_initial_commit(&repo) {
            drop(repo);
            let _ = std::fs::remove_dir_all(&target);
            return Err(AppError::Git(err));
        }
    }

    let project = state
        .projects
        .ensure(target.clone(), project_basename(&target));
    persist(&state);
    Ok(project)
}

/// Create the empty initial commit that makes a freshly `init`-ed repo usable.
/// Prefers the user's configured git identity, falling back to a generic Acorn
/// signature when `user.name`/`user.email` are unset. Committing to the unborn
/// `HEAD` symref creates whatever default branch git resolved (`main`/`master`).
fn seed_initial_commit(repo: &git2::Repository) -> Result<(), git2::Error> {
    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("Acorn", "acorn@localhost"))?;
    let tree_id = {
        let mut index = repo.index()?;
        index.write_tree()?
    };
    let tree = repo.find_tree(tree_id)?;
    repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])?;
    Ok(())
}

#[tauri::command]
pub fn get_project_settings(repo_path: String) -> AppResult<ProjectSettingsRecord> {
    project_settings::get(&PathBuf::from(repo_path))
}

#[tauri::command]
pub fn update_project_settings(
    repo_path: String,
    settings: ProjectSettings,
) -> AppResult<ProjectSettingsRecord> {
    project_settings::update(&PathBuf::from(repo_path), settings)
}

fn validate_new_project_name(name: &str, ignore_safe_name: bool) -> AppResult<&str> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("project name is required".into()));
    }
    if trimmed.contains('\0') {
        return Err(AppError::Other(
            "project name cannot contain a null character".into(),
        ));
    }
    if trimmed.contains('/') {
        return Err(AppError::Other(
            "project name must be a single folder name".into(),
        ));
    }
    let mut components = Path::new(trimmed).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {
            if !ignore_safe_name {
                if let Some(message) = safe_project_name_error(trimmed) {
                    return Err(AppError::Other(message));
                }
            }
            Ok(trimmed)
        }
        _ => Err(AppError::Other(
            "project name must be a single folder name".into(),
        )),
    }
}

fn safe_project_name_error(name: &str) -> Option<String> {
    if name.as_bytes().len() > 255 {
        return Some(
            "project name is longer than 255 bytes, which common filesystems reject".into(),
        );
    }
    None
}

#[tauri::command]
pub fn reorder_projects(state: State<'_, AppState>, order: Vec<String>) -> AppResult<Vec<Project>> {
    let paths: Vec<PathBuf> = order.into_iter().map(PathBuf::from).collect();
    state.projects.reorder(&paths);
    persist(&state);
    Ok(state.projects.list())
}

#[tauri::command]
pub fn reorder_sessions(
    state: State<'_, AppState>,
    repo_path: String,
    order: Vec<String>,
) -> AppResult<Vec<Session>> {
    let path = PathBuf::from(&repo_path);
    let ids: Vec<Uuid> = order
        .into_iter()
        .filter_map(|s| Uuid::parse_str(&s).ok())
        .collect();
    state.sessions.reorder(&path, &ids);
    persist(&state);
    Ok(state
        .sessions
        .list()
        .into_iter()
        .map(enrich_session)
        .collect())
}

/// Best-effort terminate a session's PTY regardless of where it is hosted.
///
/// In-process PTYs live in `state.pty`; daemon-managed sessions live behind
/// `stream_registry` + `daemon_bridge`. The session/project removal paths must
/// route the kill the same way [`pty_kill`] does — otherwise removing a
/// daemon-backed session is a no-op against `state.pty`, leaving its child
/// process and stream pump thread running and leaking its `stream_registry`
/// entry.
pub(crate) fn terminate_session_pty(state: &AppState, id: &Uuid) {
    let stream_attached = state.stream_registry.contains(id);
    if stream_attached || state.daemon_bridge.is_alive(*id) {
        state.daemon_bridge.kill(*id).ok();
        if stream_attached {
            state.stream_registry.drop_attachment(id);
        }
    } else {
        state.pty.kill(id).ok();
    }
}

pub(crate) fn session_removal_cascade(state: &AppState, session: &Session) -> Vec<Session> {
    let mut sessions = vec![session.clone()];
    let mut seen = HashSet::from([session.id]);
    if session.kind == SessionKind::Control {
        for owned in state.sessions.list_control_owned_descendants(session.id) {
            if seen.insert(owned.id) {
                sessions.push(owned);
            }
        }
    }
    sessions
}

fn sessions_using_linked_worktree(
    state: &AppState,
    repo_path: &Path,
    worktree_path: &Path,
) -> Vec<Session> {
    state
        .sessions
        .list()
        .into_iter()
        .filter(|session| {
            worktree::same_path(&session.repo_path, repo_path)
                && worktree::same_path(&session.worktree_path, worktree_path)
        })
        .collect()
}

fn sessions_using_worktree_path(state: &AppState, worktree_path: &Path) -> Vec<Session> {
    state
        .sessions
        .list()
        .into_iter()
        .filter(|session| worktree::same_path(&session.worktree_path, worktree_path))
        .collect()
}

fn ensure_no_sessions_using_worktree_path_except(
    state: &AppState,
    worktree_path: &Path,
    except_id: Option<&Uuid>,
) -> AppResult<()> {
    let except_ids: HashSet<Uuid> = except_id.into_iter().copied().collect();
    ensure_no_sessions_using_worktree_path_except_ids(state, worktree_path, &except_ids)
}

fn ensure_no_sessions_using_worktree_path_except_ids(
    state: &AppState,
    worktree_path: &Path,
    except_ids: &HashSet<Uuid>,
) -> AppResult<()> {
    let has_conflict = sessions_using_worktree_path(state, worktree_path)
        .into_iter()
        .any(|session| !except_ids.contains(&session.id));
    if has_conflict {
        return Err(AppError::Other(
            WORKTREE_IN_USE_BY_OTHER_SESSIONS.to_string(),
        ));
    }
    Ok(())
}

fn worktree_path_used_outside_project(
    state: &AppState,
    repo_path: &Path,
    worktree_path: &Path,
) -> bool {
    sessions_using_worktree_path(state, worktree_path)
        .into_iter()
        .any(|session| !worktree::same_path(&session.repo_path, repo_path))
}

#[tauri::command]
pub async fn remove_project(
    state: State<'_, AppState>,
    repo_path: String,
    remove_sessions: Option<bool>,
    remove_worktrees: Option<bool>,
    remove_settings: Option<bool>,
) -> AppResult<Vec<worktree::RemovedWorktree>> {
    let app_state = state.inner().clone();
    let path = PathBuf::from(&repo_path);
    let cascade = remove_sessions.unwrap_or(true);
    let drop_worktrees = remove_worktrees.unwrap_or(false);
    let mut removed_worktrees = Vec::new();
    let mut staged_worktree_paths = HashSet::new();
    if cascade {
        let session_ids: Vec<_> = app_state
            .sessions
            .list()
            .into_iter()
            .filter(|s| s.repo_path == path)
            .collect();
        for session in session_ids {
            terminate_session_pty(&app_state, &session.id);
            if drop_worktrees && staged_worktree_paths.insert(session.worktree_path.clone()) {
                if worktree_path_used_outside_project(&app_state, &path, &session.worktree_path) {
                    tracing::warn!(
                        repo_path = %session.repo_path.display(),
                        worktree_path = %session.worktree_path.display(),
                        "skipping linked worktree removal because another project still has a session there"
                    );
                    app_state.sessions.remove(&session.id).ok();
                    continue;
                }
                match stage_remove_linked_worktree_blocking(
                    session.repo_path.clone(),
                    session.worktree_path.clone(),
                )
                .await
                {
                    Ok(Some(removed)) => removed_worktrees.push(removed),
                    Ok(None) => {}
                    Err(err) => {
                        tracing::warn!(
                            repo_path = %session.repo_path.display(),
                            worktree_path = %session.worktree_path.display(),
                            error = %err,
                            "failed to stage linked worktree removal"
                        );
                    }
                }
            }
            app_state.sessions.remove(&session.id).ok();
        }
    }
    app_state.projects.remove(&path);
    let drop_settings = remove_settings.unwrap_or(false)
        || project_settings::should_remove_on_project_close(&path).unwrap_or(false);
    if drop_settings {
        if let Err(err) = project_settings::remove(&path) {
            tracing::warn!(error = %err, path = %path.display(), "failed to remove project settings");
        }
    }
    persist(&app_state);
    Ok(removed_worktrees)
}

#[tauri::command]
pub async fn remove_session(
    state: State<'_, AppState>,
    id: String,
    remove_worktree: Option<bool>,
) -> AppResult<Option<SessionRemoval>> {
    let app_state = state.inner().clone();
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Other(e.to_string()))?;
    let session = app_state.sessions.get(&id)?;
    let sessions_to_remove = session_removal_cascade(&app_state, &session);
    let removal_ids: HashSet<_> = sessions_to_remove
        .iter()
        .map(|session| session.id)
        .collect();
    if remove_worktree.unwrap_or(false) {
        ensure_no_sessions_using_worktree_path_except_ids(
            &app_state,
            &session.worktree_path,
            &removal_ids,
        )?;
    }
    for session in &sessions_to_remove {
        terminate_session_pty(&app_state, &session.id);
    }
    let removed_worktree = if remove_worktree.unwrap_or(false) {
        match stage_remove_linked_worktree_blocking(
            session.repo_path.clone(),
            session.worktree_path.clone(),
        )
        .await
        {
            Ok(removed) => removed,
            Err(err) => {
                tracing::warn!(
                    repo_path = %session.repo_path.display(),
                    worktree_path = %session.worktree_path.display(),
                    error = %err,
                    "failed to stage linked worktree removal"
                );
                None
            }
        }
    } else {
        None
    };
    for session in &sessions_to_remove {
        if session.id == id {
            app_state.sessions.remove(&session.id)?;
        } else {
            app_state.sessions.remove(&session.id).ok();
        }
    }
    if should_remove_local_project_mirror(&session, &app_state.sessions.list()) {
        app_state.projects.remove(&session.repo_path);
    }
    persist(&app_state);
    let Some(removed_worktree) = removed_worktree else {
        if let Ok(dir) = persistence::data_dir() {
            for session in &sessions_to_remove {
                scrollback::delete(&dir, &session.id.to_string()).ok();
            }
        }
        return Ok(None);
    };
    let removal = SessionRemoval::new(&removed_worktree, &sessions_to_remove);
    app_state.pending_session_removals.lock().insert(
        removed_worktree.token.clone(),
        PendingSessionRemoval {
            worktree: removed_worktree,
            sessions: sessions_to_remove,
        },
    );
    Ok(Some(removal))
}

#[tauri::command]
pub fn set_session_status(
    state: State<'_, AppState>,
    id: String,
    status: SessionStatus,
) -> AppResult<Session> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Other(e.to_string()))?;
    let updated = state.sessions.update_status(&id, status)?;
    persist(&state);
    Ok(updated)
}

#[tauri::command]
pub fn rename_session(state: State<'_, AppState>, id: String, name: String) -> AppResult<Session> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Other(e.to_string()))?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("name must not be empty".to_string()));
    }
    let current = state.sessions.get(&id)?;
    if matches!(current.owner, SessionOwner::Control { .. }) {
        return Err(AppError::Other(
            "control-session owned tabs cannot be renamed".to_string(),
        ));
    }
    let native_session = (current.kind == SessionKind::Regular
        && current.mode == SessionMode::Terminal)
        .then(|| crate::session_titles::resolve_native_session(id))
        .flatten();
    let updated = state.sessions.rename(&id, trimmed)?;
    persist(&state);
    if let Some(native_session) = native_session {
        crate::agent_session_names::enqueue(native_session, updated.name.clone());
    }
    Ok(enrich_session(updated))
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum GenerateSessionTitleStatus {
    Generated,
    NotReady,
    Skipped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleResult {
    status: GenerateSessionTitleStatus,
    session: Session,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum SessionTitleReadinessStatus {
    Ready,
    NotReady,
    Skipped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitleReadinessResult {
    status: SessionTitleReadinessStatus,
    session: Session,
}

#[tauri::command]
pub async fn session_title_readiness(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<SessionTitleReadinessResult> {
    let state = state.inner().clone();
    run_blocking("session_title_readiness", move || {
        session_title_readiness_inner(state, id)
    })
    .await
}

fn session_title_readiness_inner(
    state: AppState,
    id: String,
) -> AppResult<SessionTitleReadinessResult> {
    let id = parse_id(&id)?;
    let session = state.sessions.get(&id)?;
    let title_input = resolve_title_input_for_session(&session, id);
    let transcript_id = title_input
        .as_ref()
        .map(|input| input.transcript_id.as_str());
    if !crate::session_titles::can_generate_title(&session, transcript_id) {
        // The auto-title planner retries on this status forever; without a
        // trace the gate that keeps a tab stuck on "new session-N" is
        // invisible (auto-title opt-out, manual title, unchanged transcript).
        tracing::debug!(
            session_id = %id,
            title_source = ?session.title_source,
            auto_title_enabled = ?session.auto_title_enabled,
            has_title_input = transcript_id.is_some(),
            "session title readiness: skipped (not eligible)"
        );
        return Ok(SessionTitleReadinessResult {
            status: SessionTitleReadinessStatus::Skipped,
            session: enrich_session(session),
        });
    }
    if title_input.is_none() {
        tracing::debug!(
            session_id = %id,
            "session title readiness: not ready (no transcript context resolved)"
        );
        return Ok(SessionTitleReadinessResult {
            status: SessionTitleReadinessStatus::NotReady,
            session: enrich_session(session),
        });
    }
    Ok(SessionTitleReadinessResult {
        status: SessionTitleReadinessStatus::Ready,
        session: enrich_session(session),
    })
}

#[tauri::command]
pub async fn generate_session_title(
    state: State<'_, AppState>,
    id: String,
    ai: crate::ai::AiExecutionRequest,
    prompt: Option<String>,
    force: Option<bool>,
) -> AppResult<GenerateSessionTitleResult> {
    let state = state.inner().clone();
    run_blocking("generate_session_title", move || {
        generate_session_title_inner(state, id, ai, prompt, force.unwrap_or(false))
    })
    .await
}

fn generate_session_title_inner(
    state: AppState,
    id: String,
    ai: crate::ai::AiExecutionRequest,
    prompt: Option<String>,
    force: bool,
) -> AppResult<GenerateSessionTitleResult> {
    let id = parse_id(&id)?;
    let session = state.sessions.get(&id)?;
    let title_input = resolve_title_input_for_session(&session, id);
    let transcript_id = title_input
        .as_ref()
        .map(|input| input.transcript_id.as_str());
    let can_generate = if force {
        crate::session_titles::can_force_generate_title(&session)
    } else {
        crate::session_titles::can_generate_title(&session, transcript_id)
    };
    if !can_generate {
        return Ok(GenerateSessionTitleResult {
            status: GenerateSessionTitleStatus::Skipped,
            session: enrich_session(session),
        });
    }
    let Some(title_input) = title_input else {
        return Ok(GenerateSessionTitleResult {
            status: GenerateSessionTitleStatus::NotReady,
            session: enrich_session(session),
        });
    };
    let native_session = title_input.native_session.clone();
    let generated = crate::session_titles::generate_title_in_dir(
        &ai,
        prompt.as_deref(),
        &title_input.title_context,
        Some(&session.worktree_path),
    )?;
    let latest = state.sessions.get(&id)?;
    let can_store = if force {
        crate::session_titles::can_force_generate_title(&latest)
    } else {
        crate::session_titles::can_generate_title(&latest, Some(&title_input.transcript_id))
    };
    if !can_store {
        return Ok(GenerateSessionTitleResult {
            status: GenerateSessionTitleStatus::Skipped,
            session: enrich_session(latest),
        });
    }
    let transcript_id = title_input.transcript_id;
    let updated = state
        .sessions
        .set_generated_title(&id, generated, Some(transcript_id))?;
    persist(&state);
    if let Some(native_session) = native_session {
        crate::agent_session_names::enqueue(native_session, updated.name.clone());
    }
    Ok(GenerateSessionTitleResult {
        status: GenerateSessionTitleStatus::Generated,
        session: enrich_session(updated),
    })
}

fn resolve_title_input_for_session(
    session: &Session,
    id: Uuid,
) -> Option<crate::session_titles::ResolvedTitleInput> {
    if session.mode == SessionMode::Chat {
        crate::session_titles::resolve_chat_title_input(id)
    } else {
        crate::session_titles::resolve_title_input(id)
    }
}

#[tauri::command]
pub async fn preview_session_title(
    state: State<'_, AppState>,
    ai: crate::ai::AiExecutionRequest,
    prompt: Option<String>,
    first_user_message: String,
    repo_path: Option<String>,
) -> AppResult<String> {
    let state = state.inner().clone();
    run_blocking("preview_session_title", move || {
        let first_user_message = first_user_message.trim().to_string();
        if first_user_message.is_empty() {
            return Err(AppError::Other(
                "first user message must not be empty".to_string(),
            ));
        }
        let cwd = repo_path
            .as_deref()
            .map(|path| authorize_registered_project_root(&state, Path::new(path)))
            .transpose()?;
        crate::session_titles::generate_title_in_dir(
            &ai,
            prompt.as_deref(),
            &first_user_message,
            cwd.as_deref(),
        )
    })
    .await
}

/// Re-point a session at a new worktree directory and persist the change.
/// Frontend invokes this after the PTY exits when it detects that an in-PTY
/// command (typically `claude --worktree`) added a fresh git worktree —
/// adopting it as the session's new home avoids the "command silently
/// vanishes, you're stuck in the old cwd" dead end.
#[tauri::command]
pub fn update_session_worktree(
    state: State<'_, AppState>,
    id: String,
    worktree_path: String,
) -> AppResult<Session> {
    let id = parse_id(&id)?;
    let path = PathBuf::from(worktree_path);
    let session = state.sessions.get(&id)?;
    if session.project_scoped == false {
        return Err(AppError::InvalidPath(
            "local sessions cannot adopt project worktrees".into(),
        ));
    }
    authorize_registered_project_root(state.inner(), &session.repo_path)?;
    let path = canonical_existing_path(&path)?;
    let linked = worktree::list_worktree_paths(&session.repo_path)?
        .into_iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .any(|candidate| candidate == path);
    if !linked {
        return Err(AppError::InvalidPath(format!(
            "worktree is not registered for the session project: {}",
            path.display()
        )));
    }
    let updated = state.sessions.update_worktree_path(&id, path)?;
    persist(&state);
    Ok(enrich_session(updated))
}

/// Create and adopt a fresh linked worktree for an existing chat session.
/// Chat sessions are created before the first prompt is sent, so the
/// composer uses this to switch an empty native chat from the project root
/// into an isolated worktree without creating another tab.
#[tauri::command]
pub fn prepare_chat_session_worktree(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Session> {
    let session = authorize_chat_session(state.inner(), &session_id)?;
    if session.project_scoped == false {
        return Err(AppError::InvalidPath(
            "local chat sessions cannot create project worktrees".into(),
        ));
    }
    authorize_registered_project_root(state.inner(), &session.repo_path)?;
    if worktree::is_linked_worktree_root(&session.worktree_path) {
        return Ok(enrich_session(session));
    }
    let base = new_chat_worktree_base_name(&session.repo_path);
    let (_safe_name, path) = create_unique_worktree(&session.repo_path, &base)?;
    let updated = state.sessions.update_worktree_path(&session.id, path)?;
    persist(&state);
    Ok(enrich_session(updated))
}

pub type AgentDetection = HashMap<AgentKind, Option<String>>;

fn empty_agent_detection() -> AgentDetection {
    [
        (AgentKind::Claude, None),
        (AgentKind::Codex, None),
        (AgentKind::Antigravity, None),
    ]
    .into_iter()
    .collect()
}

/// Stage a parent claude transcript inside the new worktree's project
/// slug so `claude --resume <uuid>` can find it after the fork shell
/// `cd`s into the worktree. Claude looks transcripts up under
/// `~/.claude/projects/<slugified-cwd>/<uuid>.jsonl`; the new worktree
/// has a different slug, so without this copy the resume fails with
/// "No conversation found with session ID: ...".
///
/// Codex stores rollouts under `$CODEX_HOME/sessions/.../` (cwd-
/// independent), so this is only needed for claude forks.
///
/// Both `parent_uuid` and `new_cwd` come from the frontend IPC bridge
/// and are validated below:
///   - `parent_uuid` is checked to be a real UUID before any disk
///     lookup, blocking `..`-style filename injection.
///   - `new_cwd` is slugified and accepted only as one path component;
///     the destination directory is then verified beneath the canonical
///     `~/.claude/projects/` root before it is used.
#[tauri::command]
pub fn prepare_claude_fork(parent_uuid: String, new_cwd: String) -> AppResult<()> {
    let home = directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .ok_or_else(|| AppError::Other("no home dir".into()))?;
    prepare_claude_fork_in(
        &home.join(".claude").join("projects"),
        &parent_uuid,
        Path::new(&new_cwd),
        DEFAULT_CLAUDE_FORK_LIMITS,
    )
}

fn prepare_claude_fork_in(
    projects_root: &Path,
    parent_uuid: &str,
    new_cwd: &Path,
    limits: ClaudeForkLimits,
) -> AppResult<()> {
    if Uuid::parse_str(&parent_uuid).is_err() {
        return Err(AppError::Other(format!(
            "parent_uuid must be a valid UUID, got: {parent_uuid}"
        )));
    }

    let root_metadata = std::fs::symlink_metadata(projects_root)?;
    validate_claude_fork_directory(projects_root, &root_metadata, "projects root")?;
    let canonical_root = projects_root.canonicalize()?;
    let canonical_root_metadata = std::fs::symlink_metadata(&canonical_root)?;
    validate_claude_fork_directory(
        &canonical_root,
        &canonical_root_metadata,
        "canonical projects root",
    )?;

    let filename = format!("{parent_uuid}.jsonl");

    // The parent transcript can live under any number of project
    // slugs depending on where the agent was originally launched, so
    // inspect every raw project entry within the budget. Continuing after a
    // match ensures an oversized directory cannot produce a partial result.
    let mut src: Option<PathBuf> = None;
    for (index, entry) in std::fs::read_dir(&canonical_root)?.enumerate() {
        if index >= limits.max_project_entries {
            return Err(AppError::Other(format!(
                "Claude projects directory exceeds {} entries",
                limits.max_project_entries
            )));
        }

        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let project_dir = entry.path();
        let project_metadata = std::fs::symlink_metadata(&project_dir)?;
        validate_claude_fork_directory(&project_dir, &project_metadata, "project directory")?;
        let canonical_project = project_dir.canonicalize()?;
        if canonical_project.parent() != Some(canonical_root.as_path()) {
            return Err(AppError::InvalidPath(format!(
                "Claude project directory escapes projects root: {}",
                project_dir.display()
            )));
        }

        let candidate = canonical_project.join(&filename);
        let candidate_metadata = match std::fs::symlink_metadata(&candidate) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.into()),
        };
        validate_claude_fork_regular_file(&candidate, &candidate_metadata, "source transcript")?;
        let canonical_candidate = candidate.canonicalize()?;
        if canonical_candidate.parent() != Some(canonical_project.as_path())
            || !canonical_candidate.starts_with(&canonical_root)
        {
            return Err(AppError::InvalidPath(format!(
                "Claude source transcript escapes projects root: {}",
                candidate.display()
            )));
        }
        if src.is_none() {
            src = Some(canonical_candidate);
        }
    }
    let Some(src) = src else {
        return Err(AppError::Other(format!(
            "parent transcript {parent_uuid} not found under {}",
            canonical_root.display()
        )));
    };

    let source_path_metadata = std::fs::symlink_metadata(&src)?;
    validate_claude_fork_regular_file(&src, &source_path_metadata, "source transcript")?;
    validate_claude_fork_snapshot_size(&src, &source_path_metadata, limits)?;
    let mut source = std::fs::File::open(&src)?;
    let source_open_metadata = source.metadata()?;
    validate_claude_fork_regular_file(&src, &source_open_metadata, "opened source transcript")?;
    validate_claude_fork_snapshot_size(&src, &source_open_metadata, limits)?;
    validate_same_claude_fork_file(&src, &source_path_metadata, &source_open_metadata)?;
    let source_recheck_metadata = std::fs::symlink_metadata(&src)?;
    validate_claude_fork_regular_file(&src, &source_recheck_metadata, "source transcript")?;
    validate_same_claude_fork_file(&src, &source_recheck_metadata, &source_open_metadata)?;
    let snapshot_len = source_open_metadata.len();

    let dst_slug = acorn_transcript::slug_for_cwd(new_cwd);
    let slug_path = Path::new(&dst_slug);
    let mut slug_components = slug_path.components();
    let is_single_normal_component = matches!(slug_components.next(), Some(Component::Normal(_)))
        && slug_components.next().is_none();
    if !dst_slug.starts_with('-') || dst_slug.contains("..") || !is_single_normal_component {
        return Err(AppError::Other(format!(
            "refusing to stage transcript under unsafe slug: {dst_slug}"
        )));
    }

    let dst_dir = ensure_claude_fork_destination_directory(&canonical_root, &dst_slug)?;
    let dst = dst_dir.join(&filename);
    if claude_fork_destination_exists(&dst)? {
        return Ok(());
    }

    // A create-new tempfile in the destination's parent keeps partial copies
    // unreachable at the final name. Persist uses a same-filesystem atomic
    // rename, which replaces a concurrently introduced link rather than
    // following it to another target.
    let mut temporary = tempfile::Builder::new()
        .prefix(".acorn-claude-fork-")
        .suffix(".jsonl.tmp")
        .tempfile_in(&dst_dir)?;
    let copied = io::copy(
        &mut (&mut source).take(snapshot_len),
        temporary.as_file_mut(),
    )?;
    if copied != snapshot_len {
        return Err(AppError::Other(format!(
            "source transcript changed while copying: expected {snapshot_len} bytes, copied {copied}"
        )));
    }
    temporary.as_file_mut().flush()?;

    let rechecked_dst_dir = ensure_claude_fork_destination_directory(&canonical_root, &dst_slug)?;
    if rechecked_dst_dir != dst_dir {
        return Err(AppError::Other(format!(
            "Claude destination directory changed while copying: {}",
            dst_dir.display()
        )));
    }
    if claude_fork_destination_exists(&dst)? {
        return Ok(());
    }

    let persisted = temporary
        .persist(&dst)
        .map_err(|err| AppError::Other(format!("copy transcript: {}", err.error)))?;
    let persisted_metadata = persisted.metadata()?;
    validate_claude_fork_regular_file(&dst, &persisted_metadata, "destination transcript")?;
    Ok(())
}

fn validate_claude_fork_directory(
    path: &Path,
    metadata: &std::fs::Metadata,
    label: &str,
) -> AppResult<()> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Claude {label} must be a real directory: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_claude_fork_regular_file(
    path: &Path,
    metadata: &std::fs::Metadata,
    label: &str,
) -> AppResult<()> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "Claude {label} must be a regular file: {}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_claude_fork_snapshot_size(
    path: &Path,
    metadata: &std::fs::Metadata,
    limits: ClaudeForkLimits,
) -> AppResult<()> {
    if metadata.len() > limits.max_transcript_bytes {
        return Err(AppError::Other(format!(
            "Claude source transcript exceeds {} bytes: {}",
            limits.max_transcript_bytes,
            path.display()
        )));
    }
    Ok(())
}

fn validate_same_claude_fork_file(
    path: &Path,
    before: &std::fs::Metadata,
    opened: &std::fs::Metadata,
) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(AppError::InvalidPath(format!(
                "Claude source transcript changed while opening: {}",
                path.display()
            )));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, before, opened);
    }
    Ok(())
}

fn ensure_claude_fork_destination_directory(
    canonical_root: &Path,
    dst_slug: &str,
) -> AppResult<PathBuf> {
    let dst_dir = canonical_root.join(dst_slug);
    loop {
        match std::fs::symlink_metadata(&dst_dir) {
            Ok(metadata) => {
                validate_claude_fork_directory(&dst_dir, &metadata, "destination directory")?;
                break;
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                match std::fs::create_dir(&dst_dir) {
                    Ok(()) => {}
                    Err(create_err) if create_err.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(create_err) => return Err(create_err.into()),
                }
            }
            Err(err) => return Err(err.into()),
        }
    }

    let canonical_dst = dst_dir.canonicalize()?;
    if canonical_dst.parent() != Some(canonical_root) {
        return Err(AppError::InvalidPath(format!(
            "Claude destination directory escapes projects root: {}",
            dst_dir.display()
        )));
    }
    let metadata = std::fs::symlink_metadata(&canonical_dst)?;
    validate_claude_fork_directory(&canonical_dst, &metadata, "destination directory")?;
    Ok(canonical_dst)
}

fn claude_fork_destination_exists(dst: &Path) -> AppResult<bool> {
    match std::fs::symlink_metadata(dst) {
        Ok(metadata) => {
            validate_claude_fork_regular_file(dst, &metadata, "destination transcript")?;
            Ok(true)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

/// Live-process snapshot of which agent transcripts (if any) the user is
/// currently writing inside this Acorn session. Drives the Tab context
/// menu's agent actions — they only appear while the underlying agent
/// process is alive in the session's PTY tree.
///
/// We deliberately re-run the full process scan on every call instead
/// of reading the watcher's cached map. The cache is at most one cycle
/// (~3 s) stale, which races with rapid back-to-back Fork actions: a
/// freshly-forked session's claude process can be live at the moment
/// the user right-clicks but absent from the last cache, or vice-versa.
/// An on-demand scan locks the answer to "what's true right now."
#[tauri::command]
pub async fn detect_session_agent(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<AgentDetection> {
    let state = state.inner().clone();
    run_blocking("detect_session_agent", move || {
        detect_session_agent_inner(state, session_id)
    })
    .await
}

fn detect_session_agent_inner(state: AppState, session_id: String) -> AppResult<AgentDetection> {
    let parsed = parse_id(&session_id)?;
    let session_pids = crate::agent_resume_persister::collect_session_pids(&state);
    let mappings = acorn_transcript::collect_live_mappings(&session_pids);
    let mut detection = empty_agent_detection();
    for (sid, kind, uuid) in mappings {
        if sid != parsed {
            continue;
        }
        detection.insert(kind, Some(uuid));
    }
    Ok(detection)
}

/// Enumerate every linked git worktree of the repo containing `repo_path`.
/// Returns absolute paths so the caller can detect "what's new since I last
/// looked" by simple set diff. The main checkout is intentionally excluded —
/// it is never created or removed by the in-PTY commands we're watching for.
#[tauri::command]
pub fn git_worktrees(repo_path: String) -> AppResult<Vec<String>> {
    let path = PathBuf::from(repo_path);
    let paths = crate::worktree::list_worktree_paths(&path)?;
    Ok(paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub fn list_project_worktrees(repo_path: String) -> AppResult<Vec<worktree::ProjectWorktreeInfo>> {
    let path = PathBuf::from(repo_path);
    crate::worktree::list_worktree_infos(&path)
}

#[tauri::command]
pub async fn remove_worktree(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
    remove_sessions: Option<bool>,
) -> AppResult<Option<worktree::RemovedWorktree>> {
    let app_state = state.inner().clone();
    let repo_path = PathBuf::from(repo_path);
    let worktree_path = PathBuf::from(worktree_path);
    let remove_sessions = remove_sessions.unwrap_or(false);
    if remove_sessions {
        let matching_sessions = sessions_using_worktree_path(&app_state, &worktree_path);
        if matching_sessions.len() > 1
            || matching_sessions
                .iter()
                .any(|session| !worktree::same_path(&session.repo_path, &repo_path))
        {
            return Err(AppError::Other(
                WORKTREE_IN_USE_BY_OTHER_SESSIONS.to_string(),
            ));
        }
        return stage_remove_linked_worktree_and_sessions_blocking(
            app_state,
            repo_path,
            worktree_path,
        )
        .await;
    }
    ensure_no_sessions_using_worktree_path_except(&app_state, &worktree_path, None)?;
    stage_remove_linked_worktree_blocking(repo_path, worktree_path).await
}

#[tauri::command]
pub async fn restore_removed_worktree(
    token: String,
    repo_path: String,
    worktree_path: String,
    git_common_dir: String,
) -> AppResult<()> {
    restore_removed_worktree_blocking(token, repo_path, worktree_path, git_common_dir).await
}

#[tauri::command]
pub async fn discard_removed_worktree(
    token: String,
    repo_path: String,
    worktree_path: String,
    git_common_dir: String,
) -> AppResult<()> {
    discard_removed_worktree_blocking(token, repo_path, worktree_path, git_common_dir).await
}

#[tauri::command]
pub async fn restore_removed_session(
    state: State<'_, AppState>,
    token: String,
    repo_path: String,
    worktree_path: String,
    git_common_dir: String,
) -> AppResult<()> {
    let app_state = state.inner().clone();
    run_blocking("restore removed session", move || {
        restore_pending_session_removal(
            &app_state,
            &token,
            &repo_path,
            &worktree_path,
            &git_common_dir,
        )?;
        persist(&app_state);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn discard_removed_session(
    state: State<'_, AppState>,
    token: String,
    repo_path: String,
    worktree_path: String,
    git_common_dir: String,
) -> AppResult<()> {
    let app_state = state.inner().clone();
    run_blocking("discard removed session", move || {
        discard_pending_session_removal(
            &app_state,
            &token,
            &repo_path,
            &worktree_path,
            &git_common_dir,
        )
    })
    .await
}

fn parse_id(id: &str) -> AppResult<Uuid> {
    Uuid::parse_str(id).map_err(|e| AppError::Other(e.to_string()))
}

fn decode_b64(input: &str) -> AppResult<Vec<u8>> {
    decode_base64(input).ok_or_else(|| AppError::Other("invalid base64 input".to_string()))
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    const PAD: u8 = 64;
    const INVALID: u8 = 0xFF;
    fn idx(b: u8) -> u8 {
        match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => 26 + (b - b'a'),
            b'0'..=b'9' => 52 + (b - b'0'),
            b'+' => 62,
            b'/' => 63,
            b'=' => PAD,
            _ => INVALID,
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let a = idx(chunk[0]);
        let b = idx(chunk[1]);
        let c = idx(chunk[2]);
        let d = idx(chunk[3]);
        if a >= 64 || b >= 64 {
            return None;
        }
        out.push((a << 2) | (b >> 4));
        if c == PAD {
            break;
        }
        if c >= 64 {
            return None;
        }
        out.push(((b & 0x0F) << 4) | (c >> 2));
        if d == PAD {
            break;
        }
        if d >= 64 {
            return None;
        }
        out.push(((c & 0x03) << 6) | d);
    }
    Some(out)
}

#[tauri::command]
pub async fn pty_spawn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
    replay_scrollback: Option<bool>,
    output_token: Option<u64>,
) -> AppResult<()> {
    let state = state.inner().clone();
    // Staging dirs, control markers, and the daemon spawn path (which can
    // poll the daemon socket for seconds on first spawn) are all blocking —
    // keep them off the async executor.
    run_blocking("pty_spawn", move || {
        pty_spawn_blocking(
            app,
            state,
            session_id,
            cwd,
            env,
            cols,
            rows,
            replay_scrollback,
            output_token,
        )
    })
    .await
}

#[allow(clippy::too_many_arguments)]
fn pty_spawn_blocking<R: Runtime>(
    app: AppHandle<R>,
    state: AppState,
    session_id: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
    replay_scrollback: Option<bool>,
    output_token: Option<u64>,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let session = state.sessions.get(&id)?;
    let cwd = authorize_session_cwd(&state, &session, &PathBuf::from(cwd))?;
    let output_token = output_token.or_else(|| state.pty_output.current_token(&id));
    // Either an in-process PTY or a daemon-side stream attachment for
    // this session already exists — caller hit `pty_spawn` twice (e.g.
    // StrictMode double mount), nothing to do.
    if state.pty.contains(&id)
        || state
            .stream_registry
            .attachment_matches_output_token(&id, output_token)
    {
        return Ok(());
    }
    // Sessions always spawn the user's interactive `$SHELL` in login
    // mode so `.zprofile` / `.bash_profile` / `.profile` run — matches
    // macOS Terminal.app / iTerm2 / VS Code so the PTY feels identical
    // to opening the user's native terminal.
    let resolved_command = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let resolved_args: Vec<String> = crate::shell_args::login_args_for(&resolved_command);
    // Inject Acorn session identity and CLI reachability so a regular
    // terminal can explicitly bootstrap itself with `acorn-ipc promote-self`.
    // Privileged IPC commands still fail server-side until the session kind
    // has been promoted to Control.
    let mut effective_env = env.unwrap_or_default();
    let mut primed_args = resolved_args;

    // PTY children get the same SHELL/HOME their dotfiles expect to
    // see. portable-pty inherits these from Acorn's own env in
    // practice, but being explicit prevents drift when Acorn is
    // launched by launchd (which sanitises HOME) or via a wrapper
    // that overrode SHELL — both manifest as zsh refusing to honor
    // `~` expansion or `$SHELL`-gated logic in user dotfiles.
    effective_env
        .entry("SHELL".to_string())
        .or_insert_with(|| resolved_command.clone());
    if let Some(home) = std::env::var_os("HOME") {
        effective_env
            .entry("HOME".to_string())
            .or_insert_with(|| home.to_string_lossy().into_owned());
    }

    // Stamp the staged-dotfile fingerprint so the daemon can store
    // it per session and the app's boot reconcile can spot sessions
    // that survived from an older build. Always overwrites — callers
    // do not get to forge a stale rev.
    effective_env.insert(
        "ACORN_STAGED_REV".to_string(),
        crate::shell_init::STAGED_REV.to_string(),
    );

    // `ACORN_RESUME_TOKEN` carries the Acorn session UUID. Older builds
    // used the value inside a PATH-based shim to auto-inject claude's
    // `--session-id`; the shim is gone (filesystem-watcher persister
    // replaces it — see `agent_resume_persister`), but the env var is
    // left in place so user scripts that address the running Acorn
    // session by UUID keep working. `ACORN_AGENT_STATE_DIR` is no
    // longer needed inside the PTY (the persister writes to the same
    // path from the Rust side), but we keep it exposed so end-user
    // scripts that wanted to introspect Acorn state can still do so.
    let resume_token = id.to_string();
    effective_env
        .entry("ACORN_RESUME_TOKEN".to_string())
        .or_insert_with(|| resume_token.clone());
    if let Ok(state_dir) = crate::agent_resume::ensure_session_state_dir(id) {
        effective_env
            .entry("ACORN_AGENT_STATE_DIR".to_string())
            .or_insert_with(|| state_dir.display().to_string());
    } else {
        tracing::warn!(%id, "agent state dir setup failed; resume modal will be inactive for this session");
    }

    if let Ok(data_dir) = acorn_daemon::paths::data_dir() {
        effective_env.insert(
            acorn_daemon::paths::ENV_DATA_DIR_OVERRIDE.to_string(),
            data_dir.display().to_string(),
        );
    }

    let ipc_socket = acorn_ipc::socket_path::resolve().unwrap_or_default();
    if !ipc_socket.as_os_str().is_empty() {
        effective_env
            .entry("ACORN_IPC_SOCKET".to_string())
            .or_insert_with(|| ipc_socket.display().to_string());
    }
    if let Some(bin_dir) = acorn_ipc::cli_path::bundled_cli_dir() {
        let existing = effective_env
            .get("PATH")
            .cloned()
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        effective_env.insert(
            "PATH".to_string(),
            acorn_ipc::cli_path::prepend_to_path(&bin_dir, &existing),
        );
        // Expose the dir so the staged `.zshrc` can re-prepend the IPC CLI
        // entry after the user's rc runs — covers `export PATH="…"` patterns
        // that wipe Acorn's earlier prepend.
        effective_env
            .entry("ACORN_CLI_DIR".to_string())
            .or_insert_with(|| bin_dir.display().to_string());
    }
    if let Ok(wrapper_dir) = crate::agent_wrappers::ensure_agent_wrapper_dir() {
        let existing = effective_env
            .get("PATH")
            .cloned()
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        effective_env.insert(
            "PATH".to_string(),
            acorn_ipc::cli_path::prepend_to_path(&wrapper_dir, &existing),
        );
        effective_env
            .entry("ACORN_AGENT_WRAPPER_DIR".to_string())
            .or_insert_with(|| wrapper_dir.display().to_string());
    } else {
        tracing::warn!(%id, "agent wrapper dir setup failed; agent hook runtime injection will be inactive");
    }

    // OSC 7 emitter — only zsh needs file-side help (bash/fish self-serve).
    // Override `ZDOTDIR` with Acorn's staged dir so our `.zshrc` runs; stash
    // the user's original under `ACORN_USER_ZDOTDIR` so the staged rc can
    // restore it before sourcing their real config. zsh resolves `.zshenv`
    // off `$ZDOTDIR` too, so the staged dir also ships a `.zshenv` that
    // forwards to the user's `$HOME/.zshenv` (rustup, asdf etc. live there
    // and break without it) before pinning `ZDOTDIR` back to ours.
    if let Ok(dir) = crate::shell_init::ensure_shell_init_dir() {
        let mut user_zdotdir = effective_env
            .get("ZDOTDIR")
            .cloned()
            .or_else(|| std::env::var("ZDOTDIR").ok())
            .unwrap_or_default();
        let shell_init_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        let points_at_shell_init = Path::new(&user_zdotdir)
            .canonicalize()
            .map(|path| path == shell_init_dir)
            .unwrap_or(false);
        let points_at_acorn_shell_init = Path::new(&user_zdotdir)
            .canonicalize()
            .map(|path| crate::shell_init::is_shell_init_dir(&path))
            .unwrap_or(false);
        if user_zdotdir.is_empty() || points_at_shell_init || points_at_acorn_shell_init {
            user_zdotdir = effective_env
                .get("HOME")
                .cloned()
                .or_else(|| std::env::var("HOME").ok())
                .unwrap_or_default();
        }
        effective_env.insert("ACORN_USER_ZDOTDIR".to_string(), user_zdotdir);
        effective_env.insert("ZDOTDIR".to_string(), dir.display().to_string());
    } else {
        tracing::warn!(%id, "shell init dir setup failed; OSC 7 cwd tracking will fall back to focus-based refresh");
    }

    let agent_hooks = state.agent_hooks.lock().clone();
    inject_agent_hook_env(&mut effective_env, &session, agent_hooks.as_deref());
    if session.kind == SessionKind::Control {
        effective_env
            .entry("ACORN_SESSION_ID".to_string())
            .or_insert_with(|| session.id.to_string());
        // Daemon socket for the `acornd` CLI. Coexists with
        // `ACORN_IPC_SOCKET`: scripts that call `acorn-ipc` reach
        // the in-process server, while `acornd <subcommand>`
        // reaches the daemon. The two transports manage different
        // session graphs today (daemon vs in-process); they
        // converge when `pty_spawn` itself routes through the
        // daemon.
        if let Ok(daemon_sock) = acorn_daemon::paths::control_socket_path() {
            effective_env
                .entry("ACORN_DAEMON_SOCKET".to_string())
                .or_insert_with(|| daemon_sock.display().to_string());
        }
        // Drop the primer in a worktree-local marker file so whichever
        // agent the user invokes inside the shell can read the IPC
        // protocol. `inject_primer_args` is a no-op while `$SHELL` is
        // an ordinary shell (`AgentFlavor::Unknown`) and only takes
        // effect on the rare configuration where `$SHELL` itself
        // resolves to a recognised agent binary.
        let daemon_socket = acorn_daemon::paths::control_socket_path().ok();
        let primer = acorn_ipc::primer::primer_for(
            &session.id.to_string(),
            &session.repo_path,
            &ipc_socket,
            daemon_socket.as_deref(),
        );
        let flavor = acorn_ipc::primer::AgentFlavor::detect(&resolved_command);
        primed_args = acorn_ipc::primer::inject_primer_args(flavor, primed_args, &primer);
        write_control_marker(&cwd, &primer);
    }

    // Daemon path — when the killswitch is on, route through `acornd`
    // so the PTY survives an Acorn app close. The in-process branch
    // below is kept verbatim as the fallback for users who flip the
    // toggle off (or for environments where the daemon binary is
    // missing / refusing to start).
    if state.daemon_bridge.is_enabled() {
        match spawn_via_daemon(
            &app,
            &state,
            id,
            &cwd,
            &resolved_command,
            &primed_args,
            &effective_env,
            cols.unwrap_or(0),
            rows.unwrap_or(0),
            output_token,
            replay_scrollback.unwrap_or(true),
        ) {
            Ok(()) => return Ok(()),
            Err(err) => {
                tracing::warn!(%id, error = %err, "daemon spawn failed; falling back to in-process PTY");
            }
        }
    }

    let output_router = state.pty_output.clone();
    let app_for_output = app.clone();
    let output_sink: acorn_pty::PtyOutputSink = Arc::new(move |event, session_id, bytes| {
        output_router.send_or_emit(&app_for_output, event, session_id, bytes);
    });

    state
        .pty
        .spawn(
            app,
            output_sink,
            id,
            cwd,
            resolved_command,
            primed_args,
            |cmd| crate::pty_env::apply_layered_env(cmd, effective_env),
            cols.unwrap_or(0),
            rows.unwrap_or(0),
        )
        .map_err(|e| AppError::Pty(e.to_string()))
}

/// Route a `pty_spawn` through the daemon. Three cases:
///
/// 1. **Already attached** — short-circuit; redundant guard catches
///    races where two callers hit this helper concurrently.
/// 2. **Daemon already has an alive session** under this UUID (Acorn
///    just restarted) — skip spawn, open a stream attachment. The frontend
///    decides whether to replay the daemon's raw ring buffer based on whether
///    it already restored an xterm-rendered disk snapshot.
/// 3. **No live session** — fresh daemon spawn, attach the stream,
///    persist `daemon_session_id` so the next restart hits case 2.
fn spawn_via_daemon<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: uuid::Uuid,
    cwd: &std::path::Path,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cols: u16,
    rows: u16,
    output_token: Option<u64>,
    replay_scrollback: bool,
) -> Result<(), String> {
    let bridge = &state.daemon_bridge;
    let registry = state.stream_registry.clone();

    if registry.attachment_matches_output_token(&id, output_token) {
        return Ok(());
    }

    // Resolve the session row's persisted daemon metadata. Missing
    // session is treated as a new spawn — control sessions get their
    // own env/argv augmentation up-stack, so this branch only handles
    // the daemon ↔ stream wiring.
    let session = state.sessions.get(&id).ok();
    let session_kind = session
        .as_ref()
        .map(|s| s.kind)
        .unwrap_or(SessionKind::Regular);
    let repo_path = session.as_ref().map(|s| s.repo_path.clone());
    let branch = session.as_ref().map(|s| s.branch.clone());

    // `pty_spawn` always launches `$SHELL`, never an agent binary
    // directly, so the daemon's per-agent resume strategy registry
    // has nothing to react to here. The shim layer in the PTY is
    // what specialises behaviour by agent.
    let agent_kind: Option<acorn_daemon::protocol::AgentKind> = None;

    // The resume token == Acorn session UUID; stamped onto the
    // daemon's session record (mirrors the PTY env var the shim
    // reads) so a future daemon-side reconcile can recover identity
    // without consulting the app DB.
    let resume_token = Some(id.to_string());

    // Fast path: daemon already owns this PTY. Acorn restart re-enters
    // `pty_spawn` here; attach the stream and return. Pid comes from
    // the daemon's session registry so status polling has a process
    // tree to walk without an extra round-trip on every poll.
    if bridge.is_alive(id) {
        let pid = bridge.session_pid(id);
        crate::daemon_stream::attach(
            app.clone(),
            registry.clone(),
            state.pty_output.clone(),
            id,
            pid,
            output_token,
            replay_scrollback,
        )
        .map_err(|e| format!("daemon stream attach failed: {e}"))?;
        return Ok(());
    }

    let kind = match session_kind {
        SessionKind::Regular => acorn_daemon::protocol::SessionKind::Regular,
        SessionKind::Control => acorn_daemon::protocol::SessionKind::Control,
    };

    let outcome = bridge
        .spawn(
            id,
            daemon_spawn_name_for_session(session.as_ref(), id),
            cwd.to_path_buf(),
            command.to_string(),
            args.to_vec(),
            env.clone(),
            cols,
            rows,
            kind,
            repo_path,
            branch,
            agent_kind,
            resume_token.clone(),
        )
        .map_err(|e| format!("daemon spawn failed: {e}"))?;

    // Persist the daemon binding so next-restart's reconcile picks
    // this row up. Failures are non-fatal — the user can still use the
    // session, they just lose persistence across one restart.
    if let Err(err) = state.sessions.set_daemon_session_id(&id, Some(id)) {
        tracing::warn!(%id, error = %err, "persist daemon_session_id failed");
    }
    persist(state);

    crate::daemon_stream::attach(
        app.clone(),
        registry,
        state.pty_output.clone(),
        id,
        outcome.pid,
        output_token,
        replay_scrollback,
    )
    .map_err(|e| format!("daemon stream attach failed: {e}"))
}

fn daemon_spawn_name_for_session(session: Option<&Session>, id: Uuid) -> String {
    if let Some(name) = session
        .map(|session| session.name.trim())
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    id.to_string()
}

/// Drop a `<cwd>/.acorn-control.md` marker every time a control session
/// PTY spawns. The file is small (<2 KiB) and overwritten on each spawn
/// so the substituted session-id / socket-path always match the running
/// PTY. Best-effort: a write failure is logged but does not abort spawn,
/// since the env vars carry enough state for `acorn-ipc` itself; this
/// marker exists so whichever agent the user later invokes can read the
/// protocol from a project-local file.
fn write_control_marker(cwd: &std::path::Path, primer: &str) {
    let path = cwd.join(".acorn-control.md");
    let body = format!(
        "<!-- generated by Acorn on every control-session PTY spawn. \
         Safe to commit-ignore. -->\n\n# Control session\n\n{primer}\n",
    );
    if let Err(err) = replace_control_marker(cwd, &path, body.as_bytes()) {
        tracing::warn!(
            path = %path.display(),
            error = %err,
            "failed to write .acorn-control.md marker",
        );
    }
}

fn replace_control_marker(cwd: &Path, path: &Path, body: &[u8]) -> io::Result<()> {
    // The destination is repository-controlled and may already be a symlink or
    // hard link. Write to an unpredictable create-new file in the same
    // directory, then atomically replace the directory entry so the marker
    // write never follows that link to another file.
    let mut temporary = tempfile::Builder::new()
        .prefix(".acorn-control.md.")
        .suffix(".tmp")
        .tempfile_in(cwd)?;
    temporary.write_all(body)?;
    temporary
        .persist(path)
        .map_err(|persist_error| persist_error.error)?;
    Ok(())
}

#[tauri::command]
pub fn pty_subscribe_output(
    state: State<'_, AppState>,
    session_id: String,
    channel: Channel<Response>,
) -> AppResult<u64> {
    let id = parse_id(&session_id)?;
    Ok(state.pty_output.subscribe(id, channel))
}

#[tauri::command]
pub fn pty_unsubscribe_output(
    state: State<'_, AppState>,
    session_id: String,
    token: u64,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    state.pty_output.unsubscribe(&id, token);
    Ok(())
}

#[tauri::command]
pub fn pty_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let bytes = decode_b64(&data)?;
    let submit_revision =
        is_terminal_submit_frame(&bytes).then(|| state.sessions.hook_revision(&id));
    // Daemon-managed sessions route stdin through the control socket.
    // Keystrokes are small; one RPC round-trip per keystroke is well
    // under the typing-feedback threshold and avoids managing a second
    // socket on the app side just for input. A stream attachment is the
    // fast-path signal, but detached/re-attaching sessions can be alive in
    // the daemon without an app-side output pump for a short window.
    if daemon_session_alive_or_attached(&state, id) {
        state
            .daemon_bridge
            .send_input(id, &bytes)
            .map_err(|e| AppError::Pty(e.to_string()))?;
    } else {
        state
            .pty
            .write(&id, &bytes)
            .map_err(|e| AppError::Pty(e.to_string()))?;
    }

    if let Some(revision) = submit_revision {
        match state.sessions.refresh_status_if_hook_revision(
            &id,
            SessionStatus::WaitingForInput,
            revision,
            SessionStatus::Working,
        ) {
            Ok(true) => {
                persist(&state);
                if let Err(err) =
                    app.emit(crate::agent_hooks::AGENT_HOOK_STATUS_EVENT, id.to_string())
                {
                    tracing::warn!(%id, error = %err, "terminal submit status emit failed");
                }
            }
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(%id, error = %err, "terminal submit status refresh failed");
            }
        }
    }
    Ok(())
}

fn is_terminal_submit_frame(bytes: &[u8]) -> bool {
    matches!(bytes, b"\r" | b"\n" | b"\r\n")
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    if daemon_session_alive_or_attached(&state, id) {
        return state
            .daemon_bridge
            .resize(id, cols, rows)
            .map_err(|e| AppError::Pty(e.to_string()));
    }
    state
        .pty
        .resize(&id, cols, rows)
        .map_err(|e| AppError::Pty(e.to_string()))
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let stream_attached = state.stream_registry.contains(&id);
    if stream_attached || state.daemon_bridge.is_alive(id) {
        // Order: tell the daemon to terminate the PTY first, then
        // release the stream attachment. The daemon's wait thread
        // emits an `Exit` frame the stream pump turns into a Tauri
        // event, so the frontend sees the same exit signal it would
        // get from an in-process kill. Drop the attachment after to
        // free the entry in `stream_registry` even if the daemon
        // already disconnected first.
        let result = state
            .daemon_bridge
            .kill(id)
            .map_err(|e| AppError::Pty(e.to_string()));
        if stream_attached {
            state.stream_registry.drop_attachment(&id);
        }
        return result;
    }
    state
        .pty
        .kill(&id)
        .map_err(|e| AppError::Pty(e.to_string()))
}

/// Detach the frontend from a daemon-managed session's PTY *without* killing
/// it. Unlike [`pty_kill`], the daemon keeps the child process and its
/// scrollback ring alive, so a later [`pty_spawn`] re-attaches and replays the
/// ring. Used by the terminal eviction path to free frontend xterm memory for
/// idle, off-screen sessions while leaving the running shell untouched.
///
/// Detach is a daemon-only capability: in-process PTYs have no re-attach replay
/// (a second `pty_spawn` no-ops without replaying the tail ring), so evicting
/// one would leave the user staring at a blank terminal. For an in-process or
/// unknown session this is a no-op and returns `false` — the caller must keep
/// such terminals mounted instead of evicting them.
///
/// `output_token` is the renderer output subscription being unmounted. If a
/// newer renderer has already subscribed for the same session, the detach is a
/// stale cleanup and must not drop the current daemon stream attachment.
#[tauri::command]
pub fn pty_detach(
    state: State<'_, AppState>,
    session_id: String,
    output_token: Option<u64>,
) -> AppResult<bool> {
    let id = parse_id(&session_id)?;
    let stream_attached = state.stream_registry.contains(&id);
    if stream_attached {
        if detach_requested_by_stale_renderer(output_token, state.pty_output.current_token(&id)) {
            return Ok(true);
        }
        state.stream_registry.drop_attachment(&id);
        return Ok(true);
    }
    if state.daemon_bridge.is_alive(id) {
        return Ok(true);
    }
    Ok(false)
}

fn daemon_session_alive_or_attached(state: &AppState, id: Uuid) -> bool {
    state.stream_registry.contains(&id) || state.daemon_bridge.is_alive(id)
}

fn detach_requested_by_stale_renderer(
    detach_output_token: Option<u64>,
    current_output_token: Option<u64>,
) -> bool {
    match (detach_output_token, current_output_token) {
        (Some(detach_token), Some(current_token)) => detach_token != current_token,
        (None, Some(_)) => true,
        _ => false,
    }
}

/// Drop the cached snapshot of the user's shell environment. The next PTY
/// spawn re-runs `$SHELL -l -i -c` and picks up dotfile edits the user has
/// made since the last capture. Existing PTY children are unaffected —
/// their environment is fixed at fork time, so the frontend should tell
/// the user "restart sessions to apply".
#[tauri::command]
pub fn pty_reload_shell_env() {
    crate::shell_env::invalidate();
}

/// Resolve the *live* working directory of a session's PTY tree.
///
/// The PTY child is always `$SHELL`; we walk descendants and return the
/// cwd of the deepest descendant that exposes one. This catches the
/// common drift case where the user types e.g. `claude -w` and the agent
/// chdirs into a freshly created worktree as a grandchild, while the
/// shell's own cwd is still the original project root.
///
/// Returns `None` if the session has no live PTY (not yet spawned, or
/// already exited). The frontend then falls back to the session's recorded
/// `worktree_path`.
#[tauri::command]
pub async fn pty_cwd(state: State<'_, AppState>, session_id: String) -> AppResult<Option<String>> {
    let state = state.inner().clone();
    run_blocking("pty_cwd", move || pty_cwd_inner(state, session_id)).await
}

fn pty_cwd_inner(state: AppState, session_id: String) -> AppResult<Option<String>> {
    let id = parse_id(&session_id)?;
    let Some(root_pid) = session_root_pid(&state, &id) else {
        return Ok(None);
    };

    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::Always)
            .with_exe(UpdateKind::Always)
            .with_cmd(UpdateKind::Always),
    );

    Ok(deepest_descendant_cwd(&sys, Pid::from_u32(root_pid)))
}

fn session_root_pid(state: &AppState, id: &Uuid) -> Option<u32> {
    state
        .stream_registry
        .pid(id)
        .or_else(|| state.pty.child_pid(id))
}

/// Like [`pty_cwd`], but resolves the cwd to its enclosing git repository's
/// working directory via `Repository::discover`. Returns `None` whenever
/// either the PTY has no live cwd or that cwd lies outside any git repo —
/// the latter happens routinely when the user `cd`s into a Cargo registry
/// source dir or any other non-repo path.
///
/// Callers (currently `RightPanel`'s live-repo resolver) use the returned
/// path verbatim as the `repo_path` argument to git commands. The frontend
/// falls back to the session's recorded `worktree_path` on `None`, which
/// avoids a persistent "could not find git repository from '<cargo-dir>'"
/// banner appearing inside the panel any time the PTY drifts outside a
/// repo.
#[tauri::command]
pub async fn pty_repo_root(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<String>> {
    let id = parse_id(&session_id)?;
    let Some(root_pid) = session_root_pid(state.inner(), &id) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut sys = System::new_with_specifics(
            RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
        );
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
        );
        let Some(cwd) = deepest_descendant_cwd(&sys, Pid::from_u32(root_pid)) else {
            return Ok(None);
        };
        let Ok(repo) = git2::Repository::discover(&cwd) else {
            return Ok(None);
        };
        Ok(repo.workdir().map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| crate::error::AppError::Other(format!("pty_repo_root join failed: {e}")))?
}

/// BFS over `sys`, starting at `root`, returning the cwd of the deepest
/// reachable descendant that has one. Falls back to `root`'s own cwd at
/// depth 0 when no deeper descendant exposes a cwd. `None` if the root PID
/// is gone from the table or has no readable cwd anywhere in the tree.
fn deepest_descendant_cwd(sys: &System, root: Pid) -> Option<String> {
    let mut frontier: Vec<(Pid, u32)> = vec![(root, 0)];
    let mut best: Option<(u32, String)> = None;
    let mut visited: std::collections::HashSet<Pid> = std::collections::HashSet::new();
    while let Some((pid, depth)) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        let Some(proc) = sys.process(pid) else {
            continue;
        };
        if let Some(cwd) = proc.cwd() {
            let path = cwd.to_string_lossy().into_owned();
            match &best {
                None => best = Some((depth, path)),
                Some((d, _)) if depth > *d => best = Some((depth, path)),
                _ => {}
            }
        }
        for (child_pid, child) in sys.processes() {
            if child.parent() == Some(pid) && !visited.contains(child_pid) {
                frontier.push((*child_pid, depth + 1));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// Classify an arbitrary path as "inside a linked git worktree". Walks up
/// via libgit2's `Repository::discover` so subdirectories of a worktree
/// resolve correctly, then checks whether the discovered workdir itself
/// is a linked worktree (`.git` is a file). Used by the xterm OSC 7
/// handler — every emit hands the host a fresh cwd from the shell and
/// the response feeds straight into the worktree-icon condition without
/// touching the system process table.
#[tauri::command]
pub fn is_path_linked_worktree(path: String) -> bool {
    linked_worktree_root(path).is_some()
}

#[tauri::command]
pub fn linked_worktree_root(path: String) -> Option<String> {
    let p = PathBuf::from(&path);
    let Ok(repo) = git2::Repository::discover(&p) else {
        return None;
    };
    repo.workdir()
        .filter(|workdir| worktree::is_linked_worktree_root(workdir))
        .map(|workdir| workdir.to_string_lossy().into_owned())
}

/// Batched live-cwd → "is linked worktree" probe for every session that has
/// a live PTY. Single system process refresh, one descendant walk per
/// session — ~20-30ms regardless of session count, vs. that cost × N when
/// callers loop `pty_cwd` per session.
///
/// Key invariant: a session id appears in the map **iff** it currently has a
/// live PTY. The value is `true` when its live cwd resolves inside a linked
/// worktree, `false` otherwise. Absence means "no live PTY — fall back to
/// the session's recorded `worktree_path` / `isolated` flags". Conflating
/// "no live PTY" with "live but not in a worktree" would let a stale static
/// signal override the fresh live one (e.g. user `cd`s out of an adopted
/// worktree).
#[tauri::command]
pub async fn pty_in_worktree_all(state: State<'_, AppState>) -> AppResult<HashMap<String, bool>> {
    let state = state.inner().clone();
    run_blocking("pty_in_worktree_all", move || {
        Ok(pty_in_worktree_all_inner(state))
    })
    .await
}

fn pty_in_worktree_all_inner(state: AppState) -> HashMap<String, bool> {
    let sessions = state.sessions.list();
    let pids: Vec<(Uuid, u32)> = sessions
        .iter()
        .filter_map(|s| session_root_pid(&state, &s.id).map(|pid| (s.id, pid)))
        .collect();
    if pids.is_empty() {
        return HashMap::new();
    }

    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
    );

    let mut out = HashMap::with_capacity(pids.len());
    for (id, pid) in pids {
        let in_worktree = match deepest_descendant_cwd(&sys, Pid::from_u32(pid)) {
            Some(cwd) => match git2::Repository::discover(&cwd) {
                Ok(repo) => repo
                    .workdir()
                    .map(worktree::is_linked_worktree_root)
                    .unwrap_or(false),
                Err(_) => false,
            },
            None => false,
        };
        out.insert(id.to_string(), in_worktree);
    }
    out
}

#[tauri::command]
pub async fn scrollback_save(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    // Reject saves for sessions that no longer exist. Without this guard,
    // Terminal.tsx's unmount-time flush races against `remove_session` and
    // recreates the orphan file the remove just deleted.
    let id = parse_id(&session_id)?;
    if state.sessions.get(&id).is_err() {
        return Ok(());
    }
    let dir = persistence::data_dir()?;
    scrollback::save(&dir, &session_id, &data)?;
    Ok(())
}

#[tauri::command]
pub async fn scrollback_load(session_id: String) -> AppResult<Option<String>> {
    let dir = persistence::data_dir()?;
    let value = scrollback::load(&dir, &session_id)?;
    Ok(value)
}

#[tauri::command]
pub async fn scrollback_delete(session_id: String) -> AppResult<()> {
    let dir = persistence::data_dir()?;
    scrollback::delete(&dir, &session_id)?;
    Ok(())
}

/// Return the on-disk size (in bytes) of scrollback files whose session
/// id no longer matches a known session. Live sessions' buffers are not
/// counted — only the reclaimable orphan portion is surfaced.
#[tauri::command]
pub async fn scrollback_orphan_size(state: State<'_, AppState>) -> AppResult<u64> {
    let live_ids: Vec<String> = state
        .sessions
        .list()
        .iter()
        .map(|s| s.id.to_string())
        .collect();
    let dir = persistence::data_dir()?;
    let value = scrollback::orphan_size_bytes(&dir, live_ids)?;
    Ok(value)
}

/// Delete scrollback files whose session id no longer matches a known
/// session. Live sessions are untouched — their buffers stay on disk
/// and will keep being kept up to date by the debounced output save.
#[tauri::command]
pub async fn scrollback_orphan_clear(state: State<'_, AppState>) -> AppResult<usize> {
    let live_ids: Vec<String> = state
        .sessions
        .list()
        .iter()
        .map(|s| s.id.to_string())
        .collect();
    let dir = persistence::data_dir()?;
    let count = scrollback::prune_orphans(&dir, live_ids)?;
    Ok(count)
}

#[tauri::command]
pub async fn read_session_todos(session_id: String, cwd: String) -> AppResult<Vec<TodoItem>> {
    let cwd = PathBuf::from(cwd);
    run_blocking("read_session_todos", move || {
        todos::read_latest_todos(&session_id, &cwd)
    })
    .await
}

#[derive(serde::Serialize)]
pub struct SessionStatusEntry {
    pub id: String,
    pub status: SessionStatus,
    pub status_reason: Option<SessionStatusReason>,
    pub agent_status_source: Option<AgentStatusSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_user_message_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_agent_message: Option<String>,
    pub agent_provider: Option<SessionAgentProvider>,
    pub agent_transcript_provider: Option<SessionAgentProvider>,
    pub agent_transcript_id: Option<String>,
    pub agent_transcript_path: Option<String>,
    pub agent_activity_at: Option<String>,
    pub active_processes: Vec<SessionProcessSummary>,
    /// Current branch read live from the session's worktree on each poll.
    /// `None` when the worktree has no readable HEAD (e.g. detached, or
    /// path was deleted out from under acorn). Lets the frontend reflect
    /// `git checkout` performed inside the session without requiring a
    /// manual refresh.
    pub branch: Option<String>,
    /// Git workdir that produced `branch`. This may differ from the
    /// recorded session worktree when a shell has `cd`'d into another
    /// repo/worktree; consumers that query git/GitHub should keep the
    /// branch and repo path paired.
    pub git_context_path: Option<String>,
    /// Auto-title opt-in after this poll. Carries the promotion performed
    /// when an agent transcript is first detected (see
    /// `auto_title_promotion_needed`) so the frontend planner becomes
    /// eligible without waiting for the next full session refresh.
    pub auto_title_enabled: Option<bool>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SessionProcessSummary {
    pub pid: u32,
    pub name: String,
    pub depth: u32,
}

/// A session created as a plain terminal starts with
/// `auto_title_enabled == Some(false)` — at creation time there is no
/// agent. Once an agent transcript is bound to the session, the user is
/// running an agent inside it, which is exactly the case auto titles
/// exist for. Promote the opt-in then; without this flip the per-session
/// gate permanently overrides the global auto-title setting for every
/// terminal session. Explicit values (`Some(true)`, legacy `None`) and
/// transcript-less shells are left untouched.
fn auto_title_promotion_needed(auto_title_enabled: Option<bool>, has_transcript: bool) -> bool {
    has_transcript && auto_title_enabled == Some(false)
}

fn chat_conversation_preview(
    chat_state: &persistence::ChatSessionState,
) -> agent_resume::ConversationPreview {
    const STATUS_PREVIEW_CHARS: usize = 90;
    let mut preview = agent_resume::ConversationPreview::default();
    for message in chat_state.messages.iter().rev() {
        match message.role {
            persistence::ChatRole::User if preview.last_user_message.is_none() => {
                preview.last_user_message =
                    collapse_preview(&message.content, STATUS_PREVIEW_CHARS);
                if preview.last_user_message.is_some() {
                    preview.last_user_message_at = Some(message.created_at.to_rfc3339());
                }
            }
            persistence::ChatRole::Assistant if preview.last_agent_message.is_none() => {
                preview.last_agent_message =
                    collapse_preview(&message.content, STATUS_PREVIEW_CHARS);
            }
            _ => {}
        }
        if preview.last_user_message.is_some() && preview.last_agent_message.is_some() {
            break;
        }
    }
    preview
}

fn transcript_activity_at(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339())
}

fn git_context_for_path(path: &std::path::Path) -> Option<(String, String)> {
    let branch = worktree::current_branch(path).ok()?;
    let repo = worktree::ensure_repo(path).ok()?;
    let workdir = repo.workdir()?;
    let root = workdir
        .canonicalize()
        .unwrap_or_else(|_| workdir.to_path_buf());
    Some((branch, root.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn detect_session_statuses(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<SessionStatusEntry>> {
    let state = state.inner().clone();
    // The process-table refresh, per-session branch probes, and the daemon
    // `list_sessions` RPC (which can sit in the daemon spawn retry loop for
    // seconds) are all blocking — keep them off the async executor, or the
    // frontend's status poll stalls every other Tauri command.
    run_blocking("detect_session_statuses", move || {
        detect_session_statuses_blocking(state, ids)
    })
    .await
}

/// Whether the transcript-tail status poll should yield to the hook-set
/// status instead of applying its own classification.
///
/// Agent lifecycle hooks are the authoritative turn-boundary signal. While an
/// agent process is alive under a hooked session the poll defers the entire
/// Working/Ready/WaitingForInput distinction to the hook-set store value and
/// does not consult the transcript tail at all, because the tail is stale in
/// *both* directions around a turn boundary:
/// - just after a turn ends, a long/tool-heavy turn's `end_turn` line may be
///   outside the 256 KiB window (or absent entirely), so the tail still reads
///   Working;
/// - just after the next prompt is submitted (UserPromptSubmit already fired
///   Working), the tail still shows the *previous* turn's `end_turn` and reads
///   Ready until the agent flushes the new turn's line.
///
/// Letting either through races the independent ~1s poll against the hook and
/// can mislabel a just-started turn as Ready. The poll therefore trusts the
/// hook whenever an agent is live.
///
/// Once no matching agent process is live (the agent exited, another provider
/// now owns the PTY, or an unrelated command owns the PTY), the poll drives
/// status again.
/// Trade-off: a dropped terminating hook can leave status lagging at the last
/// hook value until the next hook or the agent exits.
fn poll_defers_to_hook(
    hook_active: bool,
    hook_provider: Option<AgentKind>,
    live_agent_kind: Option<AgentKind>,
) -> bool {
    if !hook_active {
        return false;
    }
    let Some(live_agent_kind) = live_agent_kind else {
        return false;
    };
    hook_provider.map_or(true, |provider| provider == live_agent_kind)
}

fn fallback_agent_status_source(
    live_agent_kind: Option<AgentKind>,
    evidence: session_status::StatusEvidence,
    previous_source: Option<AgentStatusSource>,
) -> Option<AgentStatusSource> {
    live_agent_kind?;
    match evidence {
        session_status::StatusEvidence::Transcript => Some(AgentStatusSource::TranscriptFallback),
        session_status::StatusEvidence::Process => Some(AgentStatusSource::ProcessFallback),
        session_status::StatusEvidence::Previous => previous_source,
    }
}

/// Recover a turn boundary that was crossed while the app was closed.
///
/// `hook_active` persists across restarts, so right after boot the poll
/// already defers to the persisted hook-set status. Durable hook delivery
/// normally replays events received while the app is unavailable, but the
/// transcript remains the bounded compatibility signal for records that
/// predate durable delivery or could not be retained. Until the first hook
/// event of this run confirms the channel, allow exactly one recovery:
/// Working -> WaitingForInput backed by a real turn-complete marker.
///
/// One-directional on purpose: while the app is closed nobody can submit a
/// prompt to the session, so a resting status cannot regress to Working
/// offline and a stale-tail Working must never demote a persisted resting
/// status. Once an event lands this run (`hook_confirmed_this_run`), hooks
/// own both directions again and this reconciliation switches off — leaving
/// it open in-run would recreate the UserPromptSubmit-vs-stale-tail race the
/// full hook deference exists to close.
fn hook_boot_reconciled_status(
    stored: SessionStatus,
    hook_confirmed_this_run: bool,
    detection: session_status::StatusDetection,
) -> Option<SessionStatus> {
    (!hook_confirmed_this_run
        && stored == SessionStatus::Working
        && detection.status == SessionStatus::Ready
        && detection.reason == Some(SessionStatusReason::TurnComplete))
    .then_some(SessionStatus::WaitingForInput)
}

fn detect_session_statuses_blocking(
    state: AppState,
    ids: Vec<String>,
) -> AppResult<Vec<SessionStatusEntry>> {
    // Fence every poll write against lifecycle events that arrive while the
    // process table and transcripts are being inspected. The clear-on-exit
    // path advances this generation before a later invocation can claim the
    // same provider again.
    let lifecycle_snapshots_before_refresh: HashMap<
        Uuid,
        (SessionStatus, Option<AgentStatusSource>, u64, u64),
    > = ids
        .iter()
        .filter_map(|id| Uuid::parse_str(id).ok())
        .filter_map(|id| {
            state
                .sessions
                .lifecycle_snapshot(&id)
                .ok()
                .map(|snapshot| (id, snapshot))
        })
        .collect();
    // One process-table snapshot covers every session in this poll. cwd is
    // refreshed because the live PTY descendant cwd drives branch detection
    // — a non-isolated session whose terminal `cd`'d into a git worktree
    // (or whose Claude Code invocation used `-w` to spawn one) has a HEAD
    // distinct from the recorded `worktree_path` (which is the project
    // root). Without this, the StatusBar/Sidebar branch stays pinned to the
    // project root's branch regardless of `git checkout` performed inside
    // the PTY.
    let refresh = ProcessRefreshKind::nothing()
        .with_cwd(UpdateKind::Always)
        .with_exe(UpdateKind::Always)
        .with_cmd(UpdateKind::Always);
    let mut sys = System::new_with_specifics(RefreshKind::nothing().with_processes(refresh));
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
    let children = build_children_map(&sys);
    let daemon_session_pids = std::sync::OnceLock::<HashMap<Uuid, u32>>::new();
    let daemon_pid_for = |uuid: Uuid| {
        daemon_session_pids
            .get_or_init(|| {
                state
                    .daemon_bridge
                    .list_sessions()
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter(|s| s.alive)
                    .filter_map(|s| s.pid.map(|pid| (s.id, pid)))
                    .collect()
            })
            .get(&uuid)
            .copied()
    };

    let mut promoted_auto_title = false;
    let mut reconciled_hook_status = false;
    let mut cleared_hook_ownership = false;
    let entries: Vec<SessionStatusEntry> = ids
        .into_iter()
        .map(|id| {
            // Hand the detector the in-memory previous status so it can
            // preserve a live session's classification when the tail buffer
            // happens to land on a run of meta-only lines (see
            // `session_status::detect` for the full rationale).
            let parsed_id = Uuid::parse_str(&id).ok();
            let session = parsed_id.and_then(|uuid| state.sessions.get(&uuid).ok());
            let initial_lifecycle =
                parsed_id.and_then(|uuid| lifecycle_snapshots_before_refresh.get(&uuid).copied());
            let previous = initial_lifecycle
                .map(|(status, _, _, _)| status)
                .or_else(|| session.as_ref().map(|session| session.status))
                .unwrap_or(SessionStatus::Ready);
            let previous_source = initial_lifecycle.and_then(|(_, source, _, _)| source);
            let observed_hook_revision = initial_lifecycle
                .map(|(_, _, revision, _)| revision)
                .unwrap_or(0);
            let observed_lifecycle_revision = initial_lifecycle
                .map(|(_, _, _, revision)| revision)
                .unwrap_or(0);
            if matches!(session.as_ref().map(|s| s.mode), Some(SessionMode::Chat)) {
                let git_context = session
                    .as_ref()
                    .and_then(|s| git_context_for_path(&s.worktree_path));
                let branch = git_context.as_ref().map(|(branch, _)| branch.clone());
                let git_context_path = git_context.map(|(_, path)| path);
                let chat_state = persistence::load_chat_session_state(&id).ok();
                let conversation_preview = chat_state.as_ref().map(chat_conversation_preview);
                let agent_activity_at = chat_state
                    .as_ref()
                    .filter(|state| !state.messages.is_empty())
                    .map(|state| state.updated_at.to_rfc3339());
                return SessionStatusEntry {
                    id,
                    status: previous,
                    status_reason: None,
                    agent_status_source: None,
                    last_message: conversation_preview
                        .as_ref()
                        .and_then(|p| p.last_agent_message.clone()),
                    last_user_message: conversation_preview
                        .as_ref()
                        .and_then(|p| p.last_user_message.clone()),
                    last_user_message_at: conversation_preview
                        .as_ref()
                        .and_then(|p| p.last_user_message_at.clone()),
                    last_agent_message: conversation_preview
                        .as_ref()
                        .and_then(|p| p.last_agent_message.clone()),
                    agent_provider: session.as_ref().and_then(|s| s.agent_provider),
                    agent_transcript_provider: None,
                    agent_transcript_id: session
                        .as_ref()
                        .and_then(|s| s.agent_transcript_id.clone()),
                    agent_transcript_path: None,
                    agent_activity_at,
                    active_processes: Vec::new(),
                    branch,
                    git_context_path,
                    auto_title_enabled: session.as_ref().and_then(|s| s.auto_title_enabled),
                };
            }
            // Routing-aware pid lookup. Daemon-managed sessions live
            // in `stream_registry` (their root pid was captured from
            // the daemon at spawn / attach); legacy in-process sessions
            // live in `state.pty`. Each side keeps separate liveness storage
            // because the sticky shell-prompt deadline is per attachment.
            let daemon_pid = session
                .as_ref()
                .and_then(|s| s.daemon_session_id)
                .and_then(daemon_pid_for);
            let root_pid =
                parsed_id.and_then(|uuid| status_poll_root_pid_source(&state, uuid, daemon_pid));
            let shell_hint = parsed_id.and_then(|uuid| {
                let (root, source) = root_pid?;
                let has_child_now = has_live_descendant(&children, Pid::from_u32(root));
                match source {
                    StatusPollRootPidSource::AttachedDaemon => state
                        .stream_registry
                        .update_shell_state(&uuid, has_child_now)
                        .or_else(|| {
                            Some(shell_hint_for_unattached_daemon_status_poll(has_child_now))
                        }),
                    StatusPollRootPidSource::InProcess => {
                        state.pty.update_shell_state(&uuid, has_child_now)
                    }
                    StatusPollRootPidSource::UnattachedDaemon => {
                        Some(shell_hint_for_unattached_daemon_status_poll(has_child_now))
                    }
                }
            });
            let root_pid_value = root_pid.map(|(pid, _)| pid);
            let active_processes = root_pid_value
                .map(|pid| session_process_summaries(&sys, &children, Pid::from_u32(pid)))
                .unwrap_or_default();
            let live_agent = root_pid_value
                .and_then(|pid| live_agent_in_descendants(&sys, &children, Pid::from_u32(pid)));
            let live_agent_kind = live_agent.map(|(kind, _)| kind);
            let hook_active_before_clear = parsed_id
                .map(|uuid| state.sessions.is_hook_active(&uuid))
                .unwrap_or(false);
            let hook_provider_before_clear =
                parsed_id.and_then(|uuid| state.sessions.hook_provider(&uuid));
            let hook_ownership_cleared = hook_active_before_clear
                && !poll_defers_to_hook(
                    hook_active_before_clear,
                    hook_provider_before_clear,
                    live_agent_kind,
                )
                && parsed_id.is_some_and(|uuid| {
                    state
                        .sessions
                        .clear_hook_ownership_if_revision(
                            &uuid,
                            observed_hook_revision,
                            observed_lifecycle_revision,
                        )
                        .unwrap_or(false)
                });
            cleared_hook_ownership |= hook_ownership_cleared;
            let (expected_poll_source, expected_poll_lifecycle_revision) = if hook_ownership_cleared
            {
                parsed_id
                    .and_then(|uuid| state.sessions.lifecycle_snapshot(&uuid).ok())
                    .map(|(_, source, _, lifecycle_revision)| (source, lifecycle_revision))
                    .unwrap_or((None, observed_lifecycle_revision))
            } else {
                (previous_source, observed_lifecycle_revision)
            };
            let codex_tool_started_at =
                parsed_id.and_then(|uuid| state.sessions.hook_tool_started_at(&uuid));
            let codex_permission_waiting_at =
                parsed_id.and_then(|uuid| state.sessions.codex_permission_waiting_at(&uuid));
            let codex_activity_started_at =
                match (codex_tool_started_at, codex_permission_waiting_at) {
                    (Some(tool), Some(permission)) => Some(tool.max(permission)),
                    (Some(tool), None) => Some(tool),
                    (None, Some(permission)) => Some(permission),
                    (None, None) => None,
                };
            let live_codex_tool_child = matches!(live_agent_kind, Some(AgentKind::Codex))
                && root_pid_value.is_some_and(|pid| {
                    live_codex_has_tool_descendant(
                        &sys,
                        &children,
                        Pid::from_u32(pid),
                        codex_activity_started_at,
                    )
                });
            // Resolve the live transcript via the persister's resume markers
            // first (covers claude/codex/antigravity run inside a shell session — JSONL
            // is named after the agent's own UUID, not Acorn's). When the PTY
            // tree already exposes a live provider, only trust that provider's
            // marker. A nested peer agent from another provider can update its
            // own marker while the parent agent is still the session owner.
            let live = parsed_id.and_then(|uuid| match live_agent_kind {
                Some(kind) => agent_resume::live_transcript_for_kind(uuid, kind),
                None => agent_resume::live_transcript(uuid),
            });
            // Claude gets a marker-less fallback below via the todos
            // mapping; codex has no equivalent, so a persister miss (pid
            // gap at spawn, ambiguous host scan) silently disables auto
            // titles and resume for the whole session. Bind the live
            // codex process straight to its rollout instead.
            let live = live.or_else(|| codex_live_transcript_fallback(&sys, parsed_id, live_agent));
            let agent_binding_changed =
                session
                    .as_ref()
                    .zip(live.as_ref())
                    .is_some_and(|(session, transcript)| {
                        session.agent_transcript_id.as_deref() != Some(transcript.id.as_str())
                    });
            let agent_transcript_id = live.as_ref().map(|t| t.id.clone());
            let transcript = match live.as_ref() {
                Some(t) => Some((t.path.clone(), t.kind)),
                None if matches!(live_agent_kind, None | Some(AgentKind::Claude)) => {
                    todos::locate_transcript_for(&id)
                        .ok()
                        .flatten()
                        .map(|p| (p, AgentKind::Claude))
                }
                None => None,
            };
            let conversation_preview = transcript.as_ref().and_then(|(path, kind)| {
                agent_resume::extract_conversation_preview(*kind, path).ok()
            });
            let agent_transcript_path = transcript
                .as_ref()
                .map(|(path, _)| path.to_string_lossy().into_owned());
            let agent_activity_at = transcript
                .as_ref()
                .and_then(|(path, _)| transcript_activity_at(path));
            let agent_transcript_provider = transcript.as_ref().map(|(_, kind)| *kind);
            let transcript_preview = conversation_preview
                .as_ref()
                .and_then(|p| p.last_agent_message.clone());
            let shell_hint = refine_shell_hint_for_unpaired_agent(
                shell_hint,
                transcript.is_some(),
                live_agent_kind,
            );
            // Durable transcript markers keep resume/title features working
            // after exit, but provider badges should reflect only a live
            // agent process under the PTY.
            let agent_provider = live_agent_kind;
            let auto_title_enabled = {
                let current = session.as_ref().and_then(|s| s.auto_title_enabled);
                match parsed_id {
                    Some(uuid) if auto_title_promotion_needed(current, transcript.is_some()) => {
                        promoted_auto_title = true;
                        state
                            .sessions
                            .set_auto_title_enabled(&uuid, true)
                            .ok()
                            .and_then(|s| s.auto_title_enabled)
                            .or(Some(true))
                    }
                    _ => current,
                }
            };
            let detection = session_status::detect_with_reason(transcript, previous, shell_hint);
            let hook_provider = parsed_id.and_then(|uuid| state.sessions.hook_provider(&uuid));
            let defer_to_hook = poll_defers_to_hook(
                parsed_id
                    .map(|uuid| state.sessions.is_hook_active(&uuid))
                    .unwrap_or(false),
                hook_provider,
                live_agent_kind,
            );
            let mut metadata_write_allowed = true;
            let metadata_expected_lifecycle_revision;
            let metadata_expected_source;
            // When a live hooked agent owns the status, keep the hook-set value
            // instead of the stale transcript reading. Re-read it fresh: a hook
            // may have written during this poll's process-table / transcript
            // I/O, and reusing the `previous` captured before that I/O would
            // clobber the newer hook status back to an old value.
            let (status, agent_status_source, status_reason) = if defer_to_hook {
                let (stored, stored_source, hook_revision, lifecycle_revision) = parsed_id
                    .and_then(|uuid| state.sessions.lifecycle_snapshot(&uuid).ok())
                    .unwrap_or((
                        previous,
                        previous_source,
                        observed_hook_revision,
                        observed_lifecycle_revision,
                    ));
                // Reconcile only while this app instance has not received a
                // native event. The revision/source checks make the status
                // and diagnostic provenance one conditional write.
                let reconciliation_requested =
                    hook_boot_reconciled_status(stored, hook_revision > 0, detection);
                let reconciled = parsed_id.and_then(|uuid| {
                    reconciliation_requested.and_then(|reconciled| {
                        state
                            .sessions
                            .refresh_status_and_source_if_lifecycle_revision(
                                &uuid,
                                stored,
                                stored_source,
                                lifecycle_revision,
                                reconciled,
                                Some(AgentStatusSource::TranscriptFallback),
                            )
                            .ok()
                            .flatten()
                            .map(|_| reconciled)
                    })
                });
                if reconciliation_requested.is_some() && reconciled.is_none() {
                    metadata_write_allowed = false;
                }
                reconciled_hook_status |= reconciled.is_some();
                let (hook_status, current_source, _, current_lifecycle_revision) = parsed_id
                    .and_then(|uuid| state.sessions.lifecycle_snapshot(&uuid).ok())
                    .unwrap_or((
                        reconciled.unwrap_or(stored),
                        reconciled
                            .map(|_| AgentStatusSource::TranscriptFallback)
                            .or(stored_source),
                        hook_revision,
                        lifecycle_revision,
                    ));
                // Codex can finish its main turn while a background command
                // remains alive. Its persistent helpers are filtered below.
                // Keep the permission boundary until a lifecycle event
                // changes the store; this poll result is intentionally not
                // written over a hook-owned Waiting status.
                let visible_status = hook_status_with_live_tool_activity(
                    hook_status,
                    live_agent_kind,
                    live_codex_tool_child,
                    codex_permission_waiting_at.is_some(),
                );
                metadata_expected_lifecycle_revision = current_lifecycle_revision;
                metadata_expected_source = current_source;
                let visible_source = if visible_status != hook_status {
                    Some(AgentStatusSource::ProcessFallback)
                } else {
                    // Runtime provenance is intentionally not persisted. Right
                    // after restart a persisted hook owner therefore remains
                    // unknown until replay, reconciliation, or a fresh native
                    // event establishes the source; do not guess `Hook` here.
                    current_source
                };
                (visible_status, visible_source, None)
            } else {
                let candidate_source = fallback_agent_status_source(
                    live_agent_kind,
                    detection.evidence,
                    expected_poll_source,
                );
                let applied_lifecycle_revision = match parsed_id {
                    Some(uuid) => state
                        .sessions
                        .refresh_status_and_source_if_lifecycle_revision(
                            &uuid,
                            previous,
                            expected_poll_source,
                            expected_poll_lifecycle_revision,
                            detection.status,
                            candidate_source,
                        )
                        .ok()
                        .flatten(),
                    None => Some(expected_poll_lifecycle_revision),
                };
                if let Some(applied_lifecycle_revision) = applied_lifecycle_revision {
                    metadata_expected_lifecycle_revision = applied_lifecycle_revision;
                    metadata_expected_source = candidate_source;
                    (detection.status, candidate_source, detection.reason)
                } else {
                    metadata_write_allowed = false;
                    let (latest_status, latest_source, _, latest_lifecycle_revision) = parsed_id
                        .and_then(|uuid| state.sessions.lifecycle_snapshot(&uuid).ok())
                        .unwrap_or((
                            detection.status,
                            candidate_source,
                            observed_hook_revision,
                            expected_poll_lifecycle_revision,
                        ));
                    metadata_expected_lifecycle_revision = latest_lifecycle_revision;
                    metadata_expected_source = latest_source;
                    (latest_status, latest_source, None)
                }
            };
            // Branch source priority:
            //  1. deepest PTY descendant cwd — reflects `cd` + `git checkout`
            //     performed inside the terminal (and `claude -w` worktrees)
            //  2. recorded session worktree_path — fallback when no live PTY
            //     or descendant cwd lies outside any git repo
            let live_git_context = root_pid_value
                .and_then(|pid| deepest_descendant_cwd(&sys, Pid::from_u32(pid)))
                .and_then(|p| git_context_for_path(std::path::Path::new(&p)));
            let fallback_git_context = session
                .as_ref()
                .and_then(|s| git_context_for_path(&s.worktree_path));
            let git_context = live_git_context.or(fallback_git_context);
            let branch = git_context.as_ref().map(|(branch, _)| branch.clone());
            let git_context_path = git_context.map(|(_, path)| path);
            // Keep live-agent metadata on the same lifecycle fence as the
            // status/source write. A native or fallback event that landed
            // during this poll must retain its newer provider claim.
            let agent_metadata_applied = if let Some(uuid) = parsed_id {
                if metadata_write_allowed {
                    state
                        .sessions
                        .refresh_agent_state_if_lifecycle_revision(
                            &uuid,
                            metadata_expected_lifecycle_revision,
                            metadata_expected_source,
                            agent_provider,
                            agent_transcript_id.clone(),
                        )
                        .unwrap_or(false)
                } else {
                    false
                }
            } else {
                false
            };
            if agent_metadata_applied && agent_binding_changed {
                if let (Some(session), Some(transcript)) = (session.as_ref(), live.clone()) {
                    crate::agent_session_names::enqueue_existing_title(session, transcript);
                }
            }
            SessionStatusEntry {
                id,
                status,
                status_reason,
                agent_status_source,
                last_message: transcript_preview,
                last_user_message: conversation_preview
                    .as_ref()
                    .and_then(|p| p.last_user_message.clone()),
                last_user_message_at: conversation_preview
                    .as_ref()
                    .and_then(|p| p.last_user_message_at.clone()),
                last_agent_message: conversation_preview
                    .as_ref()
                    .and_then(|p| p.last_agent_message.clone()),
                agent_provider,
                agent_transcript_provider,
                agent_transcript_id,
                agent_transcript_path,
                agent_activity_at,
                active_processes,
                branch,
                git_context_path,
                auto_title_enabled,
            }
        })
        .collect();
    // Promotion must survive an app restart — without the save a session
    // would silently fall back to ineligible until the agent runs again.
    if status_poll_needs_persist(
        promoted_auto_title,
        reconciled_hook_status,
        cleared_hook_ownership,
    ) {
        persist_sessions(&state);
    }
    Ok(entries)
}

fn status_poll_needs_persist(
    promoted_auto_title: bool,
    reconciled_hook_status: bool,
    cleared_hook_ownership: bool,
) -> bool {
    promoted_auto_title || reconciled_hook_status || cleared_hook_ownership
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StatusPollRootPidSource {
    AttachedDaemon,
    InProcess,
    UnattachedDaemon,
}

fn status_poll_root_pid_source(
    state: &AppState,
    uuid: Uuid,
    daemon_pid: Option<u32>,
) -> Option<(u32, StatusPollRootPidSource)> {
    let stream_attached = state.stream_registry.contains(&uuid);
    state
        .stream_registry
        .pid(&uuid)
        .or_else(|| stream_attached.then_some(daemon_pid).flatten())
        .map(|pid| (pid, StatusPollRootPidSource::AttachedDaemon))
        .or_else(|| {
            state
                .pty
                .child_pid(&uuid)
                .map(|pid| (pid, StatusPollRootPidSource::InProcess))
        })
        .or_else(|| daemon_pid.map(|pid| (pid, StatusPollRootPidSource::UnattachedDaemon)))
}

fn shell_hint_for_unattached_daemon_status_poll(has_live_descendant: bool) -> acorn_pty::ShellHint {
    if has_live_descendant {
        acorn_pty::ShellHint::Running
    } else {
        acorn_pty::ShellHint::Idle
    }
}

/// One pass over `sys.processes()` that yields parent→children adjacency.
/// Built once per poll so the per-session BFS does not rescan the whole
/// table for every PTY root.
fn build_children_map(sys: &System) -> HashMap<Pid, Vec<Pid>> {
    let mut map: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, proc) in sys.processes() {
        if let Some(parent) = proc.parent() {
            map.entry(parent).or_default().push(*pid);
        }
    }
    map
}

fn refine_shell_hint_for_unpaired_agent(
    shell_hint: Option<acorn_pty::ShellHint>,
    has_transcript: bool,
    live_agent_kind: Option<AgentKind>,
) -> Option<acorn_pty::ShellHint> {
    if has_transcript {
        return shell_hint;
    }
    match (shell_hint, live_agent_kind) {
        (Some(acorn_pty::ShellHint::Running), Some(AgentKind::Codex)) => {
            Some(acorn_pty::ShellHint::NeedsInput)
        }
        _ => shell_hint,
    }
}

/// Bind a live codex process to its rollout when the durable `codex.id`
/// marker is missing. The persister normally writes that marker within
/// seconds, but it can miss a run entirely (no root pid captured at spawn,
/// host-scan ambiguity) and nothing retries on its behalf — codex, unlike
/// claude, has no marker-less transcript mapping. Resolve the rollout from
/// the process's own cwd and start time under the conservative
/// single-candidate policy, and persist the marker so title generation and
/// resume converge on the same binding.
///
/// Known limitation: the single-candidate policy has no `assigned`-set
/// reservation, so two codex processes in the same cwd stay ambiguous and
/// the fallback fails safe to `None` rather than guessing.
fn codex_live_transcript_fallback(
    sys: &System,
    session_id: Option<Uuid>,
    live_agent: Option<(AgentKind, Pid)>,
) -> Option<agent_resume::LiveTranscript> {
    let session_id = session_id?;
    let (kind, pid) = live_agent?;
    if kind != AgentKind::Codex {
        return None;
    }
    let proc = sys.process(pid)?;
    let cwd = proc.cwd()?;
    let process_start = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(proc.start_time());
    let process_args = proc
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let resolved = if acorn_transcript::codex_resume_requested_from_args(&process_args) {
        acorn_transcript::find_resumed_codex_run_transcript(cwd, process_start)
    } else {
        acorn_transcript::find_agent_run_transcript(cwd, AgentKind::Codex, process_start)
    };
    let Some((path, id)) = resolved else {
        tracing::debug!(
            %session_id,
            pid = pid.as_u32(),
            ?cwd,
            "status poll: live codex has no unambiguous rollout; marker fallback skipped"
        );
        return None;
    };
    match crate::agent_resume_persister::bind_session_marker(session_id, AgentKind::Codex, &id) {
        Ok(()) => {
            note_codex_bind_recovered(&mut codex_bind_failure_registry(), session_id);
            tracing::info!(
                %session_id,
                %id,
                ?path,
                "status poll: bound live codex transcript via marker fallback"
            );
        }
        Err(err) => {
            // A persistent write failure (permissions, deleted state dir)
            // re-enters this fallback every poll tick; warn once per
            // failure streak, then drop to debug until a bind succeeds.
            if note_codex_bind_failure(&mut codex_bind_failure_registry(), session_id) {
                tracing::warn!(
                    %session_id, %id, error = %err,
                    "status poll: codex marker fallback write failed"
                );
            } else {
                tracing::debug!(
                    %session_id, %id, error = %err,
                    "status poll: codex marker fallback write still failing"
                );
            }
        }
    }
    Some(agent_resume::LiveTranscript {
        id,
        path,
        kind: AgentKind::Codex,
    })
}

/// Sessions whose codex marker fallback already warned about a write
/// failure this streak. Guards the poll-frequency `warn!` from repeating
/// every tick while the failure persists.
const CODEX_BIND_FAILURE_REGISTRY_CAPACITY: usize = 256;

struct CodexBindFailureRegistry {
    warned: HashSet<Uuid>,
    insertion_order: VecDeque<Uuid>,
    capacity: usize,
}

impl CodexBindFailureRegistry {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            warned: HashSet::with_capacity(capacity),
            insertion_order: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    fn note_failure(&mut self, session_id: Uuid) -> bool {
        if self.warned.contains(&session_id) {
            return false;
        }
        if self.capacity == 0 {
            return true;
        }
        while self.warned.len() >= self.capacity {
            let Some(oldest) = self.insertion_order.pop_front() else {
                break;
            };
            self.warned.remove(&oldest);
        }
        self.insertion_order.push_back(session_id);
        self.warned.insert(session_id);
        true
    }

    fn note_recovered(&mut self, session_id: Uuid) {
        if self.warned.remove(&session_id) {
            self.insertion_order.retain(|id| *id != session_id);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.warned.len()
    }

    #[cfg(test)]
    fn contains(&self, session_id: &Uuid) -> bool {
        self.warned.contains(session_id)
    }
}

fn codex_bind_failure_registry() -> std::sync::MutexGuard<'static, CodexBindFailureRegistry> {
    static WARNED: std::sync::OnceLock<Mutex<CodexBindFailureRegistry>> =
        std::sync::OnceLock::new();
    WARNED
        .get_or_init(|| {
            Mutex::new(CodexBindFailureRegistry::with_capacity(
                CODEX_BIND_FAILURE_REGISTRY_CAPACITY,
            ))
        })
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record a fallback write failure; `true` when this is the first failure
/// of the current streak (i.e. the caller should warn, not just debug).
fn note_codex_bind_failure(warned: &mut CodexBindFailureRegistry, session_id: Uuid) -> bool {
    warned.note_failure(session_id)
}

/// A successful bind ends the failure streak so the next failure warns again.
fn note_codex_bind_recovered(warned: &mut CodexBindFailureRegistry, session_id: Uuid) {
    warned.note_recovered(session_id);
}

/// Resolve the nearest live agent process under `root`, with its pid.
///
/// `found_pid` rides side-channel out of the closure; the pairing with the
/// returned kind is only sound because `nearest_agent_kind_in_tree` stops at
/// the FIRST `Some` the callback yields (see its doc). If that traversal ever
/// keeps scanning past a match, refactor the callback to return
/// `Option<(AgentKind, Pid)>` instead of relying on this capture.
fn live_agent_in_descendants(
    sys: &System,
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
) -> Option<(AgentKind, Pid)> {
    let mut found_pid = None;
    let kind = nearest_agent_kind_in_tree(children, root, |pid| {
        let proc = sys.process(pid)?;
        let kind = if process_basename_matches(proc, "codex") {
            AgentKind::Codex
        } else if process_basename_matches(proc, "claude") {
            AgentKind::Claude
        } else if process_basename_matches(proc, "agy")
            || process_basename_matches(proc, "antigravity")
            || process_basename_matches(proc, "antigravity-cli")
        {
            AgentKind::Antigravity
        } else {
            return None;
        };
        found_pid = Some(pid);
        Some(kind)
    })?;
    Some((kind, found_pid?))
}

fn live_codex_has_tool_descendant(
    sys: &System,
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
    activity_started_at: Option<SystemTime>,
) -> bool {
    let Some(activity_started_at) = activity_started_at else {
        return false;
    };
    let activity_cutoff = activity_started_at
        .checked_sub(CODEX_TOOL_PROCESS_START_TOLERANCE)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    has_current_activity_descendant_below_nearest_matching(
        children,
        root,
        |pid| {
            sys.process(pid)
                .is_some_and(|proc| process_primary_basename_matches(proc, "codex"))
        },
        |pid| {
            sys.process(pid)
                .is_some_and(is_codex_persistent_helper_process)
        },
        |pid| {
            sys.process(pid).is_some_and(|proc| {
                let process_started_at =
                    SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(proc.start_time());
                process_started_at >= activity_cutoff
            })
        },
    )
}

fn hook_status_with_live_tool_activity(
    hook_status: SessionStatus,
    live_agent_kind: Option<AgentKind>,
    live_tool_child: bool,
    permission_waiting: bool,
) -> SessionStatus {
    if live_tool_child
        && matches!(live_agent_kind, Some(AgentKind::Codex))
        && (hook_status == SessionStatus::Ready
            || (hook_status == SessionStatus::WaitingForInput && permission_waiting))
    {
        SessionStatus::Working
    } else {
        hook_status
    }
}

fn is_codex_persistent_helper_process(proc: &sysinfo::Process) -> bool {
    process_basename_matches(proc, "node_repl")
        || process_basename_matches(proc, "SkyComputerUseClient")
        || process_basename_matches(proc, "codex-code-mode-host")
        || process_basename_matches(proc, "acorn-codex-notify")
}

/// BFS from `root` that returns on the FIRST pid the callback classifies.
/// `live_agent_in_descendants` depends on this early-return to pair its
/// side-channel pid with the returned kind — keep the invariant if this
/// traversal ever grows ranking or multi-match behavior.
fn nearest_agent_kind_in_tree<F>(
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
    mut kind_for_pid: F,
) -> Option<AgentKind>
where
    F: FnMut(Pid) -> Option<AgentKind>,
{
    let mut queue = VecDeque::new();
    if let Some(direct) = children.get(&root) {
        let mut direct = direct.clone();
        direct.sort_by_key(|pid| pid.as_u32());
        queue.extend(direct);
    }
    while let Some(pid) = queue.pop_front() {
        if let Some(kind) = kind_for_pid(pid) {
            return Some(kind);
        }
        if let Some(kids) = children.get(&pid) {
            let mut kids = kids.clone();
            kids.sort_by_key(|pid| pid.as_u32());
            queue.extend(kids);
        }
    }
    None
}

fn nearest_descendant_matching<F>(
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
    mut matches: F,
) -> Option<Pid>
where
    F: FnMut(Pid) -> bool,
{
    let mut queue = VecDeque::new();
    if let Some(direct) = children.get(&root) {
        let mut direct = direct.clone();
        direct.sort_by_key(|pid| pid.as_u32());
        queue.extend(direct);
    }
    while let Some(pid) = queue.pop_front() {
        if matches(pid) {
            return Some(pid);
        }
        if let Some(kids) = children.get(&pid) {
            let mut kids = kids.clone();
            kids.sort_by_key(|pid| pid.as_u32());
            queue.extend(kids);
        }
    }
    None
}

fn has_current_activity_descendant_below_nearest_matching<F, G, H>(
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
    matches: F,
    mut ignore_subtree: G,
    mut is_current_activity: H,
) -> bool
where
    F: FnMut(Pid) -> bool,
    G: FnMut(Pid) -> bool,
    H: FnMut(Pid) -> bool,
{
    let Some(anchor) = nearest_descendant_matching(children, root, matches) else {
        return false;
    };
    let mut queue = VecDeque::new();
    if let Some(direct) = children.get(&anchor) {
        let mut direct = direct.clone();
        direct.sort_by_key(|pid| pid.as_u32());
        queue.extend(direct);
    }
    while let Some(pid) = queue.pop_front() {
        if ignore_subtree(pid) {
            continue;
        }
        if is_current_activity(pid) {
            return true;
        }
        if let Some(kids) = children.get(&pid) {
            let mut kids = kids.clone();
            kids.sort_by_key(|pid| pid.as_u32());
            queue.extend(kids);
        }
    }
    false
}

#[cfg(test)]
fn has_unignored_descendant_below_nearest_matching<F, G>(
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
    matches: F,
    ignore_subtree: G,
) -> bool
where
    F: FnMut(Pid) -> bool,
    G: FnMut(Pid) -> bool,
{
    has_current_activity_descendant_below_nearest_matching(
        children,
        root,
        matches,
        ignore_subtree,
        |_| true,
    )
}

/// `true` if any descendant of `root` exists in the children map. The root
/// itself does not count — we only care about commands launched *under* the
/// PTY shell, which is what flips Ready <-> Working for terminal sessions.
fn has_live_descendant(children: &HashMap<Pid, Vec<Pid>>, root: Pid) -> bool {
    children.get(&root).is_some_and(|direct| !direct.is_empty())
}

fn session_process_summaries(
    sys: &System,
    children: &HashMap<Pid, Vec<Pid>>,
    root: Pid,
) -> Vec<SessionProcessSummary> {
    let mut queue = VecDeque::new();
    if let Some(direct) = children.get(&root) {
        let mut direct = direct.clone();
        direct.sort_by_key(|pid| pid.as_u32());
        queue.extend(direct.into_iter().map(|pid| (pid, 1)));
    }

    let mut summaries = Vec::new();
    let mut fallback = Vec::new();
    while let Some((pid, depth)) = queue.pop_front() {
        if let Some(proc) = sys.process(pid) {
            let summary = SessionProcessSummary {
                pid: pid.as_u32(),
                name: process_display_name(proc),
                depth,
            };
            if is_session_process_noise(&summary.name) {
                fallback.push(summary);
            } else {
                summaries.push(summary);
            }
        }
        if let Some(kids) = children.get(&pid) {
            let mut kids = kids.clone();
            kids.sort_by_key(|child| child.as_u32());
            queue.extend(kids.into_iter().map(|child| (child, depth + 1)));
        }
    }

    if summaries.is_empty() {
        fallback
    } else {
        summaries
    }
}

fn is_session_process_noise(name: &str) -> bool {
    let base = basename(name).trim_matches(&['(', ')'][..]);
    matches!(base, "sh" | "bash" | "zsh" | "tail")
}

#[cfg(test)]
mod status_hint_tests {
    use super::*;

    #[test]
    fn unpaired_live_codex_process_maps_running_hint_to_needs_input() {
        assert_eq!(
            refine_shell_hint_for_unpaired_agent(
                Some(acorn_pty::ShellHint::Running),
                false,
                Some(AgentKind::Codex),
            ),
            Some(acorn_pty::ShellHint::NeedsInput),
        );
    }

    #[test]
    fn paired_codex_transcript_keeps_running_hint_for_transcript_classifier() {
        assert_eq!(
            refine_shell_hint_for_unpaired_agent(
                Some(acorn_pty::ShellHint::Running),
                true,
                Some(AgentKind::Codex),
            ),
            Some(acorn_pty::ShellHint::Running),
        );
    }

    #[test]
    fn unpaired_non_codex_process_keeps_original_hint() {
        assert_eq!(
            refine_shell_hint_for_unpaired_agent(
                Some(acorn_pty::ShellHint::Running),
                false,
                Some(AgentKind::Claude),
            ),
            Some(acorn_pty::ShellHint::Running),
        );
        assert_eq!(
            refine_shell_hint_for_unpaired_agent(
                Some(acorn_pty::ShellHint::Running),
                false,
                Some(AgentKind::Antigravity),
            ),
            Some(acorn_pty::ShellHint::Running),
        );
    }

    #[test]
    fn nearest_agent_kind_prefers_shallow_provider_over_nested_peer() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let wrapper = Pid::from_u32(3);
        let nested_claude = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![wrapper, codex]);
        children.insert(wrapper, vec![nested_claude]);

        let kind = nearest_agent_kind_in_tree(&children, root, |pid| {
            if pid == codex {
                Some(AgentKind::Codex)
            } else if pid == nested_claude {
                Some(AgentKind::Claude)
            } else {
                None
            }
        });

        assert_eq!(kind, Some(AgentKind::Codex));
    }

    #[test]
    fn has_live_descendant_tracks_root_subtree_liveness() {
        let root = Pid::from_u32(1);
        let child = Pid::from_u32(2);
        let grandchild = Pid::from_u32(3);
        let mut children = HashMap::new();
        children.insert(root, vec![child]);
        children.insert(child, vec![grandchild]);

        assert!(has_live_descendant(&children, root));
        assert!(!has_live_descendant(&children, grandchild));
    }

    #[test]
    fn matching_agent_with_child_reports_live_work_below_agent() {
        let root = Pid::from_u32(1);
        let wrapper = Pid::from_u32(2);
        let codex = Pid::from_u32(3);
        let tool = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![wrapper]);
        children.insert(wrapper, vec![codex]);
        children.insert(codex, vec![tool]);

        assert!(has_unignored_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |_| false,
        ));
    }

    #[test]
    fn matching_agent_without_child_reports_no_live_work_below_agent() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);

        assert!(!has_unignored_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |_| false,
        ));
    }

    #[test]
    fn matching_agent_with_only_ignored_child_reports_no_live_work_below_agent() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let helper = Pid::from_u32(3);
        let helper_child = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);
        children.insert(codex, vec![helper]);
        children.insert(helper, vec![helper_child]);

        assert!(!has_unignored_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |pid| pid == helper,
        ));
    }

    #[test]
    fn matching_agent_with_ignored_helper_and_tool_reports_live_work_below_agent() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let helper = Pid::from_u32(3);
        let tool = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);
        children.insert(codex, vec![helper, tool]);

        assert!(has_unignored_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |pid| pid == helper,
        ));
    }

    #[test]
    fn only_descendants_started_during_current_tool_activity_count_as_live_work() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let old_mcp = Pid::from_u32(3);
        let current_tool = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);
        children.insert(codex, vec![old_mcp, current_tool]);

        assert!(has_current_activity_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |_| false,
            |pid| pid == current_tool,
        ));
    }

    #[test]
    fn infrastructure_started_before_current_tool_activity_does_not_count() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let old_mcp = Pid::from_u32(3);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);
        children.insert(codex, vec![old_mcp]);

        assert!(!has_current_activity_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |_| false,
            |_| false,
        ));
    }

    #[test]
    fn current_tool_below_older_intermediary_still_counts_as_live_work() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let old_intermediary = Pid::from_u32(3);
        let current_tool = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);
        children.insert(codex, vec![old_intermediary]);
        children.insert(old_intermediary, vec![current_tool]);

        assert!(has_current_activity_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |_| false,
            |pid| pid == current_tool,
        ));
    }

    #[test]
    fn persistent_helper_subtrees_never_count_as_live_work() {
        let root = Pid::from_u32(1);
        let codex = Pid::from_u32(2);
        let helper = Pid::from_u32(3);
        let helper_child = Pid::from_u32(4);
        let mut children = HashMap::new();
        children.insert(root, vec![codex]);
        children.insert(codex, vec![helper]);
        children.insert(helper, vec![helper_child]);

        assert!(!has_current_activity_descendant_below_nearest_matching(
            &children,
            root,
            |pid| pid == codex,
            |pid| pid == helper,
            |pid| pid == helper_child,
        ));
    }

    #[test]
    fn session_process_noise_filters_shell_wrappers() {
        assert!(is_session_process_noise("(zsh)"));
        assert!(is_session_process_noise("tail"));
        assert!(!is_session_process_noise("codex"));
        assert!(!is_session_process_noise("rg"));
    }
}

#[tauri::command]
pub async fn list_commits(
    repo_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<Vec<CommitInfo>> {
    run_blocking("list_commits", move || {
        git_ops::list_commits(
            &PathBuf::from(repo_path),
            offset.unwrap_or(0),
            limit.unwrap_or(50),
        )
    })
    .await
}

#[tauri::command]
pub async fn list_staged(repo_path: String) -> AppResult<Vec<StagedFile>> {
    run_blocking("list_staged", move || {
        git_ops::list_staged(&PathBuf::from(repo_path))
    })
    .await
}

#[tauri::command]
pub async fn commit_diff(repo_path: String, sha: String) -> AppResult<DiffPayload> {
    run_blocking("commit_diff", move || {
        git_ops::diff_for_commit(&PathBuf::from(repo_path), &sha)
    })
    .await
}

#[tauri::command]
pub async fn commit_web_url(repo_path: String, sha: String) -> AppResult<Option<String>> {
    git_ops::web_url_for_commit(&PathBuf::from(repo_path), &sha)
}

/// `Some("owner/repo")` when the repo's `origin` remote points at GitHub,
/// `None` otherwise. The frontend uses this to hide the GitHub group of the
/// right panel for non-GitHub repos. Read-only and cheap — no network calls.
#[tauri::command]
pub async fn github_origin_slug(repo_path: String) -> AppResult<Option<String>> {
    run_blocking("github_origin_slug", move || {
        git_ops::github_owner_repo(&PathBuf::from(repo_path))
    })
    .await
}

/// True when `repo_path` is inside a git repository. The frontend uses this
/// to avoid showing GitHub-only UI for projects that have not run `git init`.
#[tauri::command]
pub async fn is_git_repository(repo_path: String) -> AppResult<bool> {
    run_blocking("is_git_repository", move || {
        Ok(git_ops::is_git_repository(&PathBuf::from(repo_path)))
    })
    .await
}

/// Spawn an external editor on `path`. Used by the "Open in editor" action
/// when the user has configured a custom editor command in settings.
///
/// `command` and `args` are taken verbatim from the user's setting; the path
/// is appended as the final argument. We deliberately do not route this
/// through the tauri-plugin-shell scope system because the user is configuring
/// the binary themselves at runtime — adding it to a static capability scope
/// would defeat the configurability.
#[tauri::command]
pub async fn open_in_editor(command: String, args: Vec<String>, path: String) -> AppResult<()> {
    let command = validate_editor_command(&command, &args)?;
    let path = canonical_existing_path(&PathBuf::from(path))?;
    std::process::Command::new(&command)
        .args(args)
        .arg(path)
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn editor: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn staged_diff(repo_path: String) -> AppResult<DiffPayload> {
    run_blocking("staged_diff", move || {
        git_ops::diff_staged(&PathBuf::from(repo_path))
    })
    .await
}

#[tauri::command]
pub async fn staged_file_diff(repo_path: String, path: String) -> AppResult<DiffPayload> {
    run_blocking("staged_file_diff", move || {
        git_ops::diff_staged_file(&PathBuf::from(repo_path), &path)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffImageSource {
    Commit { sha: String },
    Staged,
    PullRequest { number: u64 },
    PullRequestCommit { sha: String },
}

#[tauri::command]
pub async fn load_diff_images(
    repo_path: String,
    source: DiffImageSource,
    old_path: Option<String>,
    new_path: Option<String>,
) -> AppResult<DiffImages> {
    run_blocking("load_diff_images", move || {
        if old_path.is_none() && new_path.is_none() {
            return Err(AppError::InvalidPath("diff image path is missing".into()));
        }
        for path in [old_path.as_deref(), new_path.as_deref()]
            .into_iter()
            .flatten()
        {
            git_ops::validate_relative_git_path(path)?;
        }
        match source {
            DiffImageSource::Commit { sha } => git_ops::diff_images_for_commit(
                &PathBuf::from(repo_path),
                &sha,
                old_path.as_deref(),
                new_path.as_deref(),
            ),
            DiffImageSource::Staged => git_ops::diff_images_staged(
                &PathBuf::from(repo_path),
                old_path.as_deref(),
                new_path.as_deref(),
            ),
            DiffImageSource::PullRequest { number } => pull_requests::get_pull_request_diff_images(
                &PathBuf::from(repo_path),
                number,
                old_path.as_deref(),
                new_path.as_deref(),
            ),
            DiffImageSource::PullRequestCommit { sha } => {
                pull_requests::get_pull_request_commit_diff_images(
                    &PathBuf::from(repo_path),
                    &sha,
                    old_path.as_deref(),
                    new_path.as_deref(),
                )
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn list_pull_requests(
    repo_path: String,
    state: Option<PrStateFilter>,
    limit: Option<u32>,
    query: Option<String>,
) -> AppResult<PullRequestListing> {
    run_blocking("list_pull_requests", move || {
        pull_requests::list_pull_requests(
            &PathBuf::from(repo_path),
            state.unwrap_or(PrStateFilter::Open),
            limit.unwrap_or(50),
            query.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        )
    })
    .await
}

#[tauri::command]
pub async fn list_issues(
    repo_path: String,
    state: Option<IssueStateFilter>,
    limit: Option<u32>,
    query: Option<String>,
) -> AppResult<IssueListing> {
    run_blocking("list_issues", move || {
        pull_requests::list_issues(
            &PathBuf::from(repo_path),
            state.unwrap_or(IssueStateFilter::Open),
            limit.unwrap_or(50),
            query.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        )
    })
    .await
}

#[tauri::command]
pub async fn get_issue_detail(repo_path: String, number: u64) -> AppResult<IssueDetailListing> {
    run_blocking("get_issue_detail", move || {
        pull_requests::get_issue_detail(&PathBuf::from(repo_path), number)
    })
    .await
}

#[tauri::command]
pub async fn add_issue_comment(repo_path: String, number: u64, body: String) -> AppResult<()> {
    run_blocking("add_issue_comment", move || {
        pull_requests::add_issue_comment(&PathBuf::from(repo_path), number, &body)
    })
    .await
}

#[tauri::command]
pub async fn update_github_comment(
    repo_path: String,
    account_login: String,
    comment_id: u64,
    body: String,
) -> AppResult<()> {
    run_blocking("update_github_comment", move || {
        pull_requests::update_github_comment(
            &PathBuf::from(repo_path),
            &account_login,
            comment_id,
            &body,
        )
    })
    .await
}

#[tauri::command]
pub async fn delete_github_comment(
    repo_path: String,
    account_login: String,
    comment_id: u64,
) -> AppResult<()> {
    run_blocking("delete_github_comment", move || {
        pull_requests::delete_github_comment(&PathBuf::from(repo_path), &account_login, comment_id)
    })
    .await
}

#[tauri::command]
pub async fn get_pull_request_detail(
    repo_path: String,
    number: u64,
) -> AppResult<PullRequestDetailListing> {
    run_blocking("get_pull_request_detail", move || {
        pull_requests::get_pull_request_detail(&PathBuf::from(repo_path), number)
    })
    .await
}

#[tauri::command]
pub async fn get_pull_request_diff(
    repo_path: String,
    number: u64,
) -> AppResult<PullRequestDiffListing> {
    run_blocking("get_pull_request_diff", move || {
        pull_requests::get_pull_request_diff(&PathBuf::from(repo_path), number)
    })
    .await
}

#[tauri::command]
pub async fn add_pull_request_comment(
    repo_path: String,
    number: u64,
    body: String,
) -> AppResult<()> {
    run_blocking("add_pull_request_comment", move || {
        pull_requests::add_pull_request_comment(&PathBuf::from(repo_path), number, &body)
    })
    .await
}

#[tauri::command]
pub async fn get_pull_request_commit_diff(
    repo_path: String,
    sha: String,
) -> AppResult<DiffPayload> {
    run_blocking("get_pull_request_commit_diff", move || {
        pull_requests::get_pull_request_commit_diff(&PathBuf::from(repo_path), &sha)
    })
    .await
}

#[tauri::command]
pub async fn resolve_commit_logins(
    repo_path: String,
    shas: Vec<String>,
) -> AppResult<std::collections::HashMap<String, Option<String>>> {
    pull_requests::resolve_commit_logins(&PathBuf::from(repo_path), shas)
}

#[tauri::command]
pub async fn merge_pull_request(
    repo_path: String,
    number: u64,
    method: MergeMethod,
    commit_title: Option<String>,
    commit_body: Option<String>,
    admin: Option<bool>,
) -> AppResult<()> {
    pull_requests::merge_pull_request(
        &PathBuf::from(repo_path),
        number,
        method,
        commit_title,
        commit_body,
        admin.unwrap_or(false),
    )
}

#[tauri::command]
pub async fn close_pull_request(repo_path: String, number: u64) -> AppResult<()> {
    pull_requests::close_pull_request(&PathBuf::from(repo_path), number)
}

#[tauri::command]
pub async fn update_pull_request_body(
    repo_path: String,
    number: u64,
    body: String,
) -> AppResult<()> {
    pull_requests::update_pull_request_body(&PathBuf::from(repo_path), number, &body)
}

#[tauri::command]
pub async fn list_workflow_runs(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<WorkflowRunsListing> {
    run_blocking("list_workflow_runs", move || {
        pull_requests::list_workflow_runs(&PathBuf::from(repo_path), limit.unwrap_or(50))
    })
    .await
}

#[tauri::command]
pub async fn get_workflow_run_detail(
    repo_path: String,
    run_id: u64,
) -> AppResult<WorkflowRunDetailListing> {
    pull_requests::get_workflow_run_detail(&PathBuf::from(repo_path), run_id)
}

#[tauri::command]
pub async fn generate_pr_commit_message(
    repo_path: String,
    number: u64,
    method: MergeMethod,
    ai: crate::ai::AiExecutionRequest,
    prompt: String,
) -> AppResult<GeneratedCommitMessage> {
    pull_requests::generate_pr_commit_message(&PathBuf::from(repo_path), number, method, ai, prompt)
}

pub(crate) fn create_unique_worktree(
    repo: &std::path::Path,
    base: &str,
) -> AppResult<(String, PathBuf)> {
    let root = worktree::worktree_root(repo);
    let mut candidate = base.to_string();
    let mut n = 2;
    loop {
        let target = root.join(&candidate);
        if !target.exists() {
            match worktree::create_worktree(repo, &candidate) {
                Ok(path) => return Ok((candidate, path)),
                Err(AppError::InvalidPath(_)) => {}
                // libgit2 auto-creates a branch named after the worktree when
                // no explicit reference is supplied. If a branch with that name
                // already exists (e.g. a stale leftover or a real branch the
                // user has been working on), it returns Exists. Treat that as
                // "this candidate is taken" and bump the suffix.
                Err(AppError::Git(ref e)) if e.code() == git2::ErrorCode::Exists => {}
                Err(e) => return Err(e),
            }
        }
        if n > 100 {
            return Err(AppError::Other(format!(
                "could not find a free worktree name for {base}"
            )));
        }
        candidate = format!("{base}-{n}");
        n += 1;
    }
}

#[cfg(test)]
pub(crate) fn remove_linked_worktree_at_path(
    repo_path: &Path,
    worktree_path: &Path,
) -> AppResult<()> {
    worktree::remove_worktree_at_path(repo_path, worktree_path)
}

fn stage_remove_linked_worktree_at_path_and_sessions(
    state: &AppState,
    repo_path: &Path,
    worktree_path: &Path,
) -> AppResult<Option<worktree::RemovedWorktree>> {
    let sessions = sessions_using_linked_worktree(state, repo_path, worktree_path);

    let removed = stage_remove_linked_worktree_at_path(repo_path, worktree_path)?;

    if let Ok(dir) = persistence::data_dir() {
        for session in &sessions {
            scrollback::delete(&dir, &session.id.to_string()).ok();
        }
    }
    for session in &sessions {
        terminate_session_pty(state, &session.id);
    }
    for session in sessions {
        state.sessions.remove(&session.id).ok();
    }
    persist(state);
    Ok(removed)
}

pub(crate) fn stage_remove_linked_worktree_at_path(
    repo_path: &Path,
    worktree_path: &Path,
) -> AppResult<Option<worktree::RemovedWorktree>> {
    worktree::stage_remove_worktree_at_path(repo_path, worktree_path)
}

/// Surface the previous-agent-conversation candidate for a session. `None`
/// means there is nothing the user needs to decide about, or the same
/// provider is currently active in this session's PTY tree and the modal
/// would be redundant.
#[tauri::command]
pub fn get_agent_resume_candidate(
    state: State<'_, AppState>,
    session_id: String,
    kind: AgentKind,
) -> AppResult<Option<agent_resume::ResumeCandidate>> {
    let id = parse_id(&session_id)?;
    if agent_running_basenames(kind)
        .iter()
        .any(|basename| agent_is_running_in_session(&state, &id, basename))
    {
        return Ok(None);
    }
    agent_resume::resume_candidate(id, kind).map_err(|e| AppError::Other(e.to_string()))
}

/// Mark the provider's current id as seen so the modal does not pop again
/// for the same UUID. The only thing that revives the candidate is a new
/// transcript appearing under a different UUID.
#[tauri::command]
pub fn acknowledge_agent_resume(session_id: String, kind: AgentKind) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    agent_resume::acknowledge_resume(id, kind).map_err(|e| AppError::Other(e.to_string()))
}

fn agent_running_basenames(kind: AgentKind) -> &'static [&'static str] {
    match kind {
        AgentKind::Claude => &["claude"],
        AgentKind::Codex => &["codex"],
        AgentKind::Antigravity => &["agy", "antigravity", "antigravity-cli"],
    }
}

/// `true` when a process matching `basename` is alive anywhere in the
/// session's PTY descendant tree. Cheap process-table scan — fine on
/// the focus path which fires at most a few times per second.
fn agent_is_running_in_session(state: &AppState, session_id: &Uuid, basename: &str) -> bool {
    let Some(root) = state
        .stream_registry
        .pid(session_id)
        .or_else(|| state.pty.child_pid(session_id))
        // On cold app boot with background sessions enabled, the resume
        // probe can run before `pty_spawn` reattaches the frontend stream.
        // Ask the daemon directly so live agent processes still
        // suppress the modal during that attach race.
        .or_else(|| state.daemon_bridge.session_pid(*session_id))
    else {
        return false;
    };
    // Refresh with exe + cmd populated — `ProcessRefreshKind::nothing()`
    // alone gives an empty config, so `proc.exe()` and
    // `proc.cmd()` come back as `None` and the basename match always
    // fails. That silently flipped the suppression off and let the
    // modal pop for sessions whose claude was still mid-conversation.
    let refresh = ProcessRefreshKind::nothing()
        .with_exe(UpdateKind::Always)
        .with_cmd(UpdateKind::Always);
    let mut sys = System::new_with_specifics(RefreshKind::nothing().with_processes(refresh));
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh);
    let mut frontier: Vec<Pid> = vec![Pid::from_u32(root)];
    let mut visited: std::collections::HashSet<Pid> = std::collections::HashSet::new();
    while let Some(pid) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(proc) = sys.process(pid) {
            if process_basename_matches(proc, basename) {
                return true;
            }
        }
        for (child_pid, child) in sys.processes() {
            if child.parent() == Some(pid) && !visited.contains(child_pid) {
                frontier.push(*child_pid);
            }
        }
    }
    false
}

/// Match a process by `target` against any of: exe-path basename,
/// `proc.name()`, or argv basename. macOS `p_comm` is truncated to
/// 16 chars and can land as a full path *or* a basename depending on
/// how the process was invoked; sysinfo can also surface either form
/// from `exe()` (resolved via `proc_pidinfo`). Checking every channel
/// makes the detection robust against the user's `claude` binary
/// being a Bun-compiled symlink target rather than a script.
fn process_basename_matches(proc: &sysinfo::Process, target: &str) -> bool {
    if process_primary_basename_matches(proc, target) {
        return true;
    }
    for arg in proc.cmd().iter().skip(1) {
        let s = arg.to_string_lossy();
        if process_basename_part_matches(&s, target) {
            return true;
        }
    }
    false
}

fn process_primary_basename_matches(proc: &sysinfo::Process, target: &str) -> bool {
    if let Some(exe) = proc.exe().and_then(|p| p.to_str()) {
        if process_basename_part_matches(exe, target) {
            return true;
        }
    }
    if let Some(name) = proc.name().to_str() {
        if process_basename_part_matches(name, target) {
            return true;
        }
    }
    if let Some(arg0) = proc.cmd().first() {
        let s = arg0.to_string_lossy();
        if process_basename_part_matches(&s, target) {
            return true;
        }
    }
    false
}

fn process_basename_part_matches(s: &str, target: &str) -> bool {
    fn basename_matches(s: &str, target: &str) -> bool {
        let base = s.rsplit('/').next().unwrap_or(s);
        base == target
            || base.strip_suffix(".js") == Some(target)
            || base.strip_suffix(".mjs") == Some(target)
            || base.strip_suffix(".cjs") == Some(target)
    }

    basename_matches(s, target)
}

pub(crate) fn sanitize_worktree_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn new_chat_worktree_base_name(repo_path: &Path) -> String {
    let suffix = Uuid::new_v4().simple().to_string();
    chat_worktree_base_name_for_repo(repo_path, &suffix[..12])
}

fn chat_worktree_base_name_for_repo(repo_path: &Path, suffix: &str) -> String {
    let repo = sanitize_worktree_name(&project_basename(repo_path));
    let repo = if repo.is_empty() {
        "worktree".to_string()
    } else {
        repo
    };
    format!("{repo}-worktree-{suffix}")
}

/// Returns the cached boot-time staged-rev reconcile result. `Some` if
/// the daemon still holds PTYs spawned by an older build with different
/// staged dotfile bodies; `None` when reconcile found everything in
/// sync (or hasn't run yet because the daemon is disabled or
/// unreachable). The frontend polls this at mount so the prompt
/// survives a listener-mount-after-emit race.
#[tauri::command]
pub fn staged_rev_mismatch_status(
    state: State<'_, AppState>,
) -> Option<crate::staged_rev_reconcile::StagedRevMismatch> {
    state.staged_rev_mismatch.lock().clone()
}

/// Clear the cached staged-rev mismatch so the prompt does not re-show
/// when the user dismisses it or after they trigger the "restart
/// daemon" flow. Idempotent.
#[tauri::command]
pub fn acknowledge_staged_rev_mismatch(state: State<'_, AppState>) {
    *state.staged_rev_mismatch.lock() = None;
}

#[cfg(test)]
mod tests {
    use super::{
        auto_title_enabled_for_new_session, collect_memory_usage_from_roots,
        create_unique_worktree, daemon_spawn_name_for_session, detach_requested_by_stale_renderer,
        font_name_from_path, infer_acornd_root_from_session_pids, inject_agent_hook_env,
        memory_root_pids, poll_defers_to_hook, remove_linked_worktree_at_path,
        restore_pending_session_removal, seed_initial_commit, should_remove_local_project_mirror,
        validate_editor_command, validate_new_project_name, ChatProviderAdapter,
        ProcessMemorySnapshot,
    };
    use crate::error::{AppError, AppResult};
    use crate::state::{AppState, PendingSessionRemoval};
    use acorn_session::{Session, SessionAgentProvider, SessionKind, SessionMode};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use uuid::Uuid;

    fn scoped_session(id: &str, repo_path: &str, project_scoped: bool) -> Session {
        let mut session = Session::new(
            id.to_string(),
            PathBuf::from(repo_path),
            PathBuf::from(repo_path),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.project_scoped = project_scoped;
        session
    }

    fn worktree_session(id: &str, repo_path: &str, worktree_path: &str) -> Session {
        let mut session = Session::new(
            id.to_string(),
            PathBuf::from(repo_path),
            PathBuf::from(worktree_path),
            "main".to_string(),
            true,
            SessionKind::Regular,
        );
        session.in_worktree = true;
        session
    }

    fn chat_state_for_runtime(
        messages: Vec<crate::persistence::ChatMessage>,
    ) -> crate::persistence::ChatSessionState {
        let now = chrono::Utc::now();
        let session_id = Uuid::new_v4().to_string();
        crate::persistence::ChatSessionState {
            schema_version: crate::persistence::CHAT_SESSION_SCHEMA_VERSION,
            session_id: session_id.clone(),
            session: crate::persistence::ChatSession {
                id: session_id.clone(),
                workspace_path: Some("/tmp/acorn".to_string()),
                title: Some("Native chat".to_string()),
                active_provider: Some("codex".to_string()),
                active_model: None,
                created_at: now,
                updated_at: now,
            },
            provider: Some("codex".to_string()),
            model: None,
            messages,
            turns: Vec::new(),
            provider_threads: Vec::new(),
            context_snapshots: Vec::new(),
            memory: crate::persistence::SessionMemory {
                session_id,
                summary: Some("Earlier summary".to_string()),
                important_decisions: vec!["Use adapters".to_string()],
                facts: vec!["Acorn owns the transcript".to_string()],
                through_message_id: None,
                updated_at: now,
            },
            created_at: now,
            updated_at: now,
        }
    }

    fn chat_message(
        id: &str,
        role: crate::persistence::ChatRole,
        content: &str,
    ) -> crate::persistence::ChatMessage {
        crate::persistence::ChatMessage {
            id: id.to_string(),
            session_id: None,
            turn_id: None,
            role,
            content: content.to_string(),
            created_at: chrono::Utc::now(),
            status: Some(crate::persistence::ChatMessageStatus::Complete),
            metadata: None,
        }
    }

    #[derive(Default)]
    struct RecordingChatProviderAdapter {
        capabilities: super::ChatProviderCapabilities,
        response: Option<super::ProviderResponse>,
        error: Option<String>,
        inputs: Mutex<Vec<super::ChatProviderInput>>,
    }

    impl super::ChatProviderAdapter for RecordingChatProviderAdapter {
        fn capabilities(&self) -> super::ChatProviderCapabilities {
            self.capabilities
        }

        fn send_message(
            &self,
            input: super::ChatProviderInput,
        ) -> AppResult<super::ProviderResponse> {
            self.inputs.lock().unwrap().push(input);
            if let Some(error) = &self.error {
                return Err(AppError::Other(error.clone()));
            }
            Ok(self
                .response
                .clone()
                .unwrap_or_else(|| super::ProviderResponse {
                    content: "assistant response".to_string(),
                    native_thread_id: None,
                    resume_token: None,
                    last_response_id: None,
                    metadata: None,
                }))
        }
    }

    #[test]
    fn poll_defers_while_a_hooked_agent_is_live() {
        // While the agent process is alive the hook owns the turn boundary and
        // the transcript tail is ignored in both directions (stale Working just
        // after a turn ends, stale Ready just after the next prompt).
        assert!(poll_defers_to_hook(
            true,
            Some(super::AgentKind::Codex),
            Some(super::AgentKind::Codex)
        ));
    }

    #[test]
    fn poll_does_not_defer_to_a_different_provider_hook() {
        assert!(!poll_defers_to_hook(
            true,
            Some(super::AgentKind::Codex),
            Some(super::AgentKind::Claude)
        ));
    }

    #[test]
    fn poll_defers_when_hook_provider_is_unknown() {
        assert!(poll_defers_to_hook(
            true,
            None,
            Some(super::AgentKind::Antigravity)
        ));
    }

    #[test]
    fn poll_owns_status_once_the_agent_is_gone() {
        // Agent exited, or an unrelated command now owns the PTY — the poll
        // drives liveness again from the current process tree.
        assert!(!poll_defers_to_hook(
            true,
            Some(super::AgentKind::Codex),
            None
        ));
    }

    #[test]
    fn poll_drives_status_without_a_hook_channel() {
        // No observed hook events (e.g. `claude` typed straight into a terminal
        // before hooks registered) — the transcript poll is the only signal.
        assert!(!poll_defers_to_hook(
            false,
            None,
            Some(super::AgentKind::Claude)
        ));
        assert!(!poll_defers_to_hook(false, None, None));
    }

    #[test]
    fn fallback_agent_status_source_tracks_the_evidence_that_was_used() {
        use super::session_status::StatusEvidence;
        use super::AgentStatusSource;

        assert_eq!(
            super::fallback_agent_status_source(
                Some(super::AgentKind::Codex),
                StatusEvidence::Transcript,
                Some(AgentStatusSource::ProcessFallback),
            ),
            Some(AgentStatusSource::TranscriptFallback)
        );
        assert_eq!(
            super::fallback_agent_status_source(
                Some(super::AgentKind::Claude),
                StatusEvidence::Process,
                Some(AgentStatusSource::TranscriptFallback),
            ),
            Some(AgentStatusSource::ProcessFallback)
        );
        assert_eq!(
            super::fallback_agent_status_source(
                Some(super::AgentKind::Antigravity),
                StatusEvidence::Previous,
                Some(AgentStatusSource::TranscriptFallback),
            ),
            Some(AgentStatusSource::TranscriptFallback)
        );
        assert_eq!(
            super::fallback_agent_status_source(
                Some(super::AgentKind::Antigravity),
                StatusEvidence::Previous,
                None,
            ),
            None
        );
        assert_eq!(
            super::fallback_agent_status_source(
                None,
                StatusEvidence::Transcript,
                Some(AgentStatusSource::Hook),
            ),
            None
        );
    }

    #[test]
    fn live_tool_activity_only_resumes_a_codex_permission_wait() {
        assert_eq!(
            super::hook_status_with_live_tool_activity(
                acorn_session::SessionStatus::WaitingForInput,
                Some(super::AgentKind::Claude),
                true,
                true,
            ),
            acorn_session::SessionStatus::WaitingForInput
        );
        assert_eq!(
            super::hook_status_with_live_tool_activity(
                acorn_session::SessionStatus::WaitingForInput,
                Some(super::AgentKind::Claude),
                false,
                true,
            ),
            acorn_session::SessionStatus::WaitingForInput
        );
        assert_eq!(
            super::hook_status_with_live_tool_activity(
                acorn_session::SessionStatus::Ready,
                Some(super::AgentKind::Codex),
                true,
                false,
            ),
            acorn_session::SessionStatus::Working
        );
        assert_eq!(
            super::hook_status_with_live_tool_activity(
                acorn_session::SessionStatus::WaitingForInput,
                Some(super::AgentKind::Codex),
                true,
                false,
            ),
            acorn_session::SessionStatus::WaitingForInput
        );
        for poll in 1..=2 {
            assert_eq!(
                super::hook_status_with_live_tool_activity(
                    acorn_session::SessionStatus::WaitingForInput,
                    Some(super::AgentKind::Codex),
                    true,
                    true,
                ),
                acorn_session::SessionStatus::Working,
                "permission continuation regressed on poll {poll}"
            );
        }
        assert_eq!(
            super::hook_status_with_live_tool_activity(
                acorn_session::SessionStatus::WaitingForInput,
                Some(super::AgentKind::Antigravity),
                true,
                true,
            ),
            acorn_session::SessionStatus::WaitingForInput
        );
    }

    #[test]
    fn terminal_submit_frame_requires_a_standalone_line_ending() {
        assert!(super::is_terminal_submit_frame(b"\r"));
        assert!(super::is_terminal_submit_frame(b"\n"));
        assert!(super::is_terminal_submit_frame(b"\r\n"));

        for input in [
            b"answer".as_slice(),
            b"\x1b[A".as_slice(),
            b"answer\r".as_slice(),
            b"\x1b[200~line one\nline two\x1b[201~".as_slice(),
        ] {
            assert!(!super::is_terminal_submit_frame(input));
        }
    }

    #[test]
    fn boot_reconciliation_recovers_turn_end_lost_while_app_was_closed() {
        // Persisted hook status says Working, no event has confirmed the
        // channel this run, and the transcript holds a real turn-complete
        // marker — the turn ended while nobody was listening, leaving the
        // agent awaiting the user's next instruction.
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Ready,
            reason: Some(super::SessionStatusReason::TurnComplete),
            evidence: super::session_status::StatusEvidence::Transcript,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::Working,
                false,
                detection
            ),
            Some(acorn_session::SessionStatus::WaitingForInput)
        );
    }

    #[test]
    fn boot_reconciliation_keeps_persisted_waiting_status() {
        // WaitingForInput is already the correct resting value for a
        // completed turn — reconciliation must not demote it to Ready.
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Ready,
            reason: Some(super::SessionStatusReason::TurnComplete),
            evidence: super::session_status::StatusEvidence::Transcript,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::WaitingForInput,
                false,
                detection
            ),
            None
        );
    }

    #[test]
    fn status_poll_persists_successful_boot_reconciliation() {
        assert!(!super::status_poll_needs_persist(false, false, false));
        assert!(super::status_poll_needs_persist(true, false, false));
        assert!(super::status_poll_needs_persist(false, true, false));
        assert!(super::status_poll_needs_persist(false, false, true));
    }

    #[test]
    fn boot_reconciliation_preserves_real_waiting_status_without_completion_marker() {
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Working,
            reason: None,
            evidence: super::session_status::StatusEvidence::Previous,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::WaitingForInput,
                false,
                detection
            ),
            None
        );
    }

    #[test]
    fn boot_reconciliation_does_not_upgrade_waiting_after_hook_confirmation() {
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Ready,
            reason: Some(super::SessionStatusReason::TurnComplete),
            evidence: super::session_status::StatusEvidence::Transcript,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::WaitingForInput,
                true,
                detection
            ),
            None
        );
    }

    #[test]
    fn boot_reconciliation_is_off_once_a_hook_event_confirms_the_channel() {
        // An event reached this run's hook server — hooks own both directions
        // again; re-opening the transcript passthrough would recreate the
        // UserPromptSubmit-vs-stale-tail race.
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Ready,
            reason: Some(super::SessionStatusReason::TurnComplete),
            evidence: super::session_status::StatusEvidence::Transcript,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::Working,
                true,
                detection
            ),
            None
        );
    }

    #[test]
    fn boot_reconciliation_never_demotes_a_resting_status() {
        // Nobody can submit a prompt while the app is closed, so a persisted
        // resting status must not be overwritten by a stale working line.
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Working,
            reason: None,
            evidence: super::session_status::StatusEvidence::Previous,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::Ready,
                false,
                detection
            ),
            None
        );
    }

    #[test]
    fn boot_reconciliation_requires_a_turn_complete_marker() {
        // A shell-prompt Ready hint is not evidence the agent's turn
        // ended — only a transcript turn-complete marker flips Working.
        let detection = super::session_status::StatusDetection {
            status: acorn_session::SessionStatus::Ready,
            reason: Some(super::SessionStatusReason::ShellPrompt),
            evidence: super::session_status::StatusEvidence::Process,
        };
        assert_eq!(
            super::hook_boot_reconciled_status(
                acorn_session::SessionStatus::Working,
                false,
                detection
            ),
            None
        );
    }

    #[test]
    fn chat_message_status_maps_to_session_status() {
        assert_eq!(
            super::chat_session_status_for_message_status(
                crate::persistence::ChatMessageStatus::Pending
            ),
            acorn_session::SessionStatus::Working
        );
        assert_eq!(
            super::chat_session_status_for_message_status(
                crate::persistence::ChatMessageStatus::Streaming
            ),
            acorn_session::SessionStatus::Working
        );
        assert_eq!(
            super::chat_session_status_for_message_status(
                crate::persistence::ChatMessageStatus::Complete
            ),
            acorn_session::SessionStatus::Ready
        );
        assert_eq!(
            super::chat_session_status_for_message_status(
                crate::persistence::ChatMessageStatus::Error
            ),
            acorn_session::SessionStatus::Errored
        );
        assert_eq!(
            super::chat_session_status_for_message_status(
                crate::persistence::ChatMessageStatus::Cancelled
            ),
            acorn_session::SessionStatus::Ready
        );

        let completed = chat_state_for_runtime(vec![chat_message(
            "a1",
            crate::persistence::ChatRole::Assistant,
            "done",
        )]);
        assert_eq!(
            super::chat_session_status_for_state(&completed),
            acorn_session::SessionStatus::Ready
        );

        let empty = chat_state_for_runtime(Vec::new());
        assert_eq!(
            super::chat_session_status_for_state(&empty),
            acorn_session::SessionStatus::Ready
        );
    }

    #[test]
    fn chat_state_running_check_detects_running_turn_without_pending_message() {
        let now = chrono::Utc::now();
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "running prompt"),
            chat_message(
                "a1",
                crate::persistence::ChatRole::Assistant,
                "not marked pending yet",
            ),
        ]);
        state.turns.push(crate::persistence::ChatTurn {
            id: "turn-1".to_string(),
            session_id: state.session_id.clone(),
            provider: "codex".to_string(),
            model: None,
            status: crate::persistence::ChatTurnStatus::Running,
            user_message_id: "u1".to_string(),
            assistant_message_id: Some("a1".to_string()),
            started_at: now,
            completed_at: None,
            error: None,
            activities: Vec::new(),
        });

        assert!(super::chat_state_has_running_message(&state));
    }

    #[test]
    fn streaming_chunk_appends_to_pending_assistant_message() {
        let now = chrono::Utc::now();
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "hello"),
            crate::persistence::ChatMessage {
                id: "a1".to_string(),
                session_id: None,
                turn_id: Some("turn-1".to_string()),
                role: crate::persistence::ChatRole::Assistant,
                content: String::new(),
                created_at: now,
                status: Some(crate::persistence::ChatMessageStatus::Pending),
                metadata: None,
            },
        ]);

        assert!(super::append_streaming_chat_chunk(&mut state, "a1", "hel"));
        assert!(super::append_streaming_chat_chunk(&mut state, "a1", "lo"));

        let assistant = state.messages.last().unwrap();
        assert_eq!(assistant.content, "hello");
        assert_eq!(
            assistant.status,
            Some(crate::persistence::ChatMessageStatus::Streaming)
        );
        assert!(super::chat_state_has_running_message(&state));
    }

    #[test]
    fn streaming_activity_updates_one_stable_turn_entry() {
        let now = chrono::Utc::now();
        let mut state = chat_state_for_runtime(Vec::new());
        state.turns.push(crate::persistence::ChatTurn {
            id: "turn-1".to_string(),
            session_id: state.session_id.clone(),
            provider: "codex".to_string(),
            model: None,
            status: crate::persistence::ChatTurnStatus::Running,
            user_message_id: "u1".to_string(),
            assistant_message_id: Some("a1".to_string()),
            started_at: now,
            completed_at: None,
            error: None,
            activities: Vec::new(),
        });

        assert!(super::upsert_chat_activity(
            &mut state,
            "turn-1",
            super::ChatActivityPatch {
                id: "tool-1".to_string(),
                kind: crate::persistence::ChatActivityKind::Command,
                title: Some("Run tests".to_string()),
                detail: Some("cargo test".to_string()),
                status: crate::persistence::ChatActivityStatus::Running,
            },
        ));
        assert!(super::upsert_chat_activity(
            &mut state,
            "turn-1",
            super::ChatActivityPatch {
                id: "tool-1".to_string(),
                kind: crate::persistence::ChatActivityKind::Tool,
                title: None,
                detail: None,
                status: crate::persistence::ChatActivityStatus::Complete,
            },
        ));

        let activities = &state.turns[0].activities;
        assert_eq!(activities.len(), 1);
        assert_eq!(
            activities[0].kind,
            crate::persistence::ChatActivityKind::Command
        );
        assert_eq!(activities[0].title, "Run tests");
        assert_eq!(activities[0].detail.as_deref(), Some("cargo test"));
        assert_eq!(
            activities[0].status,
            crate::persistence::ChatActivityStatus::Complete
        );
        assert!(activities[0].completed_at.is_some());
    }

    #[test]
    fn chat_stream_parser_extracts_claude_partial_jsonl_without_duplicates() {
        let mut parser =
            super::ChatCliOutputParser::new(super::ChatCliOutputMode::ClaudeStreamJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hel"}]}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(r#"{"type":"result","result":"hello"}"#, &mut on_chunk);
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(chunks, vec!["hel", "lo"]);
        assert_eq!(parser.finish(""), "hello");
    }

    #[test]
    fn chat_stream_parser_normalizes_claude_reasoning_and_tool_lifecycle() {
        let mut parser =
            super::ChatCliOutputParser::new(super::ChatCliOutputMode::ClaudeStreamJson);
        let mut events = Vec::new();

        {
            let mut on_event = |event| events.push(event);
            parser.push_chunk(
                concat!(
                    r#"{"type":"assistant","message":{"id":"msg-1","stop_reason":null,"content":[{"type":"thinking","thinking":"Inspect the repository first."},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"rg --files"}}]}}"#,
                    "\n",
                    r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"done"}]}}"#,
                    "\n"
                ),
                &mut on_event,
            );
        }

        assert_eq!(
            events,
            vec![
                super::ChatProviderStreamEvent::Activity(super::ChatActivityPatch {
                    id: "claude:msg-1:reasoning:0".to_string(),
                    kind: crate::persistence::ChatActivityKind::Reasoning,
                    title: Some("Reasoning".to_string()),
                    detail: Some("Inspect the repository first.".to_string()),
                    status: crate::persistence::ChatActivityStatus::Running,
                }),
                super::ChatProviderStreamEvent::Activity(super::ChatActivityPatch {
                    id: "tool-1".to_string(),
                    kind: crate::persistence::ChatActivityKind::Command,
                    title: Some("Bash".to_string()),
                    detail: Some("rg --files".to_string()),
                    status: crate::persistence::ChatActivityStatus::Running,
                }),
                super::ChatProviderStreamEvent::Activity(super::ChatActivityPatch {
                    id: "tool-1".to_string(),
                    kind: crate::persistence::ChatActivityKind::Tool,
                    title: None,
                    detail: None,
                    status: crate::persistence::ChatActivityStatus::Complete,
                }),
            ]
        );
    }

    #[test]
    fn chat_stream_parser_normalizes_claude_partial_stream_events() {
        let mut parser =
            super::ChatCliOutputParser::new(super::ChatCliOutputMode::ClaudeStreamJson);
        let mut events = Vec::new();

        {
            let mut on_event = |event| events.push(event);
            parser.push_chunk(
                concat!(
                    r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg-live","usage":{"input_tokens":8}}}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspect live."}}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-live","name":"Bash","input":{}}}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\""}}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"pwd\"}"}}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#,
                    "\n",
                    r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Done"}}}"#,
                    "\n"
                ),
                &mut on_event,
            );
        }

        let activities = events
            .iter()
            .filter_map(|event| match event {
                super::ChatProviderStreamEvent::Activity(activity) => Some(activity),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(activities[2].id, "claude:msg-live:reasoning:0");
        assert_eq!(activities[2].detail.as_deref(), Some("Inspect live."));
        assert_eq!(
            activities[2].status,
            crate::persistence::ChatActivityStatus::Complete
        );
        let tool = activities.last().unwrap();
        assert_eq!(tool.id, "tool-live");
        assert_eq!(tool.detail.as_deref(), Some("pwd"));
        assert_eq!(tool.status, crate::persistence::ChatActivityStatus::Running);
        assert!(events.iter().any(|event| {
            matches!(
                event,
                super::ChatProviderStreamEvent::AssistantTextDelta(text) if text == "Done"
            )
        }));
        assert_eq!(
            parser.provider_metadata(),
            Some(serde_json::json!({ "usage": { "input_tokens": 8 } }))
        );
    }

    #[test]
    fn chat_stream_parser_records_claude_usage_metadata() {
        let mut parser =
            super::ChatCliOutputParser::new(super::ChatCliOutputMode::ClaudeStreamJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":11,"output_tokens":3}}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(
            parser.provider_metadata(),
            Some(serde_json::json!({
                "usage": {
                    "input_tokens": 11,
                    "output_tokens": 3,
                }
            }))
        );
    }

    #[test]
    fn chat_stream_parser_separates_non_prefix_claude_assistant_messages() {
        let mut parser =
            super::ChatCliOutputParser::new(super::ChatCliOutputMode::ClaudeStreamJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"핵심 파일 확인."}]}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"경로 문제. 절대경로로 다시."}]}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(
            chunks.concat(),
            "핵심 파일 확인.\n\n경로 문제. 절대경로로 다시."
        );
        assert_eq!(
            parser.finish(""),
            "핵심 파일 확인.\n\n경로 문제. 절대경로로 다시."
        );
    }

    #[test]
    fn chat_stream_parser_extracts_codex_delta_jsonl_and_final_message() {
        let mut parser = super::ChatCliOutputParser::new(super::ChatCliOutputMode::CodexJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"msg":{"type":"agent_message_content_delta","delta":"hel"}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(
                r#"{"msg":{"type":"agent_message_content_delta","delta":"lo"}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(
                r#"{"msg":{"type":"turn_complete","last_agent_message":"hello"}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(chunks.concat(), "hello");
        assert_eq!(parser.finish(""), "hello");
    }

    #[test]
    fn chat_stream_parser_normalizes_codex_item_events() {
        let mut parser = super::ChatCliOutputParser::new(super::ChatCliOutputMode::CodexJson);
        let mut events = Vec::new();

        {
            let mut on_event = |event| events.push(event);
            parser.push_chunk(
                concat!(
                    r#"{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","text":"Find the relevant call path."}}"#,
                    "\n",
                    r#"{"type":"item.started","item":{"id":"command-1","type":"command_execution","command":"cargo test","status":"in_progress"}}"#,
                    "\n",
                    r#"{"type":"item.completed","item":{"id":"command-1","type":"command_execution","command":"cargo test","status":"completed"}}"#,
                    "\n"
                ),
                &mut on_event,
            );
        }

        assert_eq!(events.len(), 3);
        let super::ChatProviderStreamEvent::Activity(reasoning) = &events[0] else {
            panic!("expected reasoning activity");
        };
        assert_eq!(
            reasoning.kind,
            crate::persistence::ChatActivityKind::Reasoning
        );
        assert_eq!(
            reasoning.detail.as_deref(),
            Some("Find the relevant call path.")
        );
        assert_eq!(
            reasoning.status,
            crate::persistence::ChatActivityStatus::Complete
        );

        let super::ChatProviderStreamEvent::Activity(started) = &events[1] else {
            panic!("expected command activity");
        };
        let super::ChatProviderStreamEvent::Activity(completed) = &events[2] else {
            panic!("expected command completion");
        };
        assert_eq!(started.id, "command-1");
        assert_eq!(completed.id, "command-1");
        assert_eq!(
            started.status,
            crate::persistence::ChatActivityStatus::Running
        );
        assert_eq!(
            completed.status,
            crate::persistence::ChatActivityStatus::Complete
        );
    }

    #[test]
    fn antigravity_transcript_follower_normalizes_planner_and_tool_result() {
        let tmp = tempfile::tempdir().unwrap();
        let mut follower = super::AntigravityTranscriptFollower::new(
            tmp.path().to_path_buf(),
            None,
            std::time::SystemTime::now(),
        );
        let mut events = Vec::new();
        let mut on_event = |event| events.push(event);

        follower.process_line(
            br#"{"type":"PLANNER_RESPONSE","step_index":7,"thinking":"Inspect before editing.","tool_calls":[{"name":"run_command","args":{"toolAction":"Run tests","command":"pnpm test"}}]}"#,
            &mut on_event,
        );
        follower.process_line(
            br#"{"type":"RUN_COMMAND","step_index":7,"status":"SUCCESS"}"#,
            &mut on_event,
        );

        assert_eq!(events.len(), 3);
        let super::ChatProviderStreamEvent::Activity(reasoning) = &events[0] else {
            panic!("expected reasoning activity");
        };
        assert_eq!(
            reasoning.kind,
            crate::persistence::ChatActivityKind::Reasoning
        );
        assert_eq!(reasoning.detail.as_deref(), Some("Inspect before editing."));

        let super::ChatProviderStreamEvent::Activity(started) = &events[1] else {
            panic!("expected tool activity");
        };
        let super::ChatProviderStreamEvent::Activity(completed) = &events[2] else {
            panic!("expected tool completion");
        };
        assert_eq!(started.id, "antigravity:7:tool:0");
        assert_eq!(started.title.as_deref(), Some("Run tests"));
        assert_eq!(started.detail.as_deref(), Some("pnpm test"));
        assert_eq!(
            started.status,
            crate::persistence::ChatActivityStatus::Running
        );
        assert_eq!(completed.id, started.id);
        assert_eq!(
            completed.status,
            crate::persistence::ChatActivityStatus::Complete
        );
    }

    #[test]
    fn chat_stream_parser_extracts_codex_task_complete_payload_message() {
        let mut parser = super::ChatCliOutputParser::new(super::ChatCliOutputMode::CodexJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"안녕하세요. 무엇을 도와드릴까요?"}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(chunks.concat(), "안녕하세요. 무엇을 도와드릴까요?");
        assert_eq!(parser.finish(""), "안녕하세요. 무엇을 도와드릴까요?");
    }

    #[test]
    fn backfill_empty_codex_assistant_message_reads_transcript_final_message() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "안녕"),
            chat_message("a1", crate::persistence::ChatRole::Assistant, ""),
        ]);
        state
            .provider_threads
            .push(crate::persistence::ProviderThread {
                session_id: state.session_id.clone(),
                provider: "codex".to_string(),
                model: None,
                native_thread_id: Some("019f4595-6b86-7183-878f-6fb1f523abf9".to_string()),
                resume_token: Some("019f4595-6b86-7183-878f-6fb1f523abf9".to_string()),
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            });
        let tmp = tempfile::tempdir().unwrap();
        let transcript = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &transcript,
            r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"안녕하세요. 무엇을 도와드릴까요?"}}"#,
        )
        .unwrap();

        assert!(
            super::backfill_latest_empty_codex_assistant_message_from_path(&mut state, &transcript)
        );
        assert_eq!(
            state.messages.last().unwrap().content,
            "안녕하세요. 무엇을 도와드릴까요?"
        );
    }

    #[test]
    fn backfill_empty_codex_assistant_message_stops_at_latest_user_boundary() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "다시 봐줘"),
            chat_message("a1", crate::persistence::ChatRole::Assistant, ""),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let transcript = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"이전 답변"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"다시 봐줘"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#,
            ),
        )
        .unwrap();

        assert!(
            !super::backfill_latest_empty_codex_assistant_message_from_path(
                &mut state,
                &transcript
            )
        );
        assert_eq!(state.messages.last().unwrap().content, "");
    }

    #[test]
    fn backfill_empty_codex_assistant_message_stops_at_response_item_user_boundary() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "다시 봐줘"),
            chat_message("a1", crate::persistence::ChatRole::Assistant, ""),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let transcript = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"이전 답변"}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"다시 봐줘"}]}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"token_count","info":{}}}"#
            ),
        )
        .unwrap();

        assert!(
            !super::backfill_latest_empty_codex_assistant_message_from_path(
                &mut state,
                &transcript
            )
        );
        assert_eq!(state.messages.last().unwrap().content, "");
    }

    #[test]
    fn backfill_empty_codex_assistant_message_uses_agent_message_after_empty_final() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "다시 봐줘"),
            chat_message("a1", crate::persistence::ChatRole::Assistant, ""),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let transcript = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"다시 봐줘"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"agent_message","message":"새 답변"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"   "}}"#
            ),
        )
        .unwrap();

        assert!(
            super::backfill_latest_empty_codex_assistant_message_from_path(&mut state, &transcript)
        );
        assert_eq!(state.messages.last().unwrap().content, "새 답변");
    }

    #[test]
    fn backfill_empty_codex_assistant_message_ignores_previous_final_after_empty_final() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "다시 봐줘"),
            chat_message("a1", crate::persistence::ChatRole::Assistant, ""),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let transcript = tmp.path().join("rollout.jsonl");
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"이전 답변"}}"#,
                "\n",
                r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":""}}"#
            ),
        )
        .unwrap();

        assert!(
            !super::backfill_latest_empty_codex_assistant_message_from_path(
                &mut state,
                &transcript
            )
        );
        assert_eq!(state.messages.last().unwrap().content, "");
    }

    #[test]
    fn backfill_empty_codex_assistant_message_does_not_scan_beyond_tail_budget() {
        use std::io::Write as _;

        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "다시 봐줘"),
            chat_message("a1", crate::persistence::ChatRole::Assistant, ""),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let transcript = tmp.path().join("rollout.jsonl");
        let mut file = std::fs::File::create(&transcript).unwrap();
        writeln!(
            file,
            r#"{{"type":"event_msg","payload":{{"type":"task_complete","last_agent_message":"too old"}}}}"#
        )
        .unwrap();
        file.set_len(super::MAX_CODEX_REPAIR_TAIL_BYTES + 1024)
            .unwrap();
        drop(file);

        assert!(
            !super::backfill_latest_empty_codex_assistant_message_from_path(
                &mut state,
                &transcript
            )
        );
        assert_eq!(state.messages.last().unwrap().content, "");
    }

    #[test]
    fn chat_stream_parser_records_codex_token_count_metadata() {
        let mut parser = super::ChatCliOutputParser::new(super::ChatCliOutputMode::CodexJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":20,"cached_input_tokens":7,"output_tokens":5,"reasoning_output_tokens":2,"total_tokens":32}}}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(
            parser.provider_metadata(),
            Some(serde_json::json!({
                "usage": {
                    "input_tokens": 20,
                    "cached_input_tokens": 7,
                    "output_tokens": 5,
                    "reasoning_output_tokens": 2,
                    "total_tokens": 32,
                }
            }))
        );
    }

    #[test]
    fn chat_stream_parser_separates_complete_codex_agent_messages() {
        let mut parser = super::ChatCliOutputParser::new(super::ChatCliOutputMode::CodexJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"msg":{"type":"agent_message","message":"디렉토리 + 타입 정의 핵심 파일 확인."}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(
                r#"{"msg":{"type":"agent_message","message":"경로 문제. 절대경로로 다시."}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(
            chunks.concat(),
            "디렉토리 + 타입 정의 핵심 파일 확인.\n\n경로 문제. 절대경로로 다시."
        );
        assert_eq!(
            parser.finish(""),
            "디렉토리 + 타입 정의 핵심 파일 확인.\n\n경로 문제. 절대경로로 다시."
        );
    }

    #[test]
    fn chat_stream_parser_extracts_codex_response_item_output_text() {
        let mut parser = super::ChatCliOutputParser::new(super::ChatCliOutputMode::CodexJson);
        let mut chunks = Vec::new();

        {
            let mut on_chunk = |event| {
                if let super::ChatProviderStreamEvent::AssistantTextDelta(chunk) = event {
                    chunks.push(chunk);
                }
            };
            parser.push_chunk(
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
            parser.push_chunk(
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"ignored"}]}}"#,
                &mut on_chunk,
            );
            parser.push_chunk("\n", &mut on_chunk);
        }

        assert_eq!(chunks.concat(), "hello");
        assert_eq!(parser.finish(""), "hello");
    }

    #[test]
    fn compiled_context_omits_full_transcript_once_over_threshold() {
        let messages = vec![
            chat_message(
                "old-user",
                crate::persistence::ChatRole::User,
                "old user content that should be outside the window",
            ),
            chat_message(
                "old-assistant",
                crate::persistence::ChatRole::Assistant,
                "old assistant content that should be outside the window",
            ),
            chat_message(
                "recent-user",
                crate::persistence::ChatRole::User,
                "recent user",
            ),
            chat_message(
                "recent-assistant",
                crate::persistence::ChatRole::Assistant,
                "recent assistant",
            ),
            chat_message(
                "current-user",
                crate::persistence::ChatRole::User,
                "current question",
            ),
        ];
        let state = chat_state_for_runtime(messages);

        let context = super::build_chat_execution_context(
            &state,
            "current-user",
            super::ChatContextOptions {
                recent_message_limit: 3,
                max_context_chars: 260,
                summary_threshold_chars: 120,
            },
        )
        .unwrap();

        assert!(context.prompt.contains("Earlier summary"));
        assert!(context.prompt.contains("Use adapters"));
        assert!(context.prompt.contains("current question"));
        assert!(context
            .included_message_ids
            .contains(&"current-user".to_string()));
        assert!(!context.prompt.contains("old user content"));
        assert!(!context
            .included_message_ids
            .contains(&"old-user".to_string()));
    }

    #[test]
    fn chat_runtime_sends_compiled_context_when_native_thread_is_unavailable() {
        let state = chat_state_for_runtime(Vec::new());
        let adapter = RecordingChatProviderAdapter::default();

        let result = super::run_chat_turn_for_test(
            state,
            crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Codex,
                ollama_model: None,
                llm_model: None,
            },
            "hello".to_string(),
            &adapter,
        )
        .unwrap();
        let inputs = adapter.inputs.lock().unwrap();

        assert_eq!(inputs.len(), 1);
        assert_eq!(
            result.pending_state.messages.last().unwrap().status,
            Some(crate::persistence::ChatMessageStatus::Pending)
        );
        assert!(inputs[0].thread.is_some());
        assert!(inputs[0].context.is_some());
        assert_eq!(result.final_state.turns.len(), 1);
        assert_eq!(
            result.final_state.context_snapshots[0].mode,
            crate::persistence::ContextSnapshotMode::CompiledContext
        );
        assert_eq!(
            result.final_state.messages.last().unwrap().content,
            "assistant response"
        );
    }

    #[test]
    fn chat_runtime_sends_native_thread_when_provider_cursor_exists() {
        let mut state = chat_state_for_runtime(Vec::new());
        state
            .provider_threads
            .push(crate::persistence::ProviderThread {
                session_id: state.session_id.clone(),
                provider: "claude".to_string(),
                model: None,
                native_thread_id: Some("thread-1".to_string()),
                resume_token: Some("resume-1".to_string()),
                last_response_id: Some("response-1".to_string()),
                updated_at: chrono::Utc::now(),
            });
        let adapter = RecordingChatProviderAdapter {
            capabilities: super::ChatProviderCapabilities {
                native_thread: true,
                streaming: false,
                attachments: false,
            },
            response: Some(super::ProviderResponse {
                content: "continued".to_string(),
                native_thread_id: Some("thread-1".to_string()),
                resume_token: Some("resume-2".to_string()),
                last_response_id: Some("response-2".to_string()),
                metadata: None,
            }),
            ..Default::default()
        };

        let result = super::run_chat_turn_for_test(
            state,
            crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Claude,
                ollama_model: None,
                llm_model: None,
            },
            "continue".to_string(),
            &adapter,
        )
        .unwrap();
        let inputs = adapter.inputs.lock().unwrap();

        assert!(inputs[0].context.is_none());
        assert_eq!(
            inputs[0]
                .thread
                .as_ref()
                .and_then(|t| t.native_thread_id.as_deref()),
            Some("thread-1")
        );
        assert_eq!(
            result.final_state.context_snapshots[0].mode,
            crate::persistence::ContextSnapshotMode::NativeThread
        );
        assert_eq!(
            result.final_state.provider_threads[0]
                .last_response_id
                .as_deref(),
            Some("response-2")
        );
    }

    #[test]
    fn cli_chat_provider_advertises_native_threads_for_resume_capable_clis() {
        for provider in [
            crate::ai::AiProvider::Claude,
            crate::ai::AiProvider::Codex,
            crate::ai::AiProvider::Antigravity,
        ] {
            let adapter = super::CliChatProviderAdapter {
                ai: crate::ai::AiExecutionRequest {
                    provider,
                    ollama_model: None,
                    llm_model: None,
                },
                cwd: PathBuf::from("/tmp/acorn"),
                cancellation: None,
            };

            assert!(
                adapter.capabilities().native_thread,
                "{provider:?} should support provider-native chat continuation"
            );
            assert!(
                adapter.capabilities().streaming,
                "{provider:?} should stream stdout chunks"
            );
        }
    }

    #[test]
    fn chat_cli_invocation_resumes_existing_provider_thread() {
        let input = super::ChatProviderInput {
            thread: Some(crate::persistence::ProviderThread {
                session_id: Uuid::new_v4().to_string(),
                provider: "claude".to_string(),
                model: None,
                native_thread_id: Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string()),
                resume_token: Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string()),
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            }),
            message: chat_message(
                "current-user",
                crate::persistence::ChatRole::User,
                "continue in provider state",
            ),
            context: None,
            model: None,
        };

        let invocation = super::resolve_chat_cli_invocation(
            &crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Claude,
                ollama_model: None,
                llm_model: None,
            },
            &input,
        )
        .unwrap();

        assert_eq!(invocation.cli.command, "claude");
        assert_eq!(
            invocation.cli.args,
            vec![
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--resume",
                "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
            ]
        );
        assert_eq!(
            invocation.cli.prompt_transport,
            crate::ai::PromptTransport::Stdin
        );
        assert_eq!(invocation.prompt, "continue in provider state");
        assert_eq!(
            invocation.native_thread_id.as_deref(),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );
        assert_eq!(
            invocation.output_mode,
            super::ChatCliOutputMode::ClaudeStreamJson
        );
    }

    #[test]
    fn chat_cli_invocation_seeds_claude_session_id_without_cursor() {
        let input = super::ChatProviderInput {
            thread: Some(crate::persistence::ProviderThread {
                session_id: Uuid::new_v4().to_string(),
                provider: "claude".to_string(),
                model: None,
                native_thread_id: None,
                resume_token: None,
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            }),
            message: chat_message(
                "current-user",
                crate::persistence::ChatRole::User,
                "first message",
            ),
            context: Some(super::CompiledContext {
                included_message_ids: vec!["current-user".to_string()],
                summary_id: None,
                prompt: "compiled first message".to_string(),
            }),
            model: None,
        };

        let invocation = super::resolve_chat_cli_invocation(
            &crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Claude,
                ollama_model: None,
                llm_model: None,
            },
            &input,
        )
        .unwrap();

        assert_eq!(invocation.cli.command, "claude");
        assert_eq!(
            invocation.cli.args[0..5],
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages"
            ]
        );
        assert_eq!(invocation.cli.args[5], "--session-id");
        let seeded_id = invocation.cli.args[6].as_str();
        Uuid::parse_str(seeded_id).expect("seeded Claude id should be a UUID");
        assert_eq!(invocation.prompt, "compiled first message");
        assert_eq!(invocation.native_thread_id.as_deref(), Some(seeded_id));
        assert_eq!(invocation.resume_token.as_deref(), Some(seeded_id));
        assert_eq!(
            invocation.output_mode,
            super::ChatCliOutputMode::ClaudeStreamJson
        );
    }

    #[test]
    fn chat_cli_invocation_resumes_codex_thread_from_stdin() {
        let input = super::ChatProviderInput {
            thread: Some(crate::persistence::ProviderThread {
                session_id: Uuid::new_v4().to_string(),
                provider: "codex".to_string(),
                model: None,
                native_thread_id: Some("019e2001-3250-76b0-8410-2e073b38a2c1".to_string()),
                resume_token: Some("019e2001-3250-76b0-8410-2e073b38a2c1".to_string()),
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            }),
            message: chat_message(
                "current-user",
                crate::persistence::ChatRole::User,
                "continue codex",
            ),
            context: None,
            model: None,
        };

        let invocation = super::resolve_chat_cli_invocation(
            &crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Codex,
                ollama_model: None,
                llm_model: None,
            },
            &input,
        )
        .unwrap();

        assert_eq!(invocation.cli.command, "codex");
        assert_eq!(
            invocation.cli.args,
            vec![
                "exec",
                "--skip-git-repo-check",
                "--json",
                "resume",
                "019e2001-3250-76b0-8410-2e073b38a2c1",
                "-"
            ]
        );
        assert_eq!(
            invocation.cli.prompt_transport,
            crate::ai::PromptTransport::Stdin
        );
        assert_eq!(invocation.prompt, "continue codex");
        assert_eq!(invocation.output_mode, super::ChatCliOutputMode::CodexJson);
    }

    #[test]
    fn chat_cli_invocation_passes_antigravity_prompt_as_print_argument() {
        let input = super::ChatProviderInput {
            thread: None,
            message: chat_message(
                "current-user",
                crate::persistence::ChatRole::User,
                "run antigravity",
            ),
            context: None,
            model: None,
        };

        let invocation = super::resolve_chat_cli_invocation(
            &crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Antigravity,
                ollama_model: None,
                llm_model: None,
            },
            &input,
        )
        .unwrap();

        assert_eq!(invocation.cli.command, "agy");
        assert_eq!(invocation.cli.args, vec!["-p"]);
        assert_eq!(
            invocation.cli.prompt_transport,
            crate::ai::PromptTransport::Argument
        );
        assert_eq!(invocation.prompt, "run antigravity");
    }

    #[test]
    fn chat_cli_invocation_resumes_antigravity_with_prompt_argument_last() {
        let input = super::ChatProviderInput {
            thread: Some(crate::persistence::ProviderThread {
                session_id: Uuid::new_v4().to_string(),
                provider: "antigravity".to_string(),
                model: None,
                native_thread_id: Some("agy-conversation".to_string()),
                resume_token: Some("agy-conversation".to_string()),
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            }),
            message: chat_message(
                "current-user",
                crate::persistence::ChatRole::User,
                "continue antigravity",
            ),
            context: None,
            model: None,
        };

        let invocation = super::resolve_chat_cli_invocation(
            &crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Antigravity,
                ollama_model: None,
                llm_model: None,
            },
            &input,
        )
        .unwrap();

        assert_eq!(invocation.cli.command, "agy");
        assert_eq!(
            invocation.cli.args,
            vec!["--conversation", "agy-conversation", "-p"]
        );
        assert_eq!(
            invocation.cli.prompt_transport,
            crate::ai::PromptTransport::Argument
        );
        assert_eq!(invocation.prompt, "continue antigravity");
    }

    #[test]
    fn provider_switch_uses_separate_thread_and_handoff_context() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "first"),
            chat_message(
                "a1",
                crate::persistence::ChatRole::Assistant,
                "codex answer",
            ),
        ]);
        state
            .provider_threads
            .push(crate::persistence::ProviderThread {
                session_id: state.session_id.clone(),
                provider: "codex".to_string(),
                model: None,
                native_thread_id: Some("codex-thread".to_string()),
                resume_token: None,
                last_response_id: Some("codex-response".to_string()),
                updated_at: chrono::Utc::now(),
            });
        let adapter = RecordingChatProviderAdapter {
            capabilities: super::ChatProviderCapabilities {
                native_thread: true,
                streaming: false,
                attachments: false,
            },
            ..Default::default()
        };

        let result = super::run_chat_turn_for_test(
            state,
            crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Claude,
                ollama_model: None,
                llm_model: None,
            },
            "handoff to claude".to_string(),
            &adapter,
        )
        .unwrap();
        let inputs = adapter.inputs.lock().unwrap();

        assert!(inputs[0].context.is_some());
        assert!(inputs[0]
            .thread
            .as_ref()
            .unwrap()
            .native_thread_id
            .is_none());
        assert!(result
            .final_state
            .provider_threads
            .iter()
            .any(|thread| thread.provider == "codex"));
        assert!(result
            .final_state
            .provider_threads
            .iter()
            .any(|thread| thread.provider == "claude"));
        assert_eq!(
            result.final_state.context_snapshots[0].mode,
            crate::persistence::ContextSnapshotMode::CompiledContext
        );
    }

    #[test]
    fn chat_runtime_marks_turn_and_assistant_message_error_without_deleting_user_message() {
        let state = chat_state_for_runtime(Vec::new());
        let adapter = RecordingChatProviderAdapter {
            error: Some("provider failed".to_string()),
            ..Default::default()
        };

        let result = super::run_chat_turn_for_test(
            state,
            crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Antigravity,
                ollama_model: None,
                llm_model: None,
            },
            "please fail".to_string(),
            &adapter,
        )
        .unwrap();

        assert!(result.final_state.messages.iter().any(|message| {
            message.role == crate::persistence::ChatRole::User && message.content == "please fail"
        }));
        let assistant = result.final_state.messages.last().unwrap();
        assert_eq!(
            assistant.status,
            Some(crate::persistence::ChatMessageStatus::Error)
        );
        assert!(assistant.content.contains("provider failed"));
        assert_eq!(
            result.final_state.turns[0].status,
            crate::persistence::ChatTurnStatus::Error
        );
        assert_eq!(
            result.final_state.turns[0].error.as_deref(),
            Some("provider failed")
        );
    }

    #[test]
    fn chat_runtime_records_provider_metadata_on_user_messages() {
        let state = chat_state_for_runtime(Vec::new());
        let adapter = RecordingChatProviderAdapter::default();

        let result = super::run_chat_turn_for_test(
            state,
            crate::ai::AiExecutionRequest {
                provider: crate::ai::AiProvider::Codex,
                ollama_model: None,
                llm_model: None,
            },
            "remember my provider".to_string(),
            &adapter,
        )
        .unwrap();

        let user_message = result
            .pending_state
            .messages
            .iter()
            .find(|message| message.role == crate::persistence::ChatRole::User)
            .unwrap();
        assert_eq!(
            user_message
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("provider"))
                .and_then(serde_json::Value::as_str),
            Some("codex")
        );
    }

    #[test]
    fn cancel_chat_turn_marks_running_turn_and_pending_assistant_message() {
        let now = chrono::Utc::now();
        let mut state = chat_state_for_runtime(vec![crate::persistence::ChatMessage {
            id: "u1".to_string(),
            session_id: None,
            turn_id: Some("turn-1".to_string()),
            role: crate::persistence::ChatRole::User,
            content: "stop this".to_string(),
            created_at: now,
            status: Some(crate::persistence::ChatMessageStatus::Complete),
            metadata: None,
        }]);
        state.turns.push(crate::persistence::ChatTurn {
            id: "turn-1".to_string(),
            session_id: state.session_id.clone(),
            provider: "codex".to_string(),
            model: None,
            status: crate::persistence::ChatTurnStatus::Running,
            user_message_id: "u1".to_string(),
            assistant_message_id: Some("a1".to_string()),
            started_at: now,
            completed_at: None,
            error: None,
            activities: vec![crate::persistence::ChatActivity {
                id: "tool-1".to_string(),
                kind: crate::persistence::ChatActivityKind::Command,
                title: "Long command".to_string(),
                detail: None,
                status: crate::persistence::ChatActivityStatus::Running,
                started_at: now,
                completed_at: None,
            }],
        });
        state.messages.push(crate::persistence::ChatMessage {
            id: "a1".to_string(),
            session_id: Some(state.session_id.clone()),
            turn_id: Some("turn-1".to_string()),
            role: crate::persistence::ChatRole::Assistant,
            content: String::new(),
            created_at: now,
            status: Some(crate::persistence::ChatMessageStatus::Pending),
            metadata: Some(serde_json::json!({ "provider": "codex" })),
        });

        let (state, changed) = super::cancel_chat_turn_in_state(state, "turn-1");

        assert!(changed);
        assert_eq!(
            state.turns[0].status,
            crate::persistence::ChatTurnStatus::Cancelled
        );
        assert!(state.turns[0].completed_at.is_some());
        assert_eq!(state.turns[0].error, None);
        assert_eq!(
            state.turns[0].activities[0].status,
            crate::persistence::ChatActivityStatus::Cancelled
        );
        assert!(state.turns[0].activities[0].completed_at.is_some());
        assert_eq!(state.messages[1].content, "Cancelled");
        assert_eq!(
            state.messages[1].status,
            Some(crate::persistence::ChatMessageStatus::Cancelled)
        );
    }

    #[test]
    fn retry_chat_branch_prunes_from_anchor_and_resets_hidden_context() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "first"),
            chat_message(
                "a1",
                crate::persistence::ChatRole::Assistant,
                "first answer",
            ),
            chat_message("u2", crate::persistence::ChatRole::User, "second"),
            chat_message(
                "a2",
                crate::persistence::ChatRole::Assistant,
                "second answer",
            ),
        ]);
        state
            .provider_threads
            .push(crate::persistence::ProviderThread {
                session_id: state.session_id.clone(),
                provider: "claude".to_string(),
                model: None,
                native_thread_id: Some("thread-1".to_string()),
                resume_token: Some("thread-1".to_string()),
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            });
        state.memory.summary = Some("stale summary".to_string());

        let branch = super::prepare_chat_retry_branch(state, "a2", None).unwrap();

        assert_eq!(branch.content, "second");
        assert_eq!(
            branch
                .state
                .messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["u1", "a1"]
        );
        assert!(branch.state.provider_threads.is_empty());
        assert!(branch.state.memory.summary.is_none());
    }

    #[test]
    fn retry_chat_branch_rejects_non_last_message() {
        let state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "first"),
            chat_message(
                "a1",
                crate::persistence::ChatRole::Assistant,
                "first answer",
            ),
            chat_message("u2", crate::persistence::ChatRole::User, "second"),
            chat_message(
                "a2",
                crate::persistence::ChatRole::Assistant,
                "second answer",
            ),
        ]);

        let err = match super::prepare_chat_retry_branch(state, "u2", Some("edit".to_string())) {
            Ok(_) => panic!("retrying a non-last message should be rejected"),
            Err(err) => err,
        };
        assert!(
            err.to_string().contains("only the last chat message"),
            "{err}"
        );
    }

    #[test]
    fn delete_chat_branch_removes_last_message_and_resets_hidden_context() {
        let mut state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "first"),
            chat_message(
                "a1",
                crate::persistence::ChatRole::Assistant,
                "first answer",
            ),
            chat_message("u2", crate::persistence::ChatRole::User, "second"),
            chat_message(
                "a2",
                crate::persistence::ChatRole::Assistant,
                "second answer",
            ),
        ]);
        state
            .provider_threads
            .push(crate::persistence::ProviderThread {
                session_id: state.session_id.clone(),
                provider: "codex".to_string(),
                model: None,
                native_thread_id: Some("thread-1".to_string()),
                resume_token: Some("thread-1".to_string()),
                last_response_id: None,
                updated_at: chrono::Utc::now(),
            });
        state.memory.summary = Some("stale summary".to_string());

        let pruned = super::delete_chat_branch_from_message(state, "a2").unwrap();

        assert_eq!(
            pruned
                .messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["u1", "a1", "u2"]
        );
        assert!(pruned.provider_threads.is_empty());
        assert!(pruned.memory.summary.is_none());
    }

    #[test]
    fn delete_chat_branch_rejects_non_last_message() {
        let state = chat_state_for_runtime(vec![
            chat_message("u1", crate::persistence::ChatRole::User, "first"),
            chat_message(
                "a1",
                crate::persistence::ChatRole::Assistant,
                "first answer",
            ),
            chat_message("u2", crate::persistence::ChatRole::User, "second"),
        ]);

        let err = super::delete_chat_branch_from_message(state, "a1")
            .expect_err("deleting a non-last message should be rejected");
        assert!(
            err.to_string().contains("only the last chat message"),
            "{err}"
        );
    }

    #[test]
    fn chat_provider_metadata_backfill_preserves_existing_agent_labels() {
        let now = chrono::Utc::now();
        let mut state = crate::persistence::ChatSessionState {
            schema_version: crate::persistence::CHAT_SESSION_SCHEMA_VERSION,
            session_id: Uuid::new_v4().to_string(),
            session: crate::persistence::ChatSession::default(),
            provider: Some("codex".to_string()),
            model: None,
            messages: vec![
                crate::persistence::ChatMessage {
                    id: "a1".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::Assistant,
                    content: "old codex answer".to_string(),
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: None,
                },
                crate::persistence::ChatMessage {
                    id: "a2".to_string(),
                    session_id: None,
                    turn_id: None,
                    role: crate::persistence::ChatRole::Assistant,
                    content: "existing claude answer".to_string(),
                    created_at: now,
                    status: Some(crate::persistence::ChatMessageStatus::Complete),
                    metadata: Some(serde_json::json!({ "provider": "claude" })),
                },
            ],
            turns: Vec::new(),
            provider_threads: Vec::new(),
            context_snapshots: Vec::new(),
            memory: crate::persistence::SessionMemory::default(),
            created_at: now,
            updated_at: now,
        };

        super::backfill_missing_assistant_provider_metadata(&mut state);

        assert_eq!(
            state.messages[0]
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("provider"))
                .and_then(serde_json::Value::as_str),
            Some("codex")
        );
        assert_eq!(
            state.messages[1]
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("provider"))
                .and_then(serde_json::Value::as_str),
            Some("claude")
        );
    }

    #[test]
    fn font_name_from_path_strips_compound_style_suffixes() {
        assert_eq!(
            font_name_from_path(Path::new("/tmp/GeistMono-BlackItalic.ttf")),
            Some("GeistMono".to_string())
        );
        assert_eq!(
            font_name_from_path(Path::new("/tmp/GeistMono-MediumItalic.ttf")),
            Some("GeistMono".to_string())
        );
        assert_eq!(
            font_name_from_path(Path::new("/tmp/GeistMono-ThinItalic.ttf")),
            Some("GeistMono".to_string())
        );
    }

    #[test]
    fn validate_new_project_name_accepts_single_folder_name() {
        assert_eq!(
            validate_new_project_name(" fresh-app ", false).unwrap(),
            "fresh-app"
        );
    }

    #[test]
    fn validate_new_project_name_rejects_path_like_names() {
        assert!(validate_new_project_name("", false).is_err());
        assert!(validate_new_project_name("../fresh-app", false).is_err());
        assert!(validate_new_project_name("parent/fresh-app", false).is_err());
        assert!(validate_new_project_name(".", false).is_err());
    }

    #[test]
    fn validate_editor_command_accepts_known_editors_and_safe_args() {
        assert_eq!(
            validate_editor_command("code-insiders", &["--wait".to_string()]).unwrap(),
            "code-insiders"
        );
        assert_eq!(
            validate_editor_command("idea", &["--new-window".to_string()]).unwrap(),
            "idea"
        );
    }

    #[test]
    fn validate_editor_command_rejects_paths_and_unknown_args() {
        assert!(validate_editor_command("/tmp/editor", &[]).is_err());
        assert!(validate_editor_command("open", &[]).is_err());
        assert!(
            validate_editor_command("code", &["--user-data-dir=/tmp/acorn".to_string()]).is_err()
        );
    }

    #[test]
    fn validate_new_project_name_rejects_long_names_unless_overridden() {
        let long = "a".repeat(256);
        assert!(validate_new_project_name(&long, false).is_err());
        assert_eq!(validate_new_project_name(&long, true).unwrap(), long);
    }

    #[test]
    fn validate_new_project_name_allows_macos_linux_valid_names() {
        assert_eq!(validate_new_project_name("CON", false).unwrap(), "CON");
        assert_eq!(
            validate_new_project_name("nul.txt", false).unwrap(),
            "nul.txt"
        );
        assert_eq!(
            validate_new_project_name("foo:bar", false).unwrap(),
            "foo:bar"
        );
        assert_eq!(validate_new_project_name("name.", false).unwrap(), "name.");
        assert_eq!(
            validate_new_project_name("parent\\fresh-app", false).unwrap(),
            "parent\\fresh-app"
        );
    }

    #[test]
    fn folder_permission_probe_reports_first_entry_error() {
        let result = super::folder_permission_from_first_entry(
            "documents",
            "/Users/me/Documents".to_string(),
            [Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "operation not permitted",
            ))]
            .into_iter(),
        );

        assert_eq!(
            result,
            super::FolderPermissionWarmupResult {
                id: "documents",
                path: "/Users/me/Documents".to_string(),
                status: "denied",
                error: Some("operation not permitted".to_string()),
            },
        );
    }

    #[test]
    fn folder_permission_probe_reports_empty_directory_as_ok() {
        let result = super::folder_permission_from_first_entry(
            "downloads",
            "/Users/me/Downloads".to_string(),
            std::iter::empty::<std::io::Result<()>>(),
        );

        assert_eq!(
            result,
            super::FolderPermissionWarmupResult {
                id: "downloads",
                path: "/Users/me/Downloads".to_string(),
                status: "ok",
                error: None,
            },
        );
    }

    #[test]
    fn daemon_spawn_name_prefers_session_name_over_uuid() {
        let id = Uuid::new_v4();
        let session = Session::new(
            "Readable tab".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );

        assert_eq!(
            daemon_spawn_name_for_session(Some(&session), id),
            "Readable tab"
        );
    }

    #[test]
    fn daemon_spawn_name_falls_back_to_uuid_without_session() {
        let id = Uuid::new_v4();

        assert_eq!(daemon_spawn_name_for_session(None, id), id.to_string());
    }

    #[test]
    fn detach_token_keeps_newer_renderer_attachment() {
        assert!(!detach_requested_by_stale_renderer(Some(7), Some(7)));
        assert!(!detach_requested_by_stale_renderer(Some(7), None));

        assert!(detach_requested_by_stale_renderer(Some(7), Some(8)));
        assert!(detach_requested_by_stale_renderer(None, Some(8)));
    }

    #[test]
    fn local_session_removal_cleans_project_mirror_without_project_sessions() {
        let removed = scoped_session("local", "/Users/me", false);

        assert!(should_remove_local_project_mirror(&removed, &[]));
    }

    #[test]
    fn local_session_removal_keeps_project_when_project_session_remains() {
        let removed = scoped_session("local", "/Users/me", false);
        let remaining = [scoped_session("project", "/Users/me", true)];

        assert!(!should_remove_local_project_mirror(&removed, &remaining));
    }

    #[test]
    fn project_session_removal_never_cleans_project_mirror() {
        let removed = scoped_session("project", "/Users/me", true);

        assert!(!should_remove_local_project_mirror(&removed, &[]));
    }

    #[test]
    fn inject_agent_hook_env_stamps_known_provider_without_overriding_callers() {
        let hooks = crate::agent_hooks::AgentHookServer::start().expect("hook server starts");
        let mut session = Session::new(
            "Codex".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.id = Uuid::new_v4();
        session.agent_provider = Some(SessionAgentProvider::Codex);

        let mut env = HashMap::new();
        env.insert(
            "ACORN_AGENT_HOOK_TOKEN".to_string(),
            "caller-token".to_string(),
        );
        env.insert(
            "ACORN_AGENT_INVOCATION_ROOT".to_string(),
            "caller-root".to_string(),
        );
        env.insert(
            "ACORN_AGENT_INVOCATION_TOKEN".to_string(),
            "ancestor-owner".to_string(),
        );
        env.insert("ACORN_AGENT_INVOCATION_DEPTH".to_string(), "3".to_string());
        env.insert("CODEX_TUI_RECORD_SESSION".to_string(), "1".to_string());
        env.insert(
            "CODEX_TUI_SESSION_LOG_PATH".to_string(),
            "/tmp/outer-codex.jsonl".to_string(),
        );
        env.insert(
            "ACORN_CODEX_NATIVE_HOOKS_ENABLED".to_string(),
            "1".to_string(),
        );

        inject_agent_hook_env(&mut env, &session, Some(&hooks));

        assert_eq!(
            env.get("ACORN_AGENT_HOOK_URL"),
            Some(&hooks.hook_url().to_string())
        );
        assert_eq!(
            env.get("ACORN_AGENT_HOOK_TOKEN"),
            Some(&"caller-token".to_string())
        );
        assert_eq!(
            env.get("ACORN_AGENT_HOOK_SESSION_ID"),
            Some(&session.id.to_string())
        );
        assert_eq!(
            env.get("ACORN_AGENT_INVOCATION_ROOT"),
            Some(&"1".to_string()),
            "the PTY boundary must overwrite caller input with a fresh root marker",
        );
        assert!(!env.contains_key("ACORN_AGENT_INVOCATION_TOKEN"));
        assert!(!env.contains_key("ACORN_AGENT_INVOCATION_DEPTH"));
        assert!(!env.contains_key("CODEX_TUI_RECORD_SESSION"));
        assert!(!env.contains_key("CODEX_TUI_SESSION_LOG_PATH"));
        assert!(!env.contains_key("ACORN_CODEX_NATIVE_HOOKS_ENABLED"));
        assert_eq!(
            env.get("ACORN_AGENT_HOOK_PROVIDER"),
            Some(&"codex".to_string())
        );
    }

    #[test]
    fn inject_agent_hook_env_preserves_unowned_recorder_configuration() {
        let hooks = crate::agent_hooks::AgentHookServer::start().expect("hook server starts");
        let mut session = Session::new(
            "Codex".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.id = Uuid::new_v4();
        session.agent_provider = Some(SessionAgentProvider::Codex);

        let mut env = HashMap::from([
            ("CODEX_TUI_RECORD_SESSION".to_string(), "1".to_string()),
            (
                "CODEX_TUI_SESSION_LOG_PATH".to_string(),
                "/tmp/caller-codex.jsonl".to_string(),
            ),
        ]);

        inject_agent_hook_env(&mut env, &session, Some(&hooks));

        assert_eq!(
            env.get("CODEX_TUI_RECORD_SESSION").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            env.get("CODEX_TUI_SESSION_LOG_PATH").map(String::as_str),
            Some("/tmp/caller-codex.jsonl")
        );
    }

    #[test]
    fn inject_agent_hook_env_skips_when_server_unavailable() {
        let mut session = Session::new(
            "Shell".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.agent_provider = None;

        let mut env = HashMap::new();
        inject_agent_hook_env(&mut env, &session, None);
        assert!(!env.contains_key("ACORN_AGENT_HOOK_URL"));
        assert!(!env.contains_key("ACORN_AGENT_INVOCATION_ROOT"));
    }

    #[test]
    fn inject_agent_hook_env_injects_channel_when_provider_unknown() {
        // A terminal session not yet classified as an agent still gets the
        // hook channel so a later `claude`/`codex` launch inside it can
        // register hooks. Without this the agent never reports Stop/Notify
        // events and its status falls back to transcript polling, which can't
        // see turn completion once `end_turn` scrolls out of the tail window.
        let hooks = crate::agent_hooks::AgentHookServer::start().expect("hook server starts");
        let mut session = Session::new(
            "Shell".to_string(),
            PathBuf::from("/tmp/repo"),
            PathBuf::from("/tmp/repo"),
            "main".to_string(),
            false,
            SessionKind::Regular,
        );
        session.id = Uuid::new_v4();
        session.agent_provider = None;

        let mut env = HashMap::new();
        inject_agent_hook_env(&mut env, &session, Some(&hooks));

        assert_eq!(
            env.get("ACORN_AGENT_HOOK_URL"),
            Some(&hooks.hook_url().to_string())
        );
        assert_eq!(
            env.get("ACORN_AGENT_HOOK_TOKEN"),
            Some(&hooks.token().to_string())
        );
        assert_eq!(
            env.get("ACORN_AGENT_HOOK_SESSION_ID"),
            Some(&session.id.to_string())
        );
        assert_eq!(
            env.get("ACORN_AGENT_INVOCATION_ROOT"),
            Some(&"1".to_string())
        );
        // Provider is unknown at spawn; the per-provider notify script reports
        // its own provider, so the provider-specific var stays unset here.
        assert!(!env.contains_key("ACORN_AGENT_HOOK_PROVIDER"));
    }

    #[test]
    fn auto_title_is_enabled_only_for_new_agent_and_chat_sessions() {
        assert!(!auto_title_enabled_for_new_session(
            SessionKind::Regular,
            SessionMode::Terminal,
            None,
        ));
        assert!(auto_title_enabled_for_new_session(
            SessionKind::Regular,
            SessionMode::Terminal,
            Some(SessionAgentProvider::Codex),
        ));
        assert!(auto_title_enabled_for_new_session(
            SessionKind::Regular,
            SessionMode::Chat,
            None,
        ));
        assert!(!auto_title_enabled_for_new_session(
            SessionKind::Control,
            SessionMode::Chat,
            Some(SessionAgentProvider::Codex),
        ));
    }

    #[test]
    fn auto_title_promotes_only_opted_out_sessions_with_transcripts() {
        // Plain terminal that started an agent: promote.
        assert!(super::auto_title_promotion_needed(Some(false), true));
        // Plain terminal still shell-only: leave gated.
        assert!(!super::auto_title_promotion_needed(Some(false), false));
        // Already opted in: nothing to do.
        assert!(!super::auto_title_promotion_needed(Some(true), true));
        // Legacy rows keep using compatibility heuristics.
        assert!(!super::auto_title_promotion_needed(None, true));
    }

    /// The fallback's write-failure warning must fire once per failure
    /// streak: repeat failures drop to debug, and a successful bind
    /// re-arms the warning for the next streak.
    #[test]
    fn codex_bind_failure_warns_once_per_streak() {
        let mut warned = super::CodexBindFailureRegistry::with_capacity(2);
        let session_id = Uuid::from_u128(7);

        assert!(super::note_codex_bind_failure(&mut warned, session_id));
        assert!(!super::note_codex_bind_failure(&mut warned, session_id));

        super::note_codex_bind_recovered(&mut warned, session_id);
        assert!(super::note_codex_bind_failure(&mut warned, session_id));
    }

    #[test]
    fn codex_bind_failure_registry_evicts_oldest_session_at_capacity() {
        let mut warned = super::CodexBindFailureRegistry::with_capacity(2);
        let first = Uuid::from_u128(1);
        let second = Uuid::from_u128(2);
        let third = Uuid::from_u128(3);

        assert!(super::note_codex_bind_failure(&mut warned, first));
        assert!(super::note_codex_bind_failure(&mut warned, second));
        assert!(super::note_codex_bind_failure(&mut warned, third));

        assert_eq!(warned.len(), 2);
        assert!(!warned.contains(&first));
        assert!(warned.contains(&second));
        assert!(warned.contains(&third));
    }

    #[test]
    fn unattached_daemon_session_shell_hint_uses_live_descendants() {
        assert_eq!(
            super::shell_hint_for_unattached_daemon_status_poll(true),
            acorn_pty::ShellHint::Running
        );
        assert_eq!(
            super::shell_hint_for_unattached_daemon_status_poll(false),
            acorn_pty::ShellHint::Idle
        );
    }

    #[test]
    fn transcript_activity_uses_the_transcript_mtime() {
        let transcript = tempfile::NamedTempFile::new().expect("temporary transcript");

        let activity_at = super::transcript_activity_at(transcript.path())
            .expect("transcript activity timestamp");

        assert!(chrono::DateTime::parse_from_rfc3339(&activity_at).is_ok());
    }

    #[test]
    fn memory_usage_walks_app_and_daemon_roots_once() {
        let snapshots = [
            ProcessMemorySnapshot::new(10, None, "acorn", 100),
            ProcessMemorySnapshot::new(11, Some(10), "legacy-shell", 20),
            ProcessMemorySnapshot::new(20, Some(1), "acornd", 70),
            ProcessMemorySnapshot::new(21, Some(20), "daemon-shell", 30),
            ProcessMemorySnapshot::new(22, Some(21), "claude", 200),
            ProcessMemorySnapshot::new(23, Some(22), "acorn-ipc", 15),
        ];

        let usage = collect_memory_usage_from_roots(&snapshots, &[10, 20, 21]);

        assert_eq!(usage.bytes, 435);
        assert_eq!(usage.processes.len(), 6);
        let daemon = usage.processes.iter().find(|p| p.pid == 20).unwrap();
        let daemon_shell = usage.processes.iter().find(|p| p.pid == 21).unwrap();
        let ipc = usage.processes.iter().find(|p| p.pid == 23).unwrap();
        assert_eq!(daemon.depth, 0);
        assert_eq!(daemon_shell.depth, 1);
        assert_eq!(ipc.depth, 3);
        assert_eq!(ipc.name, "acorn-ipc");
    }

    #[test]
    fn memory_roots_include_only_real_daemon_pid() {
        let snapshots = [
            ProcessMemorySnapshot::new(10, None, "acorn", 100),
            ProcessMemorySnapshot::new(20, Some(1), "acornd", 70),
            ProcessMemorySnapshot::new(30, Some(1), "zsh", 40),
        ];
        let by_pid: std::collections::HashMap<u32, &ProcessMemorySnapshot> =
            snapshots.iter().map(|p| (p.pid, p)).collect();

        assert_eq!(memory_root_pids(&by_pid, 10, Some(20)), vec![10, 20]);
        assert_eq!(memory_root_pids(&by_pid, 10, Some(30)), vec![10]);
        assert_eq!(memory_root_pids(&by_pid, 10, Some(999)), vec![10]);
    }

    fn unique_repo_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "acorn-commands-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn seeded_repo_supports_worktree_creation() {
        // Regression: a `Repository::init`-only project has an unborn HEAD, so
        // worktree creation fails with "reference 'refs/heads/master' not found".
        // seed_initial_commit must make the repo immediately worktree-capable.
        let repo_dir = unique_repo_dir("seed-initial-commit");
        let repo = git2::Repository::init(&repo_dir).expect("init repo");
        assert!(repo.head().is_err(), "fresh init must have unborn HEAD");
        seed_initial_commit(&repo).expect("seed initial commit");
        assert!(repo.head().is_ok(), "seeded repo must resolve HEAD");
        drop(repo);
        crate::worktree::create_worktree(&repo_dir, "feature")
            .expect("worktree creation on seeded repo");
    }

    fn init_repo_with_commit(path: &Path) -> git2::Repository {
        let repo = git2::Repository::init(path).expect("init repo");
        let sig = git2::Signature::now("acorn-test", "test@acorn").expect("sig");
        let tree_id = {
            let mut idx = repo.index().expect("index");
            idx.write_tree().expect("write tree")
        };
        let tree = repo.find_tree(tree_id).expect("find tree");
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .expect("initial commit");
        drop(tree);
        repo
    }

    #[test]
    fn restoring_pending_session_removal_restores_worktree_and_session_identity() {
        let repo_dir = unique_repo_dir("restore-session-and-worktree");
        let repo = init_repo_with_commit(&repo_dir);
        drop(repo);
        let worktree_path = crate::worktree::create_worktree(&repo_dir, "restored")
            .expect("create linked worktree");
        let removed = crate::worktree::stage_remove_worktree_at_path(&repo_dir, &worktree_path)
            .expect("stage worktree removal")
            .expect("removal token");
        assert!(!worktree_path.exists());

        let state = AppState::new();
        let mut session = worktree_session(
            "restored",
            repo_dir.to_str().expect("repo path"),
            worktree_path.to_str().expect("worktree path"),
        );
        let session_id = session.id;
        session.status = acorn_session::SessionStatus::Working;
        session.daemon_session_id = Some(session.id);
        state.pending_session_removals.lock().insert(
            removed.token.clone(),
            PendingSessionRemoval {
                worktree: removed.clone(),
                sessions: vec![session],
            },
        );

        restore_pending_session_removal(
            &state,
            &removed.token,
            &removed.repo_path,
            &removed.worktree_path,
            &removed.git_common_dir,
        )
        .expect("restore session removal");

        let restored = state.sessions.get(&session_id).expect("restored session");
        assert!(worktree_path.exists());
        assert_eq!(restored.id, session_id);
        assert_eq!(restored.status, acorn_session::SessionStatus::Ready);
        assert_eq!(restored.daemon_session_id, None);
        assert!(state.pending_session_removals.lock().is_empty());

        crate::worktree::remove_worktree_at_path(&repo_dir, &worktree_path)
            .expect("remove restored worktree");
        std::fs::remove_dir_all(&repo_dir).ok();
    }

    #[test]
    fn failed_worktree_restore_does_not_restore_session() {
        let repo_dir = unique_repo_dir("failed-worktree-restore");
        let worktree_path = repo_dir.join(".acorn/worktrees/missing");
        let token = Uuid::new_v4().to_string();
        let removed = crate::worktree::RemovedWorktree {
            token: token.clone(),
            repo_path: repo_dir.to_string_lossy().into_owned(),
            worktree_path: worktree_path.to_string_lossy().into_owned(),
            git_common_dir: repo_dir.join(".git").to_string_lossy().into_owned(),
        };
        let state = AppState::new();
        let session = worktree_session(
            "missing",
            repo_dir.to_str().expect("repo path"),
            worktree_path.to_str().expect("worktree path"),
        );
        let session_id = session.id;
        state.pending_session_removals.lock().insert(
            token.clone(),
            PendingSessionRemoval {
                worktree: removed.clone(),
                sessions: vec![session],
            },
        );

        restore_pending_session_removal(
            &state,
            &removed.token,
            &removed.repo_path,
            &removed.worktree_path,
            &removed.git_common_dir,
        )
        .expect_err("missing worktree backup must fail");

        assert!(state.sessions.get(&session_id).is_err());
        assert!(state.pending_session_removals.lock().contains_key(&token));
        std::fs::remove_dir_all(&repo_dir).ok();
    }

    // Regression: a generated worktree branch name can collide with an
    // existing branch. The retry loop bumps the suffix on Exists just like it
    // does for path collisions.
    #[test]
    fn create_unique_worktree_bumps_suffix_when_branch_name_taken() {
        let repo_dir = unique_repo_dir("branch-collision");
        let repo = init_repo_with_commit(&repo_dir);
        // Create a branch named after the repo so generated branch creation
        // collides on the first attempt.
        let head_commit = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .expect("HEAD commit");
        repo.branch("acorn", &head_commit, false)
            .expect("create acorn branch");
        drop(head_commit);
        drop(repo);

        let (name, path) =
            create_unique_worktree(&repo_dir, "acorn").expect("worktree should be created");
        assert_eq!(
            name, "acorn-2",
            "expected suffix bump when `acorn` branch is taken"
        );
        assert!(path.exists(), "worktree path should exist on disk");

        std::fs::remove_dir_all(&repo_dir).ok();
    }

    #[test]
    fn remove_linked_worktree_at_path_uses_actual_path_not_session_name() {
        let repo_dir = unique_repo_dir("remove-by-path");
        init_repo_with_commit(&repo_dir);
        let (_name, path) =
            create_unique_worktree(&repo_dir, "acorn-2").expect("worktree should be created");
        assert!(path.exists(), "worktree path should exist before removal");

        remove_linked_worktree_at_path(&repo_dir, &path).expect("remove by path");

        assert!(
            !path.exists(),
            "worktree path should be removed even when the session name differs"
        );
        std::fs::remove_dir_all(&repo_dir).ok();
    }

    #[test]
    fn remove_linked_worktree_at_path_handles_project_root_that_is_a_worktree() {
        let repo_dir = unique_repo_dir("remove-project-root-worktree-main");
        init_repo_with_commit(&repo_dir);
        let (_name, path) =
            create_unique_worktree(&repo_dir, "external").expect("worktree should be created");
        assert!(
            path.exists(),
            "linked project root should exist before removal"
        );

        remove_linked_worktree_at_path(&path, &path).expect("remove linked project root by path");

        assert!(
            !path.exists(),
            "linked project root should be removed when explicitly requested"
        );
        std::fs::remove_dir_all(&repo_dir).ok();
    }

    #[test]
    fn worktree_delete_guard_rejects_peer_session_on_same_worktree_path() {
        let state = crate::state::AppState::default();
        let root =
            std::env::temp_dir().join(format!("acorn-worktree-guard-{}", Uuid::new_v4().simple()));
        let repo = root.join("repo");
        let other_repo = root.join("other");
        let worktree = repo.join(".acorn/worktrees/shared");
        std::fs::create_dir_all(&worktree).expect("create worktree path");
        let active = state.sessions.insert(worktree_session(
            "active",
            &repo.display().to_string(),
            &worktree.display().to_string(),
        ));
        state.sessions.insert(worktree_session(
            "peer",
            &other_repo.display().to_string(),
            &format!("{}/", worktree.display()),
        ));

        let err = super::ensure_no_sessions_using_worktree_path_except(
            &state,
            &worktree,
            Some(&active.id),
        )
        .expect_err("peer session should block worktree deletion");

        assert_eq!(err.to_string(), super::WORKTREE_IN_USE_BY_OTHER_SESSIONS);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn worktree_delete_guard_detects_sessions_outside_project() {
        let state = crate::state::AppState::default();
        let repo = Path::new("/tmp/acorn-worktree-guard-project");
        let other_repo = Path::new("/tmp/acorn-worktree-guard-project-other");
        let worktree = repo.join(".acorn/worktrees/shared");
        state.sessions.insert(worktree_session(
            "active",
            &repo.display().to_string(),
            &worktree.display().to_string(),
        ));
        state.sessions.insert(worktree_session(
            "peer",
            &other_repo.display().to_string(),
            &worktree.display().to_string(),
        ));

        assert!(super::worktree_path_used_outside_project(
            &state, repo, &worktree,
        ));
        assert!(!super::worktree_path_used_outside_project(
            &state,
            other_repo,
            &other_repo.join(".acorn/worktrees/solo"),
        ));
    }

    #[test]
    fn worktree_delete_guard_allows_target_session_only() {
        let state = crate::state::AppState::default();
        let repo = Path::new("/tmp/acorn-worktree-guard-solo");
        let worktree = repo.join(".acorn/worktrees/solo");
        let active = state.sessions.insert(worktree_session(
            "active",
            &repo.display().to_string(),
            &worktree.display().to_string(),
        ));

        super::ensure_no_sessions_using_worktree_path_except(&state, &worktree, Some(&active.id))
            .expect("target session should not block its own worktree deletion");
    }

    #[test]
    fn chat_worktree_base_uses_internal_namespace() {
        let repo = Path::new("/Users/ian/Documents/Works/momentry");

        assert_eq!(
            super::chat_worktree_base_name_for_repo(repo, "123456789abc"),
            "momentry-worktree-123456789abc"
        );
    }

    const CLAUDE_FORK_TEST_UUID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    fn claude_fork_test_limits(
        max_project_entries: usize,
        max_transcript_bytes: u64,
    ) -> super::ClaudeForkLimits {
        super::ClaudeForkLimits {
            max_project_entries,
            max_transcript_bytes,
        }
    }

    fn write_claude_fork_source(root: &Path, contents: &[u8]) -> PathBuf {
        let project = root.join("-source-project");
        std::fs::create_dir(&project).expect("create source project");
        let source = project.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl"));
        std::fs::write(&source, contents).expect("write source transcript");
        source
    }

    #[test]
    fn prepare_claude_fork_atomically_copies_snapshot_and_keeps_regular_destination() {
        let root = tempfile::tempdir().expect("temporary Claude projects root");
        let source = write_claude_fork_source(root.path(), b"parent snapshot\n");
        let new_cwd = Path::new("/tmp/acorn-fork-target");
        let destination_dir = root.path().join(acorn_transcript::slug_for_cwd(new_cwd));
        let destination = destination_dir.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl"));
        let limits = claude_fork_test_limits(8, 1024);

        super::prepare_claude_fork_in(root.path(), CLAUDE_FORK_TEST_UUID, new_cwd, limits)
            .expect("stage transcript");
        assert_eq!(
            std::fs::read(&destination).expect("read staged transcript"),
            b"parent snapshot\n"
        );
        assert!(std::fs::read_dir(&destination_dir)
            .expect("list destination directory")
            .flatten()
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with(".acorn-claude-fork-")));

        std::fs::write(&source, b"new source contents\n").expect("replace source contents");
        std::fs::write(&destination, b"existing destination\n")
            .expect("replace destination contents");
        super::prepare_claude_fork_in(root.path(), CLAUDE_FORK_TEST_UUID, new_cwd, limits)
            .expect("existing regular destination is idempotent");
        assert_eq!(
            std::fs::read(&destination).expect("read existing destination"),
            b"existing destination\n"
        );
    }

    #[test]
    fn prepare_claude_fork_fails_closed_over_raw_project_entry_budget() {
        let root = tempfile::tempdir().expect("temporary Claude projects root");
        write_claude_fork_source(root.path(), b"parent snapshot\n");
        std::fs::create_dir(root.path().join("-extra-project")).expect("create extra project");
        let new_cwd = Path::new("/tmp/acorn-fork-over-budget");

        let error = super::prepare_claude_fork_in(
            root.path(),
            CLAUDE_FORK_TEST_UUID,
            new_cwd,
            claude_fork_test_limits(1, 1024),
        )
        .expect_err("raw entry overflow must discard a partial match");

        assert!(error.to_string().contains("exceeds 1 entries"));
        assert!(!root
            .path()
            .join(acorn_transcript::slug_for_cwd(new_cwd))
            .exists());
    }

    #[test]
    fn prepare_claude_fork_rejects_oversized_source_snapshot() {
        let root = tempfile::tempdir().expect("temporary Claude projects root");
        write_claude_fork_source(root.path(), b"12345");
        let new_cwd = Path::new("/tmp/acorn-fork-oversized");

        let error = super::prepare_claude_fork_in(
            root.path(),
            CLAUDE_FORK_TEST_UUID,
            new_cwd,
            claude_fork_test_limits(4, 4),
        )
        .expect_err("oversized source must be rejected");

        assert!(error.to_string().contains("exceeds 4 bytes"));
        assert!(!root
            .path()
            .join(acorn_transcript::slug_for_cwd(new_cwd))
            .exists());
    }

    #[test]
    fn prepare_claude_fork_rejects_non_regular_source_and_destination() {
        let root = tempfile::tempdir().expect("temporary Claude projects root");
        let source_project = root.path().join("-source-project");
        std::fs::create_dir(&source_project).expect("create source project");
        std::fs::create_dir(source_project.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")))
            .expect("create directory at source leaf");

        let source_error = super::prepare_claude_fork_in(
            root.path(),
            CLAUDE_FORK_TEST_UUID,
            Path::new("/tmp/acorn-fork-special-source"),
            claude_fork_test_limits(4, 1024),
        )
        .expect_err("directory source must be rejected");
        assert!(source_error.to_string().contains("must be a regular file"));

        std::fs::remove_dir(source_project.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")))
            .expect("remove directory source");
        std::fs::write(
            source_project.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")),
            b"parent snapshot\n",
        )
        .expect("write regular source");
        let new_cwd = Path::new("/tmp/acorn-fork-special-destination");
        let destination_dir = root.path().join(acorn_transcript::slug_for_cwd(new_cwd));
        std::fs::create_dir(&destination_dir).expect("create destination directory");
        std::fs::create_dir(destination_dir.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")))
            .expect("create directory at destination leaf");

        let destination_error = super::prepare_claude_fork_in(
            root.path(),
            CLAUDE_FORK_TEST_UUID,
            new_cwd,
            claude_fork_test_limits(4, 1024),
        )
        .expect_err("directory destination must be rejected");
        assert!(destination_error
            .to_string()
            .contains("must be a regular file"));
    }

    #[cfg(unix)]
    #[test]
    fn prepare_claude_fork_rejects_linked_root_project_source_and_destination() {
        use std::os::unix::fs::symlink;

        let limits = claude_fork_test_limits(8, 1024);

        let actual_root = tempfile::tempdir().expect("actual Claude projects root");
        write_claude_fork_source(actual_root.path(), b"parent snapshot\n");
        let root_parent = tempfile::tempdir().expect("configured root parent");
        let linked_root = root_parent.path().join("projects");
        symlink(actual_root.path(), &linked_root).expect("link projects root");
        assert!(super::prepare_claude_fork_in(
            &linked_root,
            CLAUDE_FORK_TEST_UUID,
            Path::new("/tmp/acorn-fork-linked-root"),
            limits,
        )
        .is_err());

        let linked_project_root = tempfile::tempdir().expect("linked project root");
        let outside_project = tempfile::tempdir().expect("outside source project");
        std::fs::write(
            outside_project
                .path()
                .join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")),
            b"outside source\n",
        )
        .expect("write outside source");
        symlink(
            outside_project.path(),
            linked_project_root.path().join("-linked-project"),
        )
        .expect("link source project");
        assert!(super::prepare_claude_fork_in(
            linked_project_root.path(),
            CLAUDE_FORK_TEST_UUID,
            Path::new("/tmp/acorn-fork-linked-project"),
            limits,
        )
        .is_err());

        let linked_source_root = tempfile::tempdir().expect("linked source root");
        let source_project = linked_source_root.path().join("-source-project");
        std::fs::create_dir(&source_project).expect("create source project");
        let outside_source = tempfile::NamedTempFile::new().expect("outside source");
        std::fs::write(outside_source.path(), b"outside source\n").expect("write outside source");
        symlink(
            outside_source.path(),
            source_project.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")),
        )
        .expect("link source transcript");
        assert!(super::prepare_claude_fork_in(
            linked_source_root.path(),
            CLAUDE_FORK_TEST_UUID,
            Path::new("/tmp/acorn-fork-linked-source"),
            limits,
        )
        .is_err());

        let linked_destination_root = tempfile::tempdir().expect("linked destination root");
        write_claude_fork_source(linked_destination_root.path(), b"parent snapshot\n");
        let new_cwd = Path::new("/tmp/acorn-fork-linked-destination");
        let destination_dir = linked_destination_root
            .path()
            .join(acorn_transcript::slug_for_cwd(new_cwd));
        std::fs::create_dir(&destination_dir).expect("create destination directory");
        let outside_destination = tempfile::NamedTempFile::new().expect("outside destination");
        std::fs::write(outside_destination.path(), b"outside sentinel\n")
            .expect("write destination sentinel");
        symlink(
            outside_destination.path(),
            destination_dir.join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl")),
        )
        .expect("link destination transcript");

        assert!(super::prepare_claude_fork_in(
            linked_destination_root.path(),
            CLAUDE_FORK_TEST_UUID,
            new_cwd,
            limits,
        )
        .is_err());
        assert_eq!(
            std::fs::read(outside_destination.path()).expect("read destination sentinel"),
            b"outside sentinel\n"
        );

        let linked_destination_dir_root =
            tempfile::tempdir().expect("linked destination directory root");
        write_claude_fork_source(linked_destination_dir_root.path(), b"parent snapshot\n");
        let new_cwd = Path::new("/tmp/acorn-fork-linked-destination-directory");
        let outside_destination_dir = tempfile::tempdir().expect("outside destination directory");
        symlink(
            outside_destination_dir.path(),
            linked_destination_dir_root
                .path()
                .join(acorn_transcript::slug_for_cwd(new_cwd)),
        )
        .expect("link destination directory");

        assert!(super::prepare_claude_fork_in(
            linked_destination_dir_root.path(),
            CLAUDE_FORK_TEST_UUID,
            new_cwd,
            limits,
        )
        .is_err());
        assert!(!outside_destination_dir
            .path()
            .join(format!("{CLAUDE_FORK_TEST_UUID}.jsonl"))
            .exists());
    }

    #[test]
    fn control_marker_is_atomically_created_and_replaced() {
        let directory = tempfile::tempdir().expect("temporary control cwd");
        let marker = directory.path().join(".acorn-control.md");

        super::write_control_marker(directory.path(), "first primer");
        assert!(std::fs::read_to_string(&marker)
            .expect("read first marker")
            .contains("first primer"));

        super::write_control_marker(directory.path(), "second primer");
        let body = std::fs::read_to_string(&marker).expect("read replaced marker");
        assert!(body.contains("second primer"));
        assert!(!body.contains("first primer"));
        assert!(std::fs::read_dir(directory.path())
            .expect("list control cwd")
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));
    }

    #[cfg(unix)]
    #[test]
    fn control_marker_replacement_does_not_follow_a_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary control cwd");
        let outside = tempfile::NamedTempFile::new().expect("outside sentinel");
        std::fs::write(outside.path(), "outside sentinel").expect("write sentinel");
        let marker = directory.path().join(".acorn-control.md");
        symlink(outside.path(), &marker).expect("symlink marker");

        super::write_control_marker(directory.path(), "trusted primer");

        assert_eq!(
            std::fs::read_to_string(outside.path()).expect("read sentinel"),
            "outside sentinel"
        );
        assert!(std::fs::symlink_metadata(&marker)
            .expect("marker metadata")
            .file_type()
            .is_file());
        assert!(std::fs::read_to_string(&marker)
            .expect("read marker")
            .contains("trusted primer"));
    }

    #[cfg(unix)]
    #[test]
    fn control_marker_replacement_does_not_modify_a_hard_link_peer() {
        let directory = tempfile::tempdir().expect("temporary control cwd");
        let outside = tempfile::NamedTempFile::new().expect("outside sentinel");
        std::fs::write(outside.path(), "outside sentinel").expect("write sentinel");
        let marker = directory.path().join(".acorn-control.md");
        std::fs::hard_link(outside.path(), &marker).expect("hard-link marker");

        super::write_control_marker(directory.path(), "trusted primer");

        assert_eq!(
            std::fs::read_to_string(outside.path()).expect("read sentinel"),
            "outside sentinel"
        );
        assert!(std::fs::read_to_string(&marker)
            .expect("read marker")
            .contains("trusted primer"));
    }

    #[test]
    fn memory_can_infer_daemon_root_from_session_pid() {
        let snapshots = [
            ProcessMemorySnapshot::new(20, Some(1), "acornd", 70),
            ProcessMemorySnapshot::new(21, Some(20), "zsh", 30),
            ProcessMemorySnapshot::new(22, Some(21), "claude", 200),
        ];
        let by_pid: std::collections::HashMap<u32, &ProcessMemorySnapshot> =
            snapshots.iter().map(|p| (p.pid, p)).collect();

        assert_eq!(
            infer_acornd_root_from_session_pids(&by_pid, &[21, 22]),
            Some(20)
        );
        assert_eq!(infer_acornd_root_from_session_pids(&by_pid, &[999]), None);
    }

    #[test]
    fn remembered_project_parent_folder_is_regranted_when_it_exists() {
        let app_data = tempfile::tempdir().unwrap();
        let parent_root = tempfile::tempdir().unwrap();
        let parent = parent_root.path().join("projects");
        std::fs::create_dir(&parent).unwrap();
        crate::persistence::save_last_project_parent_folder_to_dir(app_data.path(), &parent)
            .unwrap();
        let state = crate::state::AppState::default();

        let restored =
            super::get_last_project_parent_folder_from_dir(&state, app_data.path()).unwrap();

        let canonical = parent.canonicalize().unwrap();
        assert_eq!(restored, Some(canonical.to_string_lossy().into_owned()));
        assert_eq!(state.folder_grants.lock().as_slice(), &[canonical]);
    }

    #[test]
    fn missing_remembered_project_parent_folder_is_cleared() {
        let app_data = tempfile::tempdir().unwrap();
        let missing = app_data.path().join("removed-projects");
        crate::persistence::save_last_project_parent_folder_to_dir(app_data.path(), &missing)
            .unwrap();
        let state = crate::state::AppState::default();

        let restored =
            super::get_last_project_parent_folder_from_dir(&state, app_data.path()).unwrap();

        assert_eq!(restored, None);
        assert_eq!(
            crate::persistence::load_last_project_parent_folder_from_dir(app_data.path()).unwrap(),
            None
        );
        assert!(state.folder_grants.lock().is_empty());
    }
}
