import { isSessionTabId } from "./workspaceTabs";

interface PaneLike {
  activeTabId: string | null;
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
