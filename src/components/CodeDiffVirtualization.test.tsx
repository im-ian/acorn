import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsLineDiffEntry, FsReadFileResult } from "../lib/api";
import type { ParsedLine } from "../lib/diff";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import type { DiffPayload } from "../lib/types";

vi.mock("../lib/highlight", () => ({
  langFromPath: vi.fn(() => null),
  highlightCode: vi.fn(async (content: string) =>
    content.split("\n").map(() => null),
  ),
  highlightDiff: vi.fn(async (lines: ParsedLine[]) => lines.map(() => null)),
}));

vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "acorn:fs-changed",
  api: {
    fsReadFile: vi.fn<(path: string) => Promise<FsReadFileResult>>(),
    fsGitDiffLines: vi.fn<(path: string) => Promise<FsLineDiffEntry[]>>(),
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { highlightCode, langFromPath } from "../lib/highlight";
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

function emitFsChanged(payload: {
  paths: string[];
  root?: string;
  overflow?: boolean;
  refresh?: { kind: "root" | "subtree"; path: string } | null;
  dotgit_changed: boolean;
}) {
  const calls = vi.mocked(listen).mock.calls;
  const listener = calls[calls.length - 1]?.[1];
  if (!listener) throw new Error("fs listener not registered");
  listener({
    event: "acorn:fs-changed",
    id: 1,
    payload,
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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
    vi.mocked(listen).mockClear();
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(highlightCode).mockClear();
    vi.mocked(langFromPath).mockReturnValue(null);
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
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

  it("passes the current light theme mode to the code highlighter", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.appearance.themeId = "acorn-light";
    useSettings.setState({ settings });
    vi.mocked(langFromPath).mockReturnValue("rust");
    const content = "let limits = parse_limits(&h);";
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content,
      size: content.length,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<CodeViewer path="/repo/src/rate_limits_test.rs" isActive />);
    });
    await flushPromises();

    expect(highlightCode).toHaveBeenCalledWith(content, "rust", "light");
  });

  it("marks a requested code viewer target line", async () => {
    const content = "one\ntwo\nthree";
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content,
      size: content.length,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([]);

    await act(async () => {
      root.render(
        <CodeViewer
          path="/repo/src/App.tsx"
          isActive
          target={{ line: 2, token: "target-1" }}
        />,
      );
    });
    await flushPromises();

    const target = container.querySelector('[data-acorn-target-line="true"]');
    expect(target?.textContent).toContain("2");
    expect(target?.textContent).toContain("two");
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

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Find in file"]',
    );
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, "shipped");
    });

    expect(container.querySelectorAll("[data-acorn-preview-search]")).toHaveLength(
      1,
    );
    expect(container.textContent).toContain("1/1");
  });

  it("refreshes an open code viewer when its file changes", async () => {
    vi.mocked(api.fsReadFile)
      .mockResolvedValueOnce({
        content: "old content",
        size: "old content".length,
        truncated: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        content: "new content",
        size: "new content".length,
        truncated: false,
        binary: false,
      });
    vi.mocked(api.fsGitDiffLines)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ line: 1, kind: "modified" }]);

    await act(async () => {
      root.render(<CodeViewer path="/repo/src/live.ts" isActive />);
    });
    await flushPromises();

    expect(container.textContent).toContain("old content");

    await act(async () => {
      emitFsChanged({
        root: "/repo",
        paths: ["/repo/src/live.ts"],
        dotgit_changed: false,
      });
    });
    await flushPromises();

    expect(api.fsReadFile).toHaveBeenCalledTimes(2);
    expect(api.fsGitDiffLines).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("new content");
  });

  it("keeps markdown preview mode live across file changes", async () => {
    vi.mocked(api.fsReadFile)
      .mockResolvedValueOnce({
        content: "# Old title",
        size: "# Old title".length,
        truncated: false,
        binary: false,
      })
      .mockResolvedValueOnce({
        content: "# New title",
        size: "# New title".length,
        truncated: false,
        binary: false,
      });
    vi.mocked(api.fsGitDiffLines).mockResolvedValue([]);

    await act(async () => {
      root.render(<CodeViewer path="/repo/README.md" isActive />);
    });
    await flushPromises();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-pressed="false"]',
    );
    await act(async () => {
      toggle?.click();
    });

    expect(container.querySelector("h1")?.textContent).toBe("Old title");

    await act(async () => {
      emitFsChanged({
        root: "/repo",
        paths: ["/repo/README.md"],
        dotgit_changed: false,
      });
    });
    await flushPromises();

    expect(container.querySelector("h1")?.textContent).toBe("New title");
    expect(container.querySelector("pre")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]'),
    ).not.toBeNull();
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

  it("finds and highlights matches inside a code viewer", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.shortcuts.findInView = "F4";
    useSettings.setState({ settings });
    const content = "alpha\nbeta alpha\nALPHA";
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content,
      size: content.length,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<CodeViewer path="/repo/src/search.txt" isActive />);
    });
    await flushPromises();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Find in file"]'),
    ).toBeNull();

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F4",
          code: "F4",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Find in file"]',
    );
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, "alpha");
    });

    expect(container.querySelectorAll("mark")).toHaveLength(3);
    expect(container.textContent).toContain("1/3");

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(container.textContent).toContain("2/3");
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
