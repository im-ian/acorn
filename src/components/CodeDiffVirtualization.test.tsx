import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsLineDiffEntry, FsReadFileResult } from "../lib/api";
import type { ParsedLine } from "../lib/diff";
import type { DiffPayload } from "../lib/types";

vi.mock("../lib/highlight", () => ({
  langFromPath: vi.fn(() => null),
  highlightCode: vi.fn(async (content: string) =>
    content.split("\n").map(() => null),
  ),
  highlightDiff: vi.fn(async (lines: ParsedLine[]) => lines.map(() => null)),
}));

vi.mock("../lib/api", () => ({
  api: {
    fsReadFile: vi.fn<(path: string) => Promise<FsReadFileResult>>(),
    fsGitDiffLines: vi.fn<(path: string) => Promise<FsLineDiffEntry[]>>(),
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

import { api } from "../lib/api";
import { CodeViewer } from "./CodeViewer";
import { DiffView } from "./DiffView";
import {
  lineIndexProps,
  lineTextContentProps,
  VirtualizedLineList,
  VIRTUALIZED_LINE_THRESHOLD,
} from "./VirtualizedLines";

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makePatch(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `+line-${index}`).join(
    "\n",
  );
}

function makePayload(lineCount: number): DiffPayload {
  return {
    files: [
      {
        old_path: "src/big.txt",
        new_path: "src/big.txt",
        patch: makePatch(lineCount),
        is_image: false,
      },
    ],
  };
}

describe("virtualized code and diff rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(api.fsReadFile).mockReset();
    vi.mocked(api.fsGitDiffLines).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps small diffs fully rendered", () => {
    act(() => {
      root.render(<DiffView payload={makePayload(4)} />);
    });

    expect(
      container.querySelector('[data-virtualized="false"]'),
    ).not.toBeNull();
    expect(container.querySelectorAll("[data-line-index]")).toHaveLength(4);
  });

  it("renders only a window of large diff lines", () => {
    const lineCount = VIRTUALIZED_LINE_THRESHOLD + 300;
    act(() => {
      root.render(<DiffView payload={makePayload(lineCount)} />);
    });

    const renderedLines = container.querySelectorAll("[data-line-index]");
    expect(container.querySelector('[data-virtualized="true"]')).not.toBeNull();
    expect(renderedLines.length).toBeGreaterThan(0);
    expect(renderedLines.length).toBeLessThan(lineCount);
    expect(container.textContent).toContain(`+${lineCount}`);
  });

  it("renders only a window of large code files", async () => {
    const lineCount = VIRTUALIZED_LINE_THRESHOLD + 400;
    const content = Array.from(
      { length: lineCount },
      (_, index) => `const line${index} = ${index};`,
    ).join("\n");
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content,
      size: content.length,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([
      { line: 2, kind: "modified" },
    ]);

    await act(async () => {
      root.render(<CodeViewer path="/repo/src/big.ts" isActive />);
    });
    await flushPromises();

    const renderedLines = container.querySelectorAll("[data-line-index]");
    expect(container.querySelector("pre")?.dataset.virtualized).toBe("true");
    expect(renderedLines.length).toBeGreaterThan(0);
    expect(renderedLines.length).toBeLessThan(lineCount);
    expect(container.textContent).toContain("const line0 = 0;");
    expect(container.querySelector('button[aria-pressed="false"]')).toBeNull();
  });

  it("toggles markdown files between source and preview", async () => {
    const content = "# Title\n\n- [x] shipped";
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content,
      size: content.length,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<CodeViewer path="/repo/README.md" isActive />);
    });
    await flushPromises();

    expect(container.querySelector("h1")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    expect(toggle?.textContent).toContain("Preview");

    await act(async () => {
      toggle?.click();
    });

    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("pre")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
        ?.textContent,
    ).toContain("Source");
  });

  it("copies selected text by source line in virtualized lists", () => {
    const lineCount = VIRTUALIZED_LINE_THRESHOLD + 1;
    act(() => {
      root.render(
        <VirtualizedLineList
          count={lineCount}
          className="overflow-auto"
          estimateSize={() => 20}
          getLineText={(index) => `line-${index}`}
          renderLine={(index) => (
            <div key={index} {...lineIndexProps(index)}>
              <span {...lineTextContentProps()}>{`line-${index}`}</span>
            </div>
          )}
        />,
      );
    });

    const content = container.querySelectorAll("[data-line-content]");
    const range = document.createRange();
    range.setStart(content[1]!.firstChild!, 0);
    range.setEnd(content[3]!.firstChild!, content[3]!.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const clipboard = createClipboardData();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    container.querySelector('[data-virtualized="true"]')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.getData("text/plain")).toBe("line-1\nline-2\nline-3");
  });
});

function createClipboardData() {
  const data = new Map<string, string>();
  return {
    setData(type: string, value: string) {
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? "";
    },
  };
}
