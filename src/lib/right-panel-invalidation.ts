export interface RightPanelFsInvalidation {
  commits: boolean;
  staged: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSameOrInside(parent: string, child: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
}

function isRepoGitPath(repoPath: string, path: string): boolean {
  const repo = normalizePath(repoPath);
  const normalized = normalizePath(path);
  const gitPath = `${repo}/.git`;
  return normalized === gitPath || normalized.startsWith(`${gitPath}/`);
}

/**
 * Classify local filesystem watcher events for RightPanel refreshes.
 *
 * The current backend event surface is repo-root based. If an event source
 * supplies an out-of-root path for the active repo's external gitdir, treat it
 * conservatively as git metadata; otherwise the slow safety interval catches
 * those linked-worktree gitdir updates.
 */
export function classifyRightPanelFsChange(
  repoPath: string | null,
  paths: ReadonlyArray<string>,
): RightPanelFsInvalidation {
  if (!repoPath || paths.length === 0) {
    return { commits: false, staged: false };
  }

  let commits = false;
  let staged = false;

  for (const path of paths) {
    if (isRepoGitPath(repoPath, path) || !isSameOrInside(repoPath, path)) {
      commits = true;
      staged = true;
      continue;
    }
    if (isSameOrInside(repoPath, path)) {
      staged = true;
    }
  }

  return { commits, staged };
}
