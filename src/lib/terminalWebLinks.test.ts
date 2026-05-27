import { describe, expect, it } from "vitest";
import type { IBufferCell, IBufferLine, Terminal as XTerm } from "@xterm/xterm";
import { createTerminalWebLinkProvider } from "./terminalWebLinks";

interface MutableBufferCell extends IBufferCell {
  chars: string;
  width: number;
}

function makeBufferCell(chars: string, width = 1): IBufferCell {
  return {
    getChars: () => chars,
    getWidth: () => width,
  } as unknown as IBufferCell;
}

function makeMutableCell(): MutableBufferCell {
  return {
    chars: "",
    width: 1,
    getChars() {
      return this.chars;
    },
    getWidth() {
      return this.width;
    },
  } as MutableBufferCell;
}

function makeBufferLine(
  text: string,
  cells = Array.from(text, (char) => makeBufferCell(char)),
  isWrapped = false,
): IBufferLine {
  return {
    isWrapped,
    length: cells.length,
    getCell: (index: number, reusable?: IBufferCell) => {
      const source = cells[index];
      if (!source) return undefined;
      if (reusable) {
        const mutable = reusable as MutableBufferCell;
        mutable.chars = source.getChars();
        mutable.width = source.getWidth();
        return reusable;
      }
      return source;
    },
    translateToString: () => text,
  } as unknown as IBufferLine;
}

function makeTerminalWithLines(lines: IBufferLine[]): XTerm {
  return {
    buffer: {
      active: {
        getLine: (index: number) => lines[index],
        getNullCell: () => makeMutableCell(),
      },
    },
  } as unknown as XTerm;
}

describe("terminal web links", () => {
  it("provides URL links without xterm hover underlines", () => {
    const provider = createTerminalWebLinkProvider(
      makeTerminalWithLines([makeBufferLine("open https://example.test/docs")]),
      { activate: () => undefined },
    );

    provider.provideLinks(1, (links) => {
      expect(links?.[0]?.text).toBe("https://example.test/docs");
      expect(links?.[0]?.range).toEqual({
        start: { x: 6, y: 1 },
        end: { x: 30, y: 1 },
      });
      expect(links?.[0]?.decorations).toEqual({
        pointerCursor: true,
        underline: false,
      });
    });
  });

  it("skips URL-shaped text that cannot parse as a URL", () => {
    const provider = createTerminalWebLinkProvider(
      makeTerminalWithLines([makeBufferLine("open https://")]),
      { activate: () => undefined },
    );

    provider.provideLinks(1, (links) => {
      expect(links).toBeUndefined();
    });
  });
});
