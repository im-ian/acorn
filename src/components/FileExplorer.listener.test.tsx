import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fsGitStatus: vi.fn(),
  fsGitDiffStats: vi.fn(),
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
    fsGitDiffStats: apiMocks.fsGitDiffStats,
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
    apiMocks.fsGitDiffStats.mockResolvedValue({});
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
    vi.useRealTimers();
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

  it("queues one follow-up diff-stat refresh instead of overlapping a slow request", async () => {
    vi.useFakeTimers();
    const firstPath = "/tmp/acorn/first.ts";
    const secondPath = "/tmp/acorn/second.ts";
    let fsListener:
      | ((event: {
          payload: {
            paths: string[];
            root: string;
            cap: number;
            dotgit_changed: boolean;
          };
        }) => void)
      | null = null;
    eventMocks.listen.mockImplementation((_event, handler) => {
      fsListener = handler;
      return Promise.resolve(() => {});
    });
    apiMocks.fsListDir.mockResolvedValue({
      entries: [
        {
          name: "first.ts",
          path: firstPath,
          is_dir: false,
          is_symlink: false,
          size: 1,
          modified_ms: 1,
          gitignored: false,
        },
      ],
      repo_root: "/tmp/acorn",
    });
    apiMocks.fsGitStatus.mockResolvedValue({
      statuses: {
        [firstPath]: { kind: "modified", additions: 0, deletions: 0 },
        [secondPath]: { kind: "modified", additions: 0, deletions: 0 },
      },
      huge: false,
      limit: 5_000,
    });
    let resolveFirst!: (stats: Record<string, never>) => void;
    apiMocks.fsGitDiffStats
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({});

    await act(async () => {
      root?.render(<FileExplorer rootPath="/tmp/acorn" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });
    expect(apiMocks.fsGitDiffStats).toHaveBeenCalledTimes(1);

    act(() => {
      fsListener?.({
        payload: {
          paths: [secondPath],
          root: "/tmp/acorn",
          cap: 256,
          dotgit_changed: false,
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });

    expect(apiMocks.fsGitDiffStats).toHaveBeenCalledTimes(1);

    resolveFirst({});
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });
    expect(apiMocks.fsGitDiffStats).toHaveBeenCalledTimes(2);
  });

  it("does not schedule a queued diff-stat refresh after unmount", async () => {
    vi.useFakeTimers();
    const path = "/tmp/acorn/first.ts";
    let fsListener:
      | ((event: {
          payload: {
            paths: string[];
            root: string;
            cap: number;
            dotgit_changed: boolean;
          };
        }) => void)
      | null = null;
    eventMocks.listen.mockImplementation((_event, handler) => {
      fsListener = handler;
      return Promise.resolve(() => {});
    });
    apiMocks.fsListDir.mockResolvedValue({
      entries: [
        {
          name: "first.ts",
          path,
          is_dir: false,
          is_symlink: false,
          size: 1,
          modified_ms: 1,
          gitignored: false,
        },
      ],
      repo_root: "/tmp/acorn",
    });
    apiMocks.fsGitStatus.mockResolvedValue({
      statuses: {
        [path]: { kind: "modified", additions: 0, deletions: 0 },
      },
      huge: false,
      limit: 5_000,
    });
    let resolveFirst!: (stats: Record<string, never>) => void;
    apiMocks.fsGitDiffStats.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    await act(async () => {
      root?.render(<FileExplorer rootPath="/tmp/acorn" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });
    act(() => {
      fsListener?.({
        payload: {
          paths: [path],
          root: "/tmp/acorn",
          cap: 256,
          dotgit_changed: false,
        },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });
    expect(apiMocks.fsGitDiffStats).toHaveBeenCalledTimes(1);

    act(() => root?.unmount());
    root = null;
    resolveFirst({});
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("refetches every loaded directory when gitignore rules change", async () => {
    const rootPath = "/tmp/acorn-gitignore";
    const generatedPath = `${rootPath}/generated`;
    let fsListener:
      | ((event: {
          payload: {
            paths: string[];
            root: string;
            cap: number;
            dotgit_changed: boolean;
          };
        }) => void)
      | null = null;
    eventMocks.listen.mockImplementation((_event, handler) => {
      fsListener = handler;
      return Promise.resolve(() => {});
    });
    apiMocks.fsListDir.mockImplementation(async (path: string) => ({
      entries:
        path === rootPath
          ? [
              {
                name: "generated",
                path: generatedPath,
                is_dir: true,
                is_symlink: false,
                size: 0,
                modified_ms: 1,
                gitignored: false,
              },
            ]
          : [],
      repo_root: rootPath,
    }));

    await act(async () => {
      root?.render(<FileExplorer rootPath={rootPath} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const generatedButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("generated"),
    );
    expect(generatedButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      generatedButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.fsListDir).toHaveBeenCalledWith(generatedPath, false, true);
    apiMocks.fsListDir.mockClear();

    await act(async () => {
      fsListener?.({
        payload: {
          paths: [`${rootPath}/.gitignore`],
          root: rootPath,
          cap: 256,
          dotgit_changed: false,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fsListDir).toHaveBeenCalledWith(rootPath, false, true);
    expect(apiMocks.fsListDir).toHaveBeenCalledWith(generatedPath, false, true);
  });

  it("refreshes loaded directories and git status when the branch revision changes", async () => {
    const rootPath = "/tmp/acorn-branch";
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);

    await act(async () => {
      root?.render(
        <FileExplorer rootPath={rootPath} gitRevision="feature/one" />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    apiMocks.fsListDir.mockClear();
    apiMocks.fsGitStatus.mockClear();

    await act(async () => {
      root?.render(
        <FileExplorer rootPath={rootPath} gitRevision="feature/two" />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fsListDir).toHaveBeenCalledWith(rootPath, false, true);
    expect(apiMocks.fsGitStatus).toHaveBeenCalledWith(rootPath);
    hasFocus.mockRestore();
  });
});
