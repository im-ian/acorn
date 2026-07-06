import { describe, expect, it } from "vitest";
import {
  applySessionCreateRequest,
  buildSessionCreateRequest,
  buildSessionCreateRequestFromScope,
  resolveActiveSessionScope,
  resolveProjectScopedForRepoPath,
  scopeForSession,
  scopeWithProjectRootLaunch,
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
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
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
    ).toMatchObject({
      placement: { repoPath: "/Users/me", projectScoped: false },
    });
  });

  it("uses the session worktree path for isolated session scope", () => {
    const isolated = session("isolated", "/repo/app", {
      isolated: true,
      project_scoped: true,
      worktree_path: "/repo/app/.acorn/worktrees/feature",
    });

    expect(scopeForSession(isolated)).toEqual({
      placement: {
        repoPath: "/repo/app",
        projectScoped: true,
      },
      launch: {
        kind: "workspaceCwd",
        cwdPath: "/repo/app/.acorn/worktrees/feature",
      },
    });
  });

  it("preserves an isolated active session cwd when resolving active scope", () => {
    const isolated = session("isolated", "/repo/app", {
      isolated: true,
      project_scoped: true,
      worktree_path: "/repo/app/.acorn/worktrees/feature",
    });

    expect(
      resolveActiveSessionScope({
        sessions: [isolated],
        projects: [project("/repo/app")],
        activeSessionId: "isolated",
        activeWorkspaceRepoPath: "/repo/app",
      }),
    ).toEqual({
      placement: {
        repoPath: "/repo/app",
        projectScoped: true,
      },
      launch: {
        kind: "workspaceCwd",
        cwdPath: "/repo/app/.acorn/worktrees/feature",
      },
    });
  });

  it("can root-launch a generic new session from an active worktree scope", () => {
    const isolated = session("isolated", "/repo/app", {
      isolated: true,
      project_scoped: true,
      worktree_path: "/repo/app/.acorn/worktrees/feature",
    });
    const scope = resolveActiveSessionScope({
      sessions: [isolated],
      projects: [project("/repo/app")],
      activeSessionId: "isolated",
      activeWorkspaceRepoPath: "/repo/app",
    });

    expect(scope).not.toBeNull();
    const request = buildSessionCreateRequestFromScope(
      { sessions: [isolated], projects: [project("/repo/app")] },
      scopeWithProjectRootLaunch(scope!),
      { name: "worker" },
    );

    expect(request).toMatchObject({
      name: "worker",
      repoPath: "/repo/app",
      cwdPath: "/repo/app",
      isolated: false,
      projectScoped: true,
    });
  });

  it("preserves the active project workspace when the active session is inside it", () => {
    const sessions = [
      session("web", "/repo/app", {
        project_scoped: true,
        worktree_path: "/repo/app",
      }),
    ];

    expect(
      resolveActiveSessionScope({
        sessions,
        projects: [project("/repo/app")],
        activeSessionId: "web",
        activeWorkspaceRepoPath: "/repo/app",
        activeWorkspaceCwdPath: "/repo/app/apps/web",
        activeProjectFolderId: "frontend",
      }),
    ).toEqual({
      placement: {
        repoPath: "/repo/app",
        projectScoped: true,
        projectFolderId: "frontend",
      },
      launch: {
        kind: "workspaceCwd",
        cwdPath: "/repo/app/apps/web",
      },
    });
  });

  it("does not assign the default project workspace as an explicit folder", () => {
    const sessions = [
      session("root", "/repo/app", {
        project_scoped: true,
        worktree_path: "/repo/app",
      }),
    ];

    expect(
      resolveActiveSessionScope({
        sessions,
        projects: [project("/repo/app")],
        activeSessionId: "root",
        activeWorkspaceRepoPath: "/repo/app",
        activeWorkspaceCwdPath: "/repo/app",
        activeProjectFolderId: "/repo/app",
      }),
    ).toEqual({
      placement: {
        repoPath: "/repo/app",
        projectScoped: true,
      },
      launch: {
        kind: "workspaceCwd",
        cwdPath: "/repo/app",
      },
    });
  });

  it("preserves active workspace folder cwd and id when there is no active session", () => {
    expect(
      resolveActiveSessionScope({
        sessions: [],
        projects: [project("/repo/app")],
        activeWorkspaceRepoPath: "/repo/app",
        activeWorkspaceCwdPath: "/repo/app/apps/web",
        activeProjectFolderId: "frontend",
      }),
    ).toEqual({
      placement: {
        repoPath: "/repo/app",
        projectScoped: true,
        projectFolderId: "frontend",
      },
      launch: {
        kind: "workspaceCwd",
        cwdPath: "/repo/app/apps/web",
      },
    });
  });

  it("preserves the active local workspace when the active session is inside it", () => {
    const sessions = [
      session("local", "/Users/me", {
        project_scoped: false,
        worktree_path: "/Users/me",
      }),
    ];

    expect(
      resolveActiveSessionScope({
        sessions,
        projects: [],
        activeSessionId: "local",
        activeWorkspaceRepoPath: "/Users/me",
        activeWorkspaceCwdPath: "/Users/me/scratch",
        activeProjectFolderId: "scratch",
      }),
    ).toEqual({
      placement: {
        repoPath: "/Users/me",
        projectScoped: false,
        projectFolderId: "scratch",
      },
      launch: {
        kind: "workspaceCwd",
        cwdPath: "/Users/me/scratch",
      },
    });
  });

  it("builds local session requests with local naming", () => {
    const sessions = [
      session("local", "/Users/me", {
        name: "new session",
        project_scoped: false,
      }),
    ];

    expect(
      buildSessionCreateRequest(
        { sessions, projects: [] },
        { repoPath: "/Users/me", projectScoped: false },
      ),
    ).toMatchObject({
      name: "new session-1",
      repoPath: "/Users/me",
      cwdPath: "/Users/me",
      projectScoped: false,
    });
  });

  it("preserves explicit names and scope", () => {
    expect(
      buildSessionCreateRequestFromScope(
        { sessions: [], projects: [] },
        {
          placement: { repoPath: "/Users/me", projectScoped: false },
          launch: { kind: "projectRoot" },
        },
        { name: "codex-copy", agentProvider: "codex" },
      ),
    ).toMatchObject({
      name: "codex-copy",
      repoPath: "/Users/me",
      cwdPath: "/Users/me",
      agentProvider: "codex",
      projectScoped: false,
    });
  });

  it("applies project repo and workspace cwd as separate create args", async () => {
    const created = session("created", "/repo/app", {
      worktree_path: "/repo/app/.acorn/worktrees/app-worktree",
    });
    const createSession = async (
      _name: string,
      _repoPath: string,
      _isolated?: boolean,
      _kind?: Session["kind"],
      _agentProvider?: Session["agent_provider"],
      _projectScoped?: boolean,
      _mode?: Session["mode"],
      _projectFolderId?: string,
      _cwdPath?: string,
    ) => created;

    const calls: unknown[][] = [];
    const wrapped = async (...args: Parameters<typeof createSession>) => {
      calls.push(args);
      return createSession(...args);
    };

    await applySessionCreateRequest(wrapped, {
      name: "worker",
      repoPath: "/repo/app",
      cwdPath: "/repo/app/.acorn/worktrees/app-worktree",
      isolated: false,
      kind: "regular",
      agentProvider: null,
      projectScoped: true,
      mode: "terminal",
      projectFolderId: "worktree-folder",
    });

    expect(calls).toEqual([
      [
        "worker",
        "/repo/app",
        false,
        "regular",
        null,
        true,
        undefined,
        "worktree-folder",
        "/repo/app/.acorn/worktrees/app-worktree",
      ],
    ]);
  });
});
