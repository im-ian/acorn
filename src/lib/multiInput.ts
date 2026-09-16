import { isSessionTabId } from "./workspaceTabs";

interface PaneLike {
  activeTabId: string | null;
}

interface SessionLike {
  id: string;
  mode?: string | null;
  archived_at?: string | null;
}

export function visibleMultiInputSessionIds(
  panes: Record<string, PaneLike>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const pane of Object.values(panes)) {
    const id = pane.activeTabId;
    if (!id || !isSessionTabId(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function isSessionInFocusedPane(
  sessionId: string,
  panes: Record<string, PaneLike>,
  focusedPaneId: string,
): boolean {
  return panes[focusedPaneId]?.activeTabId === sessionId;
}

function canReceiveMultiInput(session: SessionLike | undefined): boolean {
  if (!session) return true;
  if (session.archived_at) return false;
  if (session.mode === "chat") return false;
  return true;
}

export function multiInputWriteSessionIds(
  enabled: boolean,
  panes: Record<string, PaneLike>,
  primarySessionId: string,
  sessions: readonly SessionLike[] = [],
): string[] {
  const raw = enabled
    ? visibleMultiInputSessionIds(panes)
    : [primarySessionId];
  const ids = raw.length > 0 ? raw : [primarySessionId];
  if (sessions.length === 0) return ids;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const writable = ids.filter((id) => canReceiveMultiInput(byId.get(id)));
  return writable.length > 0 ? writable : [primarySessionId];
}

/** Collapse the native-menu accelerator and the in-webview key handler into one toggle. */
export function createToggleLatch(windowMs = 50): (now?: number) => boolean {
  let lastAcceptedAt = 0;
  return (now = Date.now()) => {
    if (now - lastAcceptedAt < windowMs) return false;
    lastAcceptedAt = now;
    return true;
  };
}
