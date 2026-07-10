import { describe, expect, it } from "vitest";
import {
  currentPullRequestSearchQuery,
  findCurrentPullRequestForBranch,
  summarizeAllSessionProcesses,
  summarizeSessionProcesses,
} from "./sessionContext";
import type { PullRequestInfo, PullRequestListing } from "./types";

function pr(overrides: Partial<PullRequestInfo>): PullRequestInfo {
  return {
    number: 1,
    title: "Default PR",
    state: "OPEN",
    author: "octo",
    head_branch: "feature/default",
    base_branch: "main",
    url: "https://github.com/im-ian/acorn/pull/1",
    updated_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    is_draft: false,
    checks: null,
    labels: [],
    ...overrides,
  };
}

describe("session context helpers", () => {
  it("builds a GitHub search query for the exact head branch", () => {
    expect(currentPullRequestSearchQuery("feature/sidebar-prs")).toBe(
      "head:feature/sidebar-prs",
    );
    expect(currentPullRequestSearchQuery("   ")).toBeNull();
    expect(currentPullRequestSearchQuery("main")).toBeNull();
    expect(currentPullRequestSearchQuery("master")).toBeNull();
  });

  it("finds the open PR whose head branch matches the session branch", () => {
    const listing: PullRequestListing = {
      kind: "ok",
      account: "ian",
      items: [
        pr({ number: 41, head_branch: "feature/other" }),
        pr({
          number: 42,
          title: "Show session context",
          head_branch: "feature/sidebar-prs",
          url: "https://github.com/im-ian/acorn/pull/42",
        }),
      ],
    };

    expect(
      findCurrentPullRequestForBranch(listing, "feature/sidebar-prs"),
    ).toEqual({
      number: 42,
      title: "Show session context",
      url: "https://github.com/im-ian/acorn/pull/42",
      head_branch: "feature/sidebar-prs",
      base_branch: "main",
      state: "OPEN",
      is_draft: false,
    });
  });

  it("summarizes the visible session process names", () => {
    expect(
      summarizeSessionProcesses([
        { pid: 10, name: "codex", depth: 2 },
        { pid: 11, name: "rg", depth: 3 },
        { pid: 12, name: "node", depth: 3 },
      ]),
    ).toBe("codex, rg +1");
  });

  it("summarizes every session process name for detailed views", () => {
    expect(
      summarizeAllSessionProcesses([
        { pid: 10, name: "codex", depth: 2 },
        { pid: 11, name: "rg", depth: 3 },
        { pid: 12, name: "node", depth: 3 },
        { pid: 13, name: "cargo", depth: 3 },
      ]),
    ).toBe("codex, rg, node, cargo");
  });
});
