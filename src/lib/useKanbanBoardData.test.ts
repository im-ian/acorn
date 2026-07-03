import { describe, expect, it } from "vitest";
import { pickPullRequestForBranch } from "./useKanbanBoardData";
import type { PullRequestInfo } from "./types";

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
