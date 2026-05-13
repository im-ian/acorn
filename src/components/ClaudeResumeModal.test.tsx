import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ptyWrite: vi.fn<(sessionId: string, data: string) => Promise<void>>(),
  acknowledgeClaudeResume: vi.fn<(sessionId: string) => Promise<void>>(),
  clipboardWriteText: vi.fn<(text: string) => Promise<void>>(),
  toastShow: vi.fn<(msg: string) => void>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    ptyWrite: mocks.ptyWrite,
    acknowledgeClaudeResume: mocks.acknowledgeClaudeResume,
  },
}));

vi.mock("../lib/toasts", () => ({
  useToasts: (selector: (state: unknown) => unknown) =>
    selector({ show: mocks.toastShow, hide: vi.fn(), message: null }),
}));

import { ClaudeResumeModal } from "./ClaudeResumeModal";

const CANDIDATE = {
  uuid: "deadbeef-1234-5678-9abc-def012345678",
  lastActivityUnix: Math.floor(Date.now() / 1000) - 600,
  preview: "이전 대화 내용 미리보기",
};
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

describe("ClaudeResumeModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.ptyWrite.mockResolvedValue();
    mocks.acknowledgeClaudeResume.mockResolvedValue();
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

  function render(candidate: typeof CANDIDATE | null) {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <ClaudeResumeModal
          sessionId={SESSION_ID}
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
    render(null);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders the UUID and preview when candidate is set", () => {
    render(CANDIDATE);
    expect(document.body.textContent).toContain(CANDIDATE.uuid);
    expect(document.body.textContent).toContain(CANDIDATE.preview);
  });

  it("이어하기 writes the resume command to the PTY and acknowledges", async () => {
    const onDismiss = render(CANDIDATE);
    clickButton("이어하기");
    expect(mocks.ptyWrite).toHaveBeenCalledWith(
      SESSION_ID,
      `claude --resume ${CANDIDATE.uuid}\n`,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeClaudeResume).toHaveBeenCalledWith(SESSION_ID);
  });

  it("ID 복사 writes the UUID to the clipboard and toasts", async () => {
    const onDismiss = render(CANDIDATE);
    clickButton("ID 복사");
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(CANDIDATE.uuid);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeClaudeResume).toHaveBeenCalledWith(SESSION_ID);
    // Allow the clipboard promise to flush before checking the toast.
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.toastShow).toHaveBeenCalledWith("세션 ID 복사됨");
  });

  it("취소 writes shell-comment lines so the user can still recover the id", () => {
    const onDismiss = render(CANDIDATE);
    clickButton("취소");
    expect(mocks.ptyWrite).toHaveBeenCalledTimes(1);
    const payload = mocks.ptyWrite.mock.calls[0][1];
    expect(payload).toMatch(/^# 이전 Claude 대화 ID:/);
    expect(payload).toContain(CANDIDATE.uuid);
    expect(payload).toContain(`claude --resume ${CANDIDATE.uuid}`);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(mocks.acknowledgeClaudeResume).toHaveBeenCalledWith(SESSION_ID);
  });
});
