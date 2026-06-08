import { describe, expect, it } from "vitest";
import { buildLocalSessions } from "./sessionGrouping";
import type { Session } from "./types";

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
