import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const apiMocks = vi.hoisted(() => ({
  fsGitDiffStats: vi.fn(),
  fsGitStatus: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  fetchPullRequests: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    fsGitDiffStats: apiMocks.fsGitDiffStats,
    fsGitStatus: apiMocks.fsGitStatus,
  },
}));

vi.mock("./right-panel-cache", () => ({
  rightPanelCache: {
    fetchPullRequests: cacheMocks.fetchPullRequests,
  },
}));

import {
  diffStatsEntries,
  kanbanSessionBoardLookupPath,
  kanbanSessionPullRequestLookupPath,
  pickPullRequestForBranch,
  pickPullRequestForBranches,
  pruneKanbanRepoRequestSequences,
  readKanbanPrBranchLinks,
  summarizeDiffStats,
  useKanbanBoardData,
  writeKanbanPrBranchLinks,
} from "./useKanbanBoardData";
import type { PullRequestInfo, Session } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function boardSession(id: string, repoPath: string): Session {
  return {
    id,
    repo_path: repoPath,
    worktree_path: repoPath,
    git_context_path: null,
    branch: "main",
  } as Session;
}

function BoardDataHarness({ sessions }: { sessions: readonly Session[] }) {
  useKanbanBoardData(sessions);
  return null;
}

function makePr(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    number: 1,
    title: "PR",
    state: "OPEN",
    author: "me",
    head_branch: "feat/x",
    base_branch: "main",
    url: "https://example.test/pr/1",
    updated_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    merged_at: null,
    is_draft: false,
    checks: null,
    labels: [],
    ...overrides,
  };
}

describe("pickPullRequestForBranch", () => {
  it("returns null for no candidates", () => {
    expect(pickPullRequestForBranch([])).toBeNull();
  });

  it("prefers an open PR over merged and closed ones", () => {
    const merged = makePr({
      number: 1,
      state: "MERGED",
      updated_at: "2026-01-05T00:00:00.000Z",
    });
    const open = makePr({
      number: 2,
      state: "open",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    expect(pickPullRequestForBranch([merged, open])?.number).toBe(2);
    expect(pickPullRequestForBranch([open, merged])?.number).toBe(2);
  });

  it("breaks ties by most recent update", () => {
    const older = makePr({
      number: 1,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const newer = makePr({
      number: 2,
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    expect(pickPullRequestForBranch([older, newer])?.number).toBe(2);
    expect(pickPullRequestForBranch([newer, older])?.number).toBe(2);
  });
});

describe("pickPullRequestForBranches", () => {
  it("keeps a PR linked after the worktree checks out the base branch", () => {
    const pr = makePr({
      number: 604,
      state: "MERGED",
      head_branch: "feat/x",
      merged_at: "2026-01-02T00:10:13.000Z",
    });

    expect(pickPullRequestForBranches([pr], ["main", "feat/x"])?.number).toBe(
      604,
    );
  });
});

describe("kanban PR branch links", () => {
  beforeEach(() => localStorage.clear());

  it("persists the PR branch independently from the live checkout", () => {
    writeKanbanPrBranchLinks({
      session: { repoPath: "/repo", headBranch: "feat/x" },
    });

    expect(readKanbanPrBranchLinks()).toEqual({
      session: { repoPath: "/repo", headBranch: "feat/x" },
    });
  });

  it("ignores corrupt persisted links", () => {
    localStorage.setItem("acorn:workspace-kanban:pr-branch-links:v1", "{");
    expect(readKanbanPrBranchLinks()).toEqual({});
  });
});

describe("kanban diff summaries", () => {
  it("requests diff stats only for changed paths", () => {
    expect(
      diffStatsEntries({
        "src/App.tsx": { kind: "modified", additions: 0, deletions: 0 },
        "README.md": { kind: "added", additions: 0, deletions: 0 },
        "src/clean.ts": { kind: "clean", additions: 0, deletions: 0 },
      }),
    ).toEqual([
      { path: "src/App.tsx", kind: "modified" },
      { path: "README.md", kind: "added" },
    ]);
  });

  it("uses fs_git_diff_stats line counts while preserving dirty status", () => {
    expect(
      summarizeDiffStats(
        [
          { path: "src/App.tsx", kind: "modified" },
          { path: "README.md", kind: "added" },
        ],
        {
          "src/App.tsx": { additions: 12, deletions: 3 },
          "README.md": { additions: 4, deletions: 0 },
        },
      ),
    ).toEqual({ hasDiff: true, additions: 16, deletions: 3 });
  });

  it("still reports a dirty tree when diff stats omit a changed path", () => {
    expect(
      summarizeDiffStats([{ path: "renamed.ts", kind: "renamed" }], {}),
    ).toEqual({ hasDiff: true, additions: 0, deletions: 0 });
  });
});

describe("kanbanSessionBoardLookupPath", () => {
  function session(overrides: Partial<Session> = {}): Session {
    return {
      repo_path: "/repo/project",
      worktree_path: "/repo/project/.worktrees/session",
      git_context_path: null,
      ...overrides,
    } as Session;
  }

  it("prefers the live git context path when present", () => {
    expect(
      kanbanSessionBoardLookupPath(
        session({ git_context_path: " /repo/other-worktree " }),
      ),
    ).toBe("/repo/other-worktree");
  });

  it("falls back to the recorded worktree before the project repo", () => {
    expect(kanbanSessionBoardLookupPath(session())).toBe(
      "/repo/project/.worktrees/session",
    );
    expect(
      kanbanSessionBoardLookupPath(
        session({ git_context_path: "   ", worktree_path: "" }),
      ),
    ).toBe("/repo/project");
  });
});

describe("kanbanSessionPullRequestLookupPath", () => {
  function session(overrides: Partial<Session> = {}): Session {
    return {
      repo_path: "/repo/project",
      worktree_path: "/repo/project/.worktrees/session",
      git_context_path: null,
      ...overrides,
    } as Session;
  }

  it("shares the project repo lookup for its recorded worktree", () => {
    expect(kanbanSessionPullRequestLookupPath(session())).toBe(
      "/repo/project",
    );
    expect(
      kanbanSessionPullRequestLookupPath(
        session({
          git_context_path: "/repo/project/.worktrees/session/",
        }),
      ),
    ).toBe("/repo/project");
  });

  it("keeps a live git context that points outside the session worktree", () => {
    expect(
      kanbanSessionPullRequestLookupPath(
        session({ git_context_path: " /repo/other-project " }),
      ),
    ).toBe("/repo/other-project");
  });
});

describe("kanban request tracking cleanup", () => {
  it("releases request sequences for repositories no longer on the board", () => {
    const sequences = new Map([
      ["/repo/live-a", 3],
      ["/repo/removed", 8],
      ["/repo/live-b", 2],
    ]);

    pruneKanbanRepoRequestSequences(
      sequences,
      new Set(["/repo/live-a", "/repo/live-b"]),
    );

    expect([...sequences]).toEqual([
      ["/repo/live-a", 3],
      ["/repo/live-b", 2],
    ]);
  });

  it("clears request sequences when the board has no repositories", () => {
    const sequences = new Map([["/repo/removed", 8]]);

    pruneKanbanRepoRequestSequences(sequences, new Set());

    expect(sequences.size).toBe(0);
  });
});

describe("kanban diff polling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    apiMocks.fsGitDiffStats.mockResolvedValue({});
    cacheMocks.fetchPullRequests.mockResolvedValue({
      kind: "ok",
      items: [],
      account: "tester",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not overlap diff polls for the same session set", async () => {
    const pending = deferred<{
      statuses: Record<string, never>;
      huge: boolean;
      limit: number;
    }>();
    apiMocks.fsGitStatus.mockReturnValue(pending.promise);

    await act(async () => {
      root.render(
        createElement(BoardDataHarness, {
          sessions: [boardSession("session-a", "/repo/a")],
        }),
      );
    });
    expect(apiMocks.fsGitStatus).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });

    expect(apiMocks.fsGitStatus).toHaveBeenCalledOnce();
  });

  it("does not let an old poll completion clear a newer session set poll", async () => {
    const first = deferred<{
      statuses: Record<string, never>;
      huge: boolean;
      limit: number;
    }>();
    const second = deferred<{
      statuses: Record<string, never>;
      huge: boolean;
      limit: number;
    }>();
    apiMocks.fsGitStatus.mockImplementation((repoPath: string) =>
      repoPath === "/repo/a" ? first.promise : second.promise,
    );

    await act(async () => {
      root.render(
        createElement(BoardDataHarness, {
          sessions: [boardSession("session-a", "/repo/a")],
        }),
      );
    });
    await act(async () => {
      root.render(
        createElement(BoardDataHarness, {
          sessions: [boardSession("session-b", "/repo/b")],
        }),
      );
    });
    expect(apiMocks.fsGitStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({ statuses: {}, huge: false, limit: 5_000 });
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });

    expect(apiMocks.fsGitStatus).toHaveBeenCalledTimes(2);
  });
});
