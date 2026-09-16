import { describe, expect, it } from "vitest";
import {
  currentPullRequestSearchQuery,
  findCurrentPullRequestForBranch,
  findSessionsForPullRequest,
  isWslBridgedSession,
  summarizeAllSessionProcesses,
  summarizeSessionProcesses,
} from "./sessionContext";
import type { PullRequestInfo, PullRequestListing, Session } from "./types";

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

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    repo_path: "/repo",
    worktree_path: `/repo/.acorn/worktrees/${id}`,
    branch: "main",
    isolated: true,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: true,
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

  it("finds current and previously linked sessions for a PR branch", () => {
    const current = session("current", {
      name: "Current branch",
      branch: "feature/sidebar-prs",
      updated_at: "2026-01-02T00:00:00Z",
    });
    const previous = session("previous", {
      name: "Cleaned up branch",
      branch: "main",
      updated_at: "2026-01-03T00:00:00Z",
    });
    const otherRepo = session("other-repo", {
      repo_path: "/other",
      branch: "feature/sidebar-prs",
    });
    const local = session("local", {
      branch: "feature/sidebar-prs",
      project_scoped: false,
    });

    expect(
      findSessionsForPullRequest(
        [previous, otherRepo, local, current],
        "/repo/",
        "feature/sidebar-prs",
        {
          previous: {
            repoPath: "/repo",
            headBranch: "feature/sidebar-prs",
          },
        },
      ).map((candidate) => candidate.id),
    ).toEqual(["current", "previous"]);
  });

  it("orders matching current-branch sessions by recency", () => {
    const older = session("older", {
      branch: "feature/sidebar-prs",
      updated_at: "2026-01-02T00:00:00Z",
    });
    const newer = session("newer", {
      branch: "feature/sidebar-prs",
      updated_at: "2026-01-03T00:00:00Z",
    });

    expect(
      findSessionsForPullRequest(
        [older, newer],
        "/repo",
        "feature/sidebar-prs",
      ).map((candidate) => candidate.id),
    ).toEqual(["newer", "older"]);
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

  it("flags a session whose only live process is the WSL bridge", () => {
    expect(
      isWslBridgedSession(
        session("a", {
          active_processes: [{ pid: 10, name: "wsl.exe", depth: 1 }],
        }),
      ),
    ).toBe(true);
  });

  it("matches the WSL bridge regardless of reported name casing", () => {
    expect(
      isWslBridgedSession(
        session("a", {
          active_processes: [{ pid: 10, name: "WSL.EXE", depth: 1 }],
        }),
      ),
    ).toBe(true);
  });

  it("does not flag a session that resolved an agent transcript", () => {
    // `wsl.exe` can also be an incidental child of a normal Windows session.
    // A bound transcript proves status resolution worked, so the hint would
    // be actively wrong.
    expect(
      isWslBridgedSession(
        session("a", {
          agent_transcript_provider: "codex",
          active_processes: [{ pid: 10, name: "wsl.exe", depth: 2 }],
        }),
      ),
    ).toBe(false);
  });

  it("does not flag an ordinary session with no WSL bridge", () => {
    expect(
      isWslBridgedSession(
        session("a", {
          active_processes: [{ pid: 10, name: "codex", depth: 1 }],
        }),
      ),
    ).toBe(false);
  });

  it("does not flag an idle session with no live processes", () => {
    expect(isWslBridgedSession(session("a", { active_processes: [] }))).toBe(
      false,
    );
  });
});
