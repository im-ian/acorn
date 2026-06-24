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

export function sessionRemovalCascadeIds(
  sessions: readonly Session[],
  target: Session,
): Set<string> {
  const ids = new Set<string>([target.id]);
  if (target.kind !== "control") return ids;

  const frontier = [target.id];
  while (frontier.length > 0) {
    const ownerId = frontier.pop();
    if (!ownerId) continue;
    for (const session of sessions) {
      if (
        ids.has(session.id) ||
        session.owner.kind !== "control" ||
        session.owner.session_id !== ownerId
      ) {
        continue;
      }
      ids.add(session.id);
      frontier.push(session.id);
    }
  }

  return ids;
}

export function controlOwnedSessionCount(
  sessions: readonly Session[],
  target: Session,
): number {
  return sessionRemovalCascadeIds(sessions, target).size - 1;
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
  const removalIds = sessionRemovalCascadeIds(sessions, session);
  return (
    hasRecordedWorktree(session) &&
    !isSessionInWorktreeWorkspace(session, foldersByRepo) &&
    otherSessionsUsingWorktreePath(
      sessions,
      session.worktree_path,
      session.id,
    ).every((candidate) => removalIds.has(candidate.id))
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
