import { resolveProjectRootPath } from "./projectFolders";
import { isLocalSession } from "./sessionGrouping";
import type { Session } from "./types";

export function isArchivedSession(
  session: Pick<Session, "archived_at">,
): boolean {
  return Boolean(session.archived_at);
}

export function liveSessions<T extends Pick<Session, "archived_at">>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => !isArchivedSession(session));
}

export function archivedSessions<T extends Pick<Session, "archived_at">>(
  sessions: readonly T[],
): T[] {
  return sessions.filter(isArchivedSession);
}

export function archivedSessionsForProject(
  sessions: readonly Session[],
  projectRepoPath: string,
  rootIndex: ReadonlyMap<string, string>,
): Session[] {
  return archivedSessions(sessions).filter(
    (session) =>
      !isLocalSession(session) &&
      resolveProjectRootPath(rootIndex, session.repo_path) === projectRepoPath,
  );
}

export function archivedLocalSessions(sessions: readonly Session[]): Session[] {
  return archivedSessions(sessions).filter(isLocalSession);
}
