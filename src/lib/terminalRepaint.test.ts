import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalRepaintScheduler,
  repaintTerminalViewport,
} from "./terminalRepaint";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("repaintTerminalViewport", () => {
  it("forces layout, fits, and refreshes the visible xterm rows", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "offsetHeight", {
      configurable: true,
      get: vi.fn(() => 240),
    });
    const fit = vi.fn();
    const term = {
      rows: 24,
      refresh: vi.fn(),
      scrollToBottom: vi.fn(),
    };

    repaintTerminalViewport({ container, fit, term, scrollToBottom: true });

    expect(fit).toHaveBeenCalledTimes(1);
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("does not scroll when repainting after a window focus return", () => {
    const container = document.createElement("div");
    const fit = vi.fn();
    const term = {
      rows: 10,
      refresh: vi.fn(),
      scrollToBottom: vi.fn(),
    };

    repaintTerminalViewport({ container, fit, term });

    expect(term.refresh).toHaveBeenCalledWith(0, 9);
    expect(term.scrollToBottom).not.toHaveBeenCalled();
  });

  it("still refreshes when fit fails during a focus-return repaint", () => {
    const container = document.createElement("div");
    const fit = vi.fn(() => {
      throw new Error("zero-sized terminal");
    });
    const term = {
      rows: 8,
      refresh: vi.fn(),
    };

    repaintTerminalViewport({ container, fit, term });

    expect(term.refresh).toHaveBeenCalledWith(0, 7);
  });
});

describe("createTerminalRepaintScheduler", () => {
  it("runs repaint immediately, on the next frame, and after the delay", () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const repaint = vi.fn();
    const scheduler = createTerminalRepaintScheduler(repaint);

    scheduler.schedule();

    expect(repaint).toHaveBeenCalledTimes(1);
    frames.get(1)?.(0);
    expect(repaint).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50);
    expect(repaint).toHaveBeenCalledTimes(3);
  });

  it("cancels pending frame and timeout work when disposed", () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const repaint = vi.fn();
    const scheduler = createTerminalRepaintScheduler(repaint);

    scheduler.schedule();
    scheduler.dispose();
    frames.get(1)?.(0);
    vi.advanceTimersByTime(50);

    expect(repaint).toHaveBeenCalledTimes(1);
  });
});
