import type { Session } from "./types";
import type { ProjectFoldersByRepo } from "./projectFolders";

export function hasRecordedWorktree(session: Session): boolean {
  return session.isolated || session.in_worktree;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function sameWorkspacePath(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

export function isSessionInWorktreeWorkspace(
  session: Session,
  foldersByRepo: ProjectFoldersByRepo,
): boolean {
  return (foldersByRepo[session.repo_path] ?? []).some(
    (folder) =>
      !sameWorkspacePath(folder.cwdPath, folder.repoPath) &&
      sameWorkspacePath(folder.cwdPath, session.worktree_path),
  );
}

export function canDeleteSessionWorktree(
  session: Session,
  foldersByRepo: ProjectFoldersByRepo,
): boolean {
  return (
    hasRecordedWorktree(session) &&
    !isSessionInWorktreeWorkspace(session, foldersByRepo)
  );
}

export function shouldAutoDeleteSessionWorktree(
  session: Session,
  foldersByRepo: ProjectFoldersByRepo,
): boolean {
  return session.isolated && canDeleteSessionWorktree(session, foldersByRepo);
}
