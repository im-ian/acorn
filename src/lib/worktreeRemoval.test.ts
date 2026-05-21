import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import {
  isNamedAcornWorktree,
  shouldOfferWorktreeRemoval,
} from "./worktreeRemoval";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "s1",
    repo_path: "/Users/me/acorn",
    worktree_path: "/Users/me/acorn",
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

describe("worktreeRemoval", () => {
  it("recognizes acorn worktree basenames with one or two numeric suffixes", () => {
    expect(isNamedAcornWorktree("/tmp/acorn-worktree-1")).toBe(true);
    expect(isNamedAcornWorktree("/tmp/acorn-worktree-1-2")).toBe(true);
    expect(isNamedAcornWorktree("/tmp/not-acorn-worktree-1")).toBe(false);
    expect(isNamedAcornWorktree("/tmp/acorn-worktree-x")).toBe(false);
  });

  it("always offers worktree removal for isolated sessions", () => {
    expect(
      shouldOfferWorktreeRemoval(
        session({ isolated: true, worktree_path: "/tmp/feature" }),
      ),
    ).toBe(true);
  });

  it("offers removal for non-isolated acorn-worktree linked worktrees", () => {
    expect(
      shouldOfferWorktreeRemoval(
        session({
          in_worktree: true,
          worktree_path: "/tmp/acorn-worktree-1-2",
        }),
      ),
    ).toBe(true);
  });

  it("does not offer removal for ordinary non-isolated linked worktrees", () => {
    expect(
      shouldOfferWorktreeRemoval(
        session({
          in_worktree: true,
          worktree_path: "/tmp/release-worktree",
        }),
      ),
    ).toBe(false);
  });
});
