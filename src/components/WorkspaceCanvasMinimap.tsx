import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  centerWorkspaceCanvasViewportFromMinimapPoint,
  layoutWorkspaceCanvasMinimap,
  type WorkspaceCanvasNode,
  type WorkspaceCanvasSize,
  type WorkspaceCanvasViewport,
} from "../lib/workspaceCanvas";

const MINIMAP_WIDTH = 160;
const MINIMAP_HEIGHT = 96;
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
  onActivateSession: (sessionId: string) => void;
  onViewportChange: (
    viewport: WorkspaceCanvasViewport,
    commit: boolean,
  ) => void;
  onCommitNavigation: () => void;
}

function visualRectStyle(
  rect: { x: number; y: number; width: number; height: number },
  minimumSize: number,
): CSSProperties {
  const width = Math.max(rect.width, minimumSize);
  const height = Math.max(rect.height, minimumSize);
  return {
    left: rect.x - (width - rect.width) / 2,
    top: rect.y - (height - rect.height) / 2,
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
  onActivateSession,
  onViewportChange,
  onCommitNavigation,
}: WorkspaceCanvasMinimapProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const cancelDragRef = useRef<(() => void) | null>(null);
  const layout = useMemo(
    () =>
      layoutWorkspaceCanvasMinimap(
        nodes,
        viewport,
        canvasSize,
        { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT },
      ),
    [canvasSize, nodes, viewport],
  );

  useEffect(() => () => cancelDragRef.current?.(), []);

  const pointFromClient = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const plot = plotRef.current;
    if (!plot) return null;
    const rect = plot.getBoundingClientRect();
    const renderedWidth = rect.width || MINIMAP_WIDTH;
    const renderedHeight = rect.height || MINIMAP_HEIGHT;
    return {
      x: ((clientX - rect.left) / renderedWidth) * MINIMAP_WIDTH,
      y: ((clientY - rect.top) / renderedHeight) * MINIMAP_HEIGHT,
    };
  };

  const startNavigation = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("[data-workspace-canvas-minimap-node]")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelDragRef.current?.();
    const frozenLayout = layout;
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
    if (event.target !== event.currentTarget) return;
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
      tabIndex={0}
      className="absolute bottom-3 right-3 z-30 rounded-lg border border-border bg-bg/88 p-1.5 text-fg shadow-xl backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      data-testid="workspace-canvas-minimap"
      data-workspace-canvas-toolbar
      onKeyDown={nudgeViewport}
    >
      <div className="mb-1 flex items-center justify-between px-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-fg-muted">
        <span>{title}</span>
        <span className="tabular-nums">{Math.round(viewport.zoom * 100)}%</span>
      </div>
      <div
        ref={plotRef}
        className="relative touch-none cursor-crosshair overflow-hidden rounded border border-border/80 bg-bg-sidebar/90"
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
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
          return (
            <button
              key={session.id}
              type="button"
              aria-label={sessionLabel(session.name)}
              aria-pressed={active}
              className={`absolute rounded-[2px] border transition-[background-color,border-color,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                active
                  ? "z-20 border-accent bg-accent/55 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_35%,transparent)]"
                  : "z-10 border-fg-muted/55 bg-fg-muted/25 hover:border-accent/80 hover:bg-accent/25"
              }`}
              style={visualRectStyle(rect, 4)}
              data-testid="workspace-canvas-minimap-node"
              data-workspace-canvas-minimap-node
              data-canvas-minimap-session-id={session.id}
              onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
              onClick={() => onActivateSession(session.id)}
            />
          );
        })}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-30 rounded-[2px] border border-accent/90 bg-accent/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-bg)_55%,transparent)]"
          style={visualRectStyle(layout.viewportRect, 3)}
          data-testid="workspace-canvas-minimap-viewport"
        />
      </div>
    </section>
  );
}
