import { describe, expect, it } from "vitest";
import {
  createTerminalFileLinkProvider,
  findTerminalFileReferences,
  resolveTerminalFilePath,
} from "./terminalFileLinks";
import type {
  IBufferCell,
  IBufferLine,
  ILink,
  Terminal as XTerm,
} from "@xterm/xterm";

function makeBufferCell(chars: string, width = 1): IBufferCell {
  return {
    getChars: () => chars,
    getWidth: () => width,
  } as unknown as IBufferCell;
}

function makeBufferLine(
  text: string,
  cells = Array.from(text, (char) => makeBufferCell(char)),
): IBufferLine {
  return {
    length: cells.length,
    getCell: (index: number) => cells[index],
    translateToString: () => text,
  } as unknown as IBufferLine;
}

function makeTerminalWithLine(line: IBufferLine): XTerm {
  return {
    buffer: {
      active: {
        getLine: () => line,
      },
    },
  } as unknown as XTerm;
}

describe("terminal file links", () => {
  it("finds repo-relative file references with line numbers", () => {
    expect(
      findTerminalFileReferences(
        "open src/components/FolderPermissionWarmupModal.tsx:78",
      ),
    ).toEqual([
      {
        path: "src/components/FolderPermissionWarmupModal.tsx",
        line: 78,
        text: "src/components/FolderPermissionWarmupModal.tsx:78",
        startIndex: 5,
      },
    ]);
  });

  it("keeps optional column numbers and skips url-looking text", () => {
    expect(
      findTerminalFileReferences(
        "at ./src/App.tsx:12:5 and https://example.test/src/App.tsx:99",
      ),
    ).toEqual([
      {
        path: "./src/App.tsx",
        line: 12,
        column: 5,
        text: "./src/App.tsx:12:5",
        startIndex: 3,
      },
    ]);
  });

  it("finds absolute file references", () => {
    expect(findTerminalFileReferences("see /tmp/demo/src/App.tsx:4")).toEqual([
      {
        path: "/tmp/demo/src/App.tsx",
        line: 4,
        text: "/tmp/demo/src/App.tsx:4",
        startIndex: 4,
      },
    ]);
  });

  it("finds file references with a trailing colon and no line number", () => {
    expect(
      findTerminalFileReferences(
        "Path /Users/jthefloor/Desktop/helloworld/a.tsx:",
      ),
    ).toEqual([
      {
        path: "/Users/jthefloor/Desktop/helloworld/a.tsx",
        text: "/Users/jthefloor/Desktop/helloworld/a.tsx:",
        startIndex: 5,
      },
    ]);
  });

  it("finds root file references", () => {
    expect(findTerminalFileReferences("Loaded b.tsx and README.md:12")).toEqual(
      [
        {
          path: "b.tsx",
          text: "b.tsx",
          startIndex: 7,
        },
        {
          path: "README.md",
          line: 12,
          text: "README.md:12",
          startIndex: 17,
        },
      ],
    );
  });

  it("finds explicit relative file references without a trailing colon", () => {
    expect(
      findTerminalFileReferences(
        "Loaded ../../.claude/rules/typescript/coding-style.md",
      ),
    ).toEqual([
      {
        path: "../../.claude/rules/typescript/coding-style.md",
        text: "../../.claude/rules/typescript/coding-style.md",
        startIndex: 7,
      },
    ]);
  });

  it("does not treat path-colon-word text as a file reference", () => {
    expect(findTerminalFileReferences("skip src/App.tsx:error")).toEqual([]);
  });

  it("does not treat version-looking text as a file reference", () => {
    expect(findTerminalFileReferences("using package 1.2.3")).toEqual([]);
  });

  it("does not treat common abbreviation-looking text as a file reference", () => {
    expect(findTerminalFileReferences("for example, e.g. this")).toEqual([]);
  });

  it("does not treat property chains as file references", () => {
    expect(
      findTerminalFileReferences(
        "assert_eq!(limits.requests.unwrap().reset_at, Some(1779930000.0));",
      ),
    ).toEqual([]);
  });

  it("accepts sentence-ending periods after file paths", () => {
    expect(findTerminalFileReferences("Loaded README.md.")).toEqual([
      {
        path: "README.md",
        text: "README.md",
        startIndex: 7,
      },
    ]);
  });

  it("resolves relative paths from the terminal cwd", () => {
    expect(resolveTerminalFilePath("/repo/app", "src/App.tsx")).toBe(
      "/repo/app/src/App.tsx",
    );
    expect(resolveTerminalFilePath("/repo/app/src", "../README.md")).toBe(
      "/repo/app/README.md",
    );
    expect(resolveTerminalFilePath("/repo/app", "/tmp/file.ts")).toBe(
      "/tmp/file.ts",
    );
  });

  it("keeps file link hover decorations from drawing xterm underlines", () => {
    const provider = createTerminalFileLinkProvider(
      makeTerminalWithLine(makeBufferLine("src/App.tsx:12")),
      { activate: () => undefined },
    );

    provider.provideLinks(1, (links) => {
      expect(links?.[0]?.decorations).toEqual({
        pointerCursor: true,
        underline: false,
      });
    });
  });

  it("filters links through the reference resolver", async () => {
    const provider = createTerminalFileLinkProvider(
      makeTerminalWithLine(makeBufferLine("src/App.tsx missing.tsx")),
      {
        activate: () => undefined,
        resolveReferences: async (references) =>
          references
            .filter((reference) => reference.path === "src/App.tsx")
            .map((reference) => ({
              ...reference,
              absolutePath: `/repo/${reference.path}`,
            })),
      },
    );

    const links = await new Promise<ILink[] | undefined>((resolve) => {
      provider.provideLinks(1, resolve);
    });

    expect(links?.map((link) => link.text)).toEqual(["src/App.tsx"]);
  });

  it("maps file link ranges using terminal cell columns", () => {
    const provider = createTerminalFileLinkProvider(
      makeTerminalWithLine(
        makeBufferLine("경로 /tmp/a.tsx:2", [
          makeBufferCell("경", 2),
          makeBufferCell("", 0),
          makeBufferCell("로", 2),
          makeBufferCell("", 0),
          makeBufferCell(" "),
          ...Array.from("/tmp/a.tsx:2", (char) => makeBufferCell(char)),
        ]),
      ),
      { activate: () => undefined },
    );

    provider.provideLinks(1, (links) => {
      expect(links?.[0]?.range).toEqual({
        start: { x: 6, y: 1 },
        end: { x: 17, y: 1 },
      });
    });
  });
});
