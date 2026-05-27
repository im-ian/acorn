import { describe, expect, it } from "vitest";
import { buildLocalSessions, buildProjectGroups } from "./sessionGrouping";
import type { Project, Session } from "./types";

function project(repoPath: string, position: number): Project {
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

describe("buildProjectGroups", () => {
  it("preserves project order and attaches matching sessions", () => {
    const groups = buildProjectGroups(
      [project("/repo/b", 0), project("/repo/a", 1)],
      [session("a1", "/repo/a"), session("b1", "/repo/b")],
    );

    expect(groups.map((group) => group.repoPath)).toEqual([
      "/repo/b",
      "/repo/a",
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["b1"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["a1"]);
  });

  it("backfills sessions whose project entry is missing", () => {
    const groups = buildProjectGroups(
      [project("/repo/known", 0)],
      [session("ghost", "/repo/missing")],
    );

    expect(groups.map((group) => [group.repoPath, group.name])).toEqual([
      ["/repo/known", "known"],
      ["/repo/missing", "missing"],
    ]);
  });

  it("excludes local sessions from project groups", () => {
    const groups = buildProjectGroups(
      [project("/repo/known", 0)],
      [
        session("project", "/repo/known"),
        session("local", "/Users/me", { project_scoped: false }),
      ],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["project"]);
  });

  it("hides stale empty projects that only mirror local sessions", () => {
    const groups = buildProjectGroups(
      [project("/Users/me", 0), project("/repo/app", 1)],
      [
        session("local", "/Users/me", { project_scoped: false }),
        session("project", "/repo/app"),
      ],
    );

    expect(groups.map((group) => group.repoPath)).toEqual(["/repo/app"]);
  });

  it("sorts sessions by explicit position before created time", () => {
    const groups = buildProjectGroups(
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
    );

    expect(groups[0].sessions.map((s) => s.id)).toEqual([
      "pos-0",
      "pos-1",
      "newer",
      "older",
    ]);
  });

  it("does not reorder unpositioned sessions when only updated time changes", () => {
    const groups = buildProjectGroups(
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
    );

    expect(groups[0].sessions.map((s) => s.id)).toEqual([
      "newer-created",
      "older-created",
    ]);
  });
});

describe("buildLocalSessions", () => {
  it("selects non-project sessions and uses the same ordering rules", () => {
    const local = buildLocalSessions([
      session("project", "/repo/app"),
      session("newer", "/Users/me", {
        project_scoped: false,
        created_at: "2026-01-03T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
      }),
      session("pos-0", "/Users/me", {
        project_scoped: false,
        position: 0,
      }),
      session("older", "/Users/me", {
        project_scoped: false,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      }),
    ]);

    expect(local.map((s) => s.id)).toEqual(["pos-0", "newer", "older"]);
  });
});
