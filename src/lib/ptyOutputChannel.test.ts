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
