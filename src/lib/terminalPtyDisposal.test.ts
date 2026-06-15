import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingTerminalPtyDisposal,
  hasPendingTerminalPtyDisposal,
  scheduleTerminalPtyDisposal,
} from "./terminalPtyDisposal";

describe("terminal PTY disposal scheduler", () => {
  afterEach(() => {
    cancelPendingTerminalPtyDisposal("s1");
    vi.useRealTimers();
  });

  it("defers disposal so immediate remount can cancel it", () => {
    vi.useFakeTimers();
    const disposal = vi.fn();

    scheduleTerminalPtyDisposal("s1", disposal);
    expect(hasPendingTerminalPtyDisposal("s1")).toBe(true);

    cancelPendingTerminalPtyDisposal("s1");
    vi.advanceTimersByTime(250);

    expect(disposal).not.toHaveBeenCalled();
    expect(hasPendingTerminalPtyDisposal("s1")).toBe(false);
  });

  it("runs disposal after the remount grace window", () => {
    vi.useFakeTimers();
    const disposal = vi.fn();

    scheduleTerminalPtyDisposal("s1", disposal);
    vi.advanceTimersByTime(249);
    expect(disposal).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(disposal).toHaveBeenCalledTimes(1);
    expect(hasPendingTerminalPtyDisposal("s1")).toBe(false);
  });
});
