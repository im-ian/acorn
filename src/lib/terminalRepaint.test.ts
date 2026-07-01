import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalRepaintScheduler,
  createTerminalVisibilityRepaintObserver,
  repaintTerminalViewport,
  shouldRepaintForVisibility,
} from "./terminalRepaint";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

describe("shouldRepaintForVisibility", () => {
  it("repaints only on the hidden -> visible transition", () => {
    expect(shouldRepaintForVisibility(false, true)).toBe(true);
    expect(shouldRepaintForVisibility(true, true)).toBe(false);
    expect(shouldRepaintForVisibility(true, false)).toBe(false);
    expect(shouldRepaintForVisibility(false, false)).toBe(false);
  });
});

interface FakeEntry {
  isIntersecting: boolean;
  intersectionRatio: number;
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: FakeEntry[]) => void;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: (entries: FakeEntry[]) => void) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(...entries: FakeEntry[]): void {
    this.callback(entries);
  }
}

describe("createTerminalVisibilityRepaintObserver", () => {
  function stubObserver(): typeof FakeIntersectionObserver {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    return FakeIntersectionObserver;
  }

  it("returns a no-op when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const repaint = vi.fn();
    const element = document.createElement("div");

    const observer = createTerminalVisibilityRepaintObserver(element, repaint);
    observer.dispose();

    expect(repaint).not.toHaveBeenCalled();
  });

  it("observes the element and repaints when it becomes visible", () => {
    const Observer = stubObserver();
    const repaint = vi.fn();
    const element = document.createElement("div");

    createTerminalVisibilityRepaintObserver(element, repaint);
    const instance = Observer.instances[0];

    expect(instance.observed).toContain(element);

    instance.emit({ isIntersecting: true, intersectionRatio: 1 });
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it("does not repaint again while the terminal stays visible", () => {
    const Observer = stubObserver();
    const repaint = vi.fn();

    createTerminalVisibilityRepaintObserver(
      document.createElement("div"),
      repaint,
    );
    const instance = Observer.instances[0];

    instance.emit({ isIntersecting: true, intersectionRatio: 0.5 });
    instance.emit({ isIntersecting: true, intersectionRatio: 1 });

    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it("repaints again after the terminal is hidden and shown once more", () => {
    const Observer = stubObserver();
    const repaint = vi.fn();

    createTerminalVisibilityRepaintObserver(
      document.createElement("div"),
      repaint,
    );
    const instance = Observer.instances[0];

    instance.emit({ isIntersecting: true, intersectionRatio: 1 });
    instance.emit({ isIntersecting: false, intersectionRatio: 0 });
    instance.emit({ isIntersecting: true, intersectionRatio: 1 });

    expect(repaint).toHaveBeenCalledTimes(2);
  });

  it("disconnects the observer on dispose", () => {
    const Observer = stubObserver();
    const observer = createTerminalVisibilityRepaintObserver(
      document.createElement("div"),
      vi.fn(),
    );

    observer.dispose();

    expect(Observer.instances[0].disconnected).toBe(true);
  });
});
