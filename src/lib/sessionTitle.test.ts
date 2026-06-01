import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import {
  canAutoGenerateSessionTitle,
  canGenerateSessionTitle,
  canRenameSession,
  planAutoGenerateSessionTitles,
} from "./sessionTitle";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    name: "repo",
    repo_path: "/tmp/repo",
    worktree_path: "/tmp/repo",
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
    agent_provider: "codex",
    ...overrides,
  };
}

describe("session title helpers", () => {
  it("allows rename for user-owned sessions only", () => {
    expect(canRenameSession(session())).toBe(true);
    const legacy = { ...session() } as Partial<Session>;
    delete legacy.owner;
    expect(canRenameSession(legacy as Session)).toBe(true);
    expect(
      canRenameSession(
        session({ owner: { kind: "control", session_id: "control-1" } }),
      ),
    ).toBe(false);
    expect(
      canRenameSession(session(), { isGeneratingTitle: true }),
    ).toBe(false);
  });

  it("generates titles only for default user-owned regular sessions", () => {
    expect(canGenerateSessionTitle(session())).toBe(true);
    const legacy = { ...session() } as Partial<Session>;
    delete legacy.title_source;
    expect(canGenerateSessionTitle(legacy as Session)).toBe(false);
    expect(canGenerateSessionTitle(session({ title_source: "manual" }))).toBe(
      false,
    );
    expect(
      canGenerateSessionTitle(
        session({
          title_source: "generated",
          generated_title_transcript_id: "claude-1",
          agent_transcript_id: "claude-1",
        }),
      ),
    ).toBe(false);
    expect(
      canGenerateSessionTitle(
        session({
          title_source: "generated",
          generated_title_transcript_id: "claude-1",
          agent_transcript_id: "claude-2",
        }),
      ),
    ).toBe(true);
    expect(
      canGenerateSessionTitle(
        session({
          title_source: "generated",
          generated_title_transcript_id: null,
          agent_transcript_id: "claude-2",
        }),
      ),
    ).toBe(true);
    expect(canGenerateSessionTitle(session({ kind: "control" }))).toBe(false);
    expect(
      canGenerateSessionTitle(
        session({ owner: { kind: "control", session_id: "control-1" } }),
      ),
    ).toBe(false);
    expect(canGenerateSessionTitle(session({ agent_provider: null }))).toBe(true);
  });

  it("requires the global automatic title setting and an agent signal for background generation", () => {
    expect(canAutoGenerateSessionTitle(session(), false)).toBe(false);
    expect(canAutoGenerateSessionTitle(session(), true)).toBe(true);
    expect(
      canAutoGenerateSessionTitle(session({ agent_provider: null }), true),
    ).toBe(false);
    expect(
      canAutoGenerateSessionTitle(
        session({ agent_provider: null, status: "running" }),
        true,
      ),
    ).toBe(true);
    expect(
      canAutoGenerateSessionTitle(
        session({ agent_provider: null, name: "Claude task" }),
        true,
      ),
    ).toBe(true);
    expect(
      canAutoGenerateSessionTitle(
        session({
          agent_provider: null,
          mode: "chat",
          status: "needs_input",
        }),
        true,
      ),
    ).toBe(true);
  });

  it("plans immediate generation for eligible sessions only", () => {
    expect(
      planAutoGenerateSessionTitles({
        sessions: [
          session({ id: "ready" }),
          session({ id: "manual", title_source: "manual" }),
          session({ id: "terminal", agent_provider: null }),
          session({
            id: "detected-running",
            agent_provider: null,
            status: "running",
          }),
          session({
            id: "named-antigravity",
            agent_provider: null,
            name: "Antigravity task",
          }),
          session({
            id: "rotated-claude",
            title_source: "generated",
            generated_title_transcript_id: "claude-1",
            agent_transcript_id: "claude-2",
            agent_provider: null,
          }),
          session({
            id: "same-claude",
            title_source: "generated",
            generated_title_transcript_id: "claude-1",
            agent_transcript_id: "claude-1",
          }),
        ],
        enabled: true,
        inFlightIds: new Set(),
        lastAttemptAt: new Map(),
        now: 1_000,
        retryMs: 30_000,
      }),
    ).toEqual({
      sessionIds: [
        "ready",
        "detected-running",
        "named-antigravity",
        "rotated-claude",
      ],
      retryDelayMs: null,
    });
  });

  it("returns the next retry delay for recently attempted sessions", () => {
    expect(
      planAutoGenerateSessionTitles({
        sessions: [session({ id: "recent" }), session({ id: "later" })],
        enabled: true,
        inFlightIds: new Set(),
        lastAttemptAt: new Map([
          ["recent", 5_000],
          ["later", 10_000],
        ]),
        now: 20_000,
        retryMs: 30_000,
      }),
    ).toEqual({ sessionIds: [], retryDelayMs: 15_000 });
  });

  it("skips in-flight sessions while planning retries", () => {
    expect(
      planAutoGenerateSessionTitles({
        sessions: [session({ id: "busy" })],
        enabled: true,
        inFlightIds: new Set(["busy"]),
        lastAttemptAt: new Map(),
        now: 1_000,
        retryMs: 30_000,
      }),
    ).toEqual({ sessionIds: [], retryDelayMs: null });
  });
});
