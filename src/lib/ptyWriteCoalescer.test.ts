import { describe, expect, it } from "vitest";
import { createPtyWriteCoalescer } from "./ptyWriteCoalescer";

describe("createPtyWriteCoalescer", () => {
  it("joins writes to the same session into one callback", async () => {
    const sent: Array<[string, string]> = [];
    const scheduled: Array<() => void> = [];
    const coalescer = createPtyWriteCoalescer(
      (sessionId, data) => {
        sent.push([sessionId, data]);
      },
      (callback) => {
        scheduled.push(callback);
      },
    );

    void coalescer.enqueue("a", "x");
    void coalescer.enqueue("a", "y");
    void coalescer.enqueue("b", "z");
    expect(sent).toEqual([]);
    expect(scheduled.length).toBeGreaterThan(0);

    scheduled[0]();
    await coalescer.flush();
    expect(sent).toEqual([
      ["a", "xy"],
      ["b", "z"],
    ]);
  });

  it("ignores empty payloads and can flush without a scheduled turn", async () => {
    const sent: Array<[string, string]> = [];
    const coalescer = createPtyWriteCoalescer((sessionId, data) => {
      sent.push([sessionId, data]);
    });

    await coalescer.enqueue("a", "");
    await coalescer.flush();
    expect(sent).toEqual([]);

    void coalescer.enqueue("a", "hi");
    await coalescer.flush();
    expect(sent).toEqual([["a", "hi"]]);
  });

  it("sends a later burst only after the previous write settles", async () => {
    const sent: string[] = [];
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let writes = 0;
    const coalescer = createPtyWriteCoalescer(async (_sessionId, data) => {
      writes += 1;
      if (writes === 1) await firstGate;
      sent.push(data);
    });

    const first = coalescer.enqueue("a", "x");
    void coalescer.flush("a");
    const second = coalescer.enqueue("a", "y");
    void coalescer.flush("a");
    await Promise.resolve();
    expect(sent).toEqual([]);

    releaseFirst();
    await first;
    await second;
    expect(sent).toEqual(["x", "y"]);
  });
});
