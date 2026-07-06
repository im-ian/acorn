import { describe, expect, it } from "vitest";
import type { Session } from "./types";
import {
  canAutoGenerateSessionTitle,
  canForceGenerateSessionTitle,
  canGenerateSessionTitle,
  canRenameSession,
  canRegenerateSessionTitle,
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
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    auto_title_enabled: true,
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
    expect(
      canGenerateSessionTitle(session({ auto_title_enabled: false })),
    ).toBe(false);
  });

  it("allows forced title generation for user-owned regular sessions", () => {
    expect(
      canForceGenerateSessionTitle(session({ title_source: "manual" })),
    ).toBe(true);
    expect(
      canForceGenerateSessionTitle(
        session({
          title_source: "generated",
          generated_title_transcript_id: "claude-1",
          agent_transcript_id: "claude-1",
        }),
      ),
    ).toBe(true);
    expect(canForceGenerateSessionTitle(session({ kind: "control" }))).toBe(
      false,
    );
    expect(
      canForceGenerateSessionTitle(
        session({ owner: { kind: "control", session_id: "control-1" } }),
      ),
    ).toBe(false);
  });

  it("allows manual title regeneration only for sessions with agent chat work", () => {
    expect(
      canRegenerateSessionTitle(
        session({
          title_source: "manual",
          agent_provider: null,
          agent_transcript_id: null,
        }),
      ),
    ).toBe(false);
    expect(
      canRegenerateSessionTitle(
        session({
          title_source: "manual",
          agent_provider: null,
          agent_transcript_id: "codex-1",
        }),
      ),
    ).toBe(true);
    expect(
      canRegenerateSessionTitle(
        session({
          title_source: "generated",
          generated_title_transcript_id: "codex-1",
          agent_transcript_id: "codex-1",
        }),
      ),
    ).toBe(true);
    expect(
      canRegenerateSessionTitle(
        session({
          title_source: "manual",
          mode: "chat",
          status: "waiting_for_input",
          agent_provider: null,
        }),
      ),
    ).toBe(true);
    expect(
      canRegenerateSessionTitle(
        session({
          title_source: "manual",
          mode: "chat",
          status: "ready",
          agent_provider: null,
        }),
      ),
    ).toBe(false);
    expect(canRegenerateSessionTitle(session({ kind: "control" }))).toBe(
      false,
    );
  });

  it("uses the global automatic title setting for terminal sessions and always allows chat sessions", () => {
    expect(canAutoGenerateSessionTitle(session(), false)).toBe(false);
    expect(canAutoGenerateSessionTitle(session(), true)).toBe(true);
    expect(
      canAutoGenerateSessionTitle(session({ agent_provider: null }), true),
    ).toBe(false);
    expect(
      canAutoGenerateSessionTitle(
        session({ agent_provider: null, status: "working" }),
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
          status: "waiting_for_input",
        }),
        true,
      ),
    ).toBe(true);
    expect(
      canAutoGenerateSessionTitle(
        session({
          agent_provider: null,
          mode: "chat",
          status: "waiting_for_input",
        }),
        false,
      ),
    ).toBe(true);
  });

  it("does not auto-title a plain terminal only because a child agent is detected", () => {
    expect(
      canAutoGenerateSessionTitle(
        session({
          auto_title_enabled: false,
          agent_provider: "codex",
          agent_transcript_id: "codex-1",
          status: "working",
        }),
        true,
      ),
    ).toBe(false);
  });

  it("does not auto-title legacy plain terminals only because a child agent is detected", () => {
    const legacy = session({
      agent_provider: "codex",
      agent_transcript_id: "codex-1",
      status: "working",
    });
    delete legacy.auto_title_enabled;

    expect(canAutoGenerateSessionTitle(legacy, true)).toBe(false);
  });

  it("keeps legacy generated and named agent sessions eligible", () => {
    const generated = session({
      title_source: "generated",
      generated_title_transcript_id: "codex-1",
      agent_transcript_id: "codex-2",
      agent_provider: null,
    });
    delete generated.auto_title_enabled;

    const named = session({
      name: "Codex task",
      agent_provider: null,
    });
    delete named.auto_title_enabled;

    expect(canAutoGenerateSessionTitle(generated, true)).toBe(true);
    expect(canAutoGenerateSessionTitle(named, true)).toBe(true);
  });

  it("auto-titles explicit agent and chat sessions", () => {
    expect(
      canAutoGenerateSessionTitle(
        session({
          auto_title_enabled: true,
          agent_provider: "codex",
          agent_transcript_id: "codex-1",
        }),
        true,
      ),
    ).toBe(true);
    expect(
      canAutoGenerateSessionTitle(
        session({
          auto_title_enabled: true,
          agent_provider: null,
          mode: "chat",
          status: "waiting_for_input",
        }),
        false,
      ),
    ).toBe(true);
  });

  it("plans immediate generation for eligible sessions only", () => {
    expect(
      planAutoGenerateSessionTitles({
        sessions: [
          session({ id: "ready" }),
          session({
            id: "plain-terminal-with-agent",
            auto_title_enabled: false,
            agent_provider: "codex",
            agent_transcript_id: "codex-1",
            status: "working",
          }),
          session({ id: "manual", title_source: "manual" }),
          session({ id: "terminal", agent_provider: null }),
          session({
            id: "detected-running",
            agent_provider: null,
            status: "working",
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

  it("plans chat title generation even when the terminal automatic title setting is disabled", () => {
    expect(
      planAutoGenerateSessionTitles({
        sessions: [
          session({ id: "terminal", agent_provider: null, status: "working" }),
          session({
            id: "chat",
            agent_provider: null,
            mode: "chat",
            status: "waiting_for_input",
          }),
        ],
        enabled: false,
        inFlightIds: new Set(),
        lastAttemptAt: new Map(),
        now: 1_000,
        retryMs: 30_000,
      }),
    ).toEqual({
      sessionIds: ["chat"],
      retryDelayMs: null,
    });
  });

  it("skips sessions excluded from automatic title generation", () => {
    expect(
      planAutoGenerateSessionTitles({
        sessions: [
          session({ id: "auto-close" }),
          session({ id: "normal" }),
        ],
        enabled: true,
        inFlightIds: new Set(),
        excludedSessionIds: new Set(["auto-close"]),
        lastAttemptAt: new Map(),
        now: 1_000,
        retryMs: 30_000,
      }),
    ).toEqual({
      sessionIds: ["normal"],
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
