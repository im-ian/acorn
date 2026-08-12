import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  daemonShutdown: vi.fn<() => Promise<void>>(),
  acknowledgeStagedRevMismatch: vi.fn<() => Promise<void>>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    daemonShutdown: mocks.daemonShutdown,
    acknowledgeStagedRevMismatch: mocks.acknowledgeStagedRevMismatch,
  },
}));

import { useSettings } from "../lib/settings";
import { StagedRevMismatchModal } from "./StagedRevMismatchModal";

describe("StagedRevMismatchModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.daemonShutdown.mockResolvedValue();
    mocks.acknowledgeStagedRevMismatch.mockResolvedValue();
    useSettings.getState().reset();
    useSettings.getState().patchLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderModal() {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <StagedRevMismatchModal
          mismatch={{ current_rev: "new-rev", stale_session_count: 2 }}
          onDismiss={onDismiss}
        />,
      );
    });
    return onDismiss;
  }

  async function clickButton(label: string) {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    if (!button) throw new Error(`button "${label}" not found`);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  it("keeps the prompt open when daemon shutdown fails", async () => {
    mocks.daemonShutdown.mockRejectedValueOnce(new Error("access denied"));
    const onDismiss = renderModal();

    await clickButton("Restart sessions");

    expect(mocks.acknowledgeStagedRevMismatch).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't restart background sessions: access denied",
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("does not continue after acknowledgement fails", async () => {
    mocks.acknowledgeStagedRevMismatch.mockRejectedValueOnce(
      new Error("IPC unavailable"),
    );
    const onDismiss = renderModal();

    await clickButton("Restart sessions");

    expect(mocks.daemonShutdown).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't restart background sessions: IPC unavailable",
    );
  });

  it("keeps the prompt open when dismiss acknowledgement fails", async () => {
    mocks.acknowledgeStagedRevMismatch.mockRejectedValueOnce(
      new Error("IPC unavailable"),
    );
    const onDismiss = renderModal();

    await clickButton("Later");

    expect(mocks.daemonShutdown).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't dismiss this reminder: IPC unavailable",
    );
  });

  it("dismisses only after acknowledgement succeeds", async () => {
    const onDismiss = renderModal();

    await clickButton("Later");

    expect(mocks.acknowledgeStagedRevMismatch).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
