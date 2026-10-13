import { describe, expect, it } from "vitest";
import type { ProjectFolder } from "./projectFolders";
import {
  canAssignSessionToWorkspace,
  canCreateWorkspaceFromSessionWorktree,
} from "./sessionWorkspaces";
import type { Session } from "./types";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    name: "session-1",
    repo_path: "/repo",
    worktree_path: "/repo",
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

function folder(overrides: Partial<ProjectFolder> = {}): ProjectFolder {
  return {
    id: "folder-1",
    repoPath: "/repo",
    name: "feature",
    cwdPath: "/repo/.worktrees/feature",
    position: 1,
    ...overrides,
  };
}

describe("canCreateWorkspaceFromSessionWorktree", () => {
  const worktree = session({
    isolated: true,
    in_worktree: true,
    worktree_path: "/repo/.worktrees/feature",
  });

  it("requires a recorded worktree that is not the repo root", () => {
    expect(
      canCreateWorkspaceFromSessionWorktree(session(), [folder()], undefined),
    ).toBe(false);
    expect(
      canCreateWorkspaceFromSessionWorktree(
        session({ isolated: true, worktree_path: "/repo" }),
        [folder()],
        undefined,
      ),
    ).toBe(false);
  });

  it("hides the action once the session already lives in a named workspace", () => {
    const named = folder({ id: "named", cwdPath: "/repo/src" });
    expect(
      canCreateWorkspaceFromSessionWorktree(worktree, [named], named.id),
    ).toBe(false);
  });

  it("hides the action when a workspace already points at the worktree", () => {
    const existing = folder();
    expect(
      canCreateWorkspaceFromSessionWorktree(worktree, [existing], "/repo"),
    ).toBe(false);
  });

  it("allows creation from the project root", () => {
    expect(
      canCreateWorkspaceFromSessionWorktree(
        worktree,
        [folder({ id: "/repo", name: "Default", cwdPath: "/repo" })],
        "/repo",
      ),
    ).toBe(true);
  });
});

describe("canAssignSessionToWorkspace", () => {
  const worktreeSession = session({
    worktree_path: "/repo/.worktrees/feature",
  });

  it("refuses to leave a worktree workspace", () => {
    const current = folder({ id: "current" });
    expect(
      canAssignSessionToWorkspace(
        worktreeSession,
        current,
        folder({ id: "other", cwdPath: "/repo/src" }),
      ),
    ).toBe(false);
  });

  it("only assigns a session to the worktree workspace of its own path", () => {
    const target = folder();
    expect(
      canAssignSessionToWorkspace(
        session({ worktree_path: "/repo/.worktrees/other" }),
        null,
        target,
      ),
    ).toBe(false);
    expect(canAssignSessionToWorkspace(worktreeSession, null, target)).toBe(
      true,
    );
  });
});
