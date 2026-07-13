import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../lib/api";

const apiMocks = vi.hoisted(() => ({
  daemonListSessions: vi.fn(),
  daemonStatus: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    daemonListSessions: apiMocks.daemonListSessions,
    daemonStatus: apiMocks.daemonStatus,
  },
}));

vi.mock("../store", () => ({
  useAppStore: (selector: (state: { sessions: never[] }) => unknown) =>
    selector({ sessions: [] }),
}));

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
});
