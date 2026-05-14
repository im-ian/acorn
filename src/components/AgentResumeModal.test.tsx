import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ptyWrite: vi.fn<(sessionId: string, data: string) => Promise<void>>(),
  acknowledgeClaudeResume: vi.fn<(sessionId: string) => Promise<void>>(),
  acknowledgeCodexResume: vi.fn<(sessionId: string) => Promise<void>>(),
  clipboardWriteText: vi.fn<(text: string) => Promise<void>>(),
  toastShow: vi.fn<(msg: string) => void>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    ptyWrite: mocks.ptyWrite,
    acknowledgeClaudeResume: mocks.acknowledgeClaudeResume,
    acknowledgeCodexResume: mocks.acknowledgeCodexResume,
  },
}));

vi.mock("../lib/toasts", () => ({
  useToasts: (selector: (state: unknown) => unknown) =>
    selector({ show: mocks.toastShow, hide: vi.fn(), message: null }),
}));

import { AgentResumeModal } from "./AgentResumeModal";
import type { AgentKind } from "../lib/api";

const CANDIDATE = {
  uuid: "deadbeef-1234-5678-9abc-def012345678",
  lastActivityUnix: Math.floor(Date.now() / 1000) - 600,
  preview: "Preview of the previous conversation",
};
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

describe("AgentResumeModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.ptyWrite.mockResolvedValue();
    mocks.acknowledgeClaudeResume.mockResolvedValue();
    mocks.acknowledgeCodexResume.mockResolvedValue();
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
    vi.clearAllMocks();
  });

  function render(agent: AgentKind, candidate: typeof CANDIDATE | null) {
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

  function clickButton(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes(label),
    );
    if (!button) throw new Error(`button "${label}" not found`);
    act(() => button.click());
  }

  it("renders nothing when candidate is null", () => {
    render("claude", null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders the UUID and preview when candidate is set", () => {
    render("claude", CANDIDATE);
    expect(document.body.textContent).toContain(CANDIDATE.uuid);
    expect(document.body.textContent).toContain(CANDIDATE.preview);
  });

  it("Resume on a claude candidate dispatches `claude --resume <uuid>` to the PTY without ack", () => {
    const onDismiss = render("claude", CANDIDATE);
    clickButton("Resume");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `claude --resume ${CANDIDATE.uuid}\r`,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Resume must not ack — the user picked the conversation back up,
    // so subsequent exits should re-offer the modal at the next cold
    // boot.
    expect(mocks.acknowledgeClaudeResume).not.toHaveBeenCalled();
    expect(mocks.acknowledgeCodexResume).not.toHaveBeenCalled();
  });

  it("Resume on a codex candidate dispatches `codex resume <uuid>` to the PTY without ack", () => {
    const onDismiss = render("codex", CANDIDATE);
    clickButton("Resume");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `codex resume ${CANDIDATE.uuid}\r`,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeCodexResume).not.toHaveBeenCalled();
    expect(mocks.acknowledgeClaudeResume).not.toHaveBeenCalled();
  });

  it("Copy ID writes the UUID to the clipboard and toasts", async () => {
    const onDismiss = render("claude", CANDIDATE);
    clickButton("Copy ID");
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(CANDIDATE.uuid);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeClaudeResume).toHaveBeenCalledWith(SESSION_ID);
    // Allow the clipboard promise to flush before checking the toast.
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.toastShow).toHaveBeenCalledWith("Session ID copied");
  });

  it("Cancel on a claude candidate writes a single `#`-commented resume command for recall", () => {
    const onDismiss = render("claude", CANDIDATE);
    clickButton("Cancel");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
    const payload = mocks.ptyWrite.mock.calls[0][1];
    expect(payload).toBe(`# claude --resume ${CANDIDATE.uuid}\r`);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeClaudeResume).toHaveBeenCalledWith(SESSION_ID);
  });

  it("Cancel on a codex candidate writes a single `#`-commented `codex resume` command", () => {
    const onDismiss = render("codex", CANDIDATE);
    clickButton("Cancel");
    const payload = mocks.ptyWrite.mock.calls[0][1];
    expect(payload).toBe(`# codex resume ${CANDIDATE.uuid}\r`);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeCodexResume).toHaveBeenCalledWith(SESSION_ID);
  });
});
