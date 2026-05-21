import { describe, expect, it } from "vitest";
import {
  buildSessionCreateRequest,
  buildSessionCreateRequestFromScope,
  resolveActiveSessionScope,
  resolveProjectScopedForRepoPath,
} from "./sessionCreation";
import type { Project, Session } from "./types";

function project(repoPath: string): Project {
  return {
    repo_path: repoPath,
    name: repoPath.split("/").pop() ?? repoPath,
    created_at: "2026-01-01T00:00:00Z",
    position: 0,
  };
}

function session(
  id: string,
  repoPath: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    name: id,
    repo_path: repoPath,
    worktree_path: repoPath,
    branch: "main",
    isolated: false,
    status: "idle",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

describe("session creation policy", () => {
  it("keeps repo paths with only local sessions in local scope", () => {
    const sessions = [
      session("local", "/Users/me", { project_scoped: false }),
    ];

    expect(
      resolveProjectScopedForRepoPath(
        { sessions, projects: [project("/Users/me")] },
        "/Users/me",
      ),
    ).toBe(false);
  });

  it("uses project scope when a project-scoped session exists", () => {
    const sessions = [
      session("local", "/repo/app", { project_scoped: false }),
      session("project", "/repo/app", { project_scoped: true }),
    ];

    expect(
      resolveProjectScopedForRepoPath({ sessions, projects: [] }, "/repo/app"),
    ).toBe(true);
  });

  it("uses the active session scope before the active workspace repo path", () => {
    const sessions = [
      session("local", "/Users/me", { project_scoped: false }),
    ];

    expect(
      resolveActiveSessionScope({
        sessions,
        projects: [project("/repo/app")],
        activeSessionId: "local",
        activeWorkspaceRepoPath: "/repo/app",
      }),
    ).toEqual({ repoPath: "/Users/me", projectScoped: false });
  });

  it("builds local session requests with local naming", () => {
    const sessions = [
      session("local", "/Users/me", {
        name: "terminal",
        project_scoped: false,
      }),
    ];

    expect(
      buildSessionCreateRequest(
        { sessions, projects: [] },
        { repoPath: "/Users/me", projectScoped: false },
      ),
    ).toMatchObject({
      name: "terminal-2",
      repoPath: "/Users/me",
      projectScoped: false,
    });
  });

  it("preserves explicit names and scope", () => {
    expect(
      buildSessionCreateRequestFromScope(
        { sessions: [], projects: [] },
        { repoPath: "/Users/me", projectScoped: false },
        { name: "codex-copy", agentProvider: "codex" },
      ),
    ).toMatchObject({
      name: "codex-copy",
      repoPath: "/Users/me",
      agentProvider: "codex",
      projectScoped: false,
    });
  });
});
