import type { Session } from "./types";
import type { ProjectFoldersByRepo } from "./projectFolders";

export function hasRecordedWorktree(session: Session): boolean {
  return session.isolated || session.in_worktree;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function sameWorkspacePath(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

export function sessionsUsingProjectWorktree(
  sessions: readonly Session[],
  repoPath: string,
  worktreePath: string,
): Session[] {
  return sessions.filter(
    (session) =>
      sameWorkspacePath(session.repo_path, repoPath) &&
      sameWorkspacePath(session.worktree_path, worktreePath),
  );
}

export function sessionsUsingWorktreePath(
  sessions: readonly Session[],
  worktreePath: string,
): Session[] {
  return sessions.filter((session) =>
    sameWorkspacePath(session.worktree_path, worktreePath),
  );
}

export function otherSessionsUsingProjectWorktree(
  sessions: readonly Session[],
  repoPath: string,
  worktreePath: string,
  activeSessionId: string | null,
): Session[] {
  return sessionsUsingProjectWorktree(
    sessions,
    repoPath,
    worktreePath,
  ).filter((session) => session.id !== activeSessionId);
}

export function otherSessionsUsingWorktreePath(
  sessions: readonly Session[],
  worktreePath: string,
  activeSessionId: string | null,
): Session[] {
  return sessionsUsingWorktreePath(sessions, worktreePath).filter(
    (session) => session.id !== activeSessionId,
  );
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
  sessions: readonly Session[] = [session],
): boolean {
  return (
    hasRecordedWorktree(session) &&
    !isSessionInWorktreeWorkspace(session, foldersByRepo) &&
    otherSessionsUsingWorktreePath(
      sessions,
      session.worktree_path,
      session.id,
    ).length === 0
  );
}

export function shouldAutoDeleteSessionWorktree(
  session: Session,
  foldersByRepo: ProjectFoldersByRepo,
  sessions: readonly Session[] = [session],
): boolean {
  return (
    session.isolated && canDeleteSessionWorktree(session, foldersByRepo, sessions)
  );
}
