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
});
