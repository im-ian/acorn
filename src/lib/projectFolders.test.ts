import { describe, expect, it } from "vitest";
import {
  buildProjectFolderGroups,
  defaultProjectFolderId,
  ensureProjectFolders,
  makeDefaultProjectFolder,
  resolveProjectFolderIdForSession,
  type ProjectFolder,
} from "./projectFolders";
import type { Project, Session } from "./types";

function project(repoPath: string, position = 0): Project {
  return {
    repo_path: repoPath,
    name: repoPath.split("/").pop() ?? repoPath,
    created_at: "2026-01-01T00:00:00Z",
    position,
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
    title_source: "default",
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

function folder(
  id: string,
  repoPath: string,
  cwdPath: string,
  name = id,
): ProjectFolder {
  return {
    id,
    repoPath,
    name,
    cwdPath,
    position: 1,
  };
}

describe("project folders", () => {
  it("creates a default folder per known project", () => {
    const folders = ensureProjectFolders([project("/repo/app")], [], {});

    expect(folders["/repo/app"]).toEqual([
      {
        id: defaultProjectFolderId("/repo/app"),
        repoPath: "/repo/app",
        name: "Default",
        cwdPath: "/repo/app",
        position: 0,
      },
    ]);
  });

  it("keeps unassigned sessions in the default folder", () => {
    const repoPath = "/repo/app";
    const folders = [
      makeDefaultProjectFolder(repoPath),
      folder("frontend", repoPath, "/repo/app/apps/web"),
      folder("src", repoPath, "/repo/app/apps/web/src"),
    ];
    const s = session("s1", repoPath, {
      worktree_path: "/repo/app/apps/web/src/routes",
    });

    expect(resolveProjectFolderIdForSession(folders, s)).toBe(repoPath);
  });

  it("uses explicit session assignments for conceptual folders", () => {
    const repoPath = "/repo/app";
    const folders = [
      makeDefaultProjectFolder(repoPath),
      folder("frontend", repoPath, "/repo/app/apps/web"),
    ];
    const s = session("s1", repoPath, {
      worktree_path: "/repo/app/apps/web",
    });

    expect(resolveProjectFolderIdForSession(folders, s, { s1: "frontend" })).toBe(
      "frontend",
    );
  });

  it("groups explicitly assigned sessions into conceptual folders", () => {
    const repoPath = "/repo/app";
    const frontend = folder("frontend", repoPath, "/repo/app/apps/web", "Frontend");
    const groups = buildProjectFolderGroups(
      [project(repoPath)],
      [
        session("s1", repoPath, { worktree_path: "/repo/app/apps/web" }),
        session("s2", repoPath, { worktree_path: "/repo/app/apps/web" }),
        session("root", repoPath),
      ],
      {
        [repoPath]: [makeDefaultProjectFolder(repoPath), frontend],
      },
      { s1: "frontend", s2: "frontend" },
    );

    expect(groups[0].folders.map((group) => group.folder.id)).toEqual([
      repoPath,
      "frontend",
    ]);
    expect(groups[0].folders[0].sessions.map((s) => s.id)).toEqual(["root"]);
    expect(groups[0].folders[1].sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});
