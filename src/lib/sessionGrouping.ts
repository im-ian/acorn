import type { Project, Session } from "./types";

export interface ProjectGroup {
  repoPath: string;
  name: string;
  sessions: Session[];
}

export function buildProjectGroups(
  projects: Project[],
  sessions: Session[],
): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  const projectSessions = sessions.filter(isProjectSession);
  const projectSessionPaths = new Set(
    projectSessions.map((session) => session.repo_path),
  );
  const localSessionPaths = new Set(
    sessions.filter(isLocalSession).map((session) => session.repo_path),
  );

  // Preserve incoming order: backend sorts by user-defined `position`.
  for (const project of projects) {
    // Older boot backfill could persist a project entry for the user's home
    // directory after a local chat session. Keep that stale empty project out
    // of the Projects section while preserving real project sessions.
    if (
      !projectSessionPaths.has(project.repo_path) &&
      localSessionPaths.has(project.repo_path)
    ) {
      continue;
    }
    map.set(project.repo_path, {
      repoPath: project.repo_path,
      name: project.name,
      sessions: [],
    });
  }
  for (const session of projectSessions) {
    let group = map.get(session.repo_path);
    if (!group) {
      // Backfill: a session with no matching project entry shows anyway,
      // appended after known projects so user-defined project ordering wins.
      group = {
        repoPath: session.repo_path,
        name: basename(session.repo_path),
        sessions: [],
      };
      map.set(session.repo_path, group);
    }
    group.sessions.push(session);
  }
  for (const group of map.values()) {
    group.sessions = sortSessions(group.sessions);
  }
  return Array.from(map.values());
}

export function buildLocalSessions(sessions: Session[]): Session[] {
  return sortSessions(sessions.filter(isLocalSession));
}

export function isProjectSession(session: Session): boolean {
  return session.project_scoped !== false;
}

export function isLocalSession(session: Session): boolean {
  return session.project_scoped === false;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const ap = a.position ?? Number.POSITIVE_INFINITY;
    const bp = b.position ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    const createdDelta =
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdDelta !== 0) return createdDelta;
    return a.id.localeCompare(b.id);
  });
}
