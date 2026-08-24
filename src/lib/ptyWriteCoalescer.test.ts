import { describe, expect, it } from "vitest";
import { createPtyWriteCoalescer } from "./ptyWriteCoalescer";

describe("createPtyWriteCoalescer", () => {
  it("joins writes to the same session into one callback", () => {
    const sent: Array<[string, string]> = [];
    const scheduled: Array<() => void> = [];
    const coalescer = createPtyWriteCoalescer(
      (sessionId, data) => sent.push([sessionId, data]),
      (callback) => {
        scheduled.push(callback);
      },
    );

    coalescer.enqueue("a", "x");
    coalescer.enqueue("a", "y");
    coalescer.enqueue("b", "z");
    expect(sent).toEqual([]);
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    expect(sent).toEqual([
      ["a", "xy"],
      ["b", "z"],
    ]);
  });

  it("ignores empty payloads and can flush without a scheduled turn", () => {
    const sent: Array<[string, string]> = [];
    const coalescer = createPtyWriteCoalescer((sessionId, data) =>
      sent.push([sessionId, data]),
    );

    coalescer.enqueue("a", "");
    coalescer.flush();
    expect(sent).toEqual([]);

    coalescer.enqueue("a", "hi");
    coalescer.flush();
    expect(sent).toEqual([["a", "hi"]]);
  });
});
