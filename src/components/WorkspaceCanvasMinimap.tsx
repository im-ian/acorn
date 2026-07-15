import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  centerWorkspaceCanvasViewportFromMinimapPoint,
  findWorkspaceCanvasMinimapNodeAtPoint,
  layoutWorkspaceCanvasMinimap,
  type WorkspaceCanvasNode,
  type WorkspaceCanvasSize,
  type WorkspaceCanvasViewport,
} from "../lib/workspaceCanvas";

const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 96;
const COMPACT_MINIMAP_WIDTH = 120;
const COMPACT_MINIMAP_HEIGHT = 72;
const KEYBOARD_PAN_STEP = 80;

interface WorkspaceCanvasMinimapSession {
  id: string;
  name: string;
}

interface WorkspaceCanvasMinimapProps {
  sessions: readonly WorkspaceCanvasMinimapSession[];
  nodes: Readonly<Record<string, WorkspaceCanvasNode>>;
  viewport: WorkspaceCanvasViewport;
  canvasSize: WorkspaceCanvasSize;
  activeSessionId: string | null;
  regionLabel: string;
  title: string;
  sessionLabel: (name: string) => string;
  keyboardHint: string;
  collapseLabel: string;
  expandLabel: string;
  onActivateSession: (sessionId: string) => void;
  onViewportChange: (
    viewport: WorkspaceCanvasViewport,
    commit: boolean,
  ) => void;
  onCommitNavigation: () => void;
}

function expandedRect(
  rect: { x: number; y: number; width: number; height: number },
  minimumSize: number,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(rect.width, minimumSize);
  const height = Math.max(rect.height, minimumSize);
  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height,
  };
}

function positionedRectStyle(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function boundedExpandedRect(
  rect: { x: number; y: number; width: number; height: number },
  minimumSize: number,
  bounds: WorkspaceCanvasSize,
): { x: number; y: number; width: number; height: number } {
  const expanded = expandedRect(rect, minimumSize);
  const width = Math.min(expanded.width, bounds.width);
  const height = Math.min(expanded.height, bounds.height);
  return {
    x: Math.min(Math.max(expanded.x, 0), bounds.width - width),
    y: Math.min(Math.max(expanded.y, 0), bounds.height - height),
    width,
    height,
  };
}

export function WorkspaceCanvasMinimap({
  sessions,
  nodes,
  viewport,
  canvasSize,
  activeSessionId,
  regionLabel,
  title,
  sessionLabel,
  keyboardHint,
  collapseLabel,
  expandLabel,
  onActivateSession,
  onViewportChange,
  onCommitNavigation,
}: WorkspaceCanvasMinimapProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const hintId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const compact =
    canvasSize.width > 0 &&
    (canvasSize.width < 520 || canvasSize.height < 420);
  const minimapWidth = compact ? COMPACT_MINIMAP_WIDTH : MINIMAP_WIDTH;
  const minimapHeight = compact ? COMPACT_MINIMAP_HEIGHT : MINIMAP_HEIGHT;
  const layout = useMemo(
    () =>
      layoutWorkspaceCanvasMinimap(
        nodes,
        viewport,
        canvasSize,
        { width: minimapWidth, height: minimapHeight },
      ),
    [canvasSize, minimapHeight, minimapWidth, nodes, viewport],
  );

  useEffect(() => () => cancelDragRef.current?.(), []);

  const pointFromClient = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const plot = plotRef.current;
    if (!plot) return null;
    const rect = plot.getBoundingClientRect();
    const renderedWidth = rect.width || minimapWidth;
    const renderedHeight = rect.height || minimapHeight;
    return {
      x: ((clientX - rect.left) / renderedWidth) * minimapWidth,
      y: ((clientY - rect.top) / renderedHeight) * minimapHeight,
    };
  };

  const startNavigation = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cancelDragRef.current?.();
    const frozenLayout = layout;
    const initialPoint = pointFromClient(event.clientX, event.clientY);
    const targetSessionId = initialPoint
      ? findWorkspaceCanvasMinimapNodeAtPoint(
          sessions.map((session) => session.id),
          nodes,
          frozenLayout.nodeRects,
          initialPoint,
        )
      : null;
    if (targetSessionId) {
      onActivateSession(targetSessionId);
      return;
    }
    const navigate = (clientX: number, clientY: number) => {
      const point = pointFromClient(clientX, clientY);
      if (!point) return;
      onViewportChange(
        centerWorkspaceCanvasViewportFromMinimapPoint(
          viewport,
          canvasSize,
          frozenLayout,
          point,
        ),
        false,
      );
    };
    navigate(event.clientX, event.clientY);

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (cancelDragRef.current === cleanup) cancelDragRef.current = null;
    };
    const finish = () => {
      cleanup();
      onCommitNavigation();
    };
    const onMove = (moveEvent: PointerEvent) => {
      navigate(moveEvent.clientX, moveEvent.clientY);
    };
    cancelDragRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const nudgeViewport = (event: KeyboardEvent<HTMLElement>) => {
    if (
      collapsed ||
      (event.target instanceof Element &&
        event.target.closest("[data-workspace-canvas-minimap-toggle]"))
    ) {
      return;
    }
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
    event.stopPropagation();
    onViewportChange(
      {
        ...viewport,
        offset: {
          x: viewport.offset.x - direction.x * KEYBOARD_PAN_STEP,
          y: viewport.offset.y - direction.y * KEYBOARD_PAN_STEP,
        },
      },
      true,
    );
  };

  return (
    <section
      role="region"
      aria-label={regionLabel}
      aria-describedby={collapsed ? undefined : hintId}
      tabIndex={0}
      className="absolute bottom-3 right-3 z-30 rounded-lg border border-border bg-bg/88 p-1.5 text-fg shadow-xl backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      data-testid="workspace-canvas-minimap"
      data-workspace-canvas-toolbar
      onKeyDown={nudgeViewport}
    >
      <span id={hintId} className="sr-only">
        {keyboardHint}
      </span>
      <div
        className={`${collapsed ? "" : "mb-1"} flex items-center justify-between gap-2 px-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-fg-muted`}
      >
        <span>{title}</span>
        <span className="flex items-center gap-1">
          <span className="tabular-nums">
            {Math.round(viewport.zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label={collapsed ? expandLabel : collapseLabel}
            aria-expanded={!collapsed}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-fg-muted hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            data-workspace-canvas-minimap-toggle
            onClick={() => setCollapsed((current) => !current)}
          >
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </span>
      </div>
      {!collapsed ? (
        <div
          ref={plotRef}
          className="relative touch-none cursor-crosshair overflow-hidden rounded border border-border/80 bg-bg-sidebar/90"
          style={{ width: minimapWidth, height: minimapHeight }}
          data-testid="workspace-canvas-minimap-plot"
          onPointerDown={startNavigation}
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-45"
            style={{
              backgroundImage:
                "radial-gradient(circle, color-mix(in oklab, var(--color-fg-muted) 36%, transparent) 0.75px, transparent 0.75px)",
              backgroundSize: "8px 8px",
            }}
          />
          {sessions.map((session) => {
            const rect = layout.nodeRects[session.id];
            if (!rect) return null;
            const active = session.id === activeSessionId;
            const visualRect = expandedRect(rect, 4);
            const hitRect = boundedExpandedRect(visualRect, 24, {
              width: minimapWidth,
              height: minimapHeight,
            });
            return (
              <button
                key={session.id}
                type="button"
                aria-label={sessionLabel(session.name)}
                aria-pressed={active}
                className={`group absolute cursor-pointer rounded-[3px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${active ? "z-20" : "z-10"}`}
                style={positionedRectStyle(hitRect)}
                data-testid="workspace-canvas-minimap-node"
                data-workspace-canvas-minimap-node
                data-canvas-minimap-session-id={session.id}
                onClick={(clickEvent) => {
                  if (clickEvent.detail === 0) {
                    onActivateSession(session.id);
                  }
                }}
              >
                <span
                  aria-hidden="true"
                  className={`absolute rounded-[2px] border transition-[background-color,border-color,box-shadow] ${
                    active
                      ? "border-accent bg-accent/55 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_35%,transparent)]"
                      : "border-fg-muted/55 bg-fg-muted/25 group-hover:border-accent/80 group-hover:bg-accent/25"
                  }`}
                  style={{
                    left: visualRect.x - hitRect.x,
                    top: visualRect.y - hitRect.y,
                    width: visualRect.width,
                    height: visualRect.height,
                  }}
                />
              </button>
            );
          })}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-30 rounded-[2px] border border-dashed border-fg/85 bg-accent/5 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-bg)_55%,transparent)]"
            style={positionedRectStyle(expandedRect(layout.viewportRect, 3))}
            data-testid="workspace-canvas-minimap-viewport"
          />
        </div>
      ) : null}
    </section>
  );
}
