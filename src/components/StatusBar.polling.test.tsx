import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  daemonStatus: vi.fn(),
  getAcornIpcStatus: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    daemonStatus: apiMocks.daemonStatus,
    getAcornIpcStatus: apiMocks.getAcornIpcStatus,
  },
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(() => Promise.resolve("/Users/tester")),
}));

import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import { useAppStore } from "../store";
import { StatusBar } from "./StatusBar";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("StatusBar service polling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    useAppStore.setState({
      sessions: [],
      activeSessionId: null,
      activeProject: null,
      error: null,
      loading: false,
      multiInputEnabled: false,
      prAccountByRepo: {},
      sessionNotifications: [],
      workspaceViewMode: "panes",
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not overlap a slow IPC and daemon status poll pair", async () => {
    const ipcPending = deferred<unknown>();
    const daemonPending = deferred<unknown>();
    apiMocks.getAcornIpcStatus.mockReturnValue(ipcPending.promise);
    apiMocks.daemonStatus.mockReturnValue(daemonPending.promise);

    await act(async () => {
      root.render(<StatusBar />);
    });
    expect(apiMocks.getAcornIpcStatus).toHaveBeenCalledOnce();
    expect(apiMocks.daemonStatus).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(apiMocks.getAcornIpcStatus).toHaveBeenCalledOnce();
    expect(apiMocks.daemonStatus).toHaveBeenCalledOnce();
  });
});
