import { afterEach, describe, expect, it } from "vitest";
import {
  findOpenHistorySession,
  openHistoryLaunchGate,
  rememberedHistorySessionId,
  resetHistoryLaunchesForTests,
  type HistoryLaunchSession,
} from "./agentHistoryLaunch";

const item = {
  provider: "claude",
  id: "claude-1",
  resume_command: "claude --resume claude-1",
};

function session(
  overrides: Partial<HistoryLaunchSession> & Pick<HistoryLaunchSession, "id">,
): HistoryLaunchSession {
  return {
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("findOpenHistorySession", () => {
  afterEach(() => {
    resetHistoryLaunchesForTests();
  });

  it("returns the live tab already paired to the history transcript", () => {
    const open = session({
      id: "open",
      agent_provider: "claude",
      agent_transcript_id: "claude-1",
    });
    const found = findOpenHistorySession({
      sessions: [
        session({
          id: "archived",
          archived_at: "2026-01-02T00:00:00Z",
          agent_provider: "claude",
          agent_transcript_id: "claude-1",
        }),
        session({
          id: "other",
          agent_provider: "codex",
          agent_transcript_id: "claude-1",
        }),
        open,
      ],
      pendingTerminalInput: {},
      rememberedSessionId: null,
      activeSessionId: null,
      item,
    });
    expect(found?.id).toBe("open");
  });

  it("prefers the active tab when several tabs share the transcript", () => {
    const found = findOpenHistorySession({
      sessions: [
        session({
          id: "older",
          updated_at: "2026-01-01T00:00:00Z",
          agent_transcript_provider: "claude",
          agent_transcript_id: "claude-1",
        }),
        session({
          id: "active",
          updated_at: "2026-01-03T00:00:00Z",
          agent_transcript_provider: "claude",
          agent_transcript_id: "claude-1",
        }),
      ],
      pendingTerminalInput: {},
      rememberedSessionId: null,
      activeSessionId: "older",
      item,
    });
    expect(found?.id).toBe("older");
  });

  it("reuses a launch that has not paired a transcript yet", () => {
    const found = findOpenHistorySession({
      sessions: [session({ id: "fresh", agent_provider: "claude" })],
      pendingTerminalInput: {},
      rememberedSessionId: "fresh",
      activeSessionId: "s-1",
      item,
    });
    expect(found?.id).toBe("fresh");
  });

  it("ignores a remembered tab that has since paired a different transcript", () => {
    const found = findOpenHistorySession({
      sessions: [
        session({
          id: "fresh",
          agent_provider: "codex",
          agent_transcript_id: "codex-9",
        }),
      ],
      pendingTerminalInput: {},
      rememberedSessionId: "fresh",
      activeSessionId: null,
      item,
    });
    expect(found).toBeNull();
  });

  it("matches a tab whose resume command is still queued", () => {
    const found = findOpenHistorySession({
      sessions: [session({ id: "queued", agent_provider: "claude" })],
      pendingTerminalInput: {
        queued: {
          command: "claude --resume claude-1",
          agentProvider: "claude",
        },
      },
      rememberedSessionId: null,
      activeSessionId: null,
      item,
    });
    expect(found?.id).toBe("queued");
  });

  it("does not match a queued resume on a tab paired to a different transcript", () => {
    const found = findOpenHistorySession({
      sessions: [
        session({
          id: "fresh",
          agent_provider: "claude",
          agent_transcript_id: "claude-9",
        }),
      ],
      pendingTerminalInput: {
        fresh: {
          command: "claude --resume claude-1",
          agentProvider: "claude",
        },
      },
      rememberedSessionId: "fresh",
      activeSessionId: null,
      item,
    });
    expect(found).toBeNull();
  });
});

describe("openHistoryLaunchGate", () => {
  afterEach(() => {
    resetHistoryLaunchesForTests();
  });

  it("joins a second caller to the first launch and remembers the session", async () => {
    const first = openHistoryLaunchGate(item);
    const second = openHistoryLaunchGate(item);
    expect(first.joined).toBeNull();
    expect(second.joined).not.toBeNull();

    let joinedId: string | null = "pending";
    const joined = second.joined!.then((id) => {
      joinedId = id;
    });
    first.finish("created-1");
    second.finish("ignored");
    await joined;

    expect(joinedId).toBe("created-1");
    expect(rememberedHistorySessionId(item)).toBe("created-1");
  });

  it("does not remember a launch that never queued a session", async () => {
    const launch = openHistoryLaunchGate(item);
    const joined = openHistoryLaunchGate(item);
    let joinedId: string | null = "pending";
    const done = joined.joined!.then((id) => {
      joinedId = id;
    });
    launch.finish(null);
    await done;
    expect(joinedId).toBeNull();
    expect(rememberedHistorySessionId(item)).toBeNull();
    const again = openHistoryLaunchGate(item);
    expect(again.joined).toBeNull();
    again.finish(null);
  });
});
