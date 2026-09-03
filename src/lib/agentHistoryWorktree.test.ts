import { afterEach, describe, expect, it } from "vitest";
import type { AgentHistoryItem } from "./types";
import {
  applyDismissedHistoryWorktrees,
  getDismissedHistoryWorktreeVersion,
  markAgentHistoryWorktreeMissing,
  rememberDismissedHistoryWorktree,
  resetDismissedHistoryWorktreesForTests,
  subscribeDismissedHistoryWorktrees,
} from "./agentHistoryWorktree";

function historyItem(
  overrides: Partial<AgentHistoryItem> &
    Pick<AgentHistoryItem, "id" | "transcript_path">,
): AgentHistoryItem {
  return {
    provider: "codex",
    title: overrides.id,
    preview: null,
    queued_message_count: 0,
    subagent_transcript_count: 0,
    cwd: "/tmp/demo",
    worktree: {
      name: "removed-goal",
      path: "/tmp/demo/.acorn/worktrees/removed-goal",
      exists: true,
    },
    updated_at: 1,
    resume_command: "codex resume",
    ...overrides,
  };
}

describe("agentHistoryWorktree", () => {
  afterEach(() => {
    resetDismissedHistoryWorktreesForTests();
  });

  it("marks only the matching history item missing", () => {
    const target = historyItem({
      id: "codex-1",
      transcript_path: "/tmp/a.jsonl",
    });
    const other = historyItem({
      id: "codex-2",
      transcript_path: "/tmp/b.jsonl",
    });

    const next = markAgentHistoryWorktreeMissing([target, other], target);

    expect(next[0]?.worktree?.exists).toBe(false);
    expect(next[1]?.worktree?.exists).toBe(true);
    expect(markAgentHistoryWorktreeMissing(next, target)).toBe(next);
  });

  it("applies dismissed worktrees to a remounted list snapshot", () => {
    const item = historyItem({
      id: "codex-stale",
      transcript_path: "/tmp/stale.jsonl",
    });
    const notifications: number[] = [];
    const unsubscribe = subscribeDismissedHistoryWorktrees(() => {
      notifications.push(getDismissedHistoryWorktreeVersion());
    });

    rememberDismissedHistoryWorktree(item);
    rememberDismissedHistoryWorktree(item);

    expect(notifications).toEqual([1]);
    expect(applyDismissedHistoryWorktrees([item])[0]?.worktree?.exists).toBe(
      false,
    );
    unsubscribe();
  });
});
