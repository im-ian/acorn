use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System, UpdateKind};
use tauri::{AppHandle, Runtime, State};
use uuid::Uuid;

use crate::agent_resume;
use crate::error::{AppError, AppResult};
use crate::git_ops::{self, CommitInfo, DiffPayload, StagedFile};
use crate::persistence;
use crate::pull_requests::{
    self, GeneratedCommitMessage, MergeMethod, PrStateFilter, PullRequestDetailListing,
    PullRequestListing, WorkflowRunDetailListing, WorkflowRunsListing,
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
        .map(enrich_session)
        .collect()
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
    Ok(enrich_session(inserted))
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
pub fn create_new_project(
    state: State<'_, AppState>,
    parent_path: String,
    name: String,
    ignore_safe_name: Option<bool>,
) -> AppResult<Project> {
    let name = validate_new_project_name(&name, ignore_safe_name.unwrap_or(false))?;
    let parent = PathBuf::from(&parent_path);
    if !parent.is_dir() {
        return Err(AppError::InvalidPath(parent_path));
    }
    let parent = parent.canonicalize()?;
    let target = parent.join(name);
    if target.exists() {
        return Err(AppError::Other(format!(
            "project directory already exists: {}",
            target.display()
        )));
    }

    std::fs::create_dir(&target)?;
    if let Err(err) = git2::Repository::init(&target) {
        let _ = std::fs::remove_dir(&target);
        return Err(AppError::Git(err));
    }

    let project = state.projects.ensure(target.clone(), project_basename(&target));
    persist(&state);
    Ok(project)
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
        return Some("project name is longer than 255 bytes, which common filesystems reject".into());
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
    Ok(state.sessions.list().into_iter().map(enrich_session).collect())
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
    Ok(enrich_session(updated))
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
    Ok(enrich_session(updated))
}

#[derive(Serialize, Default)]
pub struct AgentDetection {
    /// Parent claude session id when a claude transcript is present at
    /// `~/.claude/projects/<slug>/<uuid>.jsonl`. This is whatever UUID
    /// claude minted for its most recent run in this Acorn session —
    /// observed live by `transcript_watcher` and mirrored to
    /// `<state_dir>/claude.id` by the shim. It is *not* guaranteed to
    /// equal the Acorn session UUID.
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
///
/// Both `parent_uuid` and `new_cwd` come from the frontend IPC bridge
/// and are validated below:
///   - `parent_uuid` is checked to be a real UUID before any disk
///     lookup, blocking `..`-style filename injection.
///   - `new_cwd` is slugified and the resulting directory path is
///     verified to canonicalise under `~/.claude/projects/` before any
///     `create_dir_all` runs, so a hostile cwd containing path-escape
///     characters cannot make us materialise directories outside the
///     claude project root.
#[tauri::command]
pub fn prepare_claude_fork(
    parent_uuid: String,
    new_cwd: String,
) -> AppResult<()> {
    if Uuid::parse_str(&parent_uuid).is_err() {
        return Err(AppError::Other(format!(
            "parent_uuid must be a valid UUID, got: {parent_uuid}"
        )));
    }

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

    let dst_slug = crate::claude_util::slug_for_cwd(std::path::Path::new(&new_cwd));
    let dst_dir = projects_root.join(&dst_slug);

    // Path-traversal guard: resolve both ends and verify the destination
    // is a real descendant of `projects_root`. We rely on `parent()`
    // climbing up — `projects_root` exists once `claude` has ever been
    // run, but `dst_dir` may not, so canonicalize the parent and append
    // the slug. A weird `new_cwd` (e.g. containing `..` segments that
    // slugify to bare dashes) shouldn't matter given the per-char filter,
    // but defense in depth is cheap.
    if !dst_slug.starts_with('-')
        || dst_slug.contains('/')
        || dst_slug.contains("..")
    {
        return Err(AppError::Other(format!(
            "refusing to stage transcript under unsafe slug: {dst_slug}"
        )));
    }
    let canonical_root = projects_root.canonicalize().unwrap_or(projects_root.clone());
    let prospective = canonical_root.join(&dst_slug);
    if !prospective.starts_with(&canonical_root) {
        return Err(AppError::Other(format!(
            "destination {} escapes claude projects root {}",
            prospective.display(),
            canonical_root.display()
        )));
    }

    std::fs::create_dir_all(&dst_dir)?;
    let dst = dst_dir.join(&filename);
    if !dst.exists() {
        std::fs::copy(&src, &dst)
            .map_err(|e| AppError::Other(format!("copy transcript: {e}")))?;
    }
    Ok(())
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
    // Sessions always spawn the user's interactive `$SHELL` in login
    // mode so `.zprofile` / `.bash_profile` / `.profile` run — matches
    // macOS Terminal.app / iTerm2 / VS Code so the PTY feels identical
    // to opening the user's native terminal.
    let resolved_command = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let resolved_args: Vec<String> = crate::shell_args::login_args_for(&resolved_command);
    // Inject IPC env vars for control sessions so the user's shell (and any
    // agent it launches) can address the running app via the `acorn-ipc`
    // CLI without per-session configuration. Only control sessions get the
    // env; regular sessions stay sandboxed from the IPC surface.
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

    // OSC 7 emitter — only zsh needs file-side help (bash/fish self-serve).
    // Override `ZDOTDIR` with Acorn's staged dir so our `.zshrc` runs; stash
    // the user's original under `ACORN_USER_ZDOTDIR` so the staged rc can
    // restore it before sourcing their real config. zsh resolves `.zshenv`
    // off `$ZDOTDIR` too, so the staged dir also ships a `.zshenv` that
    // forwards to the user's `$HOME/.zshenv` (rustup, asdf etc. live there
    // and break without it) before pinning `ZDOTDIR` back to ours.
    if let Ok(dir) = crate::shell_init::ensure_shell_init_dir() {
        let user_zdotdir = effective_env
            .get("ZDOTDIR")
            .cloned()
            .or_else(|| std::env::var("ZDOTDIR").ok())
            .unwrap_or_default();
        effective_env.insert("ACORN_USER_ZDOTDIR".to_string(), user_zdotdir);
        effective_env.insert("ZDOTDIR".to_string(), dir.display().to_string());
    } else {
        tracing::warn!(%id, "shell init dir setup failed; OSC 7 cwd tracking will fall back to focus-based refresh");
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
                // Expose the dir so the staged `.zshrc` can re-prepend
                // the IPC CLI entry after the user's rc runs — covers
                // `export PATH="…"` patterns that wipe Acorn's earlier
                // prepend.
                effective_env
                    .entry("ACORN_CLI_DIR".to_string())
                    .or_insert_with(|| bin_dir.display().to_string());
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
    let Some(root_pid) = session_root_pid(&state, &id) else {
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

fn session_root_pid(state: &State<'_, AppState>, id: &Uuid) -> Option<u32> {
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

/// Classify an arbitrary path as "inside a linked git worktree". Walks up
/// via libgit2's `Repository::discover` so subdirectories of a worktree
/// resolve correctly, then checks whether the discovered workdir itself
/// is a linked worktree (`.git` is a file). Used by the xterm OSC 7
/// handler — every emit hands the host a fresh cwd from the shell and
/// the response feeds straight into the worktree-icon condition without
/// touching the system process table.
#[tauri::command]
pub fn is_path_linked_worktree(path: String) -> bool {
    let p = PathBuf::from(&path);
    let Ok(repo) = git2::Repository::discover(&p) else {
        return false;
    };
    repo.workdir()
        .map(worktree::is_linked_worktree_root)
        .unwrap_or(false)
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
pub fn pty_in_worktree_all(state: State<'_, AppState>) -> HashMap<String, bool> {
    let sessions = state.sessions.list();
    let pids: Vec<(Uuid, u32)> = sessions
        .iter()
        .filter_map(|s| session_root_pid(&state, &s.id).map(|pid| (s.id, pid)))
        .collect();
    if pids.is_empty() {
        return HashMap::new();
    }

    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::new()),
    );
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::new().with_cwd(UpdateKind::Always),
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
pub async fn list_workflow_runs(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<WorkflowRunsListing> {
    pull_requests::list_workflow_runs(&PathBuf::from(repo_path), limit.unwrap_or(50))
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

/// Surface the "이전 Claude 대화 있음" candidate for a session — used by
/// the frontend modal that pops on session focus. `None` means there is
/// nothing the user needs to decide about (no claude has run, or the
/// last id is already acknowledged, or claude is currently active in
/// this session's PTY tree and the modal would be redundant).
#[tauri::command]
pub fn get_claude_resume_candidate(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<agent_resume::ResumeCandidate>> {
    let id = parse_id(&session_id)?;
    if agent_is_running_in_session(&state, &id, "claude") {
        return Ok(None);
    }
    agent_resume::claude_resume_candidate(id).map_err(|e| AppError::Other(e.to_string()))
}

/// Codex equivalent of `get_claude_resume_candidate`. Codex auto-resume
/// (which the deleted shim used to perform) is gone; the user now picks
/// the resume target through the modal whenever a fresh codex UUID lands
/// in the per-session state file.
#[tauri::command]
pub fn get_codex_resume_candidate(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Option<agent_resume::ResumeCandidate>> {
    let id = parse_id(&session_id)?;
    if agent_is_running_in_session(&state, &id, "codex") {
        return Ok(None);
    }
    agent_resume::codex_resume_candidate(id).map_err(|e| AppError::Other(e.to_string()))
}

/// Mark the current `claude.id` as seen so the modal does not pop again
/// for the same UUID. Invoked by every modal-button handler (이어하기 /
/// ID 복사 / 취소) — the only thing that revives the candidate is a
/// *new* JSONL appearing under a different UUID.
#[tauri::command]
pub fn acknowledge_claude_resume(session_id: String) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    agent_resume::acknowledge_claude_resume(id).map_err(|e| AppError::Other(e.to_string()))
}

/// Codex equivalent of `acknowledge_claude_resume`.
#[tauri::command]
pub fn acknowledge_codex_resume(session_id: String) -> AppResult<()> {
    let id = parse_id(&session_id)?;
    agent_resume::acknowledge_codex_resume(id).map_err(|e| AppError::Other(e.to_string()))
}

/// `true` when a process matching `basename` is alive anywhere in the
/// session's PTY descendant tree. Cheap process-table scan — fine on
/// the focus path which fires at most a few times per second.
fn agent_is_running_in_session(state: &AppState, session_id: &Uuid, basename: &str) -> bool {
    let Some(root) = state
        .stream_registry
        .pid(session_id)
        .or_else(|| state.pty.child_pid(session_id))
    else {
        return false;
    };
    // Refresh with exe + cmd populated — `ProcessRefreshKind::new()`
    // alone gives an empty config on sysinfo 0.32, so `proc.exe()` and
    // `proc.cmd()` come back as `None` and the basename match always
    // fails. That silently flipped the suppression off and let the
    // modal pop for sessions whose claude was still mid-conversation.
    let refresh = ProcessRefreshKind::new()
        .with_exe(UpdateKind::Always)
        .with_cmd(UpdateKind::Always);
    let mut sys = System::new_with_specifics(RefreshKind::new().with_processes(refresh));
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
/// `proc.name()`, or argv[0] basename. macOS `p_comm` is truncated to
/// 16 chars and can land as a full path *or* a basename depending on
/// how the process was invoked; sysinfo can also surface either form
/// from `exe()` (resolved via `proc_pidinfo`). Checking every channel
/// makes the detection robust against the user's `claude` binary
/// being a Bun-compiled symlink target rather than a script.
fn process_basename_matches(proc: &sysinfo::Process, target: &str) -> bool {
    let basename = |s: &str| s.rsplit('/').next().unwrap_or(s).to_string();
    if let Some(exe) = proc.exe().and_then(|p| p.to_str()) {
        if basename(exe) == target {
            return true;
        }
    }
    if let Some(name) = proc.name().to_str() {
        if name == target || basename(name) == target {
            return true;
        }
    }
    if let Some(first) = proc.cmd().first() {
        let s = first.to_string_lossy();
        if basename(&s) == target {
            return true;
        }
    }
    false
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
    use super::{font_name_from_path, validate_new_project_name};
    use std::path::Path;

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
    fn validate_new_project_name_rejects_long_names_unless_overridden() {
        let long = "a".repeat(256);
        assert!(validate_new_project_name(&long, false).is_err());
        assert_eq!(validate_new_project_name(&long, true).unwrap(), long);
    }

    #[test]
    fn validate_new_project_name_allows_macos_linux_valid_names() {
        assert_eq!(validate_new_project_name("CON", false).unwrap(), "CON");
        assert_eq!(validate_new_project_name("nul.txt", false).unwrap(), "nul.txt");
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
}
