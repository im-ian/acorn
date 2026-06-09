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
  beginFileDrag,
  endAcornDrag,
} from "../lib/dnd";
import { makePaneNode } from "../lib/layout";
import { defaultTabByGroup } from "../lib/rightPanelGroups";
import { useAppStore } from "../store";
import {
  beginWorkspaceTabDrag,
  cancelWorkspaceTabDrag,
  finishWorkspaceTabDrag,
} from "../lib/workspaceTabDrag";
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

function seedTwoPaneWorkspace(): void {
  const panes = {
    root: {
      id: "root",
      tabIds: ["session-1", "session-2"],
      activeTabId: "session-1",
    },
    "pane-2": { id: "pane-2", tabIds: [], activeTabId: null },
  };
  const layout = {
    kind: "split" as const,
    id: "split-test",
    direction: "horizontal" as const,
    a: makePaneNode("root"),
    b: makePaneNode("pane-2"),
  };

  useAppStore.setState((s) => ({
    ...s,
    workspaces: {
      [REPO]: {
        layout,
        panes,
        focusedPaneId: "root",
      },
    },
    layout,
    panes,
    activeTabId: "session-1",
    activeSessionId: "session-1",
  }));
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
    endAcornDrag();
    cancelWorkspaceTabDrag();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    endAcornDrag();
    cancelWorkspaceTabDrag();
  });

  it("opens a code viewer tab when a file is dropped on an empty pane", () => {
    const dataTransfer = makeDataTransfer();
    beginFileDrag(
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
    beginFileDrag(
      { dataTransfer } as unknown as React.DragEvent,
      { path: FILE },
    );

    act(() => {
      root.render(<PaneDropOverlay paneId="root" acceptFileDrops={false} />);
    });

    const overlay = container.firstElementChild;
    if (!overlay) throw new Error("overlay did not render");

    act(() => {
      dispatchDrop(overlay, dataTransfer);
    });

    const state = useAppStore.getState();
    expect(state.panes.root.tabIds).toEqual([]);
    expect(state.workspaceTabs).toEqual({});
  });

  it("moves a pointer-dragged tab onto a pane body center", () => {
    seedTwoPaneWorkspace();

    act(() => {
      root.render(<PaneDropOverlay paneId="pane-2" acceptFileDrops={false} />);
    });

    const overlay = container.firstElementChild;
    if (!overlay) throw new Error("overlay did not render");
    vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => {
      beginWorkspaceTabDrag({
        payload: { tabId: "session-1", fromPaneId: "root" },
        title: "session-1",
        pointer: { x: 50, y: 50 },
        offset: { x: 8, y: 8 },
        sourceRect: { width: 100, height: 32 },
      });
      finishWorkspaceTabDrag({ x: 50, y: 50 });
    });

    const state = useAppStore.getState();
    expect(state.panes.root.tabIds).toEqual(["session-2"]);
    expect(state.panes["pane-2"].tabIds).toEqual(["session-1"]);
    expect(state.panes["pane-2"].activeTabId).toBe("session-1");
  });
});
