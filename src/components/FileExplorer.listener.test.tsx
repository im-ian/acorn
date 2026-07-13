import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fsGitStatus: vi.fn(),
  fsListDir: vi.fn(),
  fsShellEditor: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "acorn:fs-changed",
  api: {
    fsGitStatus: apiMocks.fsGitStatus,
    fsListDir: apiMocks.fsListDir,
    fsShellEditor: apiMocks.fsShellEditor,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("../store", () => ({
  useAppStore: {
    getState: () => ({ activeSessionId: null }),
    subscribe: () => () => {},
  },
}));

vi.mock("../lib/toasts", () => ({
  useToasts: (selector: (state: { show: () => void }) => unknown) =>
    selector({ show: vi.fn() }),
}));

vi.mock("../lib/useTranslation", () => ({
  useTranslation: () => (key: string) => key,
}));

import { FileExplorer } from "./FileExplorer";

describe("FileExplorer filesystem listener", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let resolveListen: ((unlisten: () => void) => void) | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resolveListen = null;

    apiMocks.fsShellEditor.mockResolvedValue("");
    apiMocks.fsListDir.mockResolvedValue({ entries: [], repo_root: null });
    apiMocks.fsGitStatus.mockResolvedValue({
      statuses: {},
      huge: false,
      limit: 5_000,
    });
    eventMocks.listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container.remove();
    vi.clearAllMocks();
  });

  it("disposes a listener that finishes registering after unmount", async () => {
    await act(async () => {
      root?.render(<FileExplorer rootPath="/tmp/acorn" />);
    });
    expect(eventMocks.listen).toHaveBeenCalledOnce();

    act(() => root?.unmount());
    root = null;

    const unlisten = vi.fn();
    await act(async () => {
      resolveListen?.(unlisten);
      await Promise.resolve();
    });

    expect(unlisten).toHaveBeenCalledOnce();
  });
});
