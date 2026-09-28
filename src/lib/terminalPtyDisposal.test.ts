import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginTerminalMount,
  cancelPendingTerminalPtyDisposal,
  hasPendingTerminalPtyDisposal,
  scheduleTerminalPtyDisposal,
} from "./terminalPtyDisposal";

describe("terminal PTY disposal scheduler", () => {
  afterEach(() => {
    cancelPendingTerminalPtyDisposal("s1");
    vi.useRealTimers();
  });

  it("defers disposal so immediate remount can cancel it", async () => {
    vi.useFakeTimers();
    const epoch = beginTerminalMount("s1");
    const disposal = vi.fn();

    scheduleTerminalPtyDisposal("s1", epoch, disposal);
    expect(hasPendingTerminalPtyDisposal("s1")).toBe(true);

    beginTerminalMount("s1");
    await vi.advanceTimersByTimeAsync(250);

    expect(disposal).not.toHaveBeenCalled();
    expect(hasPendingTerminalPtyDisposal("s1")).toBe(false);
  });

  it("runs disposal after the remount grace window", async () => {
    vi.useFakeTimers();
    const epoch = beginTerminalMount("s1");
    const disposal = vi.fn();

    scheduleTerminalPtyDisposal("s1", epoch, disposal);
    await vi.advanceTimersByTimeAsync(249);
    expect(disposal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(disposal).toHaveBeenCalledTimes(1);
    expect(hasPendingTerminalPtyDisposal("s1")).toBe(false);
  });

  it("reaps a PTY that appears after the grace timer", async () => {
    vi.useFakeTimers();
    const epoch = beginTerminalMount("s1");
    let releaseSpawn: () => void = () => {};
    const spawn = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const disposal = vi.fn();

    scheduleTerminalPtyDisposal("s1", epoch, disposal, spawn);
    await vi.advanceTimersByTimeAsync(250);
    expect(disposal).not.toHaveBeenCalled();

    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0);
    expect(disposal).toHaveBeenCalledTimes(1);
  });

  it("does not reap when a remount wins while spawn is still in flight", async () => {
    vi.useFakeTimers();
    const epoch = beginTerminalMount("s1");
    let releaseSpawn: () => void = () => {};
    const spawn = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const disposal = vi.fn();

    scheduleTerminalPtyDisposal("s1", epoch, disposal, spawn);
    await vi.advanceTimersByTimeAsync(250);
    beginTerminalMount("s1");
    releaseSpawn();
    await vi.advanceTimersByTimeAsync(0);

    expect(disposal).not.toHaveBeenCalled();
  });
});
