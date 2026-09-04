import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionPullRequestBranchLinks } from "./sessionPullRequestLinks";
import type { Session } from "./types";
import {
  createGithubWorkSession,
  findSessionsForGithubWork,
  githubWorkSessionName,
  githubWorkSlug,
  planGithubStartWork,
  runGithubStartWork,
} from "./githubStartWork";

vi.mock("./api", () => ({
  api: {
    ensureProjectWorktreeForBranch: vi.fn(),
  },
}));

import { api } from "./api";

const ensureProjectWorktreeForBranch = vi.mocked(
  api.ensureProjectWorktreeForBranch,
);

describe("githubWorkSlug", () => {
  it("lowercases and hyphenates ascii titles", () => {
    expect(githubWorkSlug("Open the matching session")).toBe(
      "open-the-matching-session",
    );
  });

  it("strips combining marks and drops empty results", () => {
    expect(githubWorkSlug("Café login")).toBe("cafe-login");
    expect(githubWorkSlug("로그인 폼")).toBe("");
  });

  it("caps length without leaving a trailing hyphen", () => {
    const slug = githubWorkSlug(
      "this is a very long pull request title that should be truncated",
    );
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("githubWorkSessionName", () => {
  it("prefixes the number and collapses whitespace", () => {
    expect(githubWorkSessionName(91, "  Open   the session ")).toBe(
      "#91 Open the session",
    );
  });

  it("falls back to the number when the title is empty", () => {
    expect(githubWorkSessionName(12, "   ")).toBe("#12");
  });
});

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

describe("findSessionsForGithubWork", () => {
  it("matches issue sessions on the planned branch name", () => {
    const sessions = [
      session("other", { branch: "issue-12-other" }),
      session("hit", { branch: "issue-12-login-form" }),
    ];
    expect(
      findSessionsForGithubWork(sessions, "/repo", {
        kind: "issue",
        number: 12,
        title: "Login form",
      }).map((item) => item.id),
    ).toEqual(["hit"]);
  });
});

describe("planGithubStartWork", () => {
  it("plans a PR checkout of the existing head branch", () => {
    expect(
      planGithubStartWork({
        kind: "pr",
        number: 91,
        title: "Open the matching session",
        headBranch: "feature/pr-session",
      }),
    ).toEqual({
      branch: "feature/pr-session",
      nameHint: "pr-91-open-the-matching-session",
      sessionName: "#91 Open the matching session",
      createIfMissing: false,
      fetchRef: "refs/pull/91/head",
    });
  });

  it("returns null when a PR has no head branch", () => {
    expect(
      planGithubStartWork({
        kind: "pr",
        number: 8,
        title: "No branch",
        headBranch: "  ",
      }),
    ).toBeNull();
  });

  it("plans a new issue branch from the title slug", () => {
    expect(
      planGithubStartWork({
        kind: "issue",
        number: 12,
        title: "Login form",
      }),
    ).toEqual({
      branch: "issue-12-login-form",
      nameHint: "issue-12-login-form",
      sessionName: "#12 Login form",
      createIfMissing: true,
      fetchRef: null,
    });
  });

  it("omits the slug from issue branches when none remains", () => {
    expect(
      planGithubStartWork({
        kind: "issue",
        number: 12,
        title: "로그인",
      }),
    ).toEqual({
      branch: "issue-12",
      nameHint: "issue-12",
      sessionName: "#12 로그인",
      createIfMissing: true,
      fetchRef: null,
    });
  });
});

describe("createGithubWorkSession", () => {
  beforeEach(() => {
    ensureProjectWorktreeForBranch.mockReset();
  });

  it("creates an isolated session when the worktree is new", async () => {
    ensureProjectWorktreeForBranch.mockResolvedValue({
      path: "/repo/.acorn/worktrees/pr-91-open",
      branch: "feature/pr-session",
      created: true,
    });
    const createSession = vi.fn().mockResolvedValue({ id: "s-new" });

    await createGithubWorkSession(
      createSession,
      "/repo",
      planGithubStartWork({
        kind: "pr",
        number: 91,
        title: "Open",
        headBranch: "feature/pr-session",
      })!,
    );

    expect(ensureProjectWorktreeForBranch).toHaveBeenCalledWith(
      "/repo",
      "feature/pr-session",
      "pr-91-open",
      false,
      "refs/pull/91/head",
    );
    expect(createSession).toHaveBeenCalledWith(
      "#91 Open",
      "/repo",
      true,
      "regular",
      null,
      true,
      "terminal",
      undefined,
      "/repo/.acorn/worktrees/pr-91-open",
    );
  });

  it("creates a non-isolated session when an existing checkout is reused", async () => {
    ensureProjectWorktreeForBranch.mockResolvedValue({
      path: "/repo",
      branch: "main",
      created: false,
    });
    const createSession = vi.fn().mockResolvedValue({ id: "s-root" });

    await createGithubWorkSession(createSession, "/repo", {
      branch: "main",
      nameHint: "pr-1-main",
      sessionName: "#1 Main",
      createIfMissing: false,
      fetchRef: "refs/pull/1/head",
    });

    expect(createSession).toHaveBeenCalledWith(
      "#1 Main",
      "/repo",
      false,
      "regular",
      null,
      true,
      "terminal",
      undefined,
      "/repo",
    );
  });
});

describe("runGithubStartWork", () => {
  beforeEach(() => {
    ensureProjectWorktreeForBranch.mockReset();
    window.localStorage.clear();
  });

  it("links a created PR session to its head branch", async () => {
    ensureProjectWorktreeForBranch.mockResolvedValue({
      path: "/repo/.acorn/worktrees/pr-91-open",
      branch: "feature/pr-session",
      created: true,
    });
    const createSession = vi.fn().mockResolvedValue({ id: "s-new" });

    const result = await runGithubStartWork({
      repoPath: "/repo",
      target: {
        kind: "pr",
        number: 91,
        title: "Open",
        headBranch: "feature/pr-session",
      },
      createSession,
      consumeError: () => null,
    });

    expect(result).toEqual({ ok: true, session: { id: "s-new" } });
    expect(readSessionPullRequestBranchLinks()).toEqual({
      "s-new": { repoPath: "/repo", headBranch: "feature/pr-session" },
    });
  });

  it("returns a planned failure when a PR has no head branch", async () => {
    const result = await runGithubStartWork({
      repoPath: "/repo",
      target: { kind: "pr", number: 8, title: "No branch", headBranch: "  " },
      createSession: vi.fn(),
      consumeError: () => null,
    });

    expect(result).toEqual({ ok: false, error: null });
    expect(ensureProjectWorktreeForBranch).not.toHaveBeenCalled();
  });

  it("surfaces store errors without writing a PR link", async () => {
    ensureProjectWorktreeForBranch.mockResolvedValue({
      path: "/repo/.acorn/worktrees/issue-12",
      branch: "issue-12-login-form",
      created: true,
    });
    const result = await runGithubStartWork({
      repoPath: "/repo",
      target: { kind: "issue", number: 12, title: "Login form" },
      createSession: vi.fn().mockResolvedValue({ id: "s-issue" }),
      consumeError: () => "disk full",
    });

    expect(result).toEqual({ ok: false, error: "disk full" });
    expect(readSessionPullRequestBranchLinks()).toEqual({});
  });
});
