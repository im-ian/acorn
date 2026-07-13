export function pruneSessionIdSet(
  tracked: Set<string>,
  liveSessionIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const sessionId of tracked) {
    if (liveSessionIds.has(sessionId)) continue;
    tracked.delete(sessionId);
    changed = true;
  }
  return changed;
}

export function retainSessionMapEntries<T>(
  tracked: Map<string, T>,
  liveSessionIds: ReadonlySet<string>,
): Map<string, T> {
  let next: Map<string, T> | null = null;
  for (const sessionId of tracked.keys()) {
    if (liveSessionIds.has(sessionId)) continue;
    next ??= new Map(tracked);
    next.delete(sessionId);
  }
  return next ?? tracked;
}
