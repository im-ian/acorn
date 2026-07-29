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

  it.each([
    [
      "POSIX paths",
      "file:///Users/jthefloor/.codex/generated_images/019fac49-00b2-75e0-864d-5c2d6951e441/exec-59ed6210-8c1d-440b-916d-26f791750b80.png",
    ],
    ["localhost paths", "file://localhost/Users/me/report.txt"],
    ["Windows drive paths", "file:///C:/Users/me/report.txt"],
    ["UNC paths", "file://server/share/report.txt"],
    ["case-insensitive schemes", "FILE:///Users/me/report.txt"],
    [
      "parenthesized file names",
      "file:///Users/me/Desktop/Screenshot%20(1).png",
    ],
  ])("provides local file URL links for %s", (_label, uri) => {
    const provider = createTerminalWebLinkProvider(
      makeTerminalWithLines([makeBufferLine(`Saved to: (${uri}).`)]),
      { activate: () => undefined },
    );

    provider.provideLinks(1, (links) => {
      expect(links?.[0]?.text).toBe(uri);
      expect(links?.[0]?.range).toEqual({
        start: { x: 12, y: 1 },
        end: { x: 11 + uri.length, y: 1 },
      });
    });
  });

  it("provides file URL links across wrapped terminal lines", () => {
    const firstLine =
      "Saved to: file:///Users/me/.codex/generated_images/";
    const secondLine = "run/preview.png";
    const provider = createTerminalWebLinkProvider(
      makeTerminalWithLines([
        makeBufferLine(firstLine),
        makeBufferLine(secondLine, undefined, true),
      ]),
      { activate: () => undefined },
    );

    provider.provideLinks(2, (links) => {
      expect(links?.[0]?.text).toBe(
        "file:///Users/me/.codex/generated_images/run/preview.png",
      );
      expect(links?.[0]?.range).toEqual({
        start: { x: 11, y: 1 },
        end: { x: secondLine.length, y: 2 },
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

  it("skips file URLs that cannot convert to paths", () => {
    const provider = createTerminalWebLinkProvider(
      makeTerminalWithLines([makeBufferLine("open file:///tmp/bad%escape.png")]),
      { activate: () => undefined },
    );

    provider.provideLinks(1, (links) => {
      expect(links).toBeUndefined();
    });
  });
});
