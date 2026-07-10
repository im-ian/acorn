import { describe, expect, it } from "vitest";
import {
  diffStatsEntries,
  kanbanSessionBoardLookupPath,
  pickPullRequestForBranch,
  summarizeDiffStats,
} from "./useKanbanBoardData";
import type { PullRequestInfo, Session } from "./types";

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
