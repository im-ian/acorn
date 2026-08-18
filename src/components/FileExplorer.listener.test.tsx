import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fsGitStatus: vi.fn(),
  fsGitDiffStats: vi.fn(),
  fsListDir: vi.fn(),
  fsRename: vi.fn(),
  fsShellEditor: vi.fn(),
  fsOpenDefault: vi.fn(),
  ptyWrite: vi.fn(),
  detectSessionAgent: vi.fn(),
}));

const editorMocks = vi.hoisted(() => ({
  openFileInEditor: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  activeSessionId: null as string | null,
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  show: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  FS_CHANGED_EVENT: "acorn:fs-changed",
  api: {
    fsGitStatus: apiMocks.fsGitStatus,
    fsGitDiffStats: apiMocks.fsGitDiffStats,
    fsListDir: apiMocks.fsListDir,
    fsRename: apiMocks.fsRename,
    fsShellEditor: apiMocks.fsShellEditor,
    fsOpenDefault: apiMocks.fsOpenDefault,
    ptyWrite: apiMocks.ptyWrite,
    detectSessionAgent: apiMocks.detectSessionAgent,
  },
}));

vi.mock("../lib/editor", () => ({
  openFileInEditor: editorMocks.openFileInEditor,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));

vi.mock("../store", () => ({
  useAppStore: {
    getState: () => ({ activeSessionId: storeMocks.activeSessionId }),
    subscribe: () => () => {},
  },
}));

vi.mock("../lib/toasts", () => ({
  useToasts: (selector: (state: { show: () => void }) => unknown) =>
    selector({ show: toastMocks.show }),
}));

vi.mock("../lib/useTranslation", () => ({
  useTranslation: () => (key: string) => key,
}));

import { FileExplorer } from "./FileExplorer";

const originalNavigatorPlatform = navigator.platform;

function setNavigatorPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", {
    value: platform,
    configurable: true,
  });
}

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
    storeMocks.activeSessionId = null;

    apiMocks.fsShellEditor.mockResolvedValue("");
    apiMocks.fsRename.mockResolvedValue(undefined);
    apiMocks.fsOpenDefault.mockResolvedValue(undefined);
    apiMocks.ptyWrite.mockResolvedValue(undefined);
    apiMocks.detectSessionAgent.mockResolvedValue({
      claude: null,
      antigravity: null,
      codex: null,
      grok: null,
      ollama: null,
      llm: null,
      custom: null,
    });
    editorMocks.openFileInEditor.mockResolvedValue(undefined);
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
    setNavigatorPlatform(originalNavigatorPlatform);
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

  it("preserves the active-PTY $EDITOR flow on Unix", async () => {
    setNavigatorPlatform("Linux x86_64");
    storeMocks.activeSessionId = "session-1";
    const filePath = "/tmp/acorn/O'Brien file.ts";
    apiMocks.fsShellEditor.mockResolvedValue("vim");
    apiMocks.fsListDir.mockResolvedValue({
      entries: [
        {
          name: "O'Brien file.ts",
          path: filePath,
          is_dir: false,
          is_symlink: false,
          size: 1,
          modified_ms: 1,
          gitignored: false,
        },
      ],
      repo_root: "/tmp/acorn",
    });

    await act(async () => {
      root?.render(<FileExplorer rootPath="/tmp/acorn" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const fileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("O'Brien file.ts"),
    );
    expect(fileButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      fileButton?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const openButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) =>
      button.textContent?.includes("fileExplorer.menu.openIn vim"),
    );
    expect(openButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      openButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editorMocks.openFileInEditor).not.toHaveBeenCalled();
    expect(apiMocks.ptyWrite).toHaveBeenCalledWith(
      "session-1",
      "$EDITOR '/tmp/acorn/O'\\''Brien file.ts'\n",
    );
  });

  it("uses the native editor adapter without probing $EDITOR on Windows", async () => {
    setNavigatorPlatform("Win32");
    const filePath = "C:\\repo\\src\\App.tsx";
    apiMocks.fsListDir.mockResolvedValue({
      entries: [
        {
          name: "App.tsx",
          path: filePath,
          is_dir: false,
          is_symlink: false,
          size: 1,
          modified_ms: 1,
          gitignored: false,
        },
      ],
      repo_root: "C:\\repo",
    });

    await act(async () => {
      root?.render(<FileExplorer rootPath="C:\\repo" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const fileButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("App.tsx"),
    );
    expect(fileButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      fileButton?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const openButton = document.querySelector<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    expect(openButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      openButton?.click();
      await Promise.resolve();
    });

    expect(editorMocks.openFileInEditor).toHaveBeenCalledWith(filePath);
    expect(apiMocks.fsShellEditor).not.toHaveBeenCalled();
    expect(apiMocks.ptyWrite).not.toHaveBeenCalled();
  });

  it("preserves literal backslashes when renaming a POSIX file", async () => {
    const filePath = "/tmp/acorn/old\\name.md";
    apiMocks.fsListDir.mockResolvedValue({
      entries: [
        {
          name: "old\\name.md",
          path: filePath,
          is_dir: false,
          is_symlink: false,
          size: 1,
          modified_ms: 1,
          gitignored: false,
        },
      ],
      repo_root: "/tmp/acorn",
    });

    await act(async () => {
      root?.render(<FileExplorer rootPath="/tmp/acorn" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const fileButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("old\\name.md"),
    );
    expect(fileButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      fileButton?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 20,
        }),
      );
    });
    const renameButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.includes("fileExplorer.menu.rename"));
    expect(renameButton).toBeInstanceOf(HTMLButtonElement);

    act(() => renameButton?.click());
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="fileExplorer.tree.renameInput"]',
    );
    expect(input).toBeInstanceOf(HTMLInputElement);
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    expect(valueSetter).toBeTypeOf("function");
    act(() => {
      valueSetter?.call(input, "new\\name.md");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fsRename).toHaveBeenCalledWith(
      filePath,
      "/tmp/acorn/new\\name.md",
    );
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

  it("refreshes a loaded Windows directory for mixed-separator watcher paths", async () => {
    const rootPath = "C:\\Repo";
    const sourcePath = "C:\\Repo\\src";
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
                name: "src",
                path: sourcePath,
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
    const sourceButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("src"),
    );
    expect(sourceButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      sourceButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    apiMocks.fsListDir.mockClear();

    await act(async () => {
      fsListener?.({
        payload: {
          paths: ["c:/repo/src/App.tsx"],
          root: "c:/repo",
          cap: 256,
          dotgit_changed: false,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.fsListDir).toHaveBeenCalledWith(sourcePath, false, true);
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
