import { describe, expect, it } from "vitest";
import {
  ipcCloseRemovesWorktree,
  parseIpcSessionCloseRemovalNotice,
  parseIpcSessionCloseRequest,
} from "./ipcSessionClose";
import type { ProjectFoldersByRepo } from "./projectFolders";
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

const foldersByRepo: ProjectFoldersByRepo = {
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

describe("ipcCloseRemovesWorktree", () => {
  const solo = session({
    isolated: true,
    worktree_path: "/repo/.acorn/worktrees/solo",
  });

  it("deletes a standalone isolated worktree when confirmation is off", () => {
    expect(ipcCloseRemovesWorktree(solo, foldersByRepo, [solo], false)).toBe(
      true,
    );
  });

  it("keeps the worktree when confirmation is on", () => {
    expect(ipcCloseRemovesWorktree(solo, foldersByRepo, [solo], true)).toBe(
      false,
    );
  });

  it("keeps the worktree when the session owns others", () => {
    const worker = session({
      id: "worker",
      owner: { kind: "control", session_id: solo.id },
      worktree_path: "/repo/.acorn/worktrees/worker",
    });
    expect(
      ipcCloseRemovesWorktree(solo, foldersByRepo, [solo, worker], false),
    ).toBe(false);
  });

  it("keeps a worktree another session still uses", () => {
    const peer = session({
      id: "peer",
      repo_path: "/other",
      isolated: true,
      worktree_path: "/repo/.acorn/worktrees/solo/",
    });
    expect(
      ipcCloseRemovesWorktree(solo, foldersByRepo, [solo, peer], false),
    ).toBe(false);
  });

  it("keeps linked worktrees and workspace-folder checkouts", () => {
    const linked = session({
      isolated: false,
      in_worktree: true,
      worktree_path: "/repo/.acorn/worktrees/solo",
    });
    const workspace = session({
      isolated: true,
      in_worktree: true,
      worktree_path: "/repo/.acorn/worktrees/shared",
    });
    expect(ipcCloseRemovesWorktree(linked, foldersByRepo, [linked], false)).toBe(
      false,
    );
    expect(
      ipcCloseRemovesWorktree(workspace, foldersByRepo, [workspace], false),
    ).toBe(false);
  });

  it("keeps the worktree when the session is missing", () => {
    expect(ipcCloseRemovesWorktree(null, foldersByRepo, [], false)).toBe(false);
  });
});

describe("parseIpcSessionCloseRequest", () => {
  it("accepts a request id and session id", () => {
    expect(
      parseIpcSessionCloseRequest({
        request_id: "req",
        session_id: "sess",
      }),
    ).toEqual({ request_id: "req", session_id: "sess" });
  });

  it("rejects an empty payload", () => {
    expect(parseIpcSessionCloseRequest({ request_id: "", session_id: "sess" })).toBe(
      null,
    );
    expect(parseIpcSessionCloseRequest(null)).toBe(null);
  });
});

describe("parseIpcSessionCloseRemovalNotice", () => {
  it("maps the snake_case removal token onto the toast payload", () => {
    expect(
      parseIpcSessionCloseRemovalNotice({
        removal: {
          token: "tok",
          repo_path: "/repo",
          worktree_path: "/repo/.acorn/worktrees/solo",
          git_common_dir: "/repo/.git",
          session_ids: ["sess"],
        },
        issues: [
          {
            kind: "worktree",
            target: "/repo/.acorn/worktrees/solo",
            message: "busy",
            retryable: true,
          },
        ],
        retry_token: "retry",
      }),
    ).toEqual({
      removal: {
        token: "tok",
        repoPath: "/repo",
        worktreePath: "/repo/.acorn/worktrees/solo",
        gitCommonDir: "/repo/.git",
        sessionIds: ["sess"],
      },
      issues: [
        {
          kind: "worktree",
          target: "/repo/.acorn/worktrees/solo",
          message: "busy",
          retryable: true,
        },
      ],
      retryToken: "retry",
    });
  });

  it("returns an empty notice when the close did not stage a worktree", () => {
    expect(parseIpcSessionCloseRemovalNotice({ action: "removed" })).toEqual({
      removal: null,
      issues: [],
      retryToken: null,
    });
  });
});
