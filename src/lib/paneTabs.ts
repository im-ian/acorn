export function normalizeMinimizedTabIds(
  minimizedTabIds: unknown,
  tabIds: readonly string[],
): string[] {
  if (!Array.isArray(minimizedTabIds)) return [];
  const allowed = new Set(tabIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of minimizedTabIds) {
    if (typeof id !== "string" || !allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function partitionTabIds(
  tabIds: readonly string[],
  minimizedTabIds: readonly string[],
): { minimized: string[]; expanded: string[] } {
  const minimizedSet = new Set(minimizedTabIds);
  const minimized: string[] = [];
  const expanded: string[] = [];
  for (const id of tabIds) {
    if (minimizedSet.has(id)) minimized.push(id);
    else expanded.push(id);
  }
  return { minimized, expanded };
}

export function stackMinimizedTabIds(
  tabIds: readonly string[],
  minimizedTabIds: readonly string[],
): string[] {
  const { minimized, expanded } = partitionTabIds(tabIds, minimizedTabIds);
  return [...minimized, ...expanded];
}

export function applyTabMinimized(
  tabIds: readonly string[],
  minimizedTabIds: readonly string[],
  tabId: string,
  minimized: boolean,
): { tabIds: string[]; minimizedTabIds: string[] } {
  const currentMinimized = normalizeMinimizedTabIds(minimizedTabIds, tabIds);
  if (!tabIds.includes(tabId)) {
    return {
      tabIds: [...tabIds],
      minimizedTabIds: currentMinimized,
    };
  }

  const already = currentMinimized.includes(tabId);
  if (already === minimized) {
    return {
      tabIds: stackMinimizedTabIds(tabIds, currentMinimized),
      minimizedTabIds: currentMinimized,
    };
  }

  const nextMinimized = new Set(currentMinimized);
  if (minimized) nextMinimized.add(tabId);
  else nextMinimized.delete(tabId);

  const without = tabIds.filter((id) => id !== tabId);
  const { minimized: minIds, expanded } = partitionTabIds(without, [
    ...nextMinimized,
  ]);
  const nextTabIds = [...minIds, tabId, ...expanded];
  return {
    tabIds: nextTabIds,
    minimizedTabIds: normalizeMinimizedTabIds([...nextMinimized], nextTabIds),
  };
}

// Insert positions are relative to a left-prefix of minimized ids.
export function clampTabInsertIndex(
  tabIds: readonly string[],
  minimizedTabIds: readonly string[],
  insertingMinimized: boolean,
  requestedIndex: number,
): number {
  const minimizedCount = partitionTabIds(
    tabIds,
    minimizedTabIds,
  ).minimized.length;
  const index = Math.max(0, Math.min(requestedIndex, tabIds.length));
  if (insertingMinimized) return Math.min(index, minimizedCount);
  return Math.max(index, minimizedCount);
}

export function mergeMinimizedTabIds(
  left: unknown,
  right: unknown,
  tabIds: readonly string[],
): string[] {
  const merged = [
    ...normalizeMinimizedTabIds(left, tabIds),
    ...normalizeMinimizedTabIds(right, tabIds),
  ];
  return normalizeMinimizedTabIds(merged, tabIds);
}

export function collectMinimizedTabIds(
  workspaces: Record<
    string,
    { panes: Record<string, { minimizedTabIds?: readonly string[] }> }
  >,
): Set<string> {
  const ids = new Set<string>();
  for (const workspace of Object.values(workspaces)) {
    for (const pane of Object.values(workspace.panes)) {
      for (const id of pane.minimizedTabIds ?? []) ids.add(id);
    }
  }
  return ids;
}

export function isTabMinimizedInWorkspaces(
  workspaces: Record<
    string,
    { panes: Record<string, { minimizedTabIds?: readonly string[] }> }
  >,
  tabId: string,
): boolean {
  return collectMinimizedTabIds(workspaces).has(tabId);
}
