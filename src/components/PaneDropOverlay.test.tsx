import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Project } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {},
}));

import {
  clearTabDragPayload,
  setFileDragPayload,
} from "../lib/dnd";
import { makePaneNode } from "../lib/layout";
import { defaultTabByGroup } from "../lib/rightPanelGroups";
import { useAppStore } from "../store";
import { PaneDropOverlay } from "./PaneDropOverlay";

const REPO = "/tmp/acorn-repo";
const FILE = `${REPO}/src/App.tsx`;

function project(repoPath: string): Project {
  return {
    repo_path: repoPath,
    name: "acorn-repo",
    created_at: "2026-01-01T00:00:00Z",
    position: 0,
  };
}

function resetStore(): void {
  const rootPane = { id: "root", tabIds: [], activeTabId: null };
  useAppStore.setState(
    {
      sessions: [],
      projects: [project(REPO)],
      workspaces: {
        [REPO]: {
          layout: makePaneNode("root"),
          panes: { root: rootPane },
          focusedPaneId: "root",
        },
      },
      activeProject: REPO,
      layout: makePaneNode("root"),
      panes: { root: rootPane },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
      rightTab: "commits",
      rightTabByGroup: defaultTabByGroup(),
      workspaceTabs: {},
      prAccountByRepo: {},
      pendingTerminalInput: {},
      multiInputEnabled: false,
      loading: false,
      error: null,
      pendingRemoveId: null,
      pendingRemoveProject: null,
      sessionsLoadedCleanly: true,
      liveInWorktree: {},
    },
    false,
  );
}

function makeDataTransfer(): DataTransfer {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    setData: vi.fn(),
    getData: vi.fn(() => ""),
    clearData: vi.fn(),
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    setDragImage: vi.fn(),
  };
}

function dispatchDrop(target: Element, dataTransfer: DataTransfer): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  Object.defineProperty(event, "clientX", { value: 10 });
  Object.defineProperty(event, "clientY", { value: 10 });
  target.dispatchEvent(event);
}

describe("PaneDropOverlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStore();
    clearTabDragPayload();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearTabDragPayload();
  });

  it("opens a code viewer tab when a file is dropped on an empty pane", () => {
    const dataTransfer = makeDataTransfer();
    setFileDragPayload(
      { dataTransfer } as unknown as React.DragEvent,
      { path: FILE },
    );

    act(() => {
      root.render(<PaneDropOverlay paneId="root" />);
    });

    const overlay = container.firstElementChild;
    if (!overlay) throw new Error("overlay did not render");

    act(() => {
      dispatchDrop(overlay, dataTransfer);
    });

    const state = useAppStore.getState();
    const pane = state.panes.root;
    expect(pane.tabIds).toHaveLength(1);
    expect(pane.activeTabId).toBe(pane.tabIds[0]);
    expect(state.workspaceTabs[pane.activeTabId!]).toMatchObject({
      kind: "code",
      path: FILE,
      repoPath: REPO,
    });
  });

  it("does not intercept file drops when the pane reserves them for the terminal", () => {
    const dataTransfer = makeDataTransfer();
    setFileDragPayload(
      { dataTransfer } as unknown as React.DragEvent,
      { path: FILE },
    );

    act(() => {
      root.render(<PaneDropOverlay paneId="root" acceptFileDrops={false} />);
    });

    const overlay = container.firstElementChild;
    if (!overlay) throw new Error("overlay did not render");
    expect(overlay.className).toContain("pointer-events-none");

    act(() => {
      dispatchDrop(overlay, dataTransfer);
    });

    const state = useAppStore.getState();
    expect(state.panes.root.tabIds).toEqual([]);
    expect(state.workspaceTabs).toEqual({});
  });
});
