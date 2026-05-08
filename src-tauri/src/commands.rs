use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Runtime, State};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::git_ops::{self, CommitInfo, DiffPayload, StagedFile};
use crate::persistence;
use crate::pull_requests::{
    self, GeneratedCommitMessage, MergeMethod, PrStateFilter, PullRequestDetailListing,
    PullRequestListing,
};
use crate::scrollback;
use crate::session::{Project, Session, SessionStatus};
use crate::session_status;
use crate::state::AppState;
use crate::todos::{self, TodoItem};
use crate::worktree;

fn persist(state: &AppState) {
    if let Err(e) = persistence::save_sessions(&state.sessions.list()) {
        tracing::warn!("failed to persist sessions: {e}");
    }
    if let Err(e) = persistence::save_projects(&state.projects.list()) {
        tracing::warn!("failed to persist projects: {e}");
    }
}

fn project_basename(repo_path: &std::path::Path) -> String {
    repo_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_else(|| repo_path.to_str().unwrap_or("project"))
        .to_string()
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<Session> {
    state.sessions.list()
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

#[derive(serde::Serialize)]
pub struct MemoryUsage {
    /// Total resident set size in bytes — main process plus descendants.
    pub bytes: u64,
    pub processes: Vec<MemoryProcess>,
}

#[tauri::command]
pub async fn get_memory_usage() -> MemoryUsage {
    let mut guard = MEMORY_PROBE.lock().expect("memory probe poisoned");
    let sys = guard.get_or_insert_with(|| {
        System::new_with_specifics(
            RefreshKind::new().with_processes(ProcessRefreshKind::new().with_memory()),
        )
    });
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_memory(),
    );

    let self_pid = Pid::from_u32(std::process::id());
    let mut processes: Vec<MemoryProcess> = Vec::new();
    let mut total: u64 = 0;

    let mut frontier: Vec<(Pid, u32)> = vec![(self_pid, 0)];
    let mut visited: std::collections::HashSet<Pid> = std::collections::HashSet::new();

    while let Some((pid, depth)) = frontier.pop() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(proc) = sys.process(pid) {
            let bytes = proc.memory();
            total = total.saturating_add(bytes);
            processes.push(MemoryProcess {
                pid: pid.as_u32(),
                parent_pid: proc.parent().map(|p| p.as_u32()),
                name: process_display_name(proc),
                command_line: process_command_line(proc),
                bytes,
                depth,
            });
        }
        for (child_pid, child) in sys.processes() {
            if child.parent() == Some(pid) && !visited.contains(child_pid) {
                frontier.push((*child_pid, depth + 1));
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
pub async fn create_session(
    state: State<'_, AppState>,
    name: String,
    repo_path: String,
    isolated: Option<bool>,
) -> AppResult<Session> {
    let repo = PathBuf::from(&repo_path);
    if !repo.exists() {
        return Err(AppError::InvalidPath(repo_path));
    }

    let branch = worktree::current_branch(&repo).unwrap_or_else(|_| "main".to_string());
    let isolated = isolated.unwrap_or(false);
    let worktree_path = if isolated {
        let base = sanitize_worktree_name(&name);
        let (_safe_name, path) = create_unique_worktree(&repo, &base)?;
        path
    } else {
        repo.clone()
    };
    let session = Session::new(name, repo.clone(), worktree_path, branch, isolated);
    let inserted = state.sessions.insert(session);
    state
        .projects
        .ensure(repo.clone(), project_basename(&repo));
    persist(&state);
    Ok(inserted)
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Vec<Project> {
    state.projects.list()
}

#[tauri::command]
pub fn add_project(state: State<'_, AppState>, repo_path: String) -> AppResult<Project> {
    let path = PathBuf::from(&repo_path);
    if !path.exists() {
        return Err(AppError::InvalidPath(repo_path));
    }
    let project = state
        .projects
        .ensure(path.clone(), project_basename(&path));
    persist(&state);
    Ok(project)
}

#[tauri::command]
pub fn reorder_projects(
    state: State<'_, AppState>,
    order: Vec<String>,
) -> AppResult<Vec<Project>> {
    let paths: Vec<PathBuf> = order.into_iter().map(PathBuf::from).collect();
    state.projects.reorder(&paths);
    persist(&state);
    Ok(state.projects.list())
}

#[tauri::command]
pub async fn remove_project(
    state: State<'_, AppState>,
    repo_path: String,
    remove_sessions: Option<bool>,
    remove_worktrees: Option<bool>,
) -> AppResult<()> {
    let path = PathBuf::from(&repo_path);
    let cascade = remove_sessions.unwrap_or(true);
    let drop_worktrees = remove_worktrees.unwrap_or(false);
    if cascade {
        let session_ids: Vec<_> = state
            .sessions
            .list()
            .into_iter()
            .filter(|s| s.repo_path == path)
            .collect();
        for session in session_ids {
            state.pty.kill(&session.id).ok();
            if drop_worktrees && session.isolated {
                let safe_name = sanitize_worktree_name(&session.name);
                worktree::remove_worktree(&session.repo_path, &safe_name).ok();
            }
            state.sessions.remove(&session.id).ok();
        }
    }
    state.projects.remove(&path);
    persist(&state);
    Ok(())
}

#[tauri::command]
pub async fn remove_session(
    state: State<'_, AppState>,
    id: String,
    remove_worktree: Option<bool>,
) -> AppResult<()> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Other(e.to_string()))?;
    let session = state.sessions.get(&id)?;
    state.pty.kill(&id).ok();
    scrollback::delete(&id.to_string()).ok();
    if session.isolated && remove_worktree.unwrap_or(false) {
        let safe_name = sanitize_worktree_name(&session.name);
        worktree::remove_worktree(&session.repo_path, &safe_name).ok();
    }
    state.sessions.remove(&id)?;
    persist(&state);
    Ok(())
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
pub fn rename_session(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Session> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Other(e.to_string()))?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("name must not be empty".to_string()));
    }
    let updated = state.sessions.rename(&id, trimmed)?;
    persist(&state);
    Ok(updated)
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
    let bytes: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
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
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let cwd = PathBuf::from(cwd);
    if !cwd.exists() {
        return Err(AppError::InvalidPath(cwd.display().to_string()));
    }
    if state.pty.contains(&id) {
        return Ok(());
    }
    // An empty/missing command means "use the user's default shell". This is
    // how the frontend signals the "Terminal" startup mode from settings.
    let resolved_command = match command {
        Some(c) if !c.trim().is_empty() => c,
        _ => std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
    };
    state.pty.spawn(
        app,
        id,
        cwd,
        resolved_command,
        args.unwrap_or_default(),
        env.unwrap_or_default(),
        cols.unwrap_or(0),
        rows.unwrap_or(0),
    )
}

#[tauri::command]
pub fn pty_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let bytes = decode_b64(&data)?;
    state.pty.write(&id, &bytes)
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    state.pty.kill(&id)
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
    scrollback::save(&session_id, &data)
}

#[tauri::command]
pub async fn scrollback_load(session_id: String) -> AppResult<Option<String>> {
    scrollback::load(&session_id)
}

#[tauri::command]
pub async fn scrollback_delete(session_id: String) -> AppResult<()> {
    scrollback::delete(&session_id)
}

#[tauri::command]
pub async fn read_session_todos(session_id: String, cwd: String) -> AppResult<Vec<TodoItem>> {
    let cwd = PathBuf::from(cwd);
    todos::read_latest_todos(&session_id, &cwd)
}

#[derive(serde::Serialize)]
pub struct SessionStatusEntry {
    pub id: String,
    pub status: SessionStatus,
}

#[tauri::command]
pub async fn detect_session_statuses(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<SessionStatusEntry>> {
    Ok(ids
        .into_iter()
        .map(|id| {
            let status = session_status::detect(&id).unwrap_or(SessionStatus::Idle);
            // Mirror the detected status into the in-memory store so persisted
            // sessions reflect liveness on next save. Best-effort: ignore errors
            // (e.g. UUID parse failure for a stale id from the frontend).
            if let Ok(uuid) = Uuid::parse_str(&id) {
                let _ = state.sessions.refresh_status(&uuid, status);
            }
            SessionStatusEntry { id, status }
        })
        .collect())
}

#[tauri::command]
pub async fn list_commits(
    repo_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<Vec<CommitInfo>> {
    git_ops::list_commits(
        &PathBuf::from(repo_path),
        offset.unwrap_or(0),
        limit.unwrap_or(50),
    )
}

#[tauri::command]
pub async fn list_staged(repo_path: String) -> AppResult<Vec<StagedFile>> {
    git_ops::list_staged(&PathBuf::from(repo_path))
}

#[tauri::command]
pub async fn commit_diff(repo_path: String, sha: String) -> AppResult<DiffPayload> {
    git_ops::diff_for_commit(&PathBuf::from(repo_path), &sha)
}

#[tauri::command]
pub async fn commit_web_url(repo_path: String, sha: String) -> AppResult<Option<String>> {
    git_ops::web_url_for_commit(&PathBuf::from(repo_path), &sha)
}

/// Check whether a `claude` CLI transcript already exists on disk for the
/// given `session_id`. Used by the frontend to decide between `--session-id`
/// (new conversation) and `--resume` (existing) when (re)spawning claude —
/// claude refuses `--session-id` for an id that already has a transcript.
///
/// Claude's project-directory encoding has changed across versions
/// (underscores were once normalised to dashes; newer versions preserve
/// them; future versions could change again). To avoid getting tripped up
/// by the encoding, we look for `<session-id>.jsonl` under any subdir of
/// `~/.claude/projects/`.
#[tauri::command]
pub async fn claude_session_exists(_cwd: String, session_id: String) -> bool {
    let home = match std::env::var_os("HOME") {
        Some(v) => PathBuf::from(v),
        None => return false,
    };
    let projects = home.join(".claude").join("projects");
    let target = format!("{session_id}.jsonl");
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join(&target).exists() {
            return true;
        }
    }
    false
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
pub async fn open_in_editor(
    command: String,
    args: Vec<String>,
    path: String,
) -> AppResult<()> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other(
            "editor command must not be empty".to_string(),
        ));
    }
    std::process::Command::new(trimmed)
        .args(args)
        .arg(path)
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn editor: {e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn staged_diff(repo_path: String) -> AppResult<DiffPayload> {
    git_ops::diff_staged(&PathBuf::from(repo_path))
}

#[tauri::command]
pub async fn list_pull_requests(
    repo_path: String,
    state: Option<PrStateFilter>,
    limit: Option<u32>,
) -> AppResult<PullRequestListing> {
    pull_requests::list_pull_requests(
        &PathBuf::from(repo_path),
        state.unwrap_or(PrStateFilter::Open),
        limit.unwrap_or(50),
    )
}

#[tauri::command]
pub async fn get_pull_request_detail(
    repo_path: String,
    number: u64,
) -> AppResult<PullRequestDetailListing> {
    pull_requests::get_pull_request_detail(&PathBuf::from(repo_path), number)
}

#[tauri::command]
pub async fn merge_pull_request(
    repo_path: String,
    number: u64,
    method: MergeMethod,
    commit_title: Option<String>,
    commit_body: Option<String>,
) -> AppResult<()> {
    pull_requests::merge_pull_request(
        &PathBuf::from(repo_path),
        number,
        method,
        commit_title,
        commit_body,
    )
}

#[tauri::command]
pub async fn close_pull_request(repo_path: String, number: u64) -> AppResult<()> {
    pull_requests::close_pull_request(&PathBuf::from(repo_path), number)
}

#[tauri::command]
pub async fn generate_pr_commit_message(
    repo_path: String,
    number: u64,
    method: MergeMethod,
    command: String,
    args: Vec<String>,
) -> AppResult<GeneratedCommitMessage> {
    pull_requests::generate_pr_commit_message(
        &PathBuf::from(repo_path),
        number,
        method,
        command,
        args,
    )
}

fn create_unique_worktree(
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

fn sanitize_worktree_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}
