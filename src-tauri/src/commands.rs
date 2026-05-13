use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
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
use crate::session::{Project, Session, SessionKind, SessionStatus};
use crate::session_status;
use crate::state::AppState;
use crate::todos::{self, TodoItem};
use crate::worktree;

use serde::Serialize;

#[derive(Serialize)]
pub struct AcornIpcStatus {
    /// Filesystem path to the `acorn-ipc` binary that ships next to the
    /// running app. Empty when we couldn't resolve `current_exe` — should
    /// never happen in a packaged build but is handled gracefully for dev.
    pub bundled_path: String,
    /// True when the bundled binary actually exists at `bundled_path`. False
    /// in dev mode before `cargo build --bin acorn-ipc` has run.
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
    let socket_path = crate::ipc::socket_path::resolve().unwrap_or_default();
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

/// Stop the running IPC listener (if any) and spawn a fresh one. Used by
/// the Settings → Control sessions "Restart" button when the socket has
/// gone stale (e.g. socket file removed under the app's feet). The signal
/// → poll → exit cycle takes up to `ACCEPT_POLL_INTERVAL_MS`; we wait
/// twice that before rebinding so the previous listener has dropped its
/// file descriptor.
#[tauri::command]
pub fn ipc_restart<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> Result<(), String> {
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
    state
        .sessions
        .list()
        .into_iter()
        .map(|mut s| {
            if let Ok(branch) = worktree::current_branch(&s.worktree_path) {
                s.branch = branch;
            }
            s
        })
        .collect()
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
    kind: Option<SessionKind>,
) -> AppResult<Session> {
    let repo = PathBuf::from(&repo_path);
    if !repo.exists() {
        return Err(AppError::InvalidPath(repo_path));
    }

    let isolated = isolated.unwrap_or(false);
    let worktree_path = if isolated {
        let base = sanitize_worktree_name(&name);
        let (_safe_name, path) = create_unique_worktree(&repo, &base)?;
        path
    } else {
        repo.clone()
    };
    let branch = worktree::current_branch(&worktree_path).unwrap_or_else(|_| "HEAD".to_string());
    let session = Session::new(
        name,
        repo.clone(),
        worktree_path,
        branch,
        isolated,
        kind.unwrap_or_default(),
    );
    let inserted = state.sessions.insert(session);
    state.projects.ensure(repo.clone(), project_basename(&repo));
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
    let project = state.projects.ensure(path.clone(), project_basename(&path));
    persist(&state);
    Ok(project)
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
    Ok(state.sessions.list())
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
pub fn rename_session(state: State<'_, AppState>, id: String, name: String) -> AppResult<Session> {
    let id = Uuid::parse_str(&id).map_err(|e| AppError::Other(e.to_string()))?;
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Other("name must not be empty".to_string()));
    }
    let updated = state.sessions.rename(&id, trimmed)?;
    persist(&state);
    Ok(updated)
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
    if !path.exists() {
        return Err(AppError::InvalidPath(path.display().to_string()));
    }
    let updated = state.sessions.update_worktree_path(&id, path)?;
    persist(&state);
    Ok(updated)
}

#[derive(Serialize, Default)]
pub struct AgentDetection {
    /// Parent claude session id when a claude transcript is present at
    /// `~/.claude/projects/<slug>/<session-id>.jsonl`. Today this equals the
    /// Acorn session UUID (claude shim runs `--session-id $ACORN_RESUME_TOKEN`
    /// = Acorn UUID), so the parent id we pass to `claude --resume` is just
    /// the Acorn session id. Kept as a separate field so the contract stays
    /// stable if the shim ever stops reusing the Acorn UUID.
    pub claude: Option<String>,
    /// Codex session UUID captured by the codex shim in
    /// `<state_dir>/codex.id` after the first zero-arg `codex` run.
    pub codex: Option<String>,
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
#[tauri::command]
pub fn prepare_claude_fork(
    parent_uuid: String,
    new_cwd: String,
) -> AppResult<()> {
    let home = directories::UserDirs::new()
        .map(|d| d.home_dir().to_path_buf())
        .ok_or_else(|| AppError::Other("no home dir".into()))?;
    let projects_root = home.join(".claude").join("projects");
    let filename = format!("{parent_uuid}.jsonl");

    // The parent transcript can live under any number of project
    // slugs depending on where the agent was originally launched, so
    // walk the projects dir for the first matching filename instead of
    // recomputing the parent slug from a cwd the caller may not have.
    let mut src: Option<PathBuf> = None;
    if let Ok(entries) = std::fs::read_dir(&projects_root) {
        for slug in entries.flatten() {
            let candidate = slug.path().join(&filename);
            if candidate.is_file() {
                src = Some(candidate);
                break;
            }
        }
    }
    let Some(src) = src else {
        return Err(AppError::Other(format!(
            "parent transcript {parent_uuid} not found under {}",
            projects_root.display()
        )));
    };

    let dst_slug = claude_slug_for_cwd(&new_cwd);
    let dst_dir = projects_root.join(dst_slug);
    std::fs::create_dir_all(&dst_dir)?;
    let dst = dst_dir.join(&filename);
    if !dst.exists() {
        std::fs::copy(&src, &dst)
            .map_err(|e| AppError::Other(format!("copy transcript: {e}")))?;
    }
    Ok(())
}

fn claude_slug_for_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_start_matches('/');
    let mut slug = String::with_capacity(cwd.len() + 1);
    slug.push('-');
    for ch in trimmed.chars() {
        if ch == '/' || ch == '.' {
            slug.push('-');
        } else {
            slug.push(ch);
        }
    }
    slug
}

/// Live-process snapshot of which agent transcripts (if any) the user is
/// currently writing inside this Acorn session. Drives the Tab context
/// menu's Fork items — they only appear while the underlying claude /
/// codex process is alive in the session's PTY tree.
///
/// We deliberately re-run the full process scan on every call instead
/// of reading the watcher's cached map. The cache is at most one cycle
/// (~3 s) stale, which races with rapid back-to-back Fork actions: a
/// freshly-forked session's claude process can be live at the moment
/// the user right-clicks but absent from the last cache, or vice-versa.
/// An on-demand scan locks the answer to "what's true right now."
#[tauri::command]
pub fn detect_session_agent(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<AgentDetection> {
    let parsed = parse_id(&session_id)?;
    let mappings = crate::transcript_watcher::collect_live_mappings(&state);
    let mut detection = AgentDetection::default();
    for (sid, kind, uuid) in mappings {
        if sid != parsed {
            continue;
        }
        match kind {
            crate::transcript_watcher::AgentKind::Claude => {
                detection.claude = Some(uuid);
            }
            crate::transcript_watcher::AgentKind::Codex => {
                detection.codex = Some(uuid);
            }
        }
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
) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let cwd = PathBuf::from(cwd);
    if !cwd.exists() {
        return Err(AppError::InvalidPath(cwd.display().to_string()));
    }
    // Either an in-process PTY or a daemon-side stream attachment for
    // this session already exists — caller hit `pty_spawn` twice (e.g.
    // StrictMode double mount), nothing to do.
    if state.pty.contains(&id) || state.stream_registry.contains(&id) {
        return Ok(());
    }
    // Sessions always spawn the user's interactive `$SHELL`.
    let resolved_command = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let resolved_args: Vec<String> = Vec::new();
    // Inject IPC env vars for control sessions so the user's shell (and any
    // agent it launches) can address the running app via the `acorn-ipc`
    // CLI without per-session configuration. Only control sessions get the
    // env; regular sessions stay sandboxed from the IPC surface.
    let mut effective_env = env.unwrap_or_default();
    let mut primed_args = resolved_args;

    // The Acorn session UUID doubles as the resume token. claude's
    // `--session-id` names the JSONL transcript at
    // `~/.claude/projects/<repo-slug>/<id>.jsonl`, and
    // `session_status::detect` looks the file up by Acorn's session
    // id verbatim — minting a separate UUID would break that lookup
    // and leave status detection on the descendant-process fallback.
    // `ACORN_AGENT_STATE_DIR` is the per-session scratch directory
    // the codex shim writes its captured `codex.id` into.
    let resume_token = id.to_string();
    effective_env
        .entry("ACORN_RESUME_TOKEN".to_string())
        .or_insert_with(|| resume_token.clone());
    if let Ok(state_dir) = crate::agent_shim::ensure_session_state_dir(id) {
        effective_env
            .entry("ACORN_AGENT_STATE_DIR".to_string())
            .or_insert_with(|| state_dir.display().to_string());
    } else {
        tracing::warn!(%id, "agent state dir setup failed; codex shim will skip resume tracking");
    }
    if let Ok(shim_dir) = crate::agent_shim::ensure_shim_dir() {
        let existing = effective_env
            .get("PATH")
            .cloned()
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_default();
        effective_env.insert(
            "PATH".to_string(),
            crate::ipc::cli_path::prepend_to_path(&shim_dir, &existing),
        );
    } else {
        tracing::warn!(%id, "agent shim dir setup failed; claude/codex resume helpers will not be active");
    }

    if let Ok(session) = state.sessions.get(&id) {
        if session.kind == SessionKind::Control {
            effective_env
                .entry("ACORN_SESSION_ID".to_string())
                .or_insert_with(|| session.id.to_string());
            let socket = crate::ipc::socket_path::resolve().unwrap_or_default();
            if !socket.as_os_str().is_empty() {
                effective_env
                    .entry("ACORN_IPC_SOCKET".to_string())
                    .or_insert_with(|| socket.display().to_string());
            }
            // Daemon socket for the `acornd` CLI. Coexists with
            // `ACORN_IPC_SOCKET`: scripts that call `acorn-ipc` reach
            // the in-process server, while `acornd <subcommand>`
            // reaches the daemon. The two transports manage different
            // session graphs today (daemon vs in-process); they
            // converge when `pty_spawn` itself routes through the
            // daemon.
            if let Ok(daemon_sock) = crate::daemon::paths::control_socket_path() {
                effective_env
                    .entry("ACORN_DAEMON_SOCKET".to_string())
                    .or_insert_with(|| daemon_sock.display().to_string());
            }
            // Make the bundled `acorn-ipc` AND `acornd` CLIs resolvable
            // from inside this PTY without the user installing a PATH
            // shim. Both binaries ship in the same directory, so a
            // single prepend covers both. Prepending — not replacing —
            // keeps the user's existing PATH intact for every other
            // binary; dedup in `prepend_to_path` prevents the entry
            // from accumulating across reconnects.
            if let Some(bin_dir) = crate::ipc::cli_path::bundled_cli_dir() {
                let existing = effective_env
                    .get("PATH")
                    .cloned()
                    .or_else(|| std::env::var("PATH").ok())
                    .unwrap_or_default();
                effective_env.insert(
                    "PATH".to_string(),
                    crate::ipc::cli_path::prepend_to_path(&bin_dir, &existing),
                );
            }
            // Drop the primer in a worktree-local marker file so whichever
            // agent the user invokes inside the shell can read the IPC
            // protocol. `inject_primer_args` is a no-op while `$SHELL` is
            // an ordinary shell (`AgentFlavor::Unknown`) and only takes
            // effect on the rare configuration where `$SHELL` itself
            // resolves to a recognised agent binary.
            let primer = crate::ipc::primer::primer_for(&session, &socket);
            let flavor = crate::ipc::primer::AgentFlavor::detect(&resolved_command);
            primed_args = crate::ipc::primer::inject_primer_args(
                flavor,
                primed_args,
                &primer,
            );
            write_control_marker(&cwd, &primer);
        }
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
        ) {
            Ok(()) => return Ok(()),
            Err(err) => {
                tracing::warn!(%id, error = %err, "daemon spawn failed; falling back to in-process PTY");
            }
        }
    }

    state.pty.spawn(
        app,
        id,
        cwd,
        resolved_command,
        primed_args,
        effective_env,
        cols.unwrap_or(0),
        rows.unwrap_or(0),
    )
}

/// Route a `pty_spawn` through the daemon. Three cases:
///
/// 1. **Already attached** — short-circuit; redundant guard catches
///    races where two callers hit this helper concurrently.
/// 2. **Daemon already has an alive session** under this UUID (Acorn
///    just restarted) — skip spawn, open a stream attachment with
///    scrollback replay so the user sees the daemon's last screen.
/// 3. **No live session** — fresh daemon spawn, attach the stream,
///    persist `daemon_session_id` so the next restart hits case 2.
fn spawn_via_daemon<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    id: uuid::Uuid,
    cwd: &std::path::Path,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let bridge = &state.daemon_bridge;
    let registry = state.stream_registry.clone();

    if registry.contains(&id) {
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
    let agent_kind: Option<crate::daemon::protocol::AgentKind> = None;

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
        crate::daemon_stream::attach(app.clone(), registry.clone(), id, pid, true)
            .map_err(|e| format!("daemon stream attach failed: {e}"))?;
        return Ok(());
    }

    let kind = match session_kind {
        SessionKind::Regular => crate::daemon::protocol::SessionKind::Regular,
        SessionKind::Control => crate::daemon::protocol::SessionKind::Control,
    };

    let outcome = bridge
        .spawn(
            id,
            id.to_string(),
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

    crate::daemon_stream::attach(app.clone(), registry, id, outcome.pid, true)
        .map_err(|e| format!("daemon stream attach failed: {e}"))
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
    if let Err(err) = std::fs::write(&path, body) {
        tracing::warn!(
            path = %path.display(),
            error = %err,
            "failed to write .acorn-control.md marker",
        );
    }
}

#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, session_id: String, data: String) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    let bytes = decode_b64(&data)?;
    // Daemon-managed sessions route stdin through the control socket.
    // Keystrokes are small; one RPC round-trip per keystroke is well
    // under the typing-feedback threshold and avoids managing a second
    // socket on the app side just for input.
    if state.stream_registry.contains(&id) {
        return state
            .daemon_bridge
            .send_input(id, &bytes)
            .map_err(|e| AppError::Pty(e.to_string()));
    }
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
    if state.stream_registry.contains(&id) {
        return state
            .daemon_bridge
            .resize(id, cols, rows)
            .map_err(|e| AppError::Pty(e.to_string()));
    }
    state.pty.resize(&id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    if state.stream_registry.contains(&id) {
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
        state.stream_registry.drop_attachment(&id);
        return result;
    }
    state.pty.kill(&id)
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
pub fn pty_cwd(state: State<'_, AppState>, session_id: String) -> AppResult<Option<String>> {
    let id = parse_id(&session_id)?;
    let Some(root_pid) = state.pty.child_pid(&id) else {
        return Ok(None);
    };

    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
    );

    Ok(deepest_descendant_cwd(&sys, Pid::from_u32(root_pid)))
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
pub fn pty_repo_root(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<String>> {
    let Some(cwd) = pty_cwd(state, session_id)? else {
        return Ok(None);
    };
    let Ok(repo) = git2::Repository::discover(&cwd) else {
        return Ok(None);
    };
    Ok(repo
        .workdir()
        .map(|p| p.to_string_lossy().into_owned()))
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
        let Some(proc) = sys.process(pid) else { continue };
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
    scrollback::orphan_size_bytes(live_ids)
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
    scrollback::prune_orphans(live_ids)
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
    /// Current branch read live from the session's worktree on each poll.
    /// `None` when the worktree has no readable HEAD (e.g. detached, or
    /// path was deleted out from under acorn). Lets the frontend reflect
    /// `git checkout` performed inside the session without requiring a
    /// manual refresh.
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn detect_session_statuses(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<SessionStatusEntry>> {
    // One process-table snapshot covers every session in this poll. cwd is
    // refreshed because the live PTY descendant cwd drives branch detection
    // — a non-isolated session whose terminal `cd`'d into a git worktree
    // (or whose Claude Code invocation used `-w` to spawn one) has a HEAD
    // distinct from the recorded `worktree_path` (which is the project
    // root). Without this, the StatusBar/Sidebar branch stays pinned to the
    // project root's branch regardless of `git checkout` performed inside
    // the PTY.
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
    );
    let children = build_children_map(&sys);

    Ok(ids
        .into_iter()
        .map(|id| {
            // Hand the detector the in-memory previous status so it can
            // preserve a live session's classification when the tail buffer
            // happens to land on a run of meta-only lines (see
            // `session_status::detect` for the full rationale).
            let parsed_id = Uuid::parse_str(&id).ok();
            let session = parsed_id.and_then(|uuid| state.sessions.get(&uuid).ok());
            let previous = session
                .as_ref()
                .map(|s| s.status)
                .unwrap_or(SessionStatus::Idle);
            // Routing-aware pid lookup. Daemon-managed sessions live
            // in `stream_registry` (their root pid was captured from
            // the daemon at spawn / attach); legacy in-process sessions
            // live in `state.pty`. Each side drives its own shell-state
            // machine because the sticky NeedsInput deadline is
            // per-attachment, not global.
            let shell_hint = parsed_id.and_then(|uuid| {
                if state.stream_registry.contains(&uuid) {
                    let root = state.stream_registry.pid(&uuid)?;
                    let has_child_now = has_live_descendant(&children, Pid::from_u32(root));
                    state.stream_registry.update_shell_state(&uuid, has_child_now)
                } else {
                    let root = state.pty.child_pid(&uuid)?;
                    let has_child_now = has_live_descendant(&children, Pid::from_u32(root));
                    state.pty.update_shell_state(&uuid, has_child_now)
                }
            });
            let status =
                session_status::detect(&id, previous, shell_hint).unwrap_or(previous);
            // Branch source priority:
            //  1. deepest PTY descendant cwd — reflects `cd` + `git checkout`
            //     performed inside the terminal (and `claude -w` worktrees)
            //  2. recorded session worktree_path — fallback when no live PTY
            //     or descendant cwd lies outside any git repo
            let live_cwd_branch = parsed_id
                .and_then(|uuid| {
                    state
                        .stream_registry
                        .pid(&uuid)
                        .or_else(|| state.pty.child_pid(&uuid))
                })
                .and_then(|pid| deepest_descendant_cwd(&sys, Pid::from_u32(pid)))
                .and_then(|p| worktree::current_branch(std::path::Path::new(&p)).ok());
            let branch = live_cwd_branch.or_else(|| {
                session
                    .as_ref()
                    .and_then(|s| worktree::current_branch(&s.worktree_path).ok())
            });
            // Mirror the detected status into the in-memory store so persisted
            // sessions reflect liveness on next save. Best-effort: ignore errors
            // (e.g. UUID parse failure for a stale id from the frontend).
            if let Some(uuid) = parsed_id {
                let _ = state.sessions.refresh_status(&uuid, status);
            }
            SessionStatusEntry { id, status, branch }
        })
        .collect())
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

/// `true` if any descendant of `root` exists in the children map. The root
/// itself does not count — we only care about commands launched *under* the
/// PTY shell, which is what flips Idle ↔ Running for terminal sessions.
fn has_live_descendant(children: &HashMap<Pid, Vec<Pid>>, root: Pid) -> bool {
    children
        .get(&root)
        .is_some_and(|direct| !direct.is_empty())
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
    query: Option<String>,
) -> AppResult<PullRequestListing> {
    pull_requests::list_pull_requests(
        &PathBuf::from(repo_path),
        state.unwrap_or(PrStateFilter::Open),
        limit.unwrap_or(50),
        query.as_deref().map(str::trim).filter(|s| !s.is_empty()),
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
pub async fn get_pull_request_commit_diff(
    repo_path: String,
    sha: String,
) -> AppResult<DiffPayload> {
    pull_requests::get_pull_request_commit_diff(&PathBuf::from(repo_path), &sha)
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
pub async fn update_pull_request_body(
    repo_path: String,
    number: u64,
    body: String,
) -> AppResult<()> {
    pull_requests::update_pull_request_body(&PathBuf::from(repo_path), number, &body)
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

