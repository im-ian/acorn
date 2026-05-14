interface PaneLike {
  activeSessionId: string | null;
}

export function visibleMultiInputSessionIds(
  panes: Record<string, PaneLike>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const pane of Object.values(panes)) {
    const id = pane.activeSessionId;
    if (!id || seen.has(id)) continue;
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
  return panes[focusedPaneId]?.activeSessionId === sessionId;
}
