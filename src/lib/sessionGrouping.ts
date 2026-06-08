import type { Session } from "./types";

export function buildLocalSessions(sessions: Session[]): Session[] {
  return sortSessions(sessions.filter(isLocalSession));
}

export function isProjectSession(session: Session): boolean {
  return session.project_scoped !== false;
}

export function isLocalSession(session: Session): boolean {
  return session.project_scoped === false;
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
