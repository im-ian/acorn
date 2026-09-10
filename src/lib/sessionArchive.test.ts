import { describe, expect, it } from "vitest";
import {
  archivedLocalSessions,
  archivedSessions,
  archivedSessionsForProject,
  isArchivedSession,
  liveSessions,
} from "./sessionArchive";
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

describe("session archive helpers", () => {
  it("treats a missing archived_at as live", () => {
    expect(isArchivedSession(session())).toBe(false);
    expect(isArchivedSession(session({ archived_at: null }))).toBe(false);
  });

  it("partitions live and archived sessions", () => {
    const live = session({ id: "live" });
    const parked = session({
      id: "parked",
      archived_at: "2026-04-01T00:00:00Z",
    });

    expect(liveSessions([live, parked]).map((item) => item.id)).toEqual([
      "live",
    ]);
    expect(archivedSessions([live, parked]).map((item) => item.id)).toEqual([
      "parked",
    ]);
  });

  it("groups archived project sessions by the owning project root", () => {
    const rootIndex = new Map([
      ["/repo", "/repo"],
      ["/repo/extra", "/repo"],
    ]);
    const sessions = [
      session({ id: "live", repo_path: "/repo" }),
      session({
        id: "parked-root",
        repo_path: "/repo",
        archived_at: "2026-04-01T00:00:00Z",
      }),
      session({
        id: "parked-source",
        repo_path: "/repo/extra",
        archived_at: "2026-04-01T00:00:00Z",
      }),
      session({
        id: "other-project",
        repo_path: "/other",
        archived_at: "2026-04-01T00:00:00Z",
      }),
      session({
        id: "local",
        repo_path: "/repo",
        project_scoped: false,
        archived_at: "2026-04-01T00:00:00Z",
      }),
    ];

    expect(
      archivedSessionsForProject(sessions, "/repo", rootIndex).map(
        (item) => item.id,
      ),
    ).toEqual(["parked-root", "parked-source"]);
    expect(archivedLocalSessions(sessions).map((item) => item.id)).toEqual([
      "local",
    ]);
  });
});
