import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    discardRemovedSession: vi.fn(),
    discardRemovedWorktree: vi.fn(),
    discardRemovalRetry: vi.fn(),
    retryRemovalCleanup: vi.fn(),
    restoreRemovedSession: vi.fn(),
    restoreRemovedWorktree: vi.fn(),
  },
}));

import { api, type SessionRemoval, type WorktreeRemoval } from "./api";
import {
  showRemovalOutcomeIssues,
  showSessionRemovalToast,
  showWorktreeRemovalToast,
} from "./operationToasts";
import { useSettings } from "./settings";
import { useToasts } from "./toasts";

const mockApi = vi.mocked(api);

function worktreeRemoval(token: string): WorktreeRemoval {
  return {
    token,
    repoPath: "/repo",
    worktreePath: `/repo/.acorn/worktrees/${token}`,
    gitCommonDir: "/repo/.git",
  };
}

function sessionRemoval(token: string): SessionRemoval {
  return {
    ...worktreeRemoval(token),
    sessionIds: [`session-${token}`],
  };
}

describe("removal cleanup toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    useToasts.getState().hide(undefined, { skipDismiss: true });
    useSettings.setState((state) => ({
      settings: { ...state.settings, language: "en" },
    }));
  });

  afterEach(() => {
    useToasts.getState().hide(undefined, { skipDismiss: true });
    vi.useRealTimers();
  });

  it("surfaces worktree cleanup failures and retries only failed removals", async () => {
    const blocked = worktreeRemoval("blocked");
    const cleaned = worktreeRemoval("cleaned");
    mockApi.discardRemovedWorktree
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValue(undefined);

    showWorktreeRemovalToast(
      [blocked, cleaned],
      "toasts.session.worktreeRemoved",
      "toasts.session.worktreeRemovedUndo",
      "toasts.session.worktreeRestored",
      "toasts.session.worktreeRestoreFailed",
    );

    const removalToast = useToasts.getState().toasts[0];
    await removalToast.onDismiss?.();

    expect(mockApi.discardRemovedWorktree).toHaveBeenCalledTimes(2);
    const retryToast = useToasts.getState().toasts[1];
    expect(retryToast.message).toContain(
      "Failed to finish deleting removed worktree data: Permission denied.",
    );

    await retryToast.action?.();

    expect(mockApi.discardRemovedWorktree).toHaveBeenCalledTimes(3);
    expect(mockApi.discardRemovedWorktree).toHaveBeenNthCalledWith(1, blocked);
    expect(mockApi.discardRemovedWorktree).toHaveBeenNthCalledWith(2, cleaned);
    expect(mockApi.discardRemovedWorktree).toHaveBeenNthCalledWith(3, blocked);
  });

  it("surfaces session cleanup failures with a retry action", async () => {
    const removal = sessionRemoval("blocked-session");
    mockApi.discardRemovedSession
      .mockRejectedValueOnce(new Error("read-only file system"))
      .mockResolvedValue(undefined);

    showSessionRemovalToast(
      removal,
      "toasts.session.sessionWorktreeRemoved",
      "toasts.session.sessionWorktreeRemovedUndo",
      "toasts.session.sessionWorktreeRestored",
      "toasts.session.sessionWorktreeRestoreFailed",
    );

    const removalToast = useToasts.getState().toasts[0];
    await removalToast.onDismiss?.();

    const retryToast = useToasts.getState().toasts[1];
    expect(retryToast.message).toContain(
      "Failed to finish deleting removed session data: read-only file system.",
    );

    await retryToast.action?.();

    expect(mockApi.discardRemovedSession).toHaveBeenCalledTimes(2);
    expect(mockApi.discardRemovedSession).toHaveBeenLastCalledWith(removal);
  });

  it("shows exact partial-removal failures and retries by opaque token", async () => {
    const retriedRemoval = worktreeRemoval("retried-worktree");
    mockApi.retryRemovalCleanup.mockResolvedValue({
      result: [retriedRemoval],
      removedSessionIds: [],
      issues: [],
      retryToken: null,
    });

    showRemovalOutcomeIssues({
      result: null,
      removedSessionIds: ["session-1"],
      issues: [
        {
          kind: "scrollback",
          target: "session-1",
          message: "Permission denied",
          retryable: true,
        },
      ],
      retryToken: "opaque-retry-token",
    });

    const issueToast = useToasts.getState().toasts[0];
    expect(issueToast.message).toContain("session-1: Permission denied");
    await issueToast.action?.();

    expect(mockApi.retryRemovalCleanup).toHaveBeenCalledWith(
      "opaque-retry-token",
    );
    expect(useToasts.getState().toasts[1]?.message).toContain(
      "retried-worktree",
    );
  });

  it("forgets an ignored removal retry token without exposing cleanup inputs", async () => {
    showRemovalOutcomeIssues({
      result: [],
      removedSessionIds: [],
      issues: [
        {
          kind: "persistence",
          target: "sessions",
          message: "read-only file system",
          retryable: true,
        },
      ],
      retryToken: "ignored-token",
    });

    await useToasts.getState().toasts[0]?.onDismiss?.();

    expect(mockApi.discardRemovalRetry).toHaveBeenCalledWith("ignored-token");
  });
});
