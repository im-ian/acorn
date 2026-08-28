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
  forgetCompletedAgentResumeAutoDispatch,
  resetAgentResumeAutoDispatchForTests,
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
