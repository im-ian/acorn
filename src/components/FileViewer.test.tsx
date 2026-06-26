import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FsLineDiffEntry,
  FsPrepareAssetResult,
  FsReadFileResult,
} from "../lib/api";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";

vi.mock("../lib/highlight", () => ({
  langFromPath: vi.fn(() => null),
  highlightCode: vi.fn(async (content: string) =>
    content.split("\n").map(() => null),
  ),
}));

vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "acorn:fs-changed",
  api: {
    fsPrepareAsset: vi.fn<(path: string) => Promise<FsPrepareAssetResult>>(),
    fsReadFile: vi.fn<(path: string) => Promise<FsReadFileResult>>(),
    fsGitDiffLines: vi.fn<(path: string) => Promise<FsLineDiffEntry[]>>(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { api } from "../lib/api";
import { FileViewer } from "./FileViewer";

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushScrollReport() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
  });
}

describe("FileViewer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(api.fsPrepareAsset).mockReset();
    vi.mocked(api.fsReadFile).mockReset();
    vi.mocked(api.fsGitDiffLines).mockReset();
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens image files in the media viewer without reading them as text", async () => {
    vi.mocked(api.fsPrepareAsset).mockResolvedValueOnce({ size: 1024 });

    await act(async () => {
      root.render(<FileViewer path="/repo/assets/logo.png" isActive />);
    });
    await flushPromises();

    const image = container.querySelector<HTMLImageElement>('img[alt="logo.png"]');
    expect(image).not.toBeNull();
    expect(image?.src).toContain(encodeURIComponent("/repo/assets/logo.png"));
    expect(api.fsPrepareAsset).toHaveBeenCalledWith("/repo/assets/logo.png");
    expect(api.fsReadFile).not.toHaveBeenCalled();
  });

  it("lets image media zoom in, zoom out, and reset", async () => {
    vi.mocked(api.fsPrepareAsset).mockResolvedValueOnce({ size: 1536 });

    await act(async () => {
      root.render(<FileViewer path="/repo/assets/icon.svg" isActive />);
    });
    await flushPromises();

    const image = container.querySelector<HTMLImageElement>('img[alt="icon.svg"]');
    const zoomIn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Zoom in"]',
    );
    const zoomOut = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Zoom out"]',
    );
    const reset = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset zoom"]',
    );

    expect(image).not.toBeNull();
    expect(zoomIn).not.toBeNull();
    expect(zoomOut).not.toBeNull();
    expect(reset).not.toBeNull();
    expect(image?.style.transform).toBe("scale(1)");
    expect(
      container.querySelector('[data-acorn-media-zoom="1"]'),
    ).not.toBeNull();

    await act(async () => zoomIn!.click());

    expect(image?.style.transform).toBe("scale(1.25)");
    expect(
      container.querySelector('[data-acorn-media-zoom="1.25"]'),
    ).not.toBeNull();

    await act(async () => zoomOut!.click());
    await act(async () => zoomOut!.click());

    expect(image?.style.transform).toBe("scale(0.75)");

    await act(async () => reset!.click());

    expect(image?.style.transform).toBe("scale(1)");
  });

  it("restores and reports image media zoom and scroll state", async () => {
    vi.mocked(api.fsPrepareAsset).mockResolvedValueOnce({ size: 1536 });
    const onViewStateChange = vi.fn();

    await act(async () => {
      root.render(
        <FileViewer
          path="/repo/assets/icon.svg"
          isActive
          viewState={{
            media: { imageZoom: 1.5, scrollTop: 32, scrollLeft: 8 },
          }}
          onViewStateChange={onViewStateChange}
        />,
      );
    });
    await flushPromises();

    const image = container.querySelector<HTMLImageElement>('img[alt="icon.svg"]');
    const scroller = container.querySelector<HTMLDivElement>(
      '[data-acorn-media-scroll="image"]',
    );
    const zoomIn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Zoom in"]',
    );

    expect(image?.style.transform).toBe("scale(1.5)");
    expect(scroller?.scrollTop).toBe(32);
    expect(scroller?.scrollLeft).toBe(8);

    await act(async () => zoomIn!.click());

    expect(onViewStateChange).toHaveBeenCalledWith({
      media: { imageZoom: 1.75 },
    });

    await act(async () => {
      scroller!.scrollTop = 64;
      scroller!.scrollLeft = 12;
      scroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await flushScrollReport();

    expect(onViewStateChange).toHaveBeenLastCalledWith({
      media: { scrollTop: 64, scrollLeft: 12 },
    });
  });

  it("opens pdf files in the media viewer", async () => {
    vi.mocked(api.fsPrepareAsset).mockResolvedValueOnce({ size: 2048 });

    await act(async () => {
      root.render(<FileViewer path="/repo/docs/spec.pdf" isActive />);
    });
    await flushPromises();

    const frame = container.querySelector<HTMLIFrameElement>(
      'iframe[title="spec.pdf"]',
    );
    expect(frame).not.toBeNull();
    expect(frame?.src).toContain(encodeURIComponent("/repo/docs/spec.pdf"));
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]'),
    ).toBeNull();
    expect(api.fsReadFile).not.toHaveBeenCalled();
  });

  it("keeps text files on the code viewer path", async () => {
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content: "hello from source",
      size: 17,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([]);

    await act(async () => {
      root.render(<FileViewer path="/repo/README.md" isActive />);
    });
    await flushPromises();

    expect(container.textContent).toContain("hello from source");
    expect(api.fsPrepareAsset).not.toHaveBeenCalled();
  });

  it("restores and reports code viewer scroll state", async () => {
    vi.mocked(api.fsReadFile).mockResolvedValueOnce({
      content: Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n"),
      size: 640,
      truncated: false,
      binary: false,
    });
    vi.mocked(api.fsGitDiffLines).mockResolvedValueOnce([]);
    const onViewStateChange = vi.fn();

    await act(async () => {
      root.render(
        <FileViewer
          path="/repo/src/App.tsx"
          isActive
          viewState={{ code: { scrollTop: 48, scrollLeft: 6 } }}
          onViewStateChange={onViewStateChange}
        />,
      );
    });
    await flushPromises();

    const codeScroller = container.querySelector<HTMLPreElement>("pre");
    expect(codeScroller).not.toBeNull();
    expect(codeScroller?.scrollTop).toBe(48);
    expect(codeScroller?.scrollLeft).toBe(6);

    await act(async () => {
      codeScroller!.scrollTop = 96;
      codeScroller!.scrollLeft = 14;
      codeScroller!.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await flushScrollReport();

    expect(onViewStateChange).toHaveBeenLastCalledWith({
      code: { scrollTop: 96, scrollLeft: 14 },
    });
  });
});
