use git2::{Repository, WorktreePruneOptions};
use serde::Serialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const ACORN_DIR: &str = ".acorn";
const EXCLUDE_ENTRY: &str = ".acorn/";
const DELETED_WORKTREES_DIR: &str = ".acorn-deleted-worktrees";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovedWorktree {
    pub token: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub git_common_dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProjectWorktreeInfo {
    pub name: String,
    pub path: String,
    pub modified_ms: Option<i64>,
}

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

pub fn project_root_for_path(path: &Path) -> AppResult<PathBuf> {
    if let Ok(repo) = Repository::discover(path) {
        if let Some(workdir) = repo.workdir() {
            return Ok(workdir
                .canonicalize()
                .unwrap_or_else(|_| workdir.to_path_buf()));
        }
    }
    path.canonicalize().map_err(AppError::from)
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

pub fn list_worktree_infos(repo_path: &Path) -> AppResult<Vec<ProjectWorktreeInfo>> {
    let mut infos: Vec<ProjectWorktreeInfo> = list_worktree_paths(repo_path)?
        .into_iter()
        .map(project_worktree_info_from_path)
        .collect();
    infos.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(infos)
}

fn project_worktree_info_from_path(path: PathBuf) -> ProjectWorktreeInfo {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let modified_ms = std::fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(system_time_millis);
    ProjectWorktreeInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        modified_ms,
    }
}

fn system_time_millis(time: SystemTime) -> Option<i64> {
    let millis = time.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

pub fn stage_remove_worktree_at_path(
    repo_path: &Path,
    worktree_path: &Path,
) -> AppResult<Option<RemovedWorktree>> {
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
            if !worktree_path.exists() {
                if has_staged_worktree_backup(worktree_path) {
                    return Ok(None);
                }
                prune_missing_registered_worktree(&wt, worktree_path)?;
                return Ok(None);
            }
            let token = Uuid::new_v4().to_string();
            let backup = removed_worktree_backup_path(worktree_path, &token)?;
            if let Some(parent) = backup.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(worktree_path, &backup)?;
            return Ok(Some(RemovedWorktree {
                token,
                repo_path: repo_path.to_string_lossy().into_owned(),
                worktree_path: worktree_path.to_string_lossy().into_owned(),
                git_common_dir: repo.commondir().to_string_lossy().into_owned(),
            }));
        }
    }

    if is_acorn_managed_worktree_path(repo_path, worktree_path) {
        if worktree_path.exists() && is_linked_worktree_root(worktree_path) {
            std::fs::remove_dir_all(worktree_path)?;
            return Ok(None);
        }
        if !worktree_path.exists() {
            return Ok(None);
        }
    }

    if !worktree_path.exists() {
        return Ok(None);
    }

    Err(AppError::InvalidPath(format!(
        "linked git worktree is not registered: {}",
        worktree_path.display()
    )))
}

#[cfg(test)]
pub fn remove_worktree_at_path(repo_path: &Path, worktree_path: &Path) -> AppResult<()> {
    if let Some(removed) = stage_remove_worktree_at_path(repo_path, worktree_path)? {
        discard_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )?;
    }
    Ok(())
}

pub fn restore_removed_worktree(
    _repo_path: &Path,
    worktree_path: &Path,
    token: &str,
    _git_common_dir: &Path,
) -> AppResult<()> {
    validate_removal_token(token)?;
    let backup = removed_worktree_backup_path(worktree_path, token)?;
    if !backup.exists() {
        return Err(AppError::InvalidPath(format!(
            "removed worktree backup is not available: {}",
            backup.display()
        )));
    }
    if worktree_path.exists() {
        return Err(AppError::InvalidPath(format!(
            "worktree path already exists: {}",
            worktree_path.display()
        )));
    }
    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&backup, worktree_path)?;
    remove_empty_backup_root(worktree_path);
    Ok(())
}

pub fn discard_removed_worktree(
    repo_path: &Path,
    worktree_path: &Path,
    token: &str,
    git_common_dir: &Path,
) -> AppResult<()> {
    validate_removal_token(token)?;
    let backup = removed_worktree_backup_path(worktree_path, token)?;
    if backup.exists() {
        std::fs::remove_dir_all(&backup)?;
    }
    remove_empty_backup_root(worktree_path);
    if worktree_path.exists() {
        return Ok(());
    }
    let repo = match Repository::open(git_common_dir) {
        Ok(repo) => repo,
        Err(_) => ensure_repo(repo_path)?,
    };
    prune_registered_worktree_at_path(&repo, worktree_path)?;
    Ok(())
}

fn prune_registered_worktree_at_path(repo: &Repository, worktree_path: &Path) -> AppResult<bool> {
    let names = repo.worktrees()?;
    for name in names.iter().flatten() {
        let wt = repo.find_worktree(name)?;
        if same_path(wt.path(), worktree_path) {
            prune_missing_registered_worktree(&wt, worktree_path)?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn prune_missing_registered_worktree(wt: &git2::Worktree, worktree_path: &Path) -> AppResult<()> {
    let mut options = WorktreePruneOptions::new();
    if !worktree_path.exists() {
        options.locked(true);
    }
    wt.prune(Some(&mut options))?;
    Ok(())
}

fn removed_worktree_backup_path(worktree_path: &Path, token: &str) -> AppResult<PathBuf> {
    validate_removal_token(token)?;
    let parent = worktree_path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!(
            "worktree path has no parent directory: {}",
            worktree_path.display()
        ))
    })?;
    Ok(parent.join(DELETED_WORKTREES_DIR).join(token))
}

fn validate_removal_token(token: &str) -> AppResult<()> {
    let safe = !token.is_empty()
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if safe {
        return Ok(());
    }
    Err(AppError::InvalidPath(
        "invalid worktree removal token".into(),
    ))
}

fn remove_empty_backup_root(worktree_path: &Path) {
    let Some(parent) = worktree_path.parent() else {
        return;
    };
    let root = parent.join(DELETED_WORKTREES_DIR);
    let _ = std::fs::remove_dir(&root);
}

fn has_staged_worktree_backup(worktree_path: &Path) -> bool {
    let Some(parent) = worktree_path.parent() else {
        return false;
    };
    let root = parent.join(DELETED_WORKTREES_DIR);
    root.read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

pub(crate) fn same_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn is_acorn_managed_worktree_path(repo_path: &Path, worktree_path: &Path) -> bool {
    if worktree_path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return false;
    }
    let root = worktree_root(repo_path);
    worktree_path.parent() == Some(root.as_path()) && worktree_path.file_name().is_some()
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

    fn init_repo_with_tracked_file(path: &Path) -> Repository {
        let repo = Repository::init(path).expect("init repo");
        std::fs::write(path.join("tracked.txt"), "initial").expect("write tracked file");
        let sig = git2::Signature::now("acorn-test", "test@acorn").expect("sig");
        let tree_id = {
            let mut idx = repo.index().expect("index");
            idx.add_path(Path::new("tracked.txt"))
                .expect("add tracked file");
            idx.write_tree().expect("write tree")
        };
        let tree = repo.find_tree(tree_id).expect("find tree");
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .expect("initial commit");
        drop(tree);
        repo
    }

    #[test]
    fn staged_remove_restore_preserves_uncommitted_files() {
        let root = unique_temp_dir("restore-uncommitted");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "feature").expect("create worktree");
        std::fs::write(worktree_path.join("tracked.txt"), "modified").expect("modify tracked file");
        std::fs::write(worktree_path.join("untracked.txt"), "new").expect("write untracked file");

        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        assert!(!worktree_path.exists(), "worktree should move out of place");

        restore_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("restore worktree");

        assert_eq!(
            std::fs::read_to_string(worktree_path.join("tracked.txt")).unwrap(),
            "modified"
        );
        assert_eq!(
            std::fs::read_to_string(worktree_path.join("untracked.txt")).unwrap(),
            "new"
        );
        assert!(is_linked_worktree_root(&worktree_path));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_removed_worktree_prunes_registration() {
        let root = unique_temp_dir("discard");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "discard-me").expect("create worktree");
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        discard_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("discard worktree");

        assert!(!worktree_path.exists());
        assert!(
            !list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "discard should prune the linked worktree registration"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn stage_remove_missing_locked_worktree_prunes_registration() {
        let root = unique_temp_dir("missing-locked");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "locked-missing").expect("create worktree");
        {
            let repo = Repository::open(&root).expect("open repo");
            let wt = repo.find_worktree("locked-missing").expect("find worktree");
            wt.lock(Some("claude agent locked-missing (pid 999999)"))
                .expect("lock worktree");
        }
        std::fs::remove_dir_all(&worktree_path).expect("remove worktree dir");

        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("remove missing locked worktree");

        assert!(removed.is_none());
        assert!(
            !list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "missing locked worktree registration should be pruned"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discard_removed_worktree_prunes_locked_registration() {
        let root = unique_temp_dir("discard-locked");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "discard-locked").expect("create worktree");
        {
            let repo = Repository::open(&root).expect("open repo");
            let wt = repo.find_worktree("discard-locked").expect("find worktree");
            wt.lock(Some("claude agent discard-locked (pid 999999)"))
                .expect("lock worktree");
        }
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        discard_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("discard locked worktree");

        assert!(
            !list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "discard should prune locked linked worktree registration"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn staged_remove_duplicate_call_preserves_registration_for_restore() {
        let root = unique_temp_dir("duplicate-stage");
        let repo = init_repo_with_tracked_file(&root);
        drop(repo);
        let worktree_path = create_worktree(&root, "duplicate").expect("create worktree");
        let removed = stage_remove_worktree_at_path(&root, &worktree_path)
            .expect("stage remove")
            .expect("removal token");

        let second =
            stage_remove_worktree_at_path(&root, &worktree_path).expect("second stage remove");
        assert!(second.is_none());

        restore_removed_worktree(
            Path::new(&removed.repo_path),
            Path::new(&removed.worktree_path),
            &removed.token,
            Path::new(&removed.git_common_dir),
        )
        .expect("restore worktree");

        assert!(
            list_worktree_paths(&root)
                .expect("list worktrees")
                .iter()
                .any(|path| same_path(path, &worktree_path)),
            "duplicate stage should not prune a restorable worktree"
        );

        std::fs::remove_dir_all(&root).ok();
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
    fn project_root_for_path_returns_repo_workdir_from_subdirectory() {
        let root = unique_temp_dir("project-root-subdir");
        Repository::init(&root).expect("init repo");
        let subdir = root.join("packages").join("web");
        std::fs::create_dir_all(&subdir).expect("nested dirs");

        let resolved = project_root_for_path(&subdir).expect("project root");

        assert_eq!(
            resolved.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_root_for_path_falls_back_to_directory_when_not_git() {
        let root = unique_temp_dir("project-root-nongit");

        let resolved = project_root_for_path(&root).expect("canonical directory");

        assert_eq!(
            resolved.canonicalize().unwrap(),
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

    #[test]
    fn list_worktree_infos_includes_name_path_and_mtime() {
        let root = unique_temp_dir("worktree-info");
        let repo = Repository::init(&root).expect("init repo");
        let readme = root.join("README.md");
        std::fs::write(&readme, "# test\n").expect("write readme");
        let mut index = repo.index().expect("repo index");
        index.add_path(Path::new("README.md")).expect("add readme");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let signature = git2::Signature::now("Acorn Test", "acorn@example.com").expect("signature");
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .expect("commit");
        drop(tree);
        drop(repo);

        let path = create_worktree(&root, "feature-alpha").expect("create worktree");
        let infos = list_worktree_infos(&root).expect("list worktree infos");

        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "feature-alpha");
        assert_eq!(
            Path::new(&infos[0].path).canonicalize().unwrap(),
            path.canonicalize().unwrap(),
        );
        assert!(
            infos[0].modified_ms.unwrap_or_default() > 0,
            "worktree mtime should be captured"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_allows_already_missing_path() {
        let root = unique_temp_dir("remove-missing");
        Repository::init(&root).expect("init repo");
        let missing = root.join(".acorn").join("worktrees").join("gone");

        remove_worktree_at_path(&root, &missing).expect("missing worktree removal is idempotent");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_deletes_unregistered_managed_linked_root() {
        let root = unique_temp_dir("remove-stale-linked");
        Repository::init(&root).expect("init repo");
        let stale = root.join(".acorn").join("worktrees").join("stale");
        std::fs::create_dir_all(&stale).expect("create stale worktree dir");
        std::fs::write(stale.join(".git"), "gitdir: ../../.git/worktrees/stale\n")
            .expect("write linked worktree marker");

        remove_worktree_at_path(&root, &stale).expect("remove stale managed linked root");

        assert!(
            !stale.exists(),
            "stale linked worktree dir should be removed"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_allows_unregistered_missing_path() {
        let root = unique_temp_dir("remove-missing-unmanaged");
        Repository::init(&root).expect("init repo");
        let missing = root.join("somewhere-else").join("gone");

        remove_worktree_at_path(&root, &missing).expect("missing worktree removal is idempotent");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_worktree_at_path_does_not_delete_managed_traversal_path() {
        let root = unique_temp_dir("remove-traversal");
        Repository::init(&root).expect("init repo");
        let escaped = root.join(".acorn").join("escaped");
        std::fs::create_dir_all(&escaped).expect("create escaped dir");
        std::fs::write(escaped.join(".git"), "gitdir: ../.git/worktrees/escaped\n")
            .expect("write linked marker");
        let traversal = root
            .join(".acorn")
            .join("worktrees")
            .join("..")
            .join("escaped");
        let removed = stage_remove_worktree_at_path(&root, &traversal)
            .expect("traversal path removal should be a no-op");

        assert!(removed.is_none());
        assert!(
            escaped.exists(),
            "stale fallback must not delete paths outside managed worktrees"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
