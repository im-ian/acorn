import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import { hasRecordedWorktree } from "./sessionWorktree";

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
