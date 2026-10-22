import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrderedChannelReceiver } from "./ptyOutputChannel";

describe("createOrderedChannelReceiver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers out-of-order frames in index order", () => {
    const seen: unknown[] = [];
    const onGap = vi.fn();
    const receiver = createOrderedChannelReceiver((m) => seen.push(m), {
      onGap,
    });

    receiver.receive({ index: 1, message: "b" });
    expect(seen).toEqual([]);
    receiver.receive({ index: 0, message: "a" });
    receiver.receive({ index: 2, message: "c" });

    expect(seen).toEqual(["a", "b", "c"]);
    vi.advanceTimersByTime(10_000);
    expect(onGap).not.toHaveBeenCalled();
  });

  it("skips an index that never arrives instead of stalling", () => {
    const seen: unknown[] = [];
    const onGap = vi.fn();
    const receiver = createOrderedChannelReceiver((m) => seen.push(m), {
      onGap,
      gapTimeoutMs: 100,
    });

    receiver.receive({ index: 0, message: "a" });
    receiver.receive({ index: 2, message: "c" });
    receiver.receive({ index: 3, message: "d" });
    expect(seen).toEqual(["a"]);

    vi.advanceTimersByTime(100);
    expect(seen).toEqual(["a", "c", "d"]);
    expect(onGap).toHaveBeenCalledTimes(1);

    // The lost chunk arriving late must not be painted out of order.
    receiver.receive({ index: 1, message: "b" });
    receiver.receive({ index: 4, message: "e" });
    expect(seen).toEqual(["a", "c", "d", "e"]);
  });

  it("times each missing index from when it became the head", () => {
    const seen: unknown[] = [];
    const onGap = vi.fn();
    const receiver = createOrderedChannelReceiver((m) => seen.push(m), {
      onGap,
      gapTimeoutMs: 2000,
    });

    receiver.receive({ index: 0, message: 0 });
    receiver.receive({ index: 2, message: 2 });
    vi.advanceTimersByTime(100);
    receiver.receive({ index: 4, message: 4 });
    vi.advanceTimersByTime(1400);
    receiver.receive({ index: 1, message: 1 });
    // Index 3 has been missing for 500ms, not 2s.
    vi.advanceTimersByTime(500);
    receiver.receive({ index: 3, message: 3 });

    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(onGap).not.toHaveBeenCalled();
  });

  it("does not deliver after dispose", () => {
    const seen: unknown[] = [];
    const receiver = createOrderedChannelReceiver((m) => seen.push(m), {
      onGap: vi.fn(),
    });

    receiver.dispose();
    receiver.receive({ index: 0, message: "a" });

    expect(seen).toEqual([]);
  });
});
