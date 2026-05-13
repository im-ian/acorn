import { describe, expect, it } from "vitest";
import {
  calculateCellWidthFromSample,
  patchTerminalCellMeasurements,
  selectCjkMeasurementSample,
  shouldPatchTerminalCellMeasurements,
} from "./terminal-cjk-cell-width-addon";

describe("terminal CJK cell width patch", () => {
  it("only enables the measurement patch for known CJK terminal fonts", () => {
    expect(shouldPatchTerminalCellMeasurements('"D2Coding", monospace')).toBe(
      true,
    );
    expect(shouldPatchTerminalCellMeasurements('"Sarasa Mono K", monospace')).toBe(
      true,
    );
    expect(
      shouldPatchTerminalCellMeasurements('"Noto Sans Mono CJK KR", monospace'),
    ).toBe(true);
    expect(shouldPatchTerminalCellMeasurements("JetBrains Mono, monospace")).toBe(
      false,
    );
  });

  it("selects a measurement sample that matches the CJK font family", () => {
    expect(selectCjkMeasurementSample('"D2Coding", monospace')).toBe("가");
    expect(selectCjkMeasurementSample('"Sarasa Mono K", monospace')).toBe("가");
    expect(selectCjkMeasurementSample('"Sarasa Mono J", monospace')).toBe("あ");
    expect(selectCjkMeasurementSample('"Sarasa Mono SC", monospace')).toBe("汉");
    expect(selectCjkMeasurementSample('"Sarasa Mono TC", monospace')).toBe("漢");
    expect(selectCjkMeasurementSample('"Noto Sans Mono CJK KR", monospace')).toBe(
      "가",
    );
    expect(selectCjkMeasurementSample('"Noto Sans Mono CJK JP", monospace')).toBe(
      "あ",
    );
    expect(selectCjkMeasurementSample('"Noto Sans Mono CJK SC", monospace')).toBe(
      "汉",
    );
    expect(selectCjkMeasurementSample('"Noto Sans Mono CJK TC", monospace')).toBe(
      "漢",
    );
    expect(selectCjkMeasurementSample("JetBrains Mono, monospace")).toBeNull();
  });

  it("calculates the terminal cell width from half of a wide CJK sample", () => {
    expect(calculateCellWidthFromSample(13, 2)).toBe(6.5);
    expect(calculateCellWidthFromSample(16, 2)).toBe(8);
    expect(calculateCellWidthFromSample(0, 2)).toBeNull();
  });

  it("sets the caret cell width from the CJK sample and refreshes visible rows", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _setDefaultSpacing: () => undefined,
      _rowElements: [document.createElement("div")],
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "가" ? 13 : 8,
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
      options: { fontFamily: '"D2Coding", monospace' },
      cols: 6,
      rows: 6,
      refresh: (start: number, end: number) => refreshCalls.push([start, end]),
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(6.5);
    expect(renderer.dimensions.css.canvas.width).toBe(39);
    expect(renderer._rowElements[0].style.width).toBe("39px");
    expect(rowContainer.style.letterSpacing).toBe("-1.5px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -1.5 });
    expect(refreshCalls).toEqual([[0, 5]]);
  });

  it("keeps repeated CJK calibration stable when W measurement includes existing letter spacing", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "가") return 13;
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
      options: { fontFamily: '"D2Coding", monospace' },
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);
    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(6.5);
    expect(rowContainer.style.letterSpacing).toBe("-1.5px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -1.5 });
  });

  it("uses the matching CJK sample when deriving non-Korean CJK cell width", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _rowElements: [document.createElement("div")],
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) => {
          if (chars === "あ") return 15;
          if (chars === "가") return 11;
          return 8;
        },
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      options: { fontFamily: '"Noto Sans Mono CJK JP", monospace' },
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer.dimensions.css.cell.width).toBe(7.5);
    expect(renderer.dimensions.css.canvas.width).toBe(45);
    expect(rowContainer.style.letterSpacing).toBe("-0.5px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -0.5 });
  });

  it("keeps CJK width cache measurements unclamped so row rendering applies per-glyph spacing", () => {
    const rowContainer = document.createElement("div");
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: {},
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "가" ? 13 : 8,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      options: { fontFamily: '"D2Coding", monospace' },
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(renderer._widthCache.get("가", false, false)).toBe(13);
    expect(renderer._widthCache.get("A", false, false)).toBe(8);
  });

  it("restores xterm default spacing when switching away from CJK fonts", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
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
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "가" ? 13 : 7,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      options: { fontFamily: '"D2Coding", monospace' },
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);
    expect(renderer.dimensions.css.cell.width).toBe(6.5);
    expect(rowContainer.style.letterSpacing).toBe("-0.5px");

    terminal.options.fontFamily = "JetBrains Mono, monospace";
    patchTerminalCellMeasurements(terminal);

    expect(rowContainer.style.letterSpacing).toBe("1px");
    expect(rowFactory).toMatchObject({ defaultSpacing: 1 });
    expect(renderer._widthCache.get("가", false, false)).toBe(13);
  });

  it("removes the patched spacing hook when restoring without an original hook", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        clear: () => undefined,
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "가" ? 13 : 8,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      options: { fontFamily: '"D2Coding", monospace' },
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);
    expect("_setDefaultSpacing" in renderer).toBe(true);
    expect(rowContainer.style.letterSpacing).toBe("-1.5px");
    expect(rowFactory).toMatchObject({ defaultSpacing: -1.5 });

    terminal.options.fontFamily = "JetBrains Mono, monospace";
    patchTerminalCellMeasurements(terminal);

    expect("_setDefaultSpacing" in renderer).toBe(false);
    expect(rowContainer.style.letterSpacing).toBe("");
    expect("defaultSpacing" in rowFactory).toBe(false);
  });

  it("falls back to ASCII default spacing when the CJK sample cannot be measured", () => {
    const rowContainer = document.createElement("div");
    const rowFactory = {};
    const renderer = {
      _rowContainer: rowContainer,
      _rowFactory: rowFactory,
      _widthCache: {
        get: (chars: string, _bold: boolean | number, _italic: boolean | number) =>
          chars === "W" ? 7 : 0,
      },
      dimensions: { css: { cell: { width: 8 }, canvas: { width: 48 } } },
    };
    const terminal = {
      options: { fontFamily: '"D2Coding", monospace' },
      cols: 6,
      _core: {
        _renderService: { _renderer: { value: renderer } },
        _unicodeService: { getStringCellWidth: () => 2 },
      },
    };

    patchTerminalCellMeasurements(terminal);

    expect(rowContainer.style.letterSpacing).toBe("1px");
    expect(rowFactory).toMatchObject({ defaultSpacing: 1 });
  });
});
