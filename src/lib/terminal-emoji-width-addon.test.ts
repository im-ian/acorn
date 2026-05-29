import { describe, expect, it } from "vitest";
import {
  patchTerminalEmojiWidthMeasurements,
  unpatchTerminalEmojiWidthMeasurements,
} from "./terminal-emoji-width-addon";

describe("terminal emoji width patch", () => {
  function makeTerminal(measure: (chars: string) => number) {
    const renderer = {
      _widthCache: {
        clear: () => undefined,
        get: (
          chars: string,
          _bold: boolean | number,
          _italic: boolean | number,
        ) => measure(chars),
      },
      dimensions: { css: { cell: { width: 7.25 } } },
    };
    const terminal = {
      _core: {
        _renderService: { _renderer: { value: renderer } },
        unicodeService: {
          getStringCellWidth: (text: string) =>
            text === "W" || text === "가" ? 1 : 2,
        },
      },
    };
    return { renderer, terminal };
  }

  it("clamps emoji measurements to their terminal grid width", () => {
    const { renderer, terminal } = makeTerminal((chars) =>
      chars === "🦊" ? 18 : 7.25,
    );

    patchTerminalEmojiWidthMeasurements(terminal);

    expect(renderer._widthCache.get("🦊", false, false)).toBe(14.5);
  });

  it("leaves emoji measurements below the terminal grid width unchanged", () => {
    const { renderer, terminal } = makeTerminal((chars) =>
      chars === "🦊" ? 12 : 7.25,
    );

    patchTerminalEmojiWidthMeasurements(terminal);

    expect(renderer._widthCache.get("🦊", false, false)).toBe(12);
  });

  it("does not clamp non-emoji wide glyph measurements", () => {
    const { renderer, terminal } = makeTerminal((chars) =>
      chars === "가" ? 18 : 7.25,
    );

    patchTerminalEmojiWidthMeasurements(terminal);

    expect(renderer._widthCache.get("가", false, false)).toBe(18);
  });

  it("restores the original width cache getter", () => {
    const { renderer, terminal } = makeTerminal((chars) =>
      chars === "🚀" ? 20 : 7.25,
    );
    const originalGet = renderer._widthCache.get;

    patchTerminalEmojiWidthMeasurements(terminal);
    expect(renderer._widthCache.get("🚀", false, false)).toBe(14.5);

    unpatchTerminalEmojiWidthMeasurements(terminal);

    expect(renderer._widthCache.get).toBe(originalGet);
    expect(renderer._widthCache.get("🚀", false, false)).toBe(20);
  });
});
