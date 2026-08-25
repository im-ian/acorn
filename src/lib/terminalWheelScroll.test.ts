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
}: {
  mouseTrackingMode?: string;
  bufferType?: string;
  cellHeight?: number;
  speed?: number;
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
  const patch = () => patchTerminalWheelScroll(term, () => speed);
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
  it("replays one wheel event per scrolled line while the app owns the wheel", () => {
    const { term, reported, wheel } = makeTerm();
    patchTerminalWheelScroll(term);

    wheel({ deltaY: -100 });

    expect(reported).toHaveLength(5);
    expect(
      reported.every(
        (event) =>
          event.deltaMode === WheelEvent.DOM_DELTA_LINE && event.deltaY === -1,
      ),
    ).toBe(true);
  });

  it("replays line-mode ticks so a tall cell cannot drop the TUI report", () => {
    const { term, reported, wheel } = makeTerm({ cellHeight: 80 });
    patchTerminalWheelScroll(term);

    wheel({ deltaY: -80 });

    expect(reported).toHaveLength(1);
    expect(reported[0]?.deltaMode).toBe(WheelEvent.DOM_DELTA_LINE);
    expect(reported[0]?.deltaY).toBe(-1);
  });

  it("reports more lines as the scroll speed rises", () => {
    const { patch, reported, wheel } = makeTerm({ speed: 2 });
    patch();

    wheel({ deltaY: -100 });

    expect(reported).toHaveLength(10);
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
});
