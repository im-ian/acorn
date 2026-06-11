import { describe, expect, it } from "vitest";
import {
  buildLocalSessionFolderGroups,
  buildProjectFolderGroups,
  defaultProjectFolderId,
  ensureProjectFolders,
  makeDefaultProjectFolder,
  pruneSessionFolderAssignments,
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

  it("groups sessions into matching worktree workspaces without explicit assignments", () => {
    const repoPath = "/repo/app";
    const worktreePath = "/repo/app/.acorn/worktrees/app-worktree-123";
    const worktree = folder("worktree", repoPath, worktreePath, "Worktree");
    const groups = buildProjectFolderGroups(
      [project(repoPath)],
      [
        session("root", repoPath),
        session("worker", repoPath, { worktree_path: worktreePath }),
      ],
      {
        [repoPath]: [makeDefaultProjectFolder(repoPath), worktree],
      },
    );

    expect(groups[0].folders[0].sessions.map((s) => s.id)).toEqual(["root"]);
    expect(groups[0].folders[1].sessions.map((s) => s.id)).toEqual(["worker"]);
  });

  it("ignores stale assignments that move sessions across worktree workspace boundaries", () => {
    const repoPath = "/repo/app";
    const worktreePath = "/repo/app/.acorn/worktrees/app-worktree-123";
    const regular = folder("regular", repoPath, repoPath, "Regular");
    const worktree = folder("worktree", repoPath, worktreePath, "Worktree");
    const folders = [makeDefaultProjectFolder(repoPath), regular, worktree];
    const worker = session("worker", repoPath, { worktree_path: worktreePath });
    const root = session("root", repoPath);

    expect(
      resolveProjectFolderIdForSession(folders, worker, { worker: "regular" }),
    ).toBe("worktree");
    expect(
      resolveProjectFolderIdForSession(folders, root, { root: "worktree" }),
    ).toBe(repoPath);
    expect(
      pruneSessionFolderAssignments(
        { worker: "regular", root: "worktree" },
        [worker, root],
        { [repoPath]: folders },
      ),
    ).toEqual({});
  });

  it("preserves project order and attaches matching sessions", () => {
    const groups = buildProjectFolderGroups(
      [project("/repo/b", 0), project("/repo/a", 1)],
      [session("a1", "/repo/a"), session("b1", "/repo/b")],
      {
        "/repo/a": [makeDefaultProjectFolder("/repo/a")],
        "/repo/b": [makeDefaultProjectFolder("/repo/b")],
      },
    );

    expect(groups.map((group) => group.repoPath)).toEqual([
      "/repo/b",
      "/repo/a",
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["b1"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["a1"]);
  });

  it("backfills sessions whose project entry is missing", () => {
    const groups = buildProjectFolderGroups(
      [project("/repo/known", 0)],
      [session("ghost", "/repo/missing")],
      {
        "/repo/known": [makeDefaultProjectFolder("/repo/known")],
      },
    );

    expect(groups.map((group) => [group.repoPath, group.name])).toEqual([
      ["/repo/known", "known"],
      ["/repo/missing", "missing"],
    ]);
    expect(groups[1].folders.map((group) => group.folder.id)).toEqual([
      "/repo/missing",
    ]);
  });

  it("excludes local sessions from project folder groups", () => {
    const groups = buildProjectFolderGroups(
      [project("/repo/known", 0)],
      [
        session("project", "/repo/known"),
        session("local", "/Users/me", { project_scoped: false }),
      ],
      {
        "/repo/known": [makeDefaultProjectFolder("/repo/known")],
      },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["project"]);
  });

  it("groups local sessions into local workspaces", () => {
    const repoPath = "/Users/me";
    const scratch = folder("scratch", repoPath, repoPath, "Scratch");
    const groups = buildLocalSessionFolderGroups(
      [],
      [
        session("root", repoPath, { project_scoped: false }),
        session("notes", repoPath, { project_scoped: false }),
      ],
      {
        [repoPath]: [makeDefaultProjectFolder(repoPath), scratch],
      },
      { notes: "scratch" },
    );

    expect(groups.map((group) => group.repoPath)).toEqual([repoPath]);
    expect(groups[0].folders.map((group) => group.folder.id)).toEqual([
      repoPath,
      "scratch",
    ]);
    expect(groups[0].folders[0].sessions.map((s) => s.id)).toEqual(["root"]);
    expect(groups[0].folders[1].sessions.map((s) => s.id)).toEqual(["notes"]);
  });

  it("keeps empty local workspaces out of project groups", () => {
    const repoPath = "/Users/me";
    const scratch = folder("scratch", repoPath, repoPath, "Scratch");

    expect(
      buildProjectFolderGroups(
        [],
        [],
        { [repoPath]: [makeDefaultProjectFolder(repoPath), scratch] },
      ),
    ).toEqual([]);

    expect(
      buildLocalSessionFolderGroups(
        [],
        [],
        { [repoPath]: [makeDefaultProjectFolder(repoPath), scratch] },
      )[0].folders.map((group) => group.folder.id),
    ).toEqual([repoPath, "scratch"]);
  });

  it("hides stale empty projects that only mirror local sessions", () => {
    const groups = buildProjectFolderGroups(
      [project("/Users/me", 0), project("/repo/app", 1)],
      [
        session("local", "/Users/me", { project_scoped: false }),
        session("project", "/repo/app"),
      ],
      {
        "/Users/me": [makeDefaultProjectFolder("/Users/me")],
        "/repo/app": [makeDefaultProjectFolder("/repo/app")],
      },
    );

    expect(groups.map((group) => group.repoPath)).toEqual(["/repo/app"]);
  });

  it("sorts folder sessions by explicit position before created time", () => {
    const groups = buildProjectFolderGroups(
      [project("/repo/app", 0)],
      [
        session("newer", "/repo/app", {
          created_at: "2026-01-03T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
        }),
        session("pos-1", "/repo/app", { position: 1 }),
        session("pos-0", "/repo/app", { position: 0 }),
        session("older", "/repo/app", {
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        }),
      ],
      {
        "/repo/app": [makeDefaultProjectFolder("/repo/app")],
      },
    );

    expect(groups[0].folders[0].sessions.map((s) => s.id)).toEqual([
      "pos-0",
      "pos-1",
      "newer",
      "older",
    ]);
  });

  it("does not reorder unpositioned folder sessions when only updated time changes", () => {
    const groups = buildProjectFolderGroups(
      [project("/repo/app", 0)],
      [
        session("older-created", "/repo/app", {
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-05T00:00:00Z",
        }),
        session("newer-created", "/repo/app", {
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-03T00:00:00Z",
        }),
      ],
      {
        "/repo/app": [makeDefaultProjectFolder("/repo/app")],
      },
    );

    expect(groups[0].folders[0].sessions.map((s) => s.id)).toEqual([
      "newer-created",
      "older-created",
    ]);
  });
});
