import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import {
  canDeleteSessionWorktree,
  hasRecordedWorktree,
  isSessionInWorktreeWorkspace,
  shouldAutoDeleteSessionWorktree,
} from "./sessionWorktree";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    name: "session-1",
    repo_path: "/repo",
    worktree_path: "/repo",
    branch: "main",
    isolated: false,
    status: "idle",
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

describe("hasRecordedWorktree", () => {
  it("treats Acorn isolated sessions as worktree-backed", () => {
    expect(hasRecordedWorktree(session({ isolated: true }))).toBe(true);
  });

  it("treats adopted linked worktree sessions as worktree-backed", () => {
    expect(hasRecordedWorktree(session({ in_worktree: true }))).toBe(true);
  });

  it("does not infer a removable worktree for ordinary repo sessions", () => {
    expect(hasRecordedWorktree(session())).toBe(false);
  });
});

describe("worktree deletion policy", () => {
  const foldersByRepo = {
    "/repo": [
      {
        id: "/repo",
        repoPath: "/repo",
        name: "Default",
        cwdPath: "/repo",
        position: 0,
      },
      {
        id: "project-folder:/repo:shared",
        repoPath: "/repo",
        name: "Shared",
        cwdPath: "/repo/.acorn/worktrees/shared",
        position: 1,
      },
    ],
  };

  it("auto-deletes standalone isolated sessions", () => {
    const target = session({
      isolated: true,
      worktree_path: "/repo/.acorn/worktrees/solo",
    });

    expect(isSessionInWorktreeWorkspace(target, foldersByRepo)).toBe(false);
    expect(canDeleteSessionWorktree(target, foldersByRepo)).toBe(true);
    expect(shouldAutoDeleteSessionWorktree(target, foldersByRepo)).toBe(true);
  });

  it("preserves isolated sessions that are backing a worktree workspace", () => {
    const target = session({
      isolated: true,
      worktree_path: "/repo/.acorn/worktrees/shared",
      in_worktree: true,
    });

    expect(isSessionInWorktreeWorkspace(target, foldersByRepo)).toBe(true);
    expect(canDeleteSessionWorktree(target, foldersByRepo)).toBe(false);
    expect(shouldAutoDeleteSessionWorktree(target, foldersByRepo)).toBe(false);
  });

  it("does not auto-delete linked worktree sessions", () => {
    const target = session({
      isolated: false,
      in_worktree: true,
      worktree_path: "/repo/.acorn/worktrees/solo",
    });

    expect(canDeleteSessionWorktree(target, foldersByRepo)).toBe(true);
    expect(shouldAutoDeleteSessionWorktree(target, foldersByRepo)).toBe(false);
  });
});
