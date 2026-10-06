import { describe, expect, it } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  patchTerminalWheelScroll,
  wheelScrollLineCount,
} from "./terminalWheelScroll";

function makeTerm({
  mouseTrackingMode = "any",
  bufferType = "alternate",
  cellHeight = 20,
  speed = 1,
  now = () => performance.now(),
}: {
  mouseTrackingMode?: string;
  bufferType?: string;
  cellHeight?: number;
  speed?: number;
  now?: () => number;
} = {}) {
  const element = document.createElement("div");
  let handler: (event: WheelEvent) => boolean = () => true;
  const reported: WheelEvent[] = [];
  // Stands in for xterm's own wheel listener: it asks the custom handler
  // first and only reports when that returns true.
  element.addEventListener("wheel", (event) => {
    if (!handler(event as WheelEvent)) return;
    reported.push(event as WheelEvent);
  });
  const term = {
    rows: 24,
    modes: { mouseTrackingMode },
    buffer: { active: { type: bufferType } },
    attachCustomWheelEventHandler: (fn: (event: WheelEvent) => boolean) => {
      handler = fn;
    },
    _core: {
      element,
      _renderService: { dimensions: { css: { cell: { height: cellHeight } } } },
    },
  } as unknown as XTerm;
  const patch = () => patchTerminalWheelScroll(term, () => speed, now);
  const wheel = (init: WheelEventInit) =>
    element.dispatchEvent(
      new WheelEvent("wheel", { cancelable: true, ...init }),
    );
  return { term, element, reported, patch, wheel };
}

describe("wheelScrollLineCount", () => {
  it("converts pixel deltas to whole lines and carries the remainder", () => {
    const first = wheelScrollLineCount({
      deltaY: 12,
      deltaMode: 0,
      cellHeight: 20,
      rows: 24,
      carry: 0,
    });
    expect(first.lines).toBe(0);

    const second = wheelScrollLineCount({
      deltaY: 12,
      deltaMode: 0,
      cellHeight: 20,
      rows: 24,
      carry: first.carry,
    });
    expect(second.lines).toBe(1);
    expect(second.carry).toBeCloseTo(0.2);
  });

  it("scales the line count by the scroll-speed multiplier", () => {
    expect(
      wheelScrollLineCount({
        deltaY: 100,
        deltaMode: 0,
        cellHeight: 20,
        rows: 24,
        carry: 0,
        speed: 0.5,
      }).lines,
    ).toBe(2);
    expect(
      wheelScrollLineCount({
        deltaY: 40,
        deltaMode: 0,
        cellHeight: 20,
        rows: 24,
        carry: 0,
        speed: 3,
      }).lines,
    ).toBe(6);
  });

  it("clamps momentum bursts without queueing a backlog", () => {
    const { lines, carry } = wheelScrollLineCount({
      deltaY: -4000,
      deltaMode: 0,
      cellHeight: 20,
      rows: 24,
      carry: 0,
    });
    expect(lines).toBe(-8);
    expect(carry).toBe(0);
  });

  it("treats line and page deltas as lines and screenfuls", () => {
    expect(
      wheelScrollLineCount({
        deltaY: 3,
        deltaMode: 1,
        cellHeight: 20,
        rows: 24,
        carry: 0,
      }).lines,
    ).toBe(3);
    expect(
      wheelScrollLineCount({
        deltaY: 1,
        deltaMode: 2,
        cellHeight: 20,
        rows: 6,
        carry: 0,
      }).lines,
    ).toBe(6);
  });
});

describe("patchTerminalWheelScroll", () => {
  it("leaves large pixel wheels to xterm", () => {
    const { term, reported, wheel } = makeTerm();
    patchTerminalWheelScroll(term);

    wheel({ deltaY: -100 });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaY).toBe(-100);
  });

  it("replays one LINE-mode tick for a trackpad-sized delta", () => {
    const { term, reported, wheel } = makeTerm();
    patchTerminalWheelScroll(term);

    wheel({ deltaY: -40 });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    expect(reported[0]?.deltaY).toBe(-1);
  });

  it("replays a LINE tick for a trackpad delta a tall cell would otherwise drop", () => {
    const { term, reported, wheel } = makeTerm({ cellHeight: 80 });
    patchTerminalWheelScroll(term);

    expect(wheel({ deltaY: -40 })).toBe(false);
    expect(reported).toHaveLength(0);

    wheel({ deltaY: -40 });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    expect(reported[0]?.deltaY).toBe(-1);
  });

  it("reaches a report sooner as the scroll speed rises", () => {
    const { term, reported, wheel } = makeTerm({ speed: 1 });
    patchTerminalWheelScroll(term);
    expect(wheel({ deltaY: 12 })).toBe(false);
    expect(reported).toHaveLength(0);

    const fast = makeTerm({ speed: 2 });
    fast.patch();
    fast.wheel({ deltaY: 12 });
    expect(fast.reported).toHaveLength(1);
  });

  it("swallows sub-line deltas instead of reporting them", () => {
    const { term, reported, wheel } = makeTerm();
    patchTerminalWheelScroll(term);

    expect(wheel({ deltaY: 5 })).toBe(false);
    expect(reported).toHaveLength(0);
  });

  it("leaves the viewport scroll path to xterm", () => {
    const { term, reported, wheel } = makeTerm({
      mouseTrackingMode: "none",
      bufferType: "normal",
    });
    patchTerminalWheelScroll(term);

    wheel({ deltaY: -100 });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaY).toBe(-100);
  });

  it("leaves modified wheels to xterm", () => {
    const { term, reported, wheel } = makeTerm();
    patchTerminalWheelScroll(term);

    wheel({ deltaY: -100, shiftKey: true });

    expect(reported).toHaveLength(1);
  });

  it("restores xterm's own handling when unpatched", () => {
    const { term, reported, wheel } = makeTerm();
    const unpatch = patchTerminalWheelScroll(term);
    unpatch();

    wheel({ deltaY: -100 });

    expect(reported).toHaveLength(1);
  });

  it("reports one line tick per 32ms and drops the rest of the burst", () => {
    let t = 1_000;
    const { reported, wheel, patch } = makeTerm({ now: () => t });
    patch();

    for (let i = 0; i < 5; i++) wheel({ deltaY: -20 });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    expect(reported[0]?.deltaY).toBe(-1);

    t += 31;
    wheel({ deltaY: -20 });
    expect(reported).toHaveLength(1);

    t += 1;
    wheel({ deltaY: -20 });
    expect(reported).toHaveLength(2);
    expect(reported[1]?.deltaY).toBe(-1);
  });

  it("keeps a steady same-magnitude drag reporting once per interval", () => {
    let t = 0;
    const { reported, wheel, patch } = makeTerm({ now: () => t });
    patch();

    for (const at of [0, 40, 80, 120]) {
      t = at;
      wheel({ deltaY: -20 });
    }

    expect(reported).toHaveLength(4);
    expect(
      reported.every(
        (event) =>
          event.deltaY === -1 && event.deltaMode === WheelEvent.DOM_DELTA_LINE,
      ),
    ).toBe(true);
  });

  it("drops a decaying trackpad tail and still reports the next gesture", () => {
    let t = 0;
    const { reported, wheel, patch } = makeTerm({ now: () => t });
    patch();

    for (const [index, deltaY] of [-60, -40, -30, -20].entries()) {
      t = index * 40;
      wheel({ deltaY });
    }

    expect(reported).toHaveLength(3);
    expect(reported[0]?.deltaY).toBe(-60);
    expect(reported[0]?.deltaMode).toBe(WheelEvent.DOM_DELTA_PIXEL);
    expect(reported[1]?.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    expect(reported[1]?.deltaY).toBe(-1);
    expect(reported[2]?.deltaY).toBe(-1);

    t = 120 + 201;
    wheel({ deltaY: -20 });
    expect(reported).toHaveLength(4);
    expect(reported[3]?.deltaY).toBe(-1);
  });

  it("does not treat a one-pixel slowdown as momentum", () => {
    let t = 0;
    const { reported, wheel, patch } = makeTerm({ now: () => t });
    patch();

    // Each sample is still at least one line. Only the decay ratio differs.
    for (const [index, deltaY] of [-40, -39, -38, -37].entries()) {
      t = index * 40;
      wheel({ deltaY });
    }

    expect(reported).toHaveLength(4);
  });

  it("lets the first large pixel wheel through and swallows the next inside the window", () => {
    let t = 0;
    const { reported, wheel, patch } = makeTerm({ now: () => t });
    patch();

    expect(wheel({ deltaY: -100 })).toBe(true);
    expect(wheel({ deltaY: -100 })).toBe(false);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaY).toBe(-100);

    t = 32;
    expect(wheel({ deltaY: -120 })).toBe(true);
    expect(reported).toHaveLength(2);
    expect(reported[1]?.deltaY).toBe(-120);
  });
});
