use git2::Repository;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const ACORN_DIR: &str = ".acorn";
const EXCLUDE_ENTRY: &str = ".acorn/";

pub fn ensure_repo(path: &Path) -> AppResult<Repository> {
    Repository::open(path).map_err(AppError::from)
}

pub fn worktree_root(repo_path: &Path) -> PathBuf {
    repo_path.join(ACORN_DIR).join("worktrees")
}

fn ensure_git_excluded(repo_path: &Path) -> AppResult<()> {
    let info_dir = repo_path.join(".git").join("info");
    if !info_dir.exists() {
        std::fs::create_dir_all(&info_dir)?;
    }
    let exclude_path = info_dir.join("exclude");

    let already = std::fs::read_to_string(&exclude_path)
        .map(|s| s.lines().any(|l| l.trim() == EXCLUDE_ENTRY))
        .unwrap_or(false);
    if already {
        return Ok(());
    }

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)?;
    writeln!(f, "{EXCLUDE_ENTRY}")?;
    Ok(())
}

pub fn create_worktree(repo_path: &Path, name: &str) -> AppResult<PathBuf> {
    let repo = ensure_repo(repo_path)?;
    ensure_git_excluded(repo_path).ok();
    let root = worktree_root(repo_path);
    std::fs::create_dir_all(&root)?;
    let target = root.join(name);

    if target.exists() {
        return Err(AppError::InvalidPath(format!(
            "worktree path already exists: {}",
            target.display()
        )));
    }

    repo.worktree(name, &target, None)?;
    Ok(target)
}

pub fn list_worktrees(repo_path: &Path) -> AppResult<Vec<String>> {
    let repo = ensure_repo(repo_path)?;
    let names = repo.worktrees()?;
    Ok(names
        .iter()
        .filter_map(|n| n.map(|s| s.to_string()))
        .collect())
}

/// Like [`list_worktrees`] but returns absolute on-disk paths instead of
/// names. Used by the post-PTY-exit "did claude just create a worktree?"
/// detector — names alone aren't enough because we need to point a session
/// at the new worktree's directory to respawn the child there.
///
/// Note: this only enumerates *linked* worktrees. The main repo checkout is
/// excluded; libgit2's `worktrees()` only reports `.git/worktrees/<name>`
/// entries. That matches what we want — `claude -w` always adds a linked
/// worktree, never modifies the main one.
pub fn list_worktree_paths(repo_path: &Path) -> AppResult<Vec<std::path::PathBuf>> {
    let repo = ensure_repo(repo_path)?;
    let names = repo.worktrees()?;
    let mut paths = Vec::new();
    for name in names.iter().flatten() {
        if let Ok(wt) = repo.find_worktree(name) {
            paths.push(wt.path().to_path_buf());
        }
    }
    Ok(paths)
}

pub fn remove_worktree(repo_path: &Path, name: &str) -> AppResult<()> {
    let repo = ensure_repo(repo_path)?;
    let wt = repo.find_worktree(name)?;
    wt.prune(None)?;
    let path = worktree_root(repo_path).join(name);
    if path.exists() {
        std::fs::remove_dir_all(&path).ok();
    }
    Ok(())
}

pub fn current_branch(repo_path: &Path) -> AppResult<String> {
    let repo = ensure_repo(repo_path)?;
    let head = repo.head()?;
    Ok(head
        .shorthand()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "HEAD".to_string()))
}
