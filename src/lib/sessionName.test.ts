import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./types";
import {
  suggestDefaultSessionName,
  suggestLocalSessionName,
  suggestSessionName,
} from "./sessionName";
import { WORKTREE_CITY_SLUGS } from "./worktreeCitySlugs";

function session(name: string): Session {
  return {
    id: name,
    name,
    repo_path: "/repo",
    worktree_path: "/repo",
    branch: "main",
    isolated: false,
    status: "ready",
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
  it("uses the default placeholder for a fresh regular session", () => {
    expect(suggestSessionName("/Users/x/acorn", [])).toBe("new session");
  });

  it("starts numeric suffixes at one for regular sessions", () => {
    const existing = [session("new session")];
    expect(suggestSessionName("/Users/x/acorn", existing)).toBe(
      "new session-1",
    );
  });

  it("walks past multiple existing collisions", () => {
    const existing = [
      session("new session"),
      session("new session-1"),
      session("new session-2"),
    ];
    expect(suggestSessionName("/Users/x/acorn", existing)).toBe(
      "new session-3",
    );
  });

  it("prefixes control sessions to keep them in their own namespace", () => {
    expect(suggestSessionName("/Users/x/acorn", [], "control")).toBe(
      "control-acorn",
    );
  });

  it("uses `{repo}-worktree-{city}` for isolated sessions", () => {
    mockRandomUuid("00000000-0000-4000-8000-000000000000");

    expect(suggestSessionName("/Users/x/acorn", [], "regular", true)).toBe(
      "acorn-worktree-seoul",
    );
  });

  it("retries on random-name collision for isolated sessions", () => {
    mockRandomUuid(
      "00000000-0000-4000-8000-000000000000",
      "00000001-0000-4000-8000-000000000000",
    );
    const existing = [session("acorn-worktree-seoul")];

    expect(suggestSessionName("/Users/x/acorn", existing, "regular", true)).toBe(
      "acorn-worktree-tokyo",
    );
  });

  it("isolated naming ignores regular-session collisions in the same repo", () => {
    mockRandomUuid("00000000-0000-4000-8000-000000000000");
    // A regular session name should not consume the isolated
    // worktree namespace.
    const existing = [session("new session"), session("new session-1")];
    expect(suggestSessionName("/Users/x/acorn", existing, "regular", true)).toBe(
      "acorn-worktree-seoul",
    );
  });

  it("strips trailing separators when computing basename", () => {
    mockRandomUuid("00000000-0000-4000-8000-000000000000");

    expect(suggestSessionName("/Users/x/acorn/", [])).toBe("new session");
    expect(suggestSessionName("/Users/x/acorn/", [], "regular", true)).toBe(
      "acorn-worktree-seoul",
    );
  });
});

describe("WORKTREE_CITY_SLUGS", () => {
  it("keeps a broad pool of path-safe city slugs", () => {
    expect(WORKTREE_CITY_SLUGS.length).toBeGreaterThanOrEqual(200);
    expect(new Set(WORKTREE_CITY_SLUGS).size).toBe(WORKTREE_CITY_SLUGS.length);
    expect(WORKTREE_CITY_SLUGS).toContain("seoul");
    expect(WORKTREE_CITY_SLUGS).toContain("new-york");
    expect(WORKTREE_CITY_SLUGS).toContain("sao-paulo");
    for (const slug of WORKTREE_CITY_SLUGS) {
      expect(slug).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });
});

describe("suggestDefaultSessionName", () => {
  it("uses new session as the shared placeholder", () => {
    expect(suggestDefaultSessionName([])).toBe("new session");
  });
});

describe("suggestLocalSessionName", () => {
  it("uses the shared default namespace independent of cwd basename", () => {
    expect(suggestLocalSessionName([])).toBe("new session");
  });

  it("bumps numeric suffix on collision", () => {
    expect(
      suggestLocalSessionName([
        session("new session"),
        session("new session-1"),
      ]),
    ).toBe("new session-2");
  });
});
