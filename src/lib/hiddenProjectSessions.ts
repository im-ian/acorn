export const HIDDEN_PROJECT_SESSIONS_STORAGE_KEY =
  "acorn:sidebar:hidden-sessions";

const HIDDEN_PROJECT_SESSIONS_CHANGED_EVENT =
  "acorn:hidden-project-sessions-changed";

export function loadHiddenProjectSessionIds(): Set<string> {
  try {
    if (typeof localStorage === "undefined") return new Set();
    const raw = localStorage.getItem(HIDDEN_PROJECT_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // ignore
  }
  return new Set();
}

export function hideProjectSession(sessionId: string): Set<string> {
  return updateHiddenProjectSessionIds((prev) => {
    if (prev.has(sessionId)) return prev;
    const next = new Set(prev);
    next.add(sessionId);
    return next;
  });
}

export function showProjectSession(sessionId: string): Set<string> {
  return updateHiddenProjectSessionIds((prev) => {
    if (!prev.has(sessionId)) return prev;
    const next = new Set(prev);
    next.delete(sessionId);
    return next;
  });
}

export function showProjectSessions(sessionIds: readonly string[]): Set<string> {
  return updateHiddenProjectSessionIds((prev) => {
    let changed = false;
    const next = new Set(prev);
    for (const id of sessionIds) {
      if (next.delete(id)) changed = true;
    }
    return changed ? next : prev;
  });
}

export function subscribeHiddenProjectSessions(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;

  const onChanged = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === HIDDEN_PROJECT_SESSIONS_STORAGE_KEY) listener();
  };

  window.addEventListener(HIDDEN_PROJECT_SESSIONS_CHANGED_EVENT, onChanged);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(HIDDEN_PROJECT_SESSIONS_CHANGED_EVENT, onChanged);
    window.removeEventListener("storage", onStorage);
  };
}

function updateHiddenProjectSessionIds(
  update: (prev: Set<string>) => Set<string>,
): Set<string> {
  const prev = loadHiddenProjectSessionIds();
  const next = update(prev);
  if (setsEqual(prev, next)) return prev;
  saveHiddenProjectSessionIds(next);
  notifyHiddenProjectSessionsChanged();
  return next;
}

function saveHiddenProjectSessionIds(ids: Set<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      HIDDEN_PROJECT_SESSIONS_STORAGE_KEY,
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    // ignore
  }
}

function notifyHiddenProjectSessionsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(HIDDEN_PROJECT_SESSIONS_CHANGED_EVENT));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}
