use git2::Repository;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const ACORN_DIR: &str = ".acorn";
const EXCLUDE_ENTRY: &str = ".acorn/";

pub fn ensure_repo(path: &Path) -> AppResult<Repository> {
    // `discover` walks up from `path` to find the nearest `.git`, so callers
    // can pass any subdirectory (e.g. a session's PTY cwd that drifted into
    // `<repo>/src-tauri`) without the open failing. Also handles linked
    // worktrees, where `.git` is a file pointing at the parent repo.
    //
    // If `path` itself no longer exists (typical when a linked worktree was
    // pruned externally — e.g. `claude -w` cleaning up on exit — but the
    // session row in our store still references it), libgit2 refuses to
    // resolve the path and `discover` returns "failed to resolve path".
    // Walk up to the nearest existing ancestor first so the call survives
    // until the persistent reconcile sweep in `list_sessions` rewrites the
    // session's `worktree_path` back to the main repo. Without this layer,
    // any UI poll (`list_commits`, `list_staged`, `diff_*`) racing the
    // sweep still bubbles the raw git error into the right panel.
    let start = walk_to_existing_ancestor(path);
    Repository::discover(&start).map_err(|e| {
        AppError::Other(format!(
            "could not find git repository from '{}': {}",
            path.display(),
            e.message()
        ))
    })
}

fn walk_to_existing_ancestor(path: &Path) -> PathBuf {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => probe = parent.to_path_buf(),
            _ => return path.to_path_buf(),
        }
    }
    probe
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

/// Returns absolute on-disk paths of linked worktrees. Used by the
/// post-PTY-exit "did claude just create a worktree?" detector — names alone
/// aren't enough because we need to point a session at the new worktree's
/// directory to respawn the child there.
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

pub fn remove_worktree_at_path(repo_path: &Path, worktree_path: &Path) -> AppResult<()> {
    if worktree_path.exists() && !is_linked_worktree_root(worktree_path) {
        return Err(AppError::InvalidPath(format!(
            "not a linked git worktree: {}",
            worktree_path.display()
        )));
    }

    let repo = ensure_repo(repo_path)?;
    let names = repo.worktrees()?;
    for name in names.iter().flatten() {
        let wt = repo.find_worktree(name)?;
        if same_path(wt.path(), worktree_path) {
            if worktree_path.exists() {
                std::fs::remove_dir_all(worktree_path).ok();
            }
            wt.prune(None)?;
            return Ok(());
        }
    }

    Err(AppError::InvalidPath(format!(
        "linked git worktree is not registered: {}",
        worktree_path.display()
    )))
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// Returns `true` when `path` is the root of a *linked* git worktree.
/// Linked worktrees mark their root with a `.git` *file* (pointing at the
/// parent repo's `worktrees/<name>` admin dir) instead of a `.git` directory.
/// Cheap: a single stat, no libgit2 open. Used to surface a worktree
/// indicator on session tabs regardless of how the worktree was created
/// (Acorn's "new isolated session" button, `claude -w` adoption, or a
/// repo that was already a worktree when added as a project).
pub fn is_linked_worktree_root(path: &Path) -> bool {
    std::fs::metadata(path.join(".git"))
        .map(|m| m.is_file())
        .unwrap_or(false)
}

pub fn current_branch(repo_path: &Path) -> AppResult<String> {
    let repo = ensure_repo(repo_path)?;
    let head = repo.head()?;
    Ok(head
        .shorthand()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "HEAD".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "acorn-worktree-test-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn ensure_repo_discovers_from_subdirectory() {
        let root = unique_temp_dir("subdir");
        let repo = Repository::init(&root).expect("init repo");
        // Drop borrow before recreating Repository via discover.
        drop(repo);

        let subdir = root.join("nested").join("deeper");
        std::fs::create_dir_all(&subdir).expect("nested dirs");

        let opened = ensure_repo(&subdir).expect("discover from subdir");
        let workdir = opened.workdir().expect("workdir present");
        assert_eq!(
            workdir.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_repo_errors_when_no_repo_in_ancestry() {
        let root = unique_temp_dir("norepo");
        let msg = match ensure_repo(&root) {
            Ok(_) => panic!("expected discover failure outside any repo"),
            Err(e) => e.to_string(),
        };
        assert!(
            msg.contains("could not find git repository from"),
            "unexpected error message: {msg}"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn ensure_repo_walks_up_when_path_missing() {
        let root = unique_temp_dir("pruned");
        Repository::init(&root).expect("init repo");
        // Simulate a pruned linked worktree path that no longer exists, sitting
        // under the still-present repo root.
        let pruned = root.join(".acorn").join("worktrees").join("gone");
        assert!(!pruned.exists());

        let opened = ensure_repo(&pruned).expect("walk up to repo root");
        let workdir = opened.workdir().expect("workdir present");
        assert_eq!(
            workdir.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
