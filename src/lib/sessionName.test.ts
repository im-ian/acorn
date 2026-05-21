import { afterEach, describe, expect, it, vi } from "vitest";
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

function mockRandomUuid(...uuids: ReturnType<Crypto["randomUUID"]>[]) {
  const spy = vi.spyOn(crypto, "randomUUID");
  for (const uuid of uuids) {
    spy.mockReturnValueOnce(uuid);
  }
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("uses `{repo}-worktree-{random}` for isolated sessions", () => {
    mockRandomUuid("a3f5527e-9c10-4000-8000-000000000000");

    expect(suggestSessionName("/Users/x/acorn", [], "regular", true)).toBe(
      "acorn-worktree-a3f5527e9c10",
    );
  });

  it("retries on random-name collision for isolated sessions", () => {
    mockRandomUuid(
      "a3f5527e-9c10-4000-8000-000000000000",
      "b4c66311-2d21-4000-8000-000000000000",
    );
    const existing = [session("acorn-worktree-a3f5527e9c10")];

    expect(suggestSessionName("/Users/x/acorn", existing, "regular", true)).toBe(
      "acorn-worktree-b4c663112d21",
    );
  });

  it("isolated naming ignores regular-session collisions in the same repo", () => {
    mockRandomUuid("a3f5527e-9c10-4000-8000-000000000000");
    // A regular session named `acorn` should not consume the isolated
    // worktree namespace.
    const existing = [session("acorn"), session("acorn-2")];
    expect(suggestSessionName("/Users/x/acorn", existing, "regular", true)).toBe(
      "acorn-worktree-a3f5527e9c10",
    );
  });

  it("strips trailing separators when computing basename", () => {
    mockRandomUuid("a3f5527e-9c10-4000-8000-000000000000");

    expect(suggestSessionName("/Users/x/acorn/", [])).toBe("acorn");
    expect(suggestSessionName("/Users/x/acorn/", [], "regular", true)).toBe(
      "acorn-worktree-a3f5527e9c10",
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
