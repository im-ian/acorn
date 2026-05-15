use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
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
pub fn fs_create_file(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if p.exists() {
        return Err(AppError::InvalidPath(format!("already exists: {path}")));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::File::create(&p)?;
    Ok(())
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    reject_dangerous(&p)?;
    if p.exists() {
        return Err(AppError::InvalidPath(format!("already exists: {path}")));
    }
    std::fs::create_dir_all(&p)?;
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
    fn create_file_rejects_traversal() {
        let res = fs_create_file("/tmp/../etc/evil".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn create_and_rename_file_roundtrip() {
        let d = tmpdir();
        let a = d.path().join("a.txt");
        let b = d.path().join("b.txt");
        fs_create_file(a.to_string_lossy().into_owned()).unwrap();
        assert!(a.exists());
        fs_rename(
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(!a.exists());
        assert!(b.exists());
    }
}
