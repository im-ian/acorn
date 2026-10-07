import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ptyWrite: vi.fn<(sessionId: string, data: string) => Promise<void>>(),
}));

vi.mock("./api", () => ({
  api: {
    ptyWrite: mocks.ptyWrite,
  },
}));

import {
  autoResumeAgentConversation,
  dispatchAgentResumeCommand,
  armResumeProbeAfterSuccessfulRestore,
  forgetCompletedAgentResumeAutoDispatch,
  forgetCompletedAgentResumeAutoDispatchForSession,
  resetAgentResumeAutoDispatchForTests,
  shouldAcceptResumeProbeResult,
  shouldProbeSessionForResume,
  shouldRetainBusyResumeCandidate,
  shouldStampResumeProbeSkip,
} from "./agentResume";
import { useAppStore } from "../store";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const UUID = "deadbeef-1234-5678-9abc-def012345678";

describe("dispatchAgentResumeCommand", () => {
  beforeEach(() => {
    mocks.ptyWrite.mockReset();
    mocks.ptyWrite.mockResolvedValue();
    resetAgentResumeAutoDispatchForTests();
    useAppStore.setState({ pendingTerminalInput: {} });
  });

  afterEach(() => {
    resetAgentResumeAutoDispatchForTests();
    useAppStore.setState({ pendingTerminalInput: {} });
  });

  it("writes the provider resume command with a carriage return", async () => {
    await expect(
      dispatchAgentResumeCommand({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("written");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `claude --resume ${UUID}\r`,
    );
  });

  it("queues the command when the session has no live PTY handle", async () => {
    mocks.ptyWrite.mockRejectedValueOnce(
      new Error(`pty error: pty error: no pty for session ${SESSION_ID}`),
    );

    await expect(
      dispatchAgentResumeCommand({
        sessionId: SESSION_ID,
        agent: "grok",
        uuid: UUID,
      }),
    ).resolves.toBe("queued");

    expect(useAppStore.getState().pendingTerminalInput[SESSION_ID]).toEqual({
      command: `grok --resume ${UUID}`,
      adoptWorktreeOnExit: false,
      agentProvider: "grok",
    });
  });

  it("rethrows other PTY write failures", async () => {
    mocks.ptyWrite.mockRejectedValueOnce(new Error("PTY access denied"));

    await expect(
      dispatchAgentResumeCommand({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).rejects.toThrow("PTY access denied");
    expect(
      useAppStore.getState().pendingTerminalInput[SESSION_ID],
    ).toBeUndefined();
  });
});

describe("autoResumeAgentConversation", () => {
  beforeEach(() => {
    mocks.ptyWrite.mockReset();
    mocks.ptyWrite.mockResolvedValue();
    resetAgentResumeAutoDispatchForTests();
    useAppStore.setState({ pendingTerminalInput: {} });
  });

  afterEach(() => {
    resetAgentResumeAutoDispatchForTests();
    useAppStore.setState({ pendingTerminalInput: {} });
  });

  it("coalesces overlapping dispatches for the same candidate", async () => {
    let release!: () => void;
    mocks.ptyWrite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve();
        }),
    );

    const first = autoResumeAgentConversation({
      sessionId: SESSION_ID,
      agent: "codex",
      uuid: UUID,
    });
    const second = autoResumeAgentConversation({
      sessionId: SESSION_ID,
      agent: "codex",
      uuid: UUID,
    });
    release();

    await expect(first).resolves.toBe("written");
    await expect(second).resolves.toBe("written");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
  });

  it("skips a candidate that already auto-resumed this launch", async () => {
    await autoResumeAgentConversation({
      sessionId: SESSION_ID,
      agent: "claude",
      uuid: UUID,
    });
    await expect(
      autoResumeAgentConversation({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("skipped");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
  });

  it("rewrites after completed auto-resume memory is forgotten", async () => {
    await autoResumeAgentConversation({
      sessionId: SESSION_ID,
      agent: "claude",
      uuid: UUID,
    });
    forgetCompletedAgentResumeAutoDispatch();
    await expect(
      autoResumeAgentConversation({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("written");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(2);
  });

  it("rewrites one restored session without forgetting the others", async () => {
    const otherId = "99999999-8888-7777-6666-555555555555";
    await autoResumeAgentConversation({
      sessionId: SESSION_ID,
      agent: "claude",
      uuid: UUID,
    });
    await autoResumeAgentConversation({
      sessionId: otherId,
      agent: "claude",
      uuid: UUID,
    });

    forgetCompletedAgentResumeAutoDispatchForSession(SESSION_ID);

    await expect(
      autoResumeAgentConversation({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("written");
    await expect(
      autoResumeAgentConversation({
        sessionId: otherId,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("skipped");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(3);
  });

  it("allows a retry after a non-missing PTY failure", async () => {
    mocks.ptyWrite.mockRejectedValueOnce(new Error("PTY access denied"));

    await expect(
      autoResumeAgentConversation({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).rejects.toThrow("PTY access denied");

    mocks.ptyWrite.mockResolvedValueOnce();
    await expect(
      autoResumeAgentConversation({
        sessionId: SESSION_ID,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("written");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(2);
  });
});

describe("armResumeProbeAfterSuccessfulRestore", () => {
  const restored = "restored-session";

  beforeEach(() => {
    mocks.ptyWrite.mockReset();
    mocks.ptyWrite.mockResolvedValue();
    resetAgentResumeAutoDispatchForTests();
    useAppStore.setState({ pendingTerminalInput: {} });
  });

  afterEach(() => {
    resetAgentResumeAutoDispatchForTests();
    useAppStore.setState({ pendingTerminalInput: {} });
  });

  it("clears the probe mark and the dispatch dedupe when auto-resume is on", async () => {
    const otherId = "99999999-8888-7777-6666-555555555555";
    await autoResumeAgentConversation({
      sessionId: restored,
      agent: "claude",
      uuid: UUID,
    });
    await autoResumeAgentConversation({
      sessionId: otherId,
      agent: "claude",
      uuid: UUID,
    });
    const probedIds = new Set([restored, "other"]);
    const pendingRestoreProbeIds = new Set<string>();

    armResumeProbeAfterSuccessfulRestore({
      sessionId: restored,
      autoResumeEnabled: true,
      probedIds,
      pendingRestoreProbeIds,
    });

    expect(probedIds.has(restored)).toBe(false);
    expect(probedIds.has("other")).toBe(true);
    expect(pendingRestoreProbeIds).toEqual(new Set([restored]));
    await expect(
      autoResumeAgentConversation({
        sessionId: restored,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("written");
    await expect(
      autoResumeAgentConversation({
        sessionId: otherId,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("skipped");
  });

  it("does not let an in-flight dispatch reseal the key after a restore", async () => {
    let release!: () => void;
    mocks.ptyWrite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve();
        }),
    );
    const first = autoResumeAgentConversation({
      sessionId: restored,
      agent: "claude",
      uuid: UUID,
    });

    armResumeProbeAfterSuccessfulRestore({
      sessionId: restored,
      autoResumeEnabled: true,
      probedIds: new Set([restored]),
      pendingRestoreProbeIds: new Set(),
    });
    release();
    await first;

    await expect(
      autoResumeAgentConversation({
        sessionId: restored,
        agent: "claude",
        uuid: UUID,
      }),
    ).resolves.toBe("written");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(2);
  });

  it("keeps a restored session probed when auto-resume is off", () => {
    const probedIds = new Set<string>();
    const pendingRestoreProbeIds = new Set([restored]);

    armResumeProbeAfterSuccessfulRestore({
      sessionId: restored,
      autoResumeEnabled: false,
      probedIds,
      pendingRestoreProbeIds,
    });

    expect(probedIds).toEqual(new Set([restored]));
    expect(pendingRestoreProbeIds.size).toBe(0);
  });

  it("does not stamp a session that is still waiting on the restore probe", () => {
    expect(
      shouldStampResumeProbeSkip({
        session: { id: restored, archived_at: "2026-04-01T00:00:00Z" },
        pendingRestoreProbeIds: new Set(),
      }),
    ).toBe(false);
    expect(
      shouldStampResumeProbeSkip({
        session: { id: restored, archived_at: null },
        pendingRestoreProbeIds: new Set([restored]),
      }),
    ).toBe(false);
    expect(
      shouldStampResumeProbeSkip({
        session: { id: "busy-live", archived_at: null },
        pendingRestoreProbeIds: new Set([restored]),
      }),
    ).toBe(true);
  });

  it("probes a busy restored session and still accepts that result", () => {
    expect(
      shouldProbeSessionForResume({
        archived: false,
        alreadyProbed: false,
        pendingRestore: true,
        skipBecauseBusy: true,
      }),
    ).toBe(true);
    expect(
      shouldProbeSessionForResume({
        archived: true,
        alreadyProbed: false,
        pendingRestore: true,
        skipBecauseBusy: true,
      }),
    ).toBe(false);
    expect(
      shouldProbeSessionForResume({
        archived: false,
        alreadyProbed: false,
        pendingRestore: false,
        skipBecauseBusy: true,
      }),
    ).toBe(false);
    expect(
      shouldAcceptResumeProbeResult({
        archived: false,
        forcedRestoreProbe: true,
        skipBecauseBusy: true,
      }),
    ).toBe(true);
    expect(
      shouldAcceptResumeProbeResult({
        archived: true,
        forcedRestoreProbe: true,
        skipBecauseBusy: true,
      }),
    ).toBe(false);
    expect(
      shouldAcceptResumeProbeResult({
        archived: false,
        forcedRestoreProbe: false,
        skipBecauseBusy: true,
      }),
    ).toBe(false);
    expect(shouldRetainBusyResumeCandidate({ forcedRestore: true })).toBe(
      true,
    );
    expect(shouldRetainBusyResumeCandidate({ forcedRestore: false })).toBe(
      false,
    );
  });
});
