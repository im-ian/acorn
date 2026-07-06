import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import {
  canDeleteSessionWorktree,
  controlOwnedSessionCount,
  hasRecordedWorktree,
  isSessionInWorktreeWorkspace,
  otherSessionsUsingProjectWorktree,
  otherSessionsUsingWorktreePath,
  sessionRemovalCascadeIds,
  sessionsUsingProjectWorktree,
  sessionsUsingWorktreePath,
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

  it("preserves worktrees that another session still uses", () => {
    const target = session({
      id: "target",
      isolated: true,
      worktree_path: "/repo/.acorn/worktrees/solo",
    });
    const peer = session({
      id: "peer",
      repo_path: "/other",
      isolated: true,
      worktree_path: "/repo/.acorn/worktrees/solo/",
    });

    expect(canDeleteSessionWorktree(target, foldersByRepo, [target, peer])).toBe(
      false,
    );
    expect(
      shouldAutoDeleteSessionWorktree(target, foldersByRepo, [target, peer]),
    ).toBe(false);
  });

  it("allows worktree deletion when only control-owned workers share it", () => {
    const target = session({
      id: "control",
      kind: "control",
      isolated: true,
      worktree_path: "/repo/.acorn/worktrees/solo",
    });
    const worker = session({
      id: "worker",
      worktree_path: "/repo/.acorn/worktrees/solo/",
      owner: { kind: "control", session_id: "control" },
    });

    expect(canDeleteSessionWorktree(target, foldersByRepo, [target, worker])).toBe(
      true,
    );
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

describe("sessionRemovalCascadeIds", () => {
  it("includes nested control-owned descendants", () => {
    const control = session({ id: "control", kind: "control" });
    const worker = session({
      id: "worker",
      owner: { kind: "control", session_id: "control" },
    });
    const nested = session({
      id: "nested",
      owner: { kind: "control", session_id: "worker" },
    });
    const user = session({ id: "user" });

    const ids = sessionRemovalCascadeIds([control, worker, nested, user], control);

    expect([...ids].sort()).toEqual(["control", "nested", "worker"]);
    expect(controlOwnedSessionCount([control, worker, nested, user], control)).toBe(
      2,
    );
  });
});

describe("sessionsUsingProjectWorktree", () => {
  it("matches sessions by repo and normalized worktree path", () => {
    const sessions = [
      session({
        id: "active",
        worktree_path: "/repo/.acorn/worktrees/feature",
      }),
      session({
        id: "trailing",
        worktree_path: "/repo/.acorn/worktrees/feature/",
      }),
      session({
        id: "other-repo",
        repo_path: "/other",
        worktree_path: "/repo/.acorn/worktrees/feature",
      }),
      session({
        id: "windows",
        repo_path: "C:\\repo",
        worktree_path: "C:\\repo\\.acorn\\worktrees\\feature",
      }),
    ];

    expect(
      sessionsUsingProjectWorktree(
        sessions,
        "/repo",
        "/repo/.acorn/worktrees/feature/",
      ).map((candidate) => candidate.id),
    ).toEqual(["active", "trailing"]);
    expect(
      sessionsUsingProjectWorktree(
        sessions,
        "C:/repo",
        "C:/repo/.acorn/worktrees/feature/",
      ).map((candidate) => candidate.id),
    ).toEqual(["windows"]);
  });

  it("reports only non-active sessions as other users", () => {
    const sessions = [
      session({
        id: "active",
        worktree_path: "/repo/.acorn/worktrees/feature",
      }),
      session({
        id: "other",
        worktree_path: "/repo/.acorn/worktrees/feature",
      }),
    ];

    expect(
      otherSessionsUsingProjectWorktree(
        sessions,
        "/repo",
        "/repo/.acorn/worktrees/feature",
        "active",
      ).map((candidate) => candidate.id),
    ).toEqual(["other"]);
  });
});

describe("sessionsUsingWorktreePath", () => {
  it("matches sessions by worktree path even when repo paths differ", () => {
    const sessions = [
      session({
        id: "active",
        repo_path: "/repo",
        worktree_path: "/repo/.acorn/worktrees/feature",
      }),
      session({
        id: "peer",
        repo_path: "/other",
        worktree_path: "/repo/.acorn/worktrees/feature/",
      }),
    ];

    expect(
      sessionsUsingWorktreePath(
        sessions,
        "/repo/.acorn/worktrees/feature",
      ).map((candidate) => candidate.id),
    ).toEqual(["active", "peer"]);
    expect(
      otherSessionsUsingWorktreePath(
        sessions,
        "/repo/.acorn/worktrees/feature",
        "active",
      ).map((candidate) => candidate.id),
    ).toEqual(["peer"]);
  });
});
