import {
  Bot,
  ChevronDown,
  CircleHelp,
  CirclePlus,
  GitBranch,
  Maximize2,
  MessageSquareText,
  Minus,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  Scan,
  Terminal as TerminalIcon,
  Undo2,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AgentProviderIcon,
  resolveSessionAgentProvider,
} from "../lib/agentProvider";
import { formatHotkey } from "../lib/hotkeys";
import { basename } from "../lib/pathUtils";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  PROJECT_SESSION_CREATE_ACTIONS,
  type ProjectSessionCreateAction,
} from "../lib/projectSessionCreateActions";
import { useSettings } from "../lib/settings";
import type { Session, SessionStatus } from "../lib/types";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import {
  WORKSPACE_CANVAS_GRID_SIZE,
  WORKSPACE_CANVAS_MAX_ZOOM,
  WORKSPACE_CANVAS_MIN_ZOOM,
  alignWorkspaceCanvasNode,
  centerWorkspaceCanvasNode,
  clampWorkspaceCanvasNode,
  fitWorkspaceCanvasViewport,
  preserveWorkspaceCanvasNodeRevealOnZoom,
  reconcileWorkspaceCanvasState,
  resetWorkspaceCanvasState,
  revealWorkspaceCanvasNode,
  snapWorkspaceCanvasValue,
  workspaceCanvasStatesEqual,
  zoomWorkspaceCanvasAtPoint,
  type WorkspaceCanvasAlignmentGuide,
  type WorkspaceCanvasAlignmentMatches,
  type WorkspaceCanvasAlignmentMode,
  type WorkspaceCanvasNode,
  type WorkspaceCanvasSize,
  type WorkspaceCanvasState,
  type WorkspaceCanvasViewport,
} from "../lib/workspaceCanvas";
import { useAppStore, type FocusSessionEventDetail } from "../store";
import { Button, IconButton, StatusDot, type StatusTone } from "./ui";
import { ChatPane } from "./ChatPane";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Tooltip } from "./Tooltip";
import { WorkspaceCanvasMinimap } from "./WorkspaceCanvasMinimap";

type WorkspaceCanvasTranslationKey = Extract<
  TranslationKey,
  `workspace.canvas.${string}`
>;

const STATUS_TONE: Record<SessionStatus, StatusTone> = {
  ready: "neutral",
  working: "accent",
  waiting_for_input: "warning",
  errored: "danger",
};

const STATUS_ICON_CLASS: Record<SessionStatus, string> = {
  ready: "text-fg-muted",
  working: "text-accent",
  waiting_for_input: "text-warning",
  errored: "text-danger",
};

const CANVAS_SESSION_CREATE_ACTIONS = PROJECT_SESSION_CREATE_ACTIONS;

const VIEWPORT_SAVE_DEBOUNCE_MS = 220;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const TOOLBAR_ZOOM_STEP = 0.15;
const ALIGNMENT_SNAP_DISTANCE_PX = 8;

interface WorkspaceCanvasInteractionHints {
  sessionId: string;
  mode: WorkspaceCanvasAlignmentMode;
  guides: readonly WorkspaceCanvasAlignmentGuide[];
  matches: WorkspaceCanvasAlignmentMatches;
}

function emptyWorkspaceCanvasAlignmentMatches(): WorkspaceCanvasAlignmentMatches {
  return { x: false, y: false, width: false, height: false };
}

function canvasText(
  t: Translator,
  key: WorkspaceCanvasTranslationKey,
  values: Record<string, string | number> = {},
): string {
  return t(key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

function sameViewport(
  first: WorkspaceCanvasViewport,
  second: WorkspaceCanvasViewport,
): boolean {
  return (
    first.zoom === second.zoom &&
    first.offset.x === second.offset.x &&
    first.offset.y === second.offset.y
  );
}

function canvasElementScale(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  if (element.offsetWidth <= 0 || rect.width <= 0) return 1;
  const scale = rect.width / element.offsetWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function canvasAlignmentGuideStyle(
  guide: WorkspaceCanvasAlignmentGuide,
  viewport: WorkspaceCanvasViewport,
): CSSProperties {
  if (guide.axis === "x") {
    return {
      left: viewport.offset.x + guide.position * viewport.zoom,
      top: viewport.offset.y + guide.start * viewport.zoom,
      width: 1,
      height: Math.max((guide.end - guide.start) * viewport.zoom, 1),
    };
  }
  return {
    left: viewport.offset.x + guide.start * viewport.zoom,
    top: viewport.offset.y + guide.position * viewport.zoom,
    width: Math.max((guide.end - guide.start) * viewport.zoom, 1),
    height: 1,
  };
}

function canvasSessionCreateIcon(id: ProjectSessionCreateAction["id"]) {
  switch (id) {
    case "terminal":
      return <CirclePlus size={12} />;
    case "isolated":
      return <GitBranch size={12} />;
    case "control":
      return <Bot size={12} />;
    case "chat":
      return <MessageSquareText size={12} />;
  }
}

function dispatchCanvasSessionCreate(action: ProjectSessionCreateAction) {
  const eventName =
    action.id === "terminal"
      ? "acorn:new-session"
      : action.id === "isolated"
        ? "acorn:new-isolated-session"
        : action.id === "control"
          ? "acorn:new-control-session"
          : "acorn:new-chat-session";
  if (eventName) window.dispatchEvent(new CustomEvent(eventName));
}

type AppStateSnapshot = ReturnType<typeof useAppStore.getState>;

function activeWorkspaceLabel(
  state: AppStateSnapshot,
  workspaceId: string | null,
): string | null {
  if (!workspaceId) return null;
  for (const folders of Object.values(state.projectFolders)) {
    const folder = folders.find((candidate) => candidate.id === workspaceId);
    if (folder) {
      const project = state.projects.find(
        (candidate) => candidate.repo_path === folder.repoPath,
      );
      if (folder.cwdPath !== folder.repoPath) {
        return `${project?.name ?? basename(folder.repoPath)} / ${folder.name}`;
      }
      return project?.name ?? basename(folder.repoPath);
    }
  }
  return (
    state.projects.find((project) => project.repo_path === workspaceId)?.name ??
    basename(workspaceId)
  );
}

interface WorkspaceCanvasProps {
  workspaceId: string | null;
  workspaceSessionIds: readonly string[];
  sessions: readonly Session[];
}

export function WorkspaceCanvas({
  workspaceId,
  workspaceSessionIds,
  sessions,
}: WorkspaceCanvasProps) {
  const t = useTranslation();
  const showToast = useToasts((state) => state.show);
  const shortcuts = useSettings((state) => state.settings.shortcuts);
  const rootRef = useRef<HTMLElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const cancelPanRef = useRef<(() => void) | null>(null);
  const persisted = useAppStore((state) =>
    workspaceId ? state.workspaces[workspaceId]?.canvas : undefined,
  );
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const setWorkspaceCanvasState = useAppStore(
    (state) => state.setWorkspaceCanvasState,
  );
  const requestRemoveSession = useAppStore(
    (state) => state.requestRemoveSession,
  );
  const canvasSessions = sessions;
  const sessionIds = useMemo(
    () => canvasSessions.map((session) => session.id),
    [canvasSessions],
  );
  const reconciliationIdsKey = (
    sessions.length === 0 ? workspaceSessionIds : sessionIds
  ).join("\0");
  const reconciliationIds = useMemo(
    () =>
      reconciliationIdsKey.length > 0
        ? reconciliationIdsKey.split("\0")
        : [],
    [reconciliationIdsKey],
  );
  const [canvas, setCanvas] = useState<WorkspaceCanvasState>(() => {
    return reconcileWorkspaceCanvasState(persisted, reconciliationIds);
  });
  const canvasRef = useRef(canvas);
  // Session creation can activate the new id before its canvas node exists.
  const placementAnchorSessionIdRef = useRef<string | null>(
    activeSessionId && canvas.nodes[activeSessionId] ? activeSessionId : null,
  );
  const resetUndoRef = useRef<WorkspaceCanvasState | null>(null);
  const [canUndoReset, setCanUndoReset] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    sessionId: string | null;
  } | null>(null);
  const [createMenu, setCreateMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [interactionHints, setInteractionHints] =
    useState<WorkspaceCanvasInteractionHints | null>(null);
  const [containerSize, setContainerSize] = useState<WorkspaceCanvasSize>({
    width: 0,
    height: 0,
  });
  const containerSizeRef = useRef<WorkspaceCanvasSize>(containerSize);
  const workspaceLabel =
    useAppStore((state) => activeWorkspaceLabel(state, workspaceId)) ??
    t("workspace.mode.canvas");

  const applyCanvas = useCallback((next: WorkspaceCanvasState) => {
    canvasRef.current = next;
    setCanvas(next);
  }, []);

  const clearResetUndo = useCallback(() => {
    if (!resetUndoRef.current) return;
    resetUndoRef.current = null;
    setCanUndoReset(false);
  }, []);

  const persistCanvas = useCallback(
    (next: WorkspaceCanvasState) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!workspaceId) return;
      setWorkspaceCanvasState(workspaceId, next);
    },
    [setWorkspaceCanvasState, workspaceId],
  );

  const schedulePersist = useCallback(
    (next: WorkspaceCanvasState) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvas(next);
      }, VIEWPORT_SAVE_DEBOUNCE_MS);
    },
    [persistCanvas],
  );

  const updateCanvas = useCallback(
    (
      updater: (current: WorkspaceCanvasState) => WorkspaceCanvasState,
      persist: "now" | "soon" | "later" = "later",
    ) => {
      const current = canvasRef.current;
      const next = updater(current);
      if (workspaceCanvasStatesEqual(current, next)) return current;
      clearResetUndo();
      applyCanvas(next);
      if (persist === "now") persistCanvas(next);
      if (persist === "soon") schedulePersist(next);
      return next;
    },
    [applyCanvas, clearResetUndo, persistCanvas, schedulePersist],
  );

  const fitAll = useCallback(
    (state = canvasRef.current, persist: "now" | "soon" = "now") => {
      const viewport = fitWorkspaceCanvasViewport(
        state.nodes,
        containerSizeRef.current,
      );
      return updateCanvas((current) => ({ ...current, viewport }), persist);
    },
    [updateCanvas],
  );

  const revealSession = useCallback(
    (sessionId: string) => {
      const current = canvasRef.current;
      const node = current.nodes[sessionId];
      if (!node) return;
      const viewport = revealWorkspaceCanvasNode(
        current.viewport,
        node,
        containerSizeRef.current,
      );
      if (sameViewport(current.viewport, viewport)) return;
      updateCanvas((state) => ({ ...state, viewport }), "soon");
    },
    [updateCanvas],
  );

  const centerSession = useCallback(
    (sessionId: string) => {
      const current = canvasRef.current;
      const node = current.nodes[sessionId];
      if (!node) return;
      const root = rootRef.current;
      const container = root
        ? { width: root.clientWidth, height: root.clientHeight }
        : containerSizeRef.current;
      containerSizeRef.current = container;
      const viewport = centerWorkspaceCanvasNode(
        current.viewport,
        node,
        container,
      );
      if (sameViewport(current.viewport, viewport)) return;
      updateCanvas((state) => ({ ...state, viewport }), "soon");
    },
    [updateCanvas],
  );

  useEffect(() => {
    const current = canvasRef.current;
    const placementAnchorSessionId =
      activeSessionId && current.nodes[activeSessionId]
        ? activeSessionId
        : placementAnchorSessionIdRef.current;
    const next = reconcileWorkspaceCanvasState(
      current,
      reconciliationIds,
      placementAnchorSessionId,
    );
    setInteractionHints(null);
    if (workspaceCanvasStatesEqual(current, next)) return;
    clearResetUndo();
    applyCanvas(next);
    persistCanvas(next);
  }, [
    activeSessionId,
    applyCanvas,
    clearResetUndo,
    persistCanvas,
    reconciliationIds,
  ]);

  useEffect(() => {
    if (!activeSessionId) {
      placementAnchorSessionIdRef.current = null;
      return;
    }
    if (!canvasRef.current.nodes[activeSessionId]) return;
    placementAnchorSessionIdRef.current = activeSessionId;
  }, [activeSessionId, reconciliationIds]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const updateSize = (size: WorkspaceCanvasSize) => {
      containerSizeRef.current = size;
      setContainerSize((current) =>
        current.width === size.width && current.height === size.height
          ? current
          : size,
      );
    };
    updateSize({ width: root.clientWidth, height: root.clientHeight });
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      updateSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (activeSessionId) revealSession(activeSessionId);
  }, [activeSessionId, revealSession]);

  useEffect(() => {
    const onFocusSession = (event: Event) => {
      const detail = (event as CustomEvent<FocusSessionEventDetail>).detail;
      if (!detail?.sessionId) return;
      if (detail.canvasTarget === "center") {
        centerSession(detail.sessionId);
        return;
      }
      revealSession(detail.sessionId);
    };
    window.addEventListener("acorn:focus-session", onFocusSession);
    return () =>
      window.removeEventListener("acorn:focus-session", onFocusSession);
  }, [centerSession, revealSession]);

  useEffect(() => {
    return () => {
      cancelPanRef.current?.();
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      persistCanvas(canvasRef.current);
    };
  }, [persistCanvas]);

  const setViewport = useCallback(
    (viewport: WorkspaceCanvasViewport, persist: "now" | "soon" = "soon") =>
      updateCanvas((current) => ({ ...current, viewport }), persist),
    [updateCanvas],
  );

  const zoomAround = useCallback(
    (nextZoom: number, point: { x: number; y: number }) => {
      const current = canvasRef.current;
      let viewport = zoomWorkspaceCanvasAtPoint(
        current.viewport,
        nextZoom,
        point,
      );
      const activeNode = activeSessionId
        ? current.nodes[activeSessionId]
        : undefined;
      if (activeNode) {
        viewport = preserveWorkspaceCanvasNodeRevealOnZoom(
          current.viewport,
          viewport,
          activeNode,
          containerSizeRef.current,
        );
      }
      setViewport(viewport);
    },
    [activeSessionId, setViewport],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-workspace-canvas-toolbar]")) return;
      const explicitZoom = event.ctrlKey || event.metaKey;
      if (target.closest("[data-canvas-session-body]") && !explicitZoom) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const scale = canvasElementScale(root);
      if (explicitZoom) {
        const rect = root.getBoundingClientRect();
        const point = {
          x: (event.clientX - rect.left) / scale,
          y: (event.clientY - rect.top) / scale,
        };
        const currentZoom = canvasRef.current.viewport.zoom;
        const multiplier = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
        zoomAround(currentZoom * multiplier, point);
        return;
      }
      const current = canvasRef.current.viewport;
      setViewport({
        ...current,
        offset: {
          x: current.offset.x - event.deltaX / scale,
          y: current.offset.y - event.deltaY / scale,
        },
      });
    };
    root.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => root.removeEventListener("wheel", onWheel, { capture: true });
  }, [setViewport, zoomAround]);

  const startPan = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 && event.button !== 1) return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest("[data-workspace-canvas-toolbar]") ||
          (event.button === 0 &&
            target.closest("[data-workspace-canvas-node]")))
      ) {
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      event.preventDefault();
      cancelPanRef.current?.();
      const start = { x: event.clientX, y: event.clientY };
      const startOffset = { ...canvasRef.current.viewport.offset };
      const scale = canvasElementScale(root);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        const current = canvasRef.current.viewport;
        setViewport(
          {
            ...current,
            offset: {
              x: startOffset.x + (moveEvent.clientX - start.x) / scale,
              y: startOffset.y + (moveEvent.clientY - start.y) / scale,
            },
          },
          "soon",
        );
      };
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (cancelPanRef.current === cleanup) cancelPanRef.current = null;
      };
      const finish = () => {
        cleanup();
        persistCanvas(canvasRef.current);
      };
      cancelPanRef.current = cleanup;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    },
    [persistCanvas, setViewport],
  );

  const updateNode = useCallback(
    (
      sessionId: string,
      updater: (node: WorkspaceCanvasNode) => WorkspaceCanvasNode,
      persist: "now" | "soon" | "later" = "later",
    ) =>
      updateCanvas((current) => {
        const node = current.nodes[sessionId];
        if (!node) return current;
        const nextNode = clampWorkspaceCanvasNode(updater(node));
        return {
          ...current,
          nodes: { ...current.nodes, [sessionId]: nextNode },
        };
      }, persist),
    [updateCanvas],
  );

  const clearInteractionHints = useCallback(() => {
    setInteractionHints(null);
  }, []);

  const updateNodeDuringGesture = useCallback(
    (
      sessionId: string,
      mode: WorkspaceCanvasAlignmentMode,
      candidate: WorkspaceCanvasNode,
      snapThreshold: number | null,
    ): WorkspaceCanvasAlignmentMatches => {
      const peers =
        snapThreshold === null
          ? []
          : Object.entries(canvasRef.current.nodes).flatMap(([id, node]) =>
              id === sessionId ? [] : [node],
            );
      const result = alignWorkspaceCanvasNode(
        candidate,
        peers,
        mode,
        snapThreshold ?? 0,
      );
      updateNode(sessionId, (current) => ({
        ...result.node,
        zIndex: current.zIndex,
      }));

      if (
        result.guides.length > 0 ||
        result.matches.width ||
        result.matches.height
      ) {
        setInteractionHints({
          sessionId,
          mode,
          guides: result.guides,
          matches: result.matches,
        });
      } else {
        setInteractionHints(null);
      }
      return result.matches;
    },
    [updateNode],
  );

  const activateNode = useCallback(
    (sessionId: string) => {
      useAppStore.getState().selectTab(sessionId);
      const values = Object.values(canvasRef.current.nodes);
      const topZ = values.reduce((max, node) => Math.max(max, node.zIndex), 0);
      const current = canvasRef.current.nodes[sessionId];
      if (current && current.zIndex !== topZ) {
        updateNode(sessionId, (node) => ({ ...node, zIndex: topZ + 1 }), "now");
      }
      revealSession(sessionId);
    },
    [revealSession, updateNode],
  );

  const commitNode = useCallback(
    (
      sessionId: string,
      purpose: WorkspaceCanvasAlignmentMode,
      snap: boolean,
      matches: WorkspaceCanvasAlignmentMatches,
    ) => {
      const next = updateNode(
        sessionId,
        (node) =>
          snap
            ? purpose === "move"
              ? {
                  ...node,
                  x: matches.x ? node.x : snapWorkspaceCanvasValue(node.x),
                  y: matches.y ? node.y : snapWorkspaceCanvasValue(node.y),
                }
              : {
                  ...node,
                  width: matches.width
                    ? node.width
                    : snapWorkspaceCanvasValue(node.width),
                  height: matches.height
                    ? node.height
                    : snapWorkspaceCanvasValue(node.height),
                }
            : node,
        "later",
      );
      persistCanvas(next);
      clearInteractionHints();
    },
    [clearInteractionHints, persistCanvas, updateNode],
  );

  const openInPanes = useCallback((sessionId: string) => {
    const store = useAppStore.getState();
    store.selectSession(sessionId);
    store.setWorkspaceViewMode("panes");
  }, []);

  const openExpanded = useCallback(
    (sessionId: string) => {
      activateNode(sessionId);
      useAppStore.getState().openTerminalPopup(sessionId);
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent("acorn:focus-session", {
            detail: { sessionId },
          }),
        );
      });
    },
    [activateNode],
  );

  const resetLayout = useCallback(() => {
    const previous = canvasRef.current;
    const next = resetWorkspaceCanvasState(reconciliationIds);
    if (workspaceCanvasStatesEqual(previous, next)) return;
    resetUndoRef.current = previous;
    setCanUndoReset(true);
    applyCanvas(next);
    persistCanvas(next);
    showToast(canvasText(t, "workspace.canvas.resetComplete"));
  }, [applyCanvas, persistCanvas, reconciliationIds, showToast, t]);

  const undoReset = useCallback(() => {
    const previous = resetUndoRef.current;
    if (!previous) return;
    resetUndoRef.current = null;
    setCanUndoReset(false);
    const restored = reconcileWorkspaceCanvasState(
      previous,
      reconciliationIds,
    );
    applyCanvas(restored);
    persistCanvas(restored);
  }, [applyCanvas, persistCanvas, reconciliationIds]);

  const contextSession = contextMenu?.sessionId
    ? canvasSessions.find((session) => session.id === contextMenu.sessionId) ??
      null
    : null;
  const sessionCreateMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      {
        type: "group-title",
        label: canvasText(t, "workspace.canvas.contextCreateSession"),
      },
      ...CANVAS_SESSION_CREATE_ACTIONS.map((action) => ({
        label: t(action.labelKey),
        icon: canvasSessionCreateIcon(action.id),
        shortcut: action.hotkeyId
          ? formatHotkey(shortcuts[action.hotkeyId])
          : undefined,
        onClick: () => dispatchCanvasSessionCreate(action),
      })),
    ],
    [shortcuts, t],
  );
  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [];
    if (contextSession) {
      items.push({
        type: "group-title",
        label: canvasText(t, "workspace.canvas.contextSession"),
      });
      if (contextSession.mode !== "chat") {
        items.push({
          label: canvasText(t, "workspace.canvas.expandSession", {
            name: contextSession.name,
          }),
          icon: <Maximize2 size={12} />,
          onClick: () => openExpanded(contextSession.id),
        });
      }
      items.push({
        label: canvasText(t, "workspace.canvas.openInPanes", {
          name: contextSession.name,
        }),
        icon: <PanelsTopLeft size={12} />,
        onClick: () => openInPanes(contextSession.id),
      });
      items.push({
        label: canvasText(t, "workspace.canvas.closeSession"),
        icon: <X size={12} />,
        onClick: () => requestRemoveSession(contextSession.id),
      });
    }
    items.push(...sessionCreateMenuItems);
    items.push(
      {
        type: "group-title",
        label: canvasText(t, "workspace.canvas.contextLayout"),
      },
      {
        label: canvasText(t, "workspace.canvas.fit"),
        icon: <Scan size={12} />,
        disabled: canvasSessions.length === 0,
        onClick: () => fitAll(),
      },
      {
        label: canvasText(t, "workspace.canvas.reset"),
        icon: <RotateCcw size={12} />,
        disabled: canvasSessions.length === 0,
        onClick: resetLayout,
      },
    );
    return items;
  }, [
    contextSession,
    fitAll,
    openExpanded,
    openInPanes,
    requestRemoveSession,
    resetLayout,
    sessionCreateMenuItems,
    t,
    canvasSessions.length,
  ]);

  const openCanvasContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest("[data-workspace-canvas-toolbar]") ||
        target.closest("[data-canvas-session-body]")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setCreateMenu(null);
      const node = target.closest<HTMLElement>("[data-canvas-session-id]");
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        sessionId: node?.dataset.canvasSessionId ?? null,
      });
    },
    [],
  );

  const worldStyle: CSSProperties = {
    transform: `translate3d(${canvas.viewport.offset.x}px, ${canvas.viewport.offset.y}px, 0) scale(${canvas.viewport.zoom})`,
    transformOrigin: "0 0",
  };
  const gridStep = WORKSPACE_CANVAS_GRID_SIZE * canvas.viewport.zoom;
  const gridStyle: CSSProperties = {
    backgroundImage:
      "radial-gradient(circle, color-mix(in oklab, var(--color-fg-muted) 32%, transparent) 1px, transparent 1px)",
    backgroundPosition: `${canvas.viewport.offset.x}px ${canvas.viewport.offset.y}px`,
    backgroundSize: `${gridStep}px ${gridStep}px`,
  };
  const zoomPercent = Math.round(canvas.viewport.zoom * 100);
  const sizeHintNode =
    interactionHints?.mode === "resize"
      ? canvas.nodes[interactionHints.sessionId]
      : undefined;
  const sizeHintStyle: CSSProperties | undefined = sizeHintNode
    ? {
        left:
          canvas.viewport.offset.x +
          (sizeHintNode.x + sizeHintNode.width) * canvas.viewport.zoom +
          8,
        top:
          canvas.viewport.offset.y +
          (sizeHintNode.y + sizeHintNode.height) * canvas.viewport.zoom +
          8,
      }
    : undefined;

  return (
    <section
      ref={rootRef}
      role="region"
      aria-label={canvasText(t, "workspace.canvas.regionLabel")}
      className="relative h-full min-w-0 cursor-grab overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/55"
      data-testid="workspace-canvas"
      data-workspace-canvas
      onPointerDown={startPan}
      onContextMenu={openCanvasContextMenu}
    >
      <div className="pointer-events-none absolute inset-0" style={gridStyle} />
      <div
        className="absolute left-0 top-0 size-px"
        style={worldStyle}
        data-testid="workspace-canvas-world"
        data-canvas-zoom={canvas.viewport.zoom}
        data-canvas-offset-x={canvas.viewport.offset.x}
        data-canvas-offset-y={canvas.viewport.offset.y}
      >
        {canvasSessions.map((session) => {
          const node = canvas.nodes[session.id];
          if (!node) return null;
          return (
            <WorkspaceCanvasSessionNode
              key={session.id}
              session={session}
              node={node}
              zoom={canvas.viewport.zoom}
              active={activeSessionId === session.id}
              onActivate={() => activateNode(session.id)}
              onUpdate={(updater) => updateNode(session.id, updater)}
              onGestureStart={clearInteractionHints}
              onGestureUpdate={(mode, candidate, snapThreshold) =>
                updateNodeDuringGesture(
                  session.id,
                  mode,
                  candidate,
                  snapThreshold,
                )
              }
              onCommit={(purpose, snap, matches) =>
                commitNode(session.id, purpose, snap, matches)
              }
              onExpand={() => openExpanded(session.id)}
              onClose={() => requestRemoveSession(session.id)}
              t={t}
            />
          );
        })}
      </div>

      {interactionHints?.guides.map((guide) => (
        <div
          key={`${guide.axis}:${guide.position}:${guide.start}:${guide.end}`}
          aria-hidden="true"
          className="pointer-events-none absolute z-20 bg-accent shadow-[0_0_6px_var(--color-accent)]"
          data-canvas-alignment-axis={guide.axis}
          data-testid="workspace-canvas-alignment-guide"
          style={canvasAlignmentGuideStyle(guide, canvas.viewport)}
        />
      ))}
      {sizeHintNode && interactionHints ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-20 -translate-y-1/2 rounded-md border border-accent/55 bg-bg/95 px-2 py-1 font-mono text-[10px] tabular-nums text-accent shadow-lg backdrop-blur"
          data-canvas-match-height={String(interactionHints.matches.height)}
          data-canvas-match-width={String(interactionHints.matches.width)}
          data-testid="workspace-canvas-size-hint"
          style={sizeHintStyle}
        >
          {interactionHints.matches.width && interactionHints.matches.height
            ? `${sizeHintNode.width} × ${sizeHintNode.height}px`
            : interactionHints.matches.width
              ? `W ${sizeHintNode.width}px`
              : `H ${sizeHintNode.height}px`}
        </div>
      ) : null}

      {canvasSessions.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto flex flex-col items-center gap-2 rounded-xl border border-border bg-bg/85 px-4 py-3 text-xs text-fg-muted shadow-lg backdrop-blur">
            <span>{canvasText(t, "workspace.canvas.empty")}</span>
            <Button
              size="xs"
              variant="accentSoft"
              onClick={() =>
                window.dispatchEvent(new CustomEvent("acorn:new-session"))
              }
            >
              <CirclePlus size={12} />
              {canvasText(t, "workspace.canvas.newSession")}
            </Button>
          </div>
        </div>
      ) : null}

      <div
        role="toolbar"
        aria-label={canvasText(t, "workspace.canvas.toolbarLabel")}
        className="acorn-no-scrollbar absolute left-3 top-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-2 overflow-x-auto rounded-lg border border-border bg-bg/88 px-2 py-1.5 text-xs shadow-xl backdrop-blur-md"
        data-workspace-canvas-toolbar
      >
        <span className="flex min-w-0 items-center gap-1.5 border-r border-border pr-2 text-fg">
          <TerminalIcon size={13} className="shrink-0 text-accent" />
          <span className="truncate font-medium">{workspaceLabel}</span>
          <span className="shrink-0 text-[10px] text-fg-muted">
            {canvasText(
              t,
              canvasSessions.length === 1
                ? "workspace.canvas.sessionCountOne"
                : "workspace.canvas.sessionCountOther",
              {
                count: canvasSessions.length,
              },
            )}
          </span>
        </span>
        <Button
          size="xs"
          aria-label={canvasText(t, "workspace.canvas.contextCreateSession")}
          aria-haspopup="menu"
          aria-expanded={createMenu !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setContextMenu(null);
            setCreateMenu((current) =>
              current === null
                ? { x: rect.left, y: rect.bottom + 4 }
                : null,
            );
          }}
        >
          <CirclePlus size={12} />
          {canvasText(t, "workspace.canvas.contextCreateSession")}
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
        <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
        <Tooltip
          label={canvasText(t, "workspace.canvas.zoomOut")}
          side="bottom"
        >
          <IconButton
            aria-label={canvasText(t, "workspace.canvas.zoomOut")}
            size="xs"
            disabled={canvas.viewport.zoom <= WORKSPACE_CANVAS_MIN_ZOOM}
            onClick={() => {
              const size = containerSizeRef.current;
              zoomAround(canvasRef.current.viewport.zoom - TOOLBAR_ZOOM_STEP, {
                x: size.width / 2,
                y: size.height / 2,
              });
            }}
          >
            <Minus size={12} />
          </IconButton>
        </Tooltip>
        <span className="w-9 text-center font-mono text-[10px] tabular-nums text-fg-muted">
          {zoomPercent}%
        </span>
        <Tooltip label={canvasText(t, "workspace.canvas.zoomIn")} side="bottom">
          <IconButton
            aria-label={canvasText(t, "workspace.canvas.zoomIn")}
            size="xs"
            disabled={canvas.viewport.zoom >= WORKSPACE_CANVAS_MAX_ZOOM}
            onClick={() => {
              const size = containerSizeRef.current;
              zoomAround(canvasRef.current.viewport.zoom + TOOLBAR_ZOOM_STEP, {
                x: size.width / 2,
                y: size.height / 2,
              });
            }}
          >
            <Plus size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip label={canvasText(t, "workspace.canvas.fit")} side="bottom">
          <IconButton
            aria-label={canvasText(t, "workspace.canvas.fit")}
            size="xs"
            onClick={() => fitAll()}
          >
            <Scan size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip label={canvasText(t, "workspace.canvas.reset")} side="bottom">
          <IconButton
            aria-label={canvasText(t, "workspace.canvas.reset")}
            size="xs"
            onClick={resetLayout}
          >
            <RotateCcw size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip
          label={canvasText(t, "workspace.canvas.hint")}
          side="bottom"
          delay={250}
          multiline
        >
          <IconButton
            aria-label={canvasText(t, "workspace.canvas.showHelp")}
            size="xs"
          >
            <CircleHelp size={12} />
          </IconButton>
        </Tooltip>
        {canUndoReset ? (
          <Button
            aria-label={canvasText(t, "workspace.canvas.undoReset")}
            size="xs"
            variant="accentSoft"
            onClick={undoReset}
          >
            <Undo2 size={12} />
            {canvasText(t, "workspace.canvas.undoReset")}
          </Button>
        ) : null}
      </div>

      {canvasSessions.length > 0 ? (
        <WorkspaceCanvasMinimap
          sessions={canvasSessions}
          nodes={canvas.nodes}
          viewport={canvas.viewport}
          canvasSize={containerSize}
          activeSessionId={activeSessionId}
          regionLabel={canvasText(t, "workspace.canvas.overviewLabel")}
          title={canvasText(t, "workspace.canvas.overviewTitle")}
          sessionLabel={(name) =>
            canvasText(t, "workspace.canvas.overviewSession", { name })
          }
          keyboardHint={canvasText(t, "workspace.canvas.overviewHint")}
          collapseLabel={canvasText(t, "workspace.canvas.overviewCollapse")}
          expandLabel={canvasText(t, "workspace.canvas.overviewExpand")}
          onActivateSession={activateNode}
          onViewportChange={(viewport, commit) =>
            setViewport(viewport, commit ? "now" : "soon")
          }
          onCommitNavigation={() => persistCanvas(canvasRef.current)}
        />
      ) : null}

      <ContextMenu
        open={createMenu !== null}
        x={createMenu?.x ?? 0}
        y={createMenu?.y ?? 0}
        items={sessionCreateMenuItems}
        onClose={() => setCreateMenu(null)}
      />
      <ContextMenu
        open={contextMenu !== null}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        items={contextMenuItems}
        onClose={() => setContextMenu(null)}
      />
    </section>
  );
}

interface WorkspaceCanvasSessionNodeProps {
  session: Session;
  node: WorkspaceCanvasNode;
  zoom: number;
  active: boolean;
  onActivate: () => void;
  onUpdate: (
    updater: (node: WorkspaceCanvasNode) => WorkspaceCanvasNode,
  ) => void;
  onGestureStart: () => void;
  onGestureUpdate: (
    mode: WorkspaceCanvasAlignmentMode,
    candidate: WorkspaceCanvasNode,
    snapThreshold: number | null,
  ) => WorkspaceCanvasAlignmentMatches;
  onCommit: (
    purpose: WorkspaceCanvasAlignmentMode,
    snap: boolean,
    matches: WorkspaceCanvasAlignmentMatches,
  ) => void;
  onExpand: () => void;
  onClose: () => void;
  t: Translator;
}

const WorkspaceCanvasSessionNode = memo(
  function WorkspaceCanvasSessionNode({
    session,
    node,
    zoom,
    active,
    onActivate,
    onUpdate,
    onGestureStart,
    onGestureUpdate,
    onCommit,
    onExpand,
    onClose,
    t,
  }: WorkspaceCanvasSessionNodeProps) {
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const cancelGestureRef = useRef<(() => void) | null>(null);
    const provider = resolveSessionAgentProvider(session);

    useEffect(() => {
      const body = bodyRef.current;
      if (!body) return;
      const activate = () => onActivate();
      body.addEventListener("mousedown", activate, true);
      body.addEventListener("focusin", activate, true);
      return () => {
        body.removeEventListener("mousedown", activate, true);
        body.removeEventListener("focusin", activate, true);
      };
    }, [onActivate]);

    useEffect(
      () => () => {
        cancelGestureRef.current?.();
      },
      [],
    );

    const startPointerGesture = (
      cursor: string,
      purpose: WorkspaceCanvasAlignmentMode,
      start: { x: number; y: number },
      onMove: (event: PointerEvent) => WorkspaceCanvasAlignmentMatches,
    ) => {
      cancelGestureRef.current?.();
      onGestureStart();
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";
      let finished = false;
      let moved = false;
      let snapEnabled = true;
      let matches = emptyWorkspaceCanvasAlignmentMatches();

      const handleMove = (event: PointerEvent) => {
        if (event.clientX !== start.x || event.clientY !== start.y)
          moved = true;
        snapEnabled = !event.altKey;
        matches = onMove(event);
      };

      const cleanup = () => {
        if (finished) return;
        finished = true;
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        if (cancelGestureRef.current === cleanup) {
          cancelGestureRef.current = null;
        }
      };
      const finish = (event: Event) => {
        if (
          moved &&
          event.type === "pointerup" &&
          event instanceof PointerEvent
        ) {
          snapEnabled = !event.altKey;
          matches = onMove(event);
        }
        cleanup();
        if (moved) {
          onCommit(purpose, snapEnabled, matches);
        }
      };

      cancelGestureRef.current = cleanup;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
    };

    const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onActivate();
      const start = { x: event.clientX, y: event.clientY };
      const startNode = { ...node };
      const root = document.querySelector<HTMLElement>(
        "[data-workspace-canvas]",
      );
      const appScale = root ? canvasElementScale(root) : 1;
      const onMove = (moveEvent: PointerEvent) => {
        return onGestureUpdate(
          "move",
          {
            ...startNode,
            x: startNode.x + (moveEvent.clientX - start.x) / (appScale * zoom),
            y: startNode.y + (moveEvent.clientY - start.y) / (appScale * zoom),
          },
          moveEvent.altKey
            ? null
            : ALIGNMENT_SNAP_DISTANCE_PX / (appScale * zoom),
        );
      };
      startPointerGesture("grabbing", "move", start, onMove);
    };

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onActivate();
      const start = { x: event.clientX, y: event.clientY };
      const startNode = { ...node };
      const root = document.querySelector<HTMLElement>(
        "[data-workspace-canvas]",
      );
      const appScale = root ? canvasElementScale(root) : 1;
      const onMove = (moveEvent: PointerEvent) => {
        return onGestureUpdate(
          "resize",
          {
            ...startNode,
            width:
              startNode.width +
              (moveEvent.clientX - start.x) / (appScale * zoom),
            height:
              startNode.height +
              (moveEvent.clientY - start.y) / (appScale * zoom),
          },
          moveEvent.altKey
            ? null
            : ALIGNMENT_SNAP_DISTANCE_PX / (appScale * zoom),
        );
      };
      startPointerGesture("nwse-resize", "resize", start, onMove);
    };

    const nudgeNode = (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      purpose: "move" | "resize",
    ) => {
      const direction =
        event.key === "ArrowLeft"
          ? { x: -1, y: 0 }
          : event.key === "ArrowRight"
            ? { x: 1, y: 0 }
            : event.key === "ArrowUp"
              ? { x: 0, y: -1 }
              : event.key === "ArrowDown"
                ? { x: 0, y: 1 }
                : null;
      if (!direction) return;
      event.preventDefault();
      onActivate();
      const step = event.shiftKey ? 40 : 20;
      onUpdate((current) =>
        purpose === "move"
          ? {
              ...current,
              x: Math.round(current.x + direction.x * step),
              y: Math.round(current.y + direction.y * step),
            }
          : {
              ...current,
              width: Math.round(current.width + direction.x * step),
              height: Math.round(current.height + direction.y * step),
            },
      );
      onCommit(purpose, false, emptyWorkspaceCanvasAlignmentMatches());
    };

    return (
      <article
        className={`absolute flex cursor-default flex-col overflow-hidden rounded-xl border bg-bg shadow-2xl transition-[border-color,box-shadow] ${
          active
            ? "border-accent/70 ring-1 ring-accent/30"
            : "border-border hover:border-fg-muted/45"
        }`}
        aria-label={
          session.branch ? `${session.name}, ${session.branch}` : session.name
        }
        style={{
          left: node.x,
          top: node.y,
          width: node.width,
          height: node.height,
          zIndex: node.zIndex,
        }}
        data-workspace-canvas-node
        data-canvas-session-id={session.id}
        data-canvas-node-x={node.x}
        data-canvas-node-y={node.y}
        data-canvas-node-width={node.width}
        data-canvas-node-height={node.height}
        data-testid="workspace-canvas-node"
      >
        <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-bg-sidebar/90 px-1.5">
          <button
            type="button"
            aria-label={canvasText(t, "workspace.canvas.moveSession", {
              name: session.name,
            })}
            className="flex h-7 min-w-0 flex-1 touch-none cursor-grab items-center gap-2 rounded-md px-1.5 text-left hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:cursor-grabbing"
            data-testid="workspace-canvas-node-drag-handle"
            onPointerDown={startDrag}
            onKeyDown={(event) => nudgeNode(event, "move")}
            onClick={onActivate}
            onFocus={onActivate}
            aria-pressed={active}
          >
            {provider ? (
              <AgentProviderIcon
                provider={provider}
                className={`size-3 animate-pulse ${STATUS_ICON_CLASS[session.status]}`}
              />
            ) : (
              <>
                <StatusDot
                  tone={STATUS_TONE[session.status]}
                  size="sm"
                  pulse={session.status === "working"}
                />
                {session.mode === "chat" ? (
                  <MessageSquareText
                    size={12}
                    className="shrink-0 text-fg-muted"
                  />
                ) : (
                  <TerminalIcon
                    size={12}
                    className="shrink-0 text-fg-muted"
                  />
                )}
              </>
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
              {session.name}
            </span>
            {session.branch ? (
              <span className="flex max-w-[35%] shrink-0 items-center gap-1 truncate font-mono text-[10px] text-fg-muted">
                <GitBranch size={10} className="shrink-0" />
                <span className="truncate">{session.branch}</span>
              </span>
            ) : null}
          </button>
          {session.mode === "chat" ? null : (
            <Tooltip
              label={canvasText(t, "workspace.canvas.expandSession", {
                name: session.name,
              })}
              side="bottom"
            >
              <IconButton
                aria-label={canvasText(t, "workspace.canvas.expandSession", {
                  name: session.name,
                })}
                size="xs"
                data-testid="workspace-canvas-node-expand"
                onClick={onExpand}
              >
                <Maximize2 size={12} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip
            label={canvasText(t, "workspace.canvas.closeSessionButton", {
              name: session.name,
            })}
            side="bottom"
          >
            <IconButton
              aria-label={canvasText(
                t,
                "workspace.canvas.closeSessionButton",
                { name: session.name },
              )}
              size="xs"
              data-testid="workspace-canvas-node-close"
              onClick={onClose}
            >
              <X size={12} />
            </IconButton>
          </Tooltip>
        </header>
        {session.mode === "chat" ? (
          <div
            ref={bodyRef}
            className="relative min-h-0 flex-1 overflow-hidden bg-bg"
            data-canvas-chat-body={session.id}
            data-canvas-session-body={session.id}
            data-testid="workspace-canvas-chat-body"
          >
            <ChatPane
              sessionId={session.id}
              isActive={active}
              repoPath={session.worktree_path}
              session={session}
            />
          </div>
        ) : (
          <div
            ref={bodyRef}
            className="relative min-h-0 flex-1 cursor-text overflow-hidden bg-bg"
            data-canvas-session-body={session.id}
            data-canvas-terminal-body={session.id}
            data-testid="workspace-canvas-terminal-body"
          />
        )}
        <button
          type="button"
          aria-label={canvasText(t, "workspace.canvas.resizeSession", {
            name: session.name,
          })}
          className="absolute bottom-0 right-0 z-10 flex size-5 touch-none cursor-nwse-resize items-end justify-end rounded-tl-md text-fg-muted/70 hover:bg-bg-elevated hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          data-testid="workspace-canvas-node-resize-handle"
          onPointerDown={startResize}
          onKeyDown={(event) => nudgeNode(event, "resize")}
          onFocus={onActivate}
        >
          <span
            aria-hidden="true"
            className="mb-1 mr-1 block size-2.5 border-b border-r border-current"
          />
        </button>
      </article>
    );
  },
  (previous, next) =>
    previous.session === next.session &&
    previous.node.x === next.node.x &&
    previous.node.y === next.node.y &&
    previous.node.width === next.node.width &&
    previous.node.height === next.node.height &&
    previous.node.zIndex === next.node.zIndex &&
    previous.zoom === next.zoom &&
    previous.active === next.active &&
    previous.t === next.t,
);
