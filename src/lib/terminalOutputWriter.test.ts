import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalOutputWriter } from "./terminalOutputWriter";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function createFrameScheduler() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  return {
    requestFrame(callback: FrameRequestCallback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id: number) {
      frames.delete(id);
    },
    runFrame(id?: number) {
      const frameId = id ?? frames.keys().next().value;
      if (frameId === undefined) return;
      const callback = frames.get(frameId);
      frames.delete(frameId);
      callback?.(0);
    },
    hasFrame(id?: number) {
      if (id === undefined) return frames.size > 0;
      return frames.has(id);
    },
  };
}

describe("createTerminalOutputWriter", () => {
  it("coalesces active output into one frame-bound write", () => {
    const frames = createFrameScheduler();
    const afterWrite = vi.fn();
    const write = vi.fn((chunk: Uint8Array, onParsed: () => void) => {
      expect(text(chunk)).toBe("abc");
      onParsed();
    });
    const writer = createTerminalOutputWriter({
      write,
      afterWrite,
      isActive: () => true,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    writer.enqueue(bytes("a"));
    writer.enqueue(bytes("bc"));

    expect(write).not.toHaveBeenCalled();
    frames.runFrame();

    expect(write).toHaveBeenCalledTimes(1);
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(writer.pendingBytes()).toBe(0);
  });

  it("flushes inactive output on a slower cadence with a smaller batch budget", () => {
    vi.useFakeTimers();
    const written: string[] = [];
    const writer = createTerminalOutputWriter({
      write: (chunk, onParsed) => {
        written.push(text(chunk));
        onParsed();
      },
      afterWrite: vi.fn(),
      isActive: () => false,
      inactiveBatchBytes: 4,
      inactiveDelayMs: 80,
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });

    writer.enqueue(bytes("ab"));
    writer.enqueue(bytes("cd"));
    writer.enqueue(bytes("ef"));

    vi.advanceTimersByTime(79);
    expect(written).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(written).toEqual(["abcd"]);
    expect(writer.pendingBytes()).toBe(2);

    vi.advanceTimersByTime(80);
    expect(written).toEqual(["abcd", "ef"]);
    expect(writer.pendingBytes()).toBe(0);
  });

  it("promotes pending inactive output to the next frame when flushed soon", () => {
    vi.useFakeTimers();
    const frames = createFrameScheduler();
    let active = false;
    const written: string[] = [];
    const writer = createTerminalOutputWriter({
      write: (chunk, onParsed) => {
        written.push(text(chunk));
        onParsed();
      },
      afterWrite: vi.fn(),
      isActive: () => active,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
      inactiveDelayMs: 80,
    });

    writer.enqueue(bytes("hidden"));
    active = true;
    writer.flushSoon();

    vi.advanceTimersByTime(80);
    expect(written).toEqual([]);
    expect(frames.hasFrame()).toBe(true);

    frames.runFrame();
    expect(written).toEqual(["hidden"]);
  });

  it("resolves whenIdle after queued output has been parsed", async () => {
    vi.useFakeTimers();
    const frames = createFrameScheduler();
    const parseCallbacks: Array<() => void> = [];
    const writer = createTerminalOutputWriter({
      write: (_chunk, onParsed) => {
        parseCallbacks.push(onParsed);
      },
      afterWrite: vi.fn(),
      isActive: () => true,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
    });

    writer.enqueue(bytes("pending"));
    const idle = writer.whenIdle();
    let resolved = false;
    void idle.then(() => {
      resolved = true;
    });

    frames.runFrame();
    await Promise.resolve();
    expect(resolved).toBe(false);

    expect(parseCallbacks).toHaveLength(1);
    parseCallbacks[0]();
    await idle;
    expect(resolved).toBe(true);
  });
});
