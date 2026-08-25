import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ptyWrite: vi.fn<(sessionId: string, data: string) => Promise<void>>(),
  acknowledgeAgentResume: vi.fn<
    (provider: AgentKind, sessionId: string) => Promise<void>
  >(),
  clipboardWriteText: vi.fn<(text: string) => Promise<void>>(),
  toastShow: vi.fn<(msg: string) => void>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    ptyWrite: mocks.ptyWrite,
    acknowledgeAgentResume: mocks.acknowledgeAgentResume,
  },
}));

vi.mock("../lib/toasts", () => ({
  useToasts: (selector: (state: unknown) => unknown) =>
    selector({ show: mocks.toastShow, hide: vi.fn(), message: null }),
}));

import { AgentResumeModal } from "./AgentResumeModal";
import type { AgentKind, ResumeCandidate } from "../lib/api";
import { useAppStore } from "../store";

const CANDIDATE: ResumeCandidate = {
  uuid: "deadbeef-1234-5678-9abc-def012345678",
  lastActivityUnix: Math.floor(Date.now() / 1000) - 600,
  preview: "Preview of the previous conversation",
  lastUserMessage: "Please inspect the transcript watcher.",
  lastAgentMessage: "The watcher is paired to this session.",
};
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

describe("AgentResumeModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.ptyWrite.mockResolvedValue();
    mocks.acknowledgeAgentResume.mockResolvedValue();
    mocks.clipboardWriteText.mockResolvedValue();
    mocks.toastShow.mockClear();
    Object.assign(navigator, {
      clipboard: { writeText: mocks.clipboardWriteText },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState({ pendingTerminalInput: {} });
    vi.clearAllMocks();
  });

  function render(agent: AgentKind, candidate: ResumeCandidate | null) {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <AgentResumeModal
          sessionId={SESSION_ID}
          agent={agent}
          candidate={candidate}
          onDismiss={onDismiss}
        />,
      );
    });
    return onDismiss;
  }

  async function clickButton(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes(label),
    );
    if (!button) throw new Error(`button "${label}" not found`);
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders nothing when candidate is null", () => {
    render("claude", null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders the UUID and conversation preview when candidate is set", () => {
    render("claude", CANDIDATE);
    expect(document.body.textContent).toContain(CANDIDATE.uuid);
    expect(document.body.textContent).toContain(CANDIDATE.lastUserMessage);
    expect(document.body.textContent).toContain(CANDIDATE.lastAgentMessage);
  });

  it("falls back to the legacy assistant preview when conversation fields are absent", () => {
    render("claude", {
      ...CANDIDATE,
      lastUserMessage: null,
      lastAgentMessage: null,
    });
    expect(document.body.textContent).toContain(CANDIDATE.preview);
  });

  it("Resume on a claude candidate dispatches `claude --resume <uuid>` to the PTY without ack", async () => {
    const onDismiss = render("claude", CANDIDATE);
    await clickButton("Resume");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `claude --resume ${CANDIDATE.uuid}\r`,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Resume must not ack — the user picked the conversation back up,
    // so subsequent exits should re-offer the modal at the next cold
    // boot.
    expect(mocks.acknowledgeAgentResume).not.toHaveBeenCalled();
  });

  it("Resume on a codex candidate dispatches `codex resume <uuid>` to the PTY without ack", async () => {
    const onDismiss = render("codex", CANDIDATE);
    await clickButton("Resume");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `codex resume ${CANDIDATE.uuid}\r`,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeAgentResume).not.toHaveBeenCalled();
  });

  it("Resume on a Grok candidate dispatches `grok --resume <uuid>` to the PTY without ack", async () => {
    const onDismiss = render("grok", CANDIDATE);
    await clickButton("Resume");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `grok --resume ${CANDIDATE.uuid}\r`,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeAgentResume).not.toHaveBeenCalled();
  });

  it("Copy ID writes the UUID to the clipboard and toasts", async () => {
    const onDismiss = render("claude", CANDIDATE);
    await clickButton("Copy ID");
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(CANDIDATE.uuid);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeAgentResume).toHaveBeenCalledWith(
      "claude",
      SESSION_ID,
    );
    expect(mocks.toastShow).toHaveBeenCalledWith("Session ID copied.");
  });

  it("Cancel on a claude candidate writes a single `#`-commented resume command for recall", async () => {
    const onDismiss = render("claude", CANDIDATE);
    await clickButton("Cancel");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
    const payload = mocks.ptyWrite.mock.calls[0][1];
    expect(payload).toBe(`# claude --resume ${CANDIDATE.uuid}\r`);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeAgentResume).toHaveBeenCalledWith(
      "claude",
      SESSION_ID,
    );
  });

  it("Cancel on a codex candidate writes a single `#`-commented `codex resume` command", async () => {
    const onDismiss = render("codex", CANDIDATE);
    await clickButton("Cancel");
    const payload = mocks.ptyWrite.mock.calls[0][1];
    expect(payload).toBe(`# codex resume ${CANDIDATE.uuid}\r`);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeAgentResume).toHaveBeenCalledWith(
      "codex",
      SESSION_ID,
    );
  });
  it("keeps the candidate open when acknowledgement cannot be stored", async () => {
    mocks.acknowledgeAgentResume.mockRejectedValueOnce(
      new Error("agent state ack Permission denied"),
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onDismiss = render("claude", CANDIDATE);

    await clickButton("Cancel");

    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to remember that this conversation was dismissed: agent state ack Permission denied",
    );
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it("keeps the candidate open when the resume command cannot be written", async () => {
    mocks.ptyWrite.mockRejectedValueOnce(new Error("PTY access denied"));
    const onDismiss = render("claude", CANDIDATE);

    await clickButton("Resume");

    expect(onDismiss).not.toHaveBeenCalled();
    expect(mocks.acknowledgeAgentResume).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingTerminalInput[SESSION_ID]).toBeUndefined();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to send the resume command: PTY access denied",
    );
  });

  it("queues Resume for the next PTY spawn when the session has no live handle", async () => {
    mocks.ptyWrite.mockRejectedValueOnce(
      new Error(
        "pty error: pty error: no pty for session 11111111-2222-3333-4444-555555555555",
      ),
    );
    const onDismiss = render("grok", CANDIDATE);

    await clickButton("Resume");

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeAgentResume).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(useAppStore.getState().pendingTerminalInput[SESSION_ID]).toEqual({
      command: `grok --resume ${CANDIDATE.uuid}`,
      adoptWorktreeOnExit: false,
      agentProvider: "grok",
    });
  });

  it("keeps the candidate open and unacknowledged when clipboard access fails", async () => {
    mocks.clipboardWriteText.mockRejectedValueOnce(
      new Error("clipboard permission denied"),
    );
    const onDismiss = render("claude", CANDIDATE);

    await clickButton("Copy ID");

    expect(onDismiss).not.toHaveBeenCalled();
    expect(mocks.acknowledgeAgentResume).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Failed to copy session ID. clipboard permission denied",
    );
  });

  it("reports a failed recall hint but still persists explicit cancellation", async () => {
    mocks.ptyWrite.mockRejectedValueOnce(new Error("PTY closed"));
    const onDismiss = render("claude", CANDIDATE);

    await clickButton("Cancel");

    expect(mocks.toastShow).toHaveBeenCalledWith(
      "Failed to add the resume hint: PTY closed",
    );
    expect(mocks.acknowledgeAgentResume).toHaveBeenCalledWith(
      "claude",
      SESSION_ID,
    );
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
