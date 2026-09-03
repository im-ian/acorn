import type { AgentHistoryItem } from "./types";

export type AgentHistoryItemIdentity = Pick<
  AgentHistoryItem,
  "provider" | "id" | "transcript_path"
>;

function agentHistoryItemKey(item: AgentHistoryItemIdentity): string {
  return `${item.provider}:${item.id}:${item.transcript_path}`;
}

export function isSameAgentHistoryItem(
  a: AgentHistoryItemIdentity,
  b: AgentHistoryItemIdentity,
): boolean {
  return (
    a.provider === b.provider &&
    a.id === b.id &&
    a.transcript_path === b.transcript_path
  );
}

export function markAgentHistoryWorktreeMissing(
  items: AgentHistoryItem[],
  item: AgentHistoryItemIdentity,
): AgentHistoryItem[] {
  let changed = false;
  const next = items.map((candidate) => {
    if (
      !isSameAgentHistoryItem(candidate, item) ||
      !candidate.worktree?.exists
    ) {
      return candidate;
    }
    changed = true;
    return {
      ...candidate,
      worktree: { ...candidate.worktree, exists: false },
    };
  });
  return changed ? next : items;
}

let dismissedVersion = 0;
const dismissedKeys = new Set<string>();
const listeners = new Set<() => void>();

function emitDismissedHistoryWorktrees(): void {
  dismissedVersion += 1;
  for (const listener of listeners) listener();
}

export function rememberDismissedHistoryWorktree(
  item: AgentHistoryItemIdentity,
): void {
  const key = agentHistoryItemKey(item);
  if (dismissedKeys.has(key)) return;
  dismissedKeys.add(key);
  emitDismissedHistoryWorktrees();
}

export function subscribeDismissedHistoryWorktrees(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDismissedHistoryWorktreeVersion(): number {
  return dismissedVersion;
}

export function applyDismissedHistoryWorktrees(
  items: AgentHistoryItem[],
): AgentHistoryItem[] {
  if (dismissedKeys.size === 0) return items;
  let changed = false;
  const next = items.map((candidate) => {
    if (
      !dismissedKeys.has(agentHistoryItemKey(candidate)) ||
      !candidate.worktree?.exists
    ) {
      return candidate;
    }
    changed = true;
    return {
      ...candidate,
      worktree: { ...candidate.worktree, exists: false },
    };
  });
  return changed ? next : items;
}

export function resetDismissedHistoryWorktreesForTests(): void {
  dismissedKeys.clear();
  dismissedVersion = 0;
  listeners.clear();
}
