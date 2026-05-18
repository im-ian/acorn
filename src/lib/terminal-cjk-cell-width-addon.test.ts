import { describe, expect, it } from "vitest";
import {
  patchTerminalCellMeasurements,
  unpatchTerminalCellMeasurements,
} from "./terminal-cjk-cell-width-addon";

describe("terminal CJK cell width patch", () => {
  it("treats differing W and Hangul measurements as ASCII and leaves spacing untouched", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "W") return 8;
          if (chars === "가") return 13;
          return 16;
        },
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer).not.toHaveProperty("__acornCjkCellPatch");
    expect(rowContainer.style.letterSpacing).toBe("");
    expect(rowFactory).not.toHaveProperty("defaultSpacing");
  });

  it("uses half of the shared W/Hangul width as one cell", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _setDefaultSpacing: () => undefined,
      _rowElements: [document.createElement("div")],
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "가" || chars === "漢") return 8;
          if (chars === "あ" || chars === "汉") return 16;
          return 8;
        },
      },
      dimensions: {
        css: {
          cell: { width: 8 },
          canvas: { width: 48 },
        },
      },
    };
    const refreshCalls: Array<[number, number]> = [];
    const terminal = {
      cols: 6,
      rows: 6,
      refresh: (start: number, end: number) => refreshCalls.push([start, end]),
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(4);
    expect(renderer.dimensions.css.canvas.width).toBe(24);
    expect(renderer._rowElements[0].style.width).toBe("24px");
    expect(rowContainer.style.letterSpacing).toBe("-4px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -4 });
    expect(refreshCalls).toEqual([[0, 5]]);
  });

  it("leaves spacing untouched when W and Hangul measurements differ", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "W") return 8;
          if (chars === "가" || chars === "あ" || chars === "汉" || chars === "漢") return 16;
          return 8;
        },
      },
      dimensions: {
        css: {
          cell: { width: 8 },
          canvas: { width: 48 },
        },
      },
    };
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer).not.toHaveProperty("__acornCjkCellPatch");
    expect(renderer.dimensions.css.cell.width).toBe(8);
    expect(renderer.dimensions.css.canvas.width).toBe(48);
    expect(rowContainer.style.letterSpacing).toBe("");
    expect(rowFactory).not.toHaveProperty("defaultSpacing");
  });

  it("keeps repeated automatic calibration stable when W measurement includes existing letter spacing", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "가" || chars === "あ" || chars === "汉" || chars === "漢") {
            return 8;
          }
          if (chars === "W") {
            const spacing = Number.parseFloat(rowContainer.style.letterSpacing);
            return 8 + (Number.isFinite(spacing) ? spacing : 0);
          }
          return 8;
        },
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);
    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(4);
    expect(renderer.dimensions.css.canvas.width).toBe(24);
    expect(rowContainer.style.letterSpacing).toBe("-4px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -4 });
  });

  it("keeps CJK width cache measurements unclamped so row rendering applies per-glyph spacing", () => {
    const rowContainer = document.createElement("div");
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: {},
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "가" || chars === "あ" || chars === "汉" || chars === "漢") {
            return 8;
          }
          return 8;
        },
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer._widthCache.get("가", false, false)).toBe(8);
    expect(renderer._widthCache.get("A", false, false)).toBe(8);
  });

  it("uses W as one cell when W and Hangul measurements no longer match", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    let wideGlyphWidth = 7;
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _setDefaultSpacing: () => {
        rowContainer.style.letterSpacing = "1px";
        Object.assign(rowFactory, { defaultSpacing: 1 });
      },
      _rowElements: [document.createElement("div")],
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "W") return 7;
          if (chars === "가" || chars === "あ" || chars === "汉" || chars === "漢") {
            return wideGlyphWidth;
          }
          return 7;
        },
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);
    expect(renderer.dimensions.css.cell.width).toBe(3.5);
    expect(rowContainer.style.letterSpacing).toBe("-3.5px");

    wideGlyphWidth = 16;
    patchTerminalCellMeasurements(terminal);

    expect(rowContainer.style.letterSpacing).toBe("0px");
    expect(rowFactory).toMatchObject({ defaultSpacing: 0 });
    expect(renderer.dimensions.css.cell.width).toBe(7);
    expect(renderer.dimensions.css.canvas.width).toBe(42);
  });

  it("recovers global cell width from the legacy CJK basis patch when auto patching", () => {
    const rowContainer = document.createElement("div");
    const rowElement = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _rowElements: [rowElement],
      _setDefaultSpacing: () => undefined,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "W" ? 8 : 8,
      },
      __acornCjkCellPatch: {
        originalSetDefaultSpacing: () => undefined,
        originalCellWidth: 8,
        originalCanvasWidth: 48,
      },
      dimensions: { css: { cell: { width: 6.5 }, canvas: { width: 39 } } },
    };
    rowElement.style.width = "39px";
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(4);
    expect(renderer.dimensions.css.canvas.width).toBe(24);
    expect(rowElement.style.width).toBe("24px");
    expect(rowContainer.style.letterSpacing).toBe("-4px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -4 });
  });

  it("recovers global cell width from the legacy CJK basis patch when auto patching is unnecessary", () => {
    const rowContainer = document.createElement("div");
    const rowElement = document.createElement("div");
    const rowFactory = { defaultSpacing: -1.5 };
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _rowElements: [rowElement],
      _setDefaultSpacing: () => undefined,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string) => (chars === "W" ? 8 : 16),
      },
      __acornCjkCellPatch: {
        originalCellWidth: 8,
        originalCanvasWidth: 48,
      },
      dimensions: { css: { cell: { width: 6.5 }, canvas: { width: 39 } } },
    };
    rowContainer.style.letterSpacing = "-1.5px";
    rowElement.style.width = "39px";
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(8);
    expect(renderer.dimensions.css.canvas.width).toBe(48);
    expect(rowElement.style.width).toBe("48px");
    expect("_setDefaultSpacing" in renderer).toBe(false);
    expect(rowContainer.style.letterSpacing).toBe("");
    expect("defaultSpacing" in rowFactory).toBe(false);
  });

  it("removes the patched spacing hook when restoring without an original hook", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    let wideGlyphWidth = 8;
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "W" ? 8 : wideGlyphWidth,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);
    expect("_setDefaultSpacing" in renderer).toBe(true);
    expect(renderer.dimensions.css.cell.width).toBe(4);
    expect(rowContainer.style.letterSpacing).toBe("-4px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -4 });

    wideGlyphWidth = 16;
    patchTerminalCellMeasurements(terminal);

    expect("_setDefaultSpacing" in renderer).toBe(false);
    expect(rowContainer.style.letterSpacing).toBe("");
    expect("defaultSpacing" in rowFactory).toBe(false);
  });

  it("unpatch restores cell metrics and clears the patch marker", () => {
    const rowContainer = document.createElement("div");
    const rowElement = document.createElement("div");
    const rowFactory = {};
    const refreshCalls: Array<[number, number]> = [];
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _rowElements: [rowElement],
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "W" || chars === "가" || chars === "あ" || chars === "汉" || chars === "漢"
            ? 8
            : 8,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      cols: 6,
      rows: 6,
      refresh: (start: number, end: number) => refreshCalls.push([start, end]),
      _core: {
        _renderService: { _renderer: { value: renderer } },
      },
    };

    patchTerminalCellMeasurements(terminal);
    expect(renderer.dimensions.css.cell.width).toBe(4);
    expect(renderer).toHaveProperty("__acornCjkCellPatch");

    unpatchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(8);
    expect(renderer.dimensions.css.canvas.width).toBe(48);
    expect(rowElement.style.width).toBe("48px");
    expect(rowContainer.style.letterSpacing).toBe("");
    expect("defaultSpacing" in rowFactory).toBe(false);
    expect(renderer).not.toHaveProperty("__acornCjkCellPatch");
    expect(refreshCalls).toContainEqual([0, 5]);
  });

  it("unpatch is a no-op when no patch is active", () => {
    const renderer = {
      _rowContainer: document.createElement("div"),
      _rowFactory: {},
      _widthCache: {
        clear: () => undefined,
        get: () => 8,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const refreshCalls: Array<[number, number]> = [];
    const terminal = {
      cols: 6,
      rows: 6,
      refresh: (start: number, end: number) => refreshCalls.push([start, end]),
      _core: { _renderService: { _renderer: { value: renderer } } },
    };

    unpatchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(8);
    expect(refreshCalls).toEqual([]);
  });
});
