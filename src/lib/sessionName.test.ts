import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import { suggestLocalSessionName, suggestSessionName } from "./sessionName";

function session(name: string): Session {
  return {
    id: name,
    name,
    repo_path: "/repo",
    worktree_path: "/repo",
    branch: "main",
    isolated: false,
    status: "idle",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
  } as Session;
}

describe("suggestSessionName", () => {
  it("uses repo basename for a fresh regular session", () => {
    expect(suggestSessionName("/Users/x/acorn", [])).toBe("acorn");
  });

  it("bumps numeric suffix on collision for regular sessions", () => {
    const existing = [session("acorn")];
    expect(suggestSessionName("/Users/x/acorn", existing)).toBe("acorn-2");
  });

  it("walks past multiple existing collisions", () => {
    const existing = [session("acorn"), session("acorn-2"), session("acorn-3")];
    expect(suggestSessionName("/Users/x/acorn", existing)).toBe("acorn-4");
  });

  it("prefixes control sessions to keep them in their own namespace", () => {
    expect(suggestSessionName("/Users/x/acorn", [], "control")).toBe(
      "control-acorn",
    );
  });

  // Regression: isolated sessions used to inherit the same naming as regular
  // ones (`acorn`), which collided with the existing `acorn` branch the
  // moment libgit2 tried to auto-create a worktree branch — see
  // `create_unique_worktree` in src-tauri/src/commands.rs.
  it("uses `{repo}-worktree-{n}` for the first isolated session", () => {
    expect(suggestSessionName("/Users/x/acorn", [], "regular", true)).toBe(
      "acorn-worktree-1",
    );
  });

  it("bumps the worktree suffix on collision for isolated sessions", () => {
    const existing = [session("acorn-worktree-1"), session("acorn-worktree-2")];
    expect(suggestSessionName("/Users/x/acorn", existing, "regular", true)).toBe(
      "acorn-worktree-3",
    );
  });

  it("isolated naming ignores regular-session collisions in the same repo", () => {
    // A regular session named `acorn` should not consume the
    // `acorn-worktree-1` slot — the two namespaces are independent.
    const existing = [session("acorn"), session("acorn-2")];
    expect(suggestSessionName("/Users/x/acorn", existing, "regular", true)).toBe(
      "acorn-worktree-1",
    );
  });

  it("strips trailing separators when computing basename", () => {
    expect(suggestSessionName("/Users/x/acorn/", [])).toBe("acorn");
    expect(suggestSessionName("/Users/x/acorn/", [], "regular", true)).toBe(
      "acorn-worktree-1",
    );
  });
});

describe("suggestLocalSessionName", () => {
  it("uses a terminal namespace independent of cwd basename", () => {
    expect(suggestLocalSessionName([])).toBe("terminal");
  });

  it("bumps numeric suffix on collision", () => {
    expect(
      suggestLocalSessionName([
        session("terminal"),
        session("terminal-2"),
      ]),
    ).toBe("terminal-3");
  });
});
