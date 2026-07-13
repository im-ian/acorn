import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  daemonStatus: vi.fn(),
  getAcornIpcStatus: vi.fn(),
  getAgentTokenUsage: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    daemonStatus: apiMocks.daemonStatus,
    getAcornIpcStatus: apiMocks.getAcornIpcStatus,
    getAgentTokenUsage: apiMocks.getAgentTokenUsage,
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

  it("does not overlap a slow agent token usage poll", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.statusBar.showAgentTokenUsage = true;
    useSettings.setState({ settings });
    useAppStore.setState({
      sessions: [
        {
          id: "session-a",
          name: "Codex",
          repo_path: "/repo/a",
          worktree_path: "/repo/a",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "default",
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
          agent_provider: "codex",
        },
      ],
      activeSessionId: "session-a",
    });
    apiMocks.getAcornIpcStatus.mockResolvedValue({ server_running: true });
    apiMocks.daemonStatus.mockResolvedValue({
      running: true,
      enabled: true,
      session_count_alive: 1,
    });
    const pending = deferred<unknown>();
    apiMocks.getAgentTokenUsage.mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<StatusBar />);
    });
    expect(apiMocks.getAgentTokenUsage).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(apiMocks.getAgentTokenUsage).toHaveBeenCalledOnce();
  });
});
