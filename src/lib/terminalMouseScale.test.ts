import { describe, expect, it, vi } from "vitest";
import {
  patchTerminalMouseCoordinateScale,
  scaledMousePositionForElement,
} from "./terminalMouseScale";

function makeElement({
  offsetWidth,
  offsetHeight,
  rect,
}: {
  offsetWidth: number;
  offsetHeight: number;
  rect: DOMRectInit;
}): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "offsetWidth", {
    configurable: true,
    value: offsetWidth,
  });
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    value: offsetHeight,
  });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect(rect),
  );
  return element;
}

describe("scaledMousePositionForElement", () => {
  it("converts visual coordinates back into unscaled element coordinates", () => {
    const element = makeElement({
      offsetWidth: 200,
      offsetHeight: 100,
      rect: { x: 100, y: 50, width: 250, height: 125 },
    });

    expect(
      scaledMousePositionForElement({ clientX: 150, clientY: 100 }, element),
    ).toEqual({ clientX: 140, clientY: 90 });
  });

  it("leaves coordinates unchanged when no transform scale is present", () => {
    const event = { clientX: 150, clientY: 100 };
    const element = makeElement({
      offsetWidth: 200,
      offsetHeight: 100,
      rect: { x: 100, y: 50, width: 200, height: 100 },
    });

    expect(scaledMousePositionForElement(event, element)).toBe(event);
  });
});

describe("patchTerminalMouseCoordinateScale", () => {
  it("normalizes xterm mouse service inputs and restores originals", () => {
    const element = makeElement({
      offsetWidth: 200,
      offsetHeight: 100,
      rect: { x: 100, y: 50, width: 250, height: 125 },
    });
    const getCoords = vi.fn(() => [1, 1] as [number, number]);
    const getMouseReportCoords = vi.fn(() => ({ col: 0, row: 0, x: 0, y: 0 }));
    const getScrollAmount = vi.fn(() => 0);
    const mouseService = { getCoords, getMouseReportCoords };
    const selectionService = {
      _screenElement: element,
      _getMouseEventScrollAmount: getScrollAmount,
    };
    const term = {
      _core: {
        _mouseService: mouseService,
        _selectionService: selectionService,
      },
    };

    const unpatch = patchTerminalMouseCoordinateScale(term as never);

    (
      mouseService.getCoords as (
        event: { clientX: number; clientY: number },
        element: HTMLElement,
        colCount: number,
        rowCount: number,
        isSelection?: boolean,
      ) => [number, number] | undefined
    )({ clientX: 150, clientY: 100 }, element, 80, 24, true);
    (
      mouseService.getMouseReportCoords as (
        event: MouseEvent,
        element: HTMLElement,
      ) => { col: number; row: number; x: number; y: number }
    )({ clientX: 150, clientY: 100 } as MouseEvent, element);
    (
      selectionService._getMouseEventScrollAmount as (
        event: MouseEvent,
      ) => number
    )({
      clientX: 150,
      clientY: 100,
    } as MouseEvent);

    expect(getCoords).toHaveBeenCalledWith(
      { clientX: 140, clientY: 90 },
      element,
      80,
      24,
      true,
    );
    expect(getMouseReportCoords).toHaveBeenCalledWith(
      { clientX: 140, clientY: 90 },
      element,
    );
    expect(getScrollAmount).toHaveBeenCalledWith({ clientX: 140, clientY: 90 });

    unpatch();

    expect(mouseService.getCoords).toBe(getCoords);
    expect(mouseService.getMouseReportCoords).toBe(getMouseReportCoords);
    expect(selectionService._getMouseEventScrollAmount).toBe(getScrollAmount);
  });

  it("returns a no-op cleanup when xterm has no mouse service", () => {
    const term = { _core: {} };
    const unpatch = patchTerminalMouseCoordinateScale(term as never);
    expect(typeof unpatch).toBe("function");
    expect(() => unpatch()).not.toThrow();
  });

  it("falls back to core.screenElement when selection service has no screen element", () => {
    const element = makeElement({
      offsetWidth: 200,
      offsetHeight: 100,
      rect: { x: 100, y: 50, width: 250, height: 125 },
    });
    const getCoords = vi.fn(() => [1, 1] as [number, number]);
    const getScrollAmount = vi.fn(() => 0);
    const mouseService = { getCoords };
    const selectionService = {
      _screenElement: undefined,
      _getMouseEventScrollAmount: getScrollAmount,
    };
    const term = {
      _core: {
        screenElement: element,
        _mouseService: mouseService,
        _selectionService: selectionService,
      },
    };

    patchTerminalMouseCoordinateScale(term as never);

    (
      selectionService._getMouseEventScrollAmount as (
        event: MouseEvent,
      ) => number
    )({ clientX: 150, clientY: 100 } as MouseEvent);

    expect(getScrollAmount).toHaveBeenCalledWith({ clientX: 140, clientY: 90 });
  });

  it("passes the raw event through when no screen element is reachable", () => {
    const getCoords = vi.fn(() => [1, 1] as [number, number]);
    const getScrollAmount = vi.fn(() => 0);
    const mouseService = { getCoords };
    const selectionService = {
      _screenElement: undefined,
      _getMouseEventScrollAmount: getScrollAmount,
    };
    const term = {
      _core: {
        _mouseService: mouseService,
        _selectionService: selectionService,
      },
    };

    patchTerminalMouseCoordinateScale(term as never);

    const event = { clientX: 150, clientY: 100 } as MouseEvent;
    (
      selectionService._getMouseEventScrollAmount as (
        event: MouseEvent,
      ) => number
    )(event);
    expect(getScrollAmount).toHaveBeenCalledWith(event);
  });

  it("leaves the selection service untouched when it exposes no scroll-amount helper", () => {
    const mouseService = { getCoords: vi.fn(() => [0, 0] as [number, number]) };
    const selectionService: { _screenElement?: HTMLElement } = {};
    const term = {
      _core: {
        _mouseService: mouseService,
        _selectionService: selectionService,
      },
    };

    const unpatch = patchTerminalMouseCoordinateScale(term as never);
    expect(
      (selectionService as { _getMouseEventScrollAmount?: unknown })
        ._getMouseEventScrollAmount,
    ).toBeUndefined();
    expect(() => unpatch()).not.toThrow();
  });
});

describe("scaledMousePositionForElement edge cases", () => {
  it("returns the original event when the element has zero offset width", () => {
    const element = makeElement({
      offsetWidth: 0,
      offsetHeight: 100,
      rect: { x: 0, y: 0, width: 200, height: 100 },
    });
    const event = { clientX: 50, clientY: 50 };
    expect(scaledMousePositionForElement(event, element)).toBe(event);
  });
});
