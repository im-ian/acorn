import { describe, expect, it, vi } from "vitest";
import { createInFlightCoalescer } from "./inFlightCoalescer";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("createInFlightCoalescer", () => {
  it("shares one loader call across overlapping requests", async () => {
    const pending = deferred<number>();
    const load = vi.fn(() => pending.promise);
    const coalesced = createInFlightCoalescer(load);

    const first = coalesced();
    const second = coalesced();
    pending.resolve(42);

    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts a new loader call after the previous request settles", async () => {
    const load = vi.fn(async () => load.mock.calls.length);
    const coalesced = createInFlightCoalescer(load);

    await expect(coalesced()).resolves.toBe(1);
    await expect(coalesced()).resolves.toBe(2);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
