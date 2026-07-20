import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNode } from "../lib/layout";
import type { Session } from "../lib/types";

vi.mock("./LayoutRenderer", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    LayoutRenderer: () =>
      React.createElement("div", { "data-testid": "layout-renderer" }),
  };
});

vi.mock("./ChatPane", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ChatPane: ({
      sessionId,
      isActive,
    }: {
      sessionId: string;
      isActive?: boolean;
    }) =>
      React.createElement("textarea", {
        "aria-label": "Chat message",
        "data-active": String(Boolean(isActive)),
        "data-chat-session-id": sessionId,
        "data-testid": "mock-chat-pane",
      }),
  };
});

import { WorkspaceMain } from "./WorkspaceMain";
import { useAppStore, type WorkspaceViewMode } from "../store";
import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import { useToasts } from "../lib/toasts";

const REPO = "/Users/me/repo";
const LAYOUT: LayoutNode = { kind: "pane", id: "root" };

function resetStore(): void {
  const pane = { id: "root", tabIds: [], activeTabId: null };
  useAppStore.setState(
    {
      sessions: [],
      workspaces: {
        [REPO]: {
          layout: LAYOUT,
          panes: { root: pane },
          focusedPaneId: "root",
        },
      },
      activeProject: REPO,
      activeProjectFolderId: REPO,
      layout: LAYOUT,
      panes: { root: pane },
      focusedPaneId: "root",
      activeTabId: null,
      activeSessionId: null,
      workspaceViewMode: "panes",
      terminalPopupSessionId: null,
    },
    false,
  );
}

function queryLayout(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='layout-renderer']");
}

function queryKanban(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-testid='workspace-kanban']");
}

function queryCanvas(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-testid='workspace-canvas']",
  );
}

function queryCanvasMinimap(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-testid='workspace-canvas-minimap']",
  );
}

function installCanvasSessions(
  ids: string[],
  modes: Partial<Record<string, Session["mode"]>> = {},
): void {
  const sessions: Session[] = ids.map((id) => ({
    id,
    name: id,
    repo_path: REPO,
    worktree_path: `${REPO}/.worktrees/${id}`,
    branch: `feat/${id}`,
    isolated: false,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message: null,
    title_source: "default",
    kind: "regular",
    mode: modes[id] ?? "terminal",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
  }));
  const pane = {
    id: "root",
    tabIds: ids,
    activeTabId: ids[0] ?? null,
  };
  useAppStore.setState((state) => ({
    sessions,
    panes: { root: pane },
    activeTabId: pane.activeTabId,
    activeSessionId: pane.activeTabId,
    workspaces: {
      ...state.workspaces,
      [REPO]: {
        ...state.workspaces[REPO],
        panes: { root: pane },
      },
    },
  }));
}

function queryColumnResizeHandle(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    "[data-testid='workspace-kanban-column-resize-handle']",
  );
}

function readColumnWidths(): number[] {
  const board = document.querySelector<HTMLElement>(
    "[data-kanban-column-widths]",
  );
  return (board?.dataset.kanbanColumnWidths ?? "").split(",").map(Number);
}

// jsdom has no PointerEvent constructor; React's pointer handlers and the
// component's raw listeners only read MouseEvent fields plus `pointerId`,
// which stays undefined on both sides and passes the same-pointer check.
function firePointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit = {},
): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("WorkspaceMain", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useToasts.getState().hide(undefined, { skipDismiss: true });
    resetStore();
    useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    useToasts.getState().hide(undefined, { skipDismiss: true });
    container.remove();
    vi.clearAllMocks();
  });

  function render(viewMode: WorkspaceViewMode): void {
    act(() => {
      root.render(<WorkspaceMain layout={LAYOUT} viewMode={viewMode} />);
    });
  }

  it("keeps the pane layout mounted with a stable DOM node across a kanban toggle", () => {
    render("panes");
    const initial = queryLayout();
    expect(initial).not.toBeNull();
    expect(queryKanban()).toBeNull();

    render("kanban");
    const duringKanban = queryLayout();
    // The layout must stay mounted (same DOM node) so the terminal target divs
    // appendChild'd into pane bodies keep their identity and are not orphaned.
    expect(duringKanban).toBe(initial);
    expect(queryKanban()).not.toBeNull();

    render("panes");
    expect(queryLayout()).toBe(initial);
    expect(queryKanban()).toBeNull();
  });

  it("hides the pane layout while the kanban board is shown", () => {
    render("panes");
    expect(queryLayout()?.parentElement?.className).not.toContain("hidden");

    render("kanban");
    expect(queryLayout()?.parentElement?.className).toContain("hidden");
  });

  it("keeps the pane layout mounted while the canvas is shown", () => {
    render("panes");
    const initial = queryLayout();

    render("canvas");
    expect(queryCanvas()).not.toBeNull();
    expect(queryLayout()).toBe(initial);
    expect(queryLayout()?.parentElement?.className).toContain("hidden");

    render("panes");
    expect(queryCanvas()).toBeNull();
    expect(queryLayout()).toBe(initial);
  });

  it("moves and resizes canvas terminals and persists their geometry", () => {
    installCanvasSessions(["alpha", "beta"]);
    render("canvas");

    const nodes = document.querySelectorAll<HTMLElement>(
      "[data-testid='workspace-canvas-node']",
    );
    expect(nodes).toHaveLength(2);
    const alpha = document.querySelector<HTMLElement>(
      '[data-canvas-session-id="alpha"]',
    );
    expect(alpha).not.toBeNull();

    const dragHandle = alpha!.querySelector<HTMLElement>(
      "[data-testid='workspace-canvas-node-drag-handle']",
    );
    firePointer(dragHandle!, "pointerdown", { clientX: 100, clientY: 100 });
    firePointer(window, "pointerup", { clientX: 100, clientY: 100 });
    expect(alpha!.dataset.canvasNodeX).toBe("40");
    expect(alpha!.dataset.canvasNodeY).toBe("40");

    firePointer(dragHandle!, "pointerdown", { clientX: 100, clientY: 100 });
    firePointer(window, "pointermove", { clientX: 152, clientY: 132 });
    firePointer(window, "pointerup", { clientX: 152, clientY: 132 });

    expect(alpha!.dataset.canvasNodeX).toBe("100");
    expect(alpha!.dataset.canvasNodeY).toBe("80");
    expect(
      useAppStore.getState().workspaces[REPO].canvas?.nodes.alpha,
    ).toMatchObject({ x: 100, y: 80 });

    const resizeHandle = alpha!.querySelector<HTMLElement>(
      "[data-testid='workspace-canvas-node-resize-handle']",
    );
    firePointer(resizeHandle!, "pointerdown", {
      clientX: 100,
      clientY: 100,
    });
    firePointer(window, "pointermove", { clientX: 180, clientY: 160 });
    firePointer(window, "pointerup", { clientX: 180, clientY: 160 });

    expect(alpha!.dataset.canvasNodeWidth).toBe("700");
    expect(alpha!.dataset.canvasNodeHeight).toBe("460");
    expect(alpha!.dataset.canvasNodeX).toBe("100");
    expect(alpha!.dataset.canvasNodeY).toBe("80");
    expect(
      useAppStore.getState().workspaces[REPO].canvas?.nodes.alpha,
    ).toMatchObject({ width: 700, height: 460 });
  });

  it("renders chat sessions as interactive canvas nodes", () => {
    installCanvasSessions(["terminal", "chat"], { chat: "chat" });
    render("canvas");

    const chatNode = document.querySelector<HTMLElement>(
      '[data-canvas-session-id="chat"]',
    );
    expect(chatNode).not.toBeNull();
    expect(
      chatNode!.querySelector('[data-chat-session-id="chat"]'),
    ).not.toBeNull();
    expect(chatNode!.querySelector("[data-canvas-terminal-body]")).toBeNull();
    expect(
      chatNode!.querySelector('button[aria-label="Expand chat"]'),
    ).toBeNull();
    expect(
      chatNode!
        .querySelector('[data-testid="mock-chat-pane"]')
        ?.getAttribute("data-active"),
    ).toBe("false");

    act(() =>
      chatNode!
        .querySelector<HTMLButtonElement>(
          '[data-testid="workspace-canvas-node-drag-handle"]',
        )!
        .click(),
    );

    expect(useAppStore.getState().activeSessionId).toBe("chat");
    expect(
      chatNode!
        .querySelector('[data-testid="mock-chat-pane"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      queryCanvasMinimap()!.querySelectorAll(
        "[data-testid='workspace-canvas-minimap-node']",
      ),
    ).toHaveLength(2);

    const world = document.querySelector<HTMLElement>(
      "[data-testid='workspace-canvas-world']",
    )!;
    const offsetBeforeChatScroll = world.dataset.canvasOffsetY;
    const chatScroll = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    });
    act(() =>
      chatNode!
        .querySelector('[data-testid="mock-chat-pane"]')!
        .dispatchEvent(chatScroll),
    );

    expect(chatScroll.defaultPrevented).toBe(false);
    expect(world.dataset.canvasOffsetY).toBe(offsetBeforeChatScroll);
  });

  it("preserves saved nodes while sessions are transiently empty at startup", () => {
    const pane = {
      id: "root",
      tabIds: ["alpha"],
      activeTabId: "alpha",
    };
    useAppStore.setState((state) => ({
      panes: { root: pane },
      activeTabId: "alpha",
      activeSessionId: "alpha",
      workspaces: {
        ...state.workspaces,
        [REPO]: {
          ...state.workspaces[REPO],
          panes: { root: pane },
          canvas: {
            viewport: { offset: { x: -40, y: 20 }, zoom: 0.8 },
            nodes: {
              alpha: {
                x: 320,
                y: 180,
                width: 680,
                height: 440,
                zIndex: 1,
              },
            },
          },
        },
      },
    }));
    render("canvas");
    expect(useAppStore.getState().workspaces[REPO].canvas?.nodes.alpha.x).toBe(
      320,
    );

    act(() => installCanvasSessions(["alpha"]));

    expect(
      document.querySelector<HTMLElement>('[data-canvas-session-id="alpha"]')
        ?.dataset.canvasNodeX,
    ).toBe("320");
    expect(useAppStore.getState().workspaces[REPO].canvas?.nodes.alpha.x).toBe(
      320,
    );
  });

  it("prunes saved nodes after the final pane tab is removed", () => {
    installCanvasSessions(["alpha"]);
    render("canvas");
    expect(
      document.querySelector('[data-canvas-session-id="alpha"]'),
    ).not.toBeNull();

    const emptyPane = { id: "root", tabIds: [], activeTabId: null };
    act(() => {
      useAppStore.setState((state) => ({
        sessions: [],
        panes: { root: emptyPane },
        activeTabId: null,
        activeSessionId: null,
        workspaces: {
          ...state.workspaces,
          [REPO]: {
            ...state.workspaces[REPO],
            panes: { root: emptyPane },
          },
        },
      }));
    });

    expect(useAppStore.getState().workspaces[REPO].canvas?.nodes).toEqual({});
  });

  it("activates a canvas terminal when focus enters its portaled body", () => {
    installCanvasSessions(["alpha", "beta"]);
    render("canvas");
    const betaBody = document.querySelector<HTMLElement>(
      '[data-canvas-terminal-body="beta"]',
    );
    const input = document.createElement("textarea");
    betaBody!.appendChild(input);

    act(() => input.focus());

    expect(useAppStore.getState().activeSessionId).toBe("beta");
    expect(useAppStore.getState().panes.root.activeTabId).toBe("beta");
  });

  it("shows active-project sessions in the minimap and activates its target", () => {
    installCanvasSessions(["alpha", "beta"]);
    render("canvas");

    const minimap = queryCanvasMinimap();
    expect(minimap).not.toBeNull();
    expect(
      minimap!.querySelectorAll("[data-testid='workspace-canvas-minimap-node']"),
    ).toHaveLength(2);

    const beta = minimap!.querySelector<HTMLButtonElement>(
      '[data-canvas-minimap-session-id="beta"]',
    );
    expect(beta).not.toBeNull();
    act(() => beta!.click());

    expect(useAppStore.getState().activeSessionId).toBe("beta");
    expect(useAppStore.getState().panes.root.activeTabId).toBe("beta");
  });

  it("restores canvas geometry and viewport through the reset undo control", () => {
    installCanvasSessions(["alpha", "beta"]);
    useAppStore.setState((state) => ({
      workspaces: {
        ...state.workspaces,
        [REPO]: {
          ...state.workspaces[REPO],
          canvas: {
            viewport: { offset: { x: -180, y: 75 }, zoom: 1.35 },
            nodes: {
              alpha: {
                x: 280,
                y: 160,
                width: 720,
                height: 480,
                zIndex: 2,
              },
              beta: {
                x: 1_100,
                y: 420,
                width: 560,
                height: 360,
                zIndex: 1,
              },
            },
          },
        },
      },
    }));
    render("canvas");
    const beforeReset = structuredClone(
      useAppStore.getState().workspaces[REPO].canvas,
    );

    const reset = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Reset session layout"]',
    );
    expect(reset).not.toBeNull();
    act(() => reset!.click());

    expect(useAppStore.getState().workspaces[REPO].canvas).not.toEqual(
      beforeReset,
    );
    const toasts = useToasts.getState().toasts;
    const resetToast = toasts[toasts.length - 1];
    expect(resetToast?.message).toBe(
      "Session layout reset. Undo is available in the toolbar.",
    );
    expect(resetToast?.action).toBeNull();

    const undo = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Undo reset"]',
    );
    expect(undo).not.toBeNull();
    act(() => undo!.click());

    expect(useAppStore.getState().workspaces[REPO].canvas).toEqual(beforeReset);
    expect(
      document.querySelector('button[aria-label="Undo reset"]'),
    ).toBeNull();
  });

  it("invalidates reset undo after the next canvas mutation", () => {
    installCanvasSessions(["alpha"]);
    useAppStore.getState().setWorkspaceCanvasState(REPO, {
      viewport: { offset: { x: -120, y: 40 }, zoom: 1.2 },
      nodes: {
        alpha: { x: 180, y: 100, width: 620, height: 400, zIndex: 1 },
      },
    });
    render("canvas");

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Reset session layout"]',
        )!
        .click(),
    );
    expect(
      document.querySelector('button[aria-label="Undo reset"]'),
    ).not.toBeNull();

    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!
        .click(),
    );
    expect(
      document.querySelector('button[aria-label="Undo reset"]'),
    ).toBeNull();
  });

  it("uses pane session ids for reset and undo while metadata is unavailable", () => {
    installCanvasSessions(["alpha", "beta"]);
    const previous = {
      viewport: { offset: { x: -140, y: 60 }, zoom: 1.25 },
      nodes: {
        alpha: { x: 200, y: 140, width: 640, height: 420, zIndex: 2 },
        beta: { x: 900, y: 300, width: 580, height: 360, zIndex: 1 },
      },
    };
    useAppStore.getState().setWorkspaceCanvasState(REPO, previous);
    render("canvas");

    act(() => useAppStore.setState({ sessions: [] }));
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Reset session layout"]',
        )!
        .click(),
    );
    expect(
      Object.keys(useAppStore.getState().workspaces[REPO].canvas!.nodes),
    ).toEqual(["alpha", "beta"]);

    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Undo reset"]')!
        .click(),
    );
    expect(useAppStore.getState().workspaces[REPO].canvas).toEqual(previous);
  });

  it("resizes the column during a drag and restores body styles on pointerup", () => {
    render("kanban");
    const handle = queryColumnResizeHandle();
    expect(handle).not.toBeNull();
    const initialWidth = readColumnWidths()[0];

    firePointer(handle!, "pointerdown", { clientX: 100 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    firePointer(window, "pointermove", { clientX: 140 });
    expect(readColumnWidths()[0]).toBe(initialWidth + 40);

    firePointer(window, "pointerup", { clientX: 140 });
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    // The drag listeners must be gone: further moves change nothing.
    firePointer(window, "pointermove", { clientX: 200 });
    expect(readColumnWidths()[0]).toBe(initialWidth + 40);
  });

  it("restores body styles and drops drag listeners when unmounted mid-drag", () => {
    render("kanban");
    const handle = queryColumnResizeHandle();
    expect(handle).not.toBeNull();
    const initialWidth = readColumnWidths()[0];

    firePointer(handle!, "pointerdown", { clientX: 100 });
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    // Flipping the view mode away from kanban unmounts the board mid-drag.
    render("panes");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    // The orphaned pointermove listener must not fire against a stale closure.
    firePointer(window, "pointermove", { clientX: 300 });
    render("kanban");
    expect(readColumnWidths()[0]).toBe(initialWidth);
  });

  it("flushes the debounced prefs write on unmount so the final width persists", () => {
    render("kanban");
    const handle = queryColumnResizeHandle();
    expect(handle).not.toBeNull();
    const initialWidth = readColumnWidths()[0];

    firePointer(handle!, "pointerdown", { clientX: 100 });
    firePointer(window, "pointermove", { clientX: 140 });
    firePointer(window, "pointerup", { clientX: 140 });
    expect(readColumnWidths()[0]).toBe(initialWidth + 40);

    // Unmount before the debounce window elapses; the pending write must
    // flush so the remounted board reads the final width back.
    render("panes");
    render("kanban");
    expect(readColumnWidths()[0]).toBe(initialWidth + 40);
  });
});
