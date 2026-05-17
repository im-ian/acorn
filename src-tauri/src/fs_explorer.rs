use std::cmp::Ordering;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use git2::{Repository, Status, StatusOptions};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const EVENT_FS_CHANGED: &str = "acorn:fs-changed";

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: i64,
    /// True when `respect_gitignore` was true and the entry is ignored by
    /// the aggregated gitignore. We still surface it so the frontend can
    /// decide whether to dim it; default to hiding ignored entries.
    pub gitignored: bool,
}

#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

impl WatcherState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
struct FsChangePayload {
    paths: Vec<String>,
}

fn canonical(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if p.as_os_str().is_empty() {
        return Err(AppError::InvalidPath("empty path".into()));
    }
    // For browsing we do not require the path to exist on create operations;
    // canonicalize only when the path already exists.
    if p.exists() {
        p.canonicalize().map_err(AppError::from)
    } else {
        Ok(p)
    }
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cur: Option<&Path> = Some(start);
    while let Some(p) = cur {
        let dot_git = p.join(".git");
        if dot_git.exists() {
            return Some(p.to_path_buf());
        }
        cur = p.parent();
    }
    None
}

fn build_gitignore(repo_root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(repo_root);
    let root_ignore = repo_root.join(".gitignore");
    if root_ignore.exists() {
        let _ = b.add(root_ignore);
    }
    let exclude = repo_root.join(".git").join("info").join("exclude");
    if exclude.exists() {
        let _ = b.add(exclude);
    }
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

#[derive(Debug, Clone, Serialize)]
pub struct ListResult {
    pub entries: Vec<FileEntry>,
    pub repo_root: Option<String>,
}

#[tauri::command]
pub fn fs_list_dir(
    path: String,
    show_hidden: bool,
    respect_gitignore: bool,
) -> AppResult<ListResult> {
    let dir = canonical(&path)?;
    if !dir.is_dir() {
        return Err(AppError::InvalidPath(format!("not a directory: {path}")));
    }
    let repo_root = find_repo_root(&dir);
    let gi = repo_root.as_deref().map(build_gitignore);

    let mut entries: Vec<FileEntry> = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let item = item?;
        let p = item.path();
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !show_hidden && is_hidden(&name) {
            continue;
        }
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        // `DirEntry::metadata` follows symlinks on macOS, so check the link
        // type via `symlink_metadata` to distinguish links from their targets.
        let is_symlink = std::fs::symlink_metadata(&p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        let is_dir = meta.is_dir();
        let gitignored = match (respect_gitignore, gi.as_ref(), repo_root.as_deref()) {
            (true, Some(g), Some(_)) => g.matched(&p, is_dir).is_ignore(),
            _ => false,
        };
        if respect_gitignore && gitignored {
            continue;
        }
        let size = if is_dir { 0 } else { meta.len() };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(FileEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            size,
            modified_ms,
            gitignored,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(ListResult {
        entries,
        repo_root: repo_root.map(|p| p.to_string_lossy().into_owned()),
    })
}

fn reject_dangerous(p: &Path) -> AppResult<()> {
    // Require absolute paths so relative arguments cannot resolve against
    // the process CWD (e.g., the app bundle) and overwrite something
    // outside the user's intended folder.
    if !p.is_absolute() {
        return Err(AppError::InvalidPath("absolute path required".into()));
    }
    for c in p.components() {
        if matches!(c, Component::ParentDir) {
            return Err(AppError::InvalidPath(
                "path traversal segment (`..`) is not allowed".into(),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> AppResult<()> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    reject_dangerous(&from_p)?;
    reject_dangerous(&to_p)?;
    if !from_p.exists() {
        return Err(AppError::InvalidPath(format!("source missing: {from}")));
    }
    if to_p.exists() {
        return Err(AppError::InvalidPath(format!("destination exists: {to}")));
    }
    std::fs::rename(&from_p, &to_p)?;
    Ok(())
}

#[tauri::command]
pub fn fs_trash(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    trash::delete(&p).map_err(|e| AppError::Other(format!("trash failed: {e}")))?;
    Ok(())
}

#[tauri::command]
pub fn fs_reveal(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("open failed: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(p.parent().unwrap_or(&p))
            .spawn()
            .map_err(|e| AppError::Other(format!("xdg-open failed: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("explorer failed: {e}")))?;
    }
    Ok(())
}

/// Open a file with the OS's default registered application. Used as a
/// fallback when the user has not set `$EDITOR` in their shell rc — the
/// PTY path otherwise blows up with `permission denied` because the
/// shell tries to execute the empty command followed by the file.
#[tauri::command]
pub fn fs_open_default(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.exists() {
        return Err(AppError::InvalidPath(format!("missing: {path}")));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("open failed: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("xdg-open failed: {e}")))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", ""])
            .arg(&p)
            .spawn()
            .map_err(|e| AppError::Other(format!("start failed: {e}")))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStatusEntry {
    pub kind: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Per-path git status, mapped to a small set of buckets the frontend
/// uses to pick a color. Diff line counts are intentionally omitted here
/// because computing them requires extra per-path IO/diff work.
///
/// Paths are absolute strings keyed by full path so the FileExplorer's
/// flat lookup matches its entry paths.
#[tauri::command]
pub fn fs_git_status(repo_root: String) -> AppResult<HashMap<String, GitStatusEntry>> {
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(AppError::InvalidPath(format!("missing: {repo_root}")));
    }
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        // Not a git repo — return empty map, frontend treats this as "no
        // status colors to apply".
        Err(_) => return Ok(HashMap::new()),
    };
    let workdir = match repo.workdir() {
        Some(p) => p.to_path_buf(),
        None => return Ok(HashMap::new()),
    };
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status failed: {e}")))?;

    let mut out: HashMap<String, GitStatusEntry> = HashMap::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let Some(rel) = entry.path() else { continue };
        let abs = workdir.join(rel);
        let abs_str = abs.to_string_lossy().into_owned();
        let s = entry.status();
        let kind = classify_status(s);
        out.insert(
            abs_str,
            GitStatusEntry {
                kind: kind.into(),
                additions: 0,
                deletions: 0,
            },
        );
    }
    Ok(out)
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitDiffStatsRequest {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitDiffStatsEntry {
    pub additions: u32,
    pub deletions: u32,
}

#[tauri::command]
pub fn fs_git_diff_stats(
    repo_root: String,
    entries: Vec<GitDiffStatsRequest>,
) -> AppResult<HashMap<String, GitDiffStatsEntry>> {
    let root = PathBuf::from(&repo_root);
    if !root.exists() {
        return Err(AppError::InvalidPath(format!("missing: {repo_root}")));
    }
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(HashMap::new()),
    };
    let workdir = match repo.workdir() {
        Some(p) => p.to_path_buf(),
        None => return Ok(HashMap::new()),
    };

    let mut out = HashMap::with_capacity(entries.len());
    for entry in entries {
        let path = PathBuf::from(&entry.path);
        reject_dangerous(&path)?;
        let Ok(rel_path) = path.strip_prefix(&workdir) else {
            continue;
        };
        let rel = rel_path.to_string_lossy();
        let (additions, deletions) = file_diff_stats(&repo, &workdir, &rel, &entry.kind);
        out.insert(
            path.to_string_lossy().into_owned(),
            GitDiffStatsEntry {
                additions,
                deletions,
            },
        );
    }
    Ok(out)
}

/// Compute additions/deletions for a single path against HEAD. For
/// untracked files we count line count as additions; for deleted files
/// the count comes from the HEAD blob.
fn file_diff_stats(
    repo: &Repository,
    workdir: &Path,
    rel: &str,
    kind: &str,
) -> (u32, u32) {
    if kind == "added" {
        // Untracked or freshly-added file. Count file lines as additions.
        let abs = workdir.join(rel);
        if let Ok(bytes) = std::fs::read(&abs) {
            let lines = count_lines(&bytes);
            return (lines, 0);
        }
        return (0, 0);
    }
    if kind == "deleted" {
        // Read HEAD blob to know the original line count.
        if let Ok(head) = repo.head() {
            if let Ok(commit) = head.peel_to_commit() {
                if let Ok(tree) = commit.tree() {
                    if let Ok(entry) = tree.get_path(Path::new(rel)) {
                        if let Ok(obj) = entry.to_object(repo) {
                            if let Some(blob) = obj.as_blob() {
                                return (0, count_lines(blob.content()));
                            }
                        }
                    }
                }
            }
        }
        return (0, 0);
    }
    // modified / renamed / conflicted — run a diff vs HEAD scoped to
    // this single path so we get the patch stats directly.
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(rel)
        .include_untracked(true)
        .recurse_untracked_dirs(false);
    let tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());
    let diff = repo.diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut opts));
    if let Ok(d) = diff {
        if let Ok(stats) = d.stats() {
            return (stats.insertions() as u32, stats.deletions() as u32);
        }
    }
    (0, 0)
}

fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let mut n = bytes.iter().filter(|&&b| b == b'\n').count() as u32;
    if bytes.last() != Some(&b'\n') {
        n += 1;
    }
    n
}

fn classify_status(s: Status) -> &'static str {
    if s.is_conflicted() {
        return "conflicted";
    }
    if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        return "deleted";
    }
    if s.intersects(Status::INDEX_NEW | Status::WT_NEW) {
        return "added";
    }
    if s.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        return "renamed";
    }
    if s.intersects(
        Status::INDEX_MODIFIED | Status::WT_MODIFIED | Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE,
    ) {
        return "modified";
    }
    "clean"
}

/// Read a file's contents as UTF-8 for the readonly code viewer.
/// Caps at 2 MB so a stray `git clone` of an LFS pointer or a giant
/// log file does not lock up the webview. Detects binary content by
/// the presence of a NUL byte in the first 4 KB and rejects up front.
#[derive(Debug, Clone, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

const VIEWER_MAX_BYTES: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub fn fs_read_file(path: String) -> AppResult<ReadFileResult> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if !p.is_file() {
        return Err(AppError::InvalidPath(format!("not a file: {path}")));
    }
    let meta = std::fs::metadata(&p)?;
    let size = meta.len();
    let mut probe = vec![0u8; 4096.min(size as usize)];
    use std::io::Read;
    let mut file = std::fs::File::open(&p)?;
    let probe_n = file.read(&mut probe)?;
    if probe[..probe_n].contains(&0) {
        return Ok(ReadFileResult {
            content: String::new(),
            size,
            truncated: false,
            binary: true,
        });
    }
    let truncated = size > VIEWER_MAX_BYTES;
    let to_read = if truncated { VIEWER_MAX_BYTES } else { size };
    let mut buf = Vec::with_capacity(to_read as usize);
    let file = std::fs::File::open(&p)?;
    let mut take = file.take(to_read);
    take.read_to_end(&mut buf)?;
    let content = String::from_utf8_lossy(&buf).into_owned();
    Ok(ReadFileResult {
        content,
        size,
        truncated,
        binary: false,
    })
}

/// Per-line change marker against HEAD for the file at `path`. Frontend
/// uses this to paint a VSCode-style gutter bar next to changed lines
/// when the readonly viewer is in view mode. `1`-indexed line numbers.
#[derive(Debug, Clone, Serialize)]
pub struct LineDiffEntry {
    pub line: u32,
    pub kind: String,
}

#[tauri::command]
pub fn fs_git_diff_lines(path: String) -> AppResult<Vec<LineDiffEntry>> {
    let target = PathBuf::from(&path);
    reject_dangerous(&target)?;
    if !target.is_file() {
        return Ok(Vec::new());
    }
    let repo = match Repository::discover(&target) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    let workdir = match repo.workdir() {
        Some(p) => p.to_path_buf(),
        None => return Ok(Vec::new()),
    };
    let rel = match target.strip_prefix(&workdir) {
        Ok(r) => r.to_string_lossy().into_owned(),
        Err(_) => return Ok(Vec::new()),
    };

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&rel)
        .context_lines(0)
        .include_untracked(true);
    let tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());
    let diff = match repo.diff_tree_to_workdir_with_index(tree.as_ref(), Some(&mut opts)) {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out: Vec<LineDiffEntry> = Vec::new();
    let mut adds: Vec<u32> = Vec::new();
    let mut dels: Vec<u32> = Vec::new();
    let mut current_marker: Option<u32> = None;
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' => {
                if let Some(n) = line.new_lineno() {
                    adds.push(n);
                }
            }
            '-' => {
                if let Some(n) = line.old_lineno() {
                    dels.push(n);
                }
                // Track the new-side anchor for "modified" classification.
                if current_marker.is_none() {
                    current_marker = line.new_lineno();
                }
            }
            _ => {
                current_marker = None;
            }
        }
        true
    })
    .ok();

    // Classify: a deleted-only hunk shows as a "deleted" anchor on the
    // line immediately AFTER the deletion; an added line that follows
    // a deletion in the same hunk shows as "modified"; pure additions
    // show as "added".
    let del_set: std::collections::HashSet<u32> = dels.iter().copied().collect();
    let add_set: std::collections::HashSet<u32> = adds.iter().copied().collect();
    for n in adds.iter().copied() {
        // Heuristic: if the prior new-line was a deletion anchor or a
        // contiguous addition started at n, mark as modified vs added.
        // We classify all adds as `added` here; the frontend collapses
        // the visual to a single bar so the distinction is cosmetic.
        let kind = if del_set.contains(&n) {
            "modified"
        } else {
            "added"
        };
        out.push(LineDiffEntry {
            line: n,
            kind: kind.into(),
        });
    }
    // Surface pure deletions as a marker on the next surviving line so
    // the user knows something was removed at that spot. Use min(new
    // lineno) recorded next to the deletion when available.
    if adds.is_empty() && !dels.is_empty() {
        out.push(LineDiffEntry {
            line: 1,
            kind: "deleted".into(),
        });
    }
    let _ = add_set; // silence: kept for future "modified vs added" refinement
    Ok(out)
}

/// Return the current branch name (or short HEAD oid when detached) of
/// the repo enclosing `repo_root`. Empty string when the path is not a
/// git repo — frontend then hides the branch chip.
#[tauri::command]
pub fn fs_git_branch(repo_root: String) -> AppResult<String> {
    let root = PathBuf::from(&repo_root);
    let repo = match Repository::discover(&root) {
        Ok(r) => r,
        Err(_) => return Ok(String::new()),
    };
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(String::new()),
    };
    if head.is_branch() {
        if let Some(name) = head.shorthand() {
            return Ok(name.to_string());
        }
    }
    if let Some(oid) = head.target() {
        let short = oid.to_string();
        return Ok(short.chars().take(7).collect());
    }
    Ok(String::new())
}

/// Return the cached `$EDITOR` value pulled from the user's shell rc.
/// Empty string when unset — frontend uses that to decide between the
/// PTY editor path and the OS-default opener.
#[tauri::command]
pub fn fs_shell_editor() -> String {
    crate::shell_env::resolve()
        .get("EDITOR")
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub fn fs_watch_set_root<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: Option<String>,
) -> AppResult<()> {
    let mut guard = state.fs_watcher.inner.lock();
    if let Some(p) = path.as_deref() {
        let root = canonical(p)?;
        if !root.is_dir() {
            return Err(AppError::InvalidPath(format!("not a directory: {p}")));
        }
        if let Some(existing) = guard.as_ref() {
            if existing.root == root {
                return Ok(());
            }
        }
        let app_for_cb = app.clone();
        let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
            handle_watch_event(&app_for_cb, res);
        })
        .map_err(|e| AppError::Other(format!("notify init failed: {e}")))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| AppError::Other(format!("notify watch failed: {e}")))?;
        *guard = Some(WatcherHandle {
            _watcher: watcher,
            root,
        });
    } else {
        *guard = None;
    }
    Ok(())
}

fn handle_watch_event<R: Runtime>(app: &AppHandle<R>, res: notify::Result<Event>) {
    let event = match res {
        Ok(e) => e,
        Err(err) => {
            tracing::debug!(error = %err, "fs watch error");
            return;
        }
    };
    if !matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    ) {
        return;
    }
    let paths: Vec<String> = event
        .paths
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }
    if let Err(e) = app.emit(EVENT_FS_CHANGED, FsChangePayload { paths }) {
        tracing::warn!(error = %e, "fs-changed emit failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn lists_directory_dirs_first_then_alpha() {
        let d = tmpdir();
        fs::write(d.path().join("zebra.txt"), b"z").unwrap();
        fs::write(d.path().join("apple.txt"), b"a").unwrap();
        fs::create_dir(d.path().join("middle")).unwrap();
        fs::create_dir(d.path().join("Alpha")).unwrap();

        let res = fs_list_dir(d.path().to_string_lossy().into_owned(), false, false).unwrap();
        let names: Vec<_> = res.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["Alpha", "middle", "apple.txt", "zebra.txt"]);
    }

    #[test]
    fn hides_dotfiles_by_default() {
        let d = tmpdir();
        fs::write(d.path().join(".env"), b"").unwrap();
        fs::write(d.path().join("visible.txt"), b"").unwrap();

        let hidden_off =
            fs_list_dir(d.path().to_string_lossy().into_owned(), false, false).unwrap();
        assert_eq!(hidden_off.entries.len(), 1);
        let hidden_on = fs_list_dir(d.path().to_string_lossy().into_owned(), true, false).unwrap();
        assert_eq!(hidden_on.entries.len(), 2);
    }

    #[test]
    fn respects_gitignore_when_repo_root_present() {
        let d = tmpdir();
        fs::create_dir(d.path().join(".git")).unwrap();
        fs::write(d.path().join(".gitignore"), b"build/\nsecret.txt\n").unwrap();
        fs::create_dir(d.path().join("build")).unwrap();
        fs::write(d.path().join("secret.txt"), b"").unwrap();
        fs::write(d.path().join("keep.txt"), b"").unwrap();

        let on = fs_list_dir(d.path().to_string_lossy().into_owned(), false, true).unwrap();
        let names: Vec<_> = on.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["keep.txt"]);

        let off = fs_list_dir(d.path().to_string_lossy().into_owned(), false, false).unwrap();
        let off_names: Vec<_> = off.entries.iter().map(|e| e.name.clone()).collect();
        assert_eq!(off_names, vec!["build", "keep.txt", "secret.txt"]);
    }

    #[test]
    fn rename_rejects_traversal_segments() {
        let res = fs_rename("/tmp/../etc/evil".to_string(), "/tmp/x".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn rename_file_roundtrip() {
        let d = tmpdir();
        let a = d.path().join("a.txt");
        let b = d.path().join("b.txt");
        std::fs::write(&a, b"hi").unwrap();
        fs_rename(
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(!a.exists());
        assert!(b.exists());
    }
}
