import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  daemonShutdown: vi.fn<() => Promise<void>>(),
  acknowledgeDaemonVersionMismatch: vi.fn<() => Promise<void>>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    daemonShutdown: mocks.daemonShutdown,
    acknowledgeDaemonVersionMismatch: mocks.acknowledgeDaemonVersionMismatch,
  },
}));

import { useSettings } from "../lib/settings";
import { useAppStore } from "../store";
import type { Session } from "../lib/types";
import { DaemonUpdateModal } from "./DaemonUpdateModal";

const STORAGE_KEY = "acorn:daemon-update-resume";

const GROK_SESSION = {
  id: "b94a531c-455a-4912-8f6d-eb3a09267446",
  name: "session",
  repo_path: "/repo",
  worktree_path: "/repo",
  branch: "main",
  isolated: false,
  status: "working",
  created_at: "2026-10-08T00:00:00Z",
  updated_at: "2026-10-08T00:00:00Z",
  last_message: null,
  title_source: "generated",
  kind: "regular",
  owner: { kind: "user" },
  position: null,
  in_worktree: false,
  agent_provider: "grok",
  agent_transcript_provider: "grok",
  agent_transcript_id: "01a11a58-1780-78b3-91e9-1f6198c9d200",
} as Session;

describe("DaemonUpdateModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.daemonShutdown.mockResolvedValue();
    mocks.acknowledgeDaemonVersionMismatch.mockResolvedValue();
    useSettings.getState().reset();
    useSettings.getState().patchLanguage("en");
    useAppStore.setState({ sessions: [GROK_SESSION] });
    window.localStorage.removeItem(STORAGE_KEY);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState({ sessions: [] });
    window.localStorage.removeItem(STORAGE_KEY);
    vi.clearAllMocks();
  });

  function renderModal() {
    const onDismiss = vi.fn();
    act(() => {
      root.render(
        <DaemonUpdateModal
          mismatch={{
            daemon_version: "1.39.1-preview.20260929005847",
            app_version: "1.40.0",
            alive_session_count: 2,
          }}
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

  it("clears the stashed resume pass when daemon shutdown fails", async () => {
    mocks.daemonShutdown.mockRejectedValueOnce(new Error("access denied"));
    const onDismiss = renderModal();

    await clickButton("Update now");

    expect(mocks.acknowledgeDaemonVersionMismatch).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    // No reload follows a failed shutdown — a surviving stash would
    // type resume commands into live agent TUIs at a later boot.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't update the background daemon: access denied",
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps the stash when only acknowledgement fails after shutdown", async () => {
    mocks.acknowledgeDaemonVersionMismatch.mockRejectedValueOnce(
      new Error("IPC unavailable"),
    );
    const onDismiss = renderModal();

    await clickButton("Update now");

    expect(mocks.daemonShutdown).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    // The daemon is already down; the next boot should still run the
    // resume pass.
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't update the background daemon: IPC unavailable",
    );
  });

  it("keeps the prompt open when dismiss acknowledgement fails", async () => {
    mocks.acknowledgeDaemonVersionMismatch.mockRejectedValueOnce(
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

    expect(mocks.acknowledgeDaemonVersionMismatch).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
