import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../lib/api";

const apiMocks = vi.hoisted(() => ({
  daemonListSessions: vi.fn(),
  daemonStatus: vi.fn(),
  daemonRestart: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  sessions: [] as never[],
  setPendingTerminalInput: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    daemonListSessions: apiMocks.daemonListSessions,
    daemonStatus: apiMocks.daemonStatus,
    daemonRestart: apiMocks.daemonRestart,
  },
}));

vi.mock("../store", () => {
  const useAppStore = (selector: (state: { sessions: never[] }) => unknown) =>
    selector({ sessions: storeMocks.sessions });
  (useAppStore as unknown as { getState: () => unknown }).getState = () => ({
    sessions: storeMocks.sessions,
    setPendingTerminalInput: storeMocks.setPendingTerminalInput,
  });
  return { useAppStore };
});

vi.mock("../lib/toasts", () => ({
  useToasts: (selector: (state: { show: () => void }) => unknown) =>
    selector({ show: vi.fn() }),
}));

vi.mock("../lib/useTranslation", () => ({
  useTranslation: () => (key: string) => key,
}));

import { BackgroundSessionsSettings } from "./BackgroundSessionsSettings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("BackgroundSessionsSettings polling", () => {
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
    apiMocks.daemonListSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("does not overlap a slow daemon status poll", async () => {
    const pending = deferred<DaemonStatus>();
    apiMocks.daemonStatus.mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<BackgroundSessionsSettings />);
    });
    expect(apiMocks.daemonStatus).toHaveBeenCalledOnce();

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(apiMocks.daemonStatus).toHaveBeenCalledOnce();
  });

  it("polls again on the next interval after a refresh settles", async () => {
    apiMocks.daemonStatus.mockResolvedValue({
      enabled: true,
      running: false,
      daemon_version: null,
      uptime_seconds: null,
      session_count_total: 0,
      session_count_alive: 0,
      log_path: null,
      last_error: null,
    } satisfies DaemonStatus);

    await act(async () => {
      root.render(<BackgroundSessionsSettings />);
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(3_000);
      await Promise.resolve();
    });

    expect(apiMocks.daemonStatus).toHaveBeenCalledTimes(2);
  });

  it("renders operational errors returned with the daemon status", async () => {
    apiMocks.daemonStatus.mockResolvedValue({
      enabled: true,
      running: false,
      daemon_version: null,
      uptime_seconds: null,
      session_count_total: null,
      session_count_alive: null,
      log_path: null,
      last_error: "failed to resolve daemon log path: permission denied",
    } satisfies DaemonStatus);

    await act(async () => {
      root.render(<BackgroundSessionsSettings />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "failed to resolve daemon log path: permission denied",
    );
  });
});

describe("BackgroundSessionsSettings restart", () => {
  let container: HTMLDivElement;
  let root: Root;

  const RUNNING_STATUS: DaemonStatus = {
    enabled: true,
    running: true,
    daemon_version: "1.40.0",
    uptime_seconds: 10,
    session_count_total: 1,
    session_count_alive: 1,
    log_path: null,
    last_error: null,
  };

  const DAEMON_SESSION_ID = "b94a531c-455a-4912-8f6d-eb3a09267446";
  const IN_PROCESS_SESSION_ID = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    apiMocks.daemonStatus.mockResolvedValue(RUNNING_STATUS);
    apiMocks.daemonListSessions.mockResolvedValue([
      {
        id: DAEMON_SESSION_ID,
        name: "session",
        kind: "regular",
        alive: true,
        cwd: null,
        repo_path: null,
        branch: null,
        agent_kind: null,
      },
    ]);
    apiMocks.daemonRestart.mockResolvedValue(undefined);
    storeMocks.sessions = [
      {
        id: DAEMON_SESSION_ID,
        name: "daemon session",
        repo_path: "/repo",
        worktree_path: "/repo",
        branch: "main",
        archived_at: null,
        mode: "terminal",
        agent_provider: "grok",
        agent_transcript_provider: "grok",
        agent_transcript_id: "01a11a58-1780-78b3-91e9-1f6198c9d200",
      },
      // In-process session with a live shell — a queued resume command
      // would drain straight into its TUI, so it must not be queued.
      {
        id: IN_PROCESS_SESSION_ID,
        name: "in-process session",
        repo_path: "/repo",
        worktree_path: "/repo",
        branch: "main",
        archived_at: null,
        mode: "terminal",
        agent_provider: "grok",
        agent_transcript_provider: "grok",
        agent_transcript_id: "fedcba98-7654-3210-fedc-ba9876543210",
      },
    ] as unknown as never[];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    storeMocks.sessions = [];
    vi.clearAllMocks();
  });

  async function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    if (!button) throw new Error(`button "${label}" not found`);
    await act(async () => {
      button.click();
      // A macrotask hop drains the handler's full await chain
      // (list → restart → refresh → queue) before assertions run.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("confirms, restarts the daemon, and queues resume for daemon-backed sessions", async () => {
    await act(async () => {
      root.render(<BackgroundSessionsSettings />);
      await Promise.resolve();
    });

    await clickButton("backgroundSessions.controls.restart");
    // Live daemon → destructive, so the first click only arms the prompt.
    expect(apiMocks.daemonRestart).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "backgroundSessions.controls.confirmRestartPrompt",
    );

    await clickButton("backgroundSessions.controls.confirm");

    expect(apiMocks.daemonRestart).toHaveBeenCalledOnce();
    expect(storeMocks.setPendingTerminalInput).toHaveBeenCalledOnce();
    expect(storeMocks.setPendingTerminalInput).toHaveBeenCalledWith(
      DAEMON_SESSION_ID,
      "grok --resume 01a11a58-1780-78b3-91e9-1f6198c9d200",
      { agentProvider: "grok" },
    );
  });

  it("does not queue resume commands when the restart fails", async () => {
    apiMocks.daemonRestart.mockRejectedValue(new Error("spawn failed"));

    await act(async () => {
      root.render(<BackgroundSessionsSettings />);
      await Promise.resolve();
    });

    await clickButton("backgroundSessions.controls.restart");
    await clickButton("backgroundSessions.controls.confirm");

    expect(apiMocks.daemonRestart).toHaveBeenCalledOnce();
    expect(storeMocks.setPendingTerminalInput).not.toHaveBeenCalled();
  });
});
