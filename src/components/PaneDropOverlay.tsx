import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { classifyDropZone, type DropZone } from "../lib/dnd";
import { useAppStore } from "../store";
import type { PaneId } from "../lib/layout";
import {
  registerWorkspaceTabDropTarget,
  useWorkspaceTabDragSession,
  type WorkspaceTabDragPoint,
} from "../lib/workspaceTabDrag";

interface PaneDropOverlayProps {
  paneId: PaneId;
}

/**
 * Edge + center drop overlay for a pane body. Tab drops can move or split
 * panes. File drops are handled through the file drop target registry so
 * native OS drags and right-panel file drags share the same hit testing.
 */
export function PaneDropOverlay({ paneId }: PaneDropOverlayProps) {
  const tabDrag = useWorkspaceTabDragSession();
  const moveTab = useAppStore((s) => s.moveTab);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);

  const computeTabZone = useCallback(
    (point: WorkspaceTabDragPoint): DropZone | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (
        point.x < rect.left ||
        point.x > rect.right ||
        point.y < rect.top ||
        point.y > rect.bottom
      ) {
        return null;
      }
      return classifyDropZone(point, rect);
    },
    [],
  );

  useEffect(() => {
    return registerWorkspaceTabDropTarget({
      id: `pane-body:${paneId}`,
      priority: 10,
      getRect: () => containerRef.current?.getBoundingClientRect() ?? null,
      onDrop: (payload, point) => {
        const target = computeTabZone(point);
        if (!target) return;
        if (target.kind === "center") {
          if (payload.fromPaneId === paneId) return;
          moveTab({
            tabId: payload.tabId,
            fromPaneId: payload.fromPaneId,
            toPaneId: paneId,
          });
          return;
        }
        if (payload.fromPaneId === paneId) {
          const fromPane = useAppStore.getState().panes[paneId];
          if (fromPane && fromPane.tabIds.length <= 1) return;
        }
        moveTab({
          tabId: payload.tabId,
          fromPaneId: payload.fromPaneId,
          toPaneId: paneId,
          splitDirection: target.direction,
          splitSide: target.side,
        });
      },
    });
  }, [computeTabZone, moveTab, paneId]);

  // Clear or update highlights when pointer tab drags end.
  useEffect(() => {
    if (tabDrag) {
      const next = computeTabZone(tabDrag.pointer);
      if (
        !zone ||
        !next ||
        zone.kind !== next.kind ||
        (zone.kind === "edge" &&
          next.kind === "edge" &&
          (zone.direction !== next.direction || zone.side !== next.side))
      ) {
        setZone(next);
      }
      return;
    }
    if (zone) setZone(null);
  }, [computeTabZone, tabDrag, zone]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 z-20"
    >
      <ZoneHighlight zone={zone} />
    </div>
  );
}

function ZoneHighlight({ zone }: { zone: DropZone | null }) {
  if (!zone) return null;
  if (zone.kind === "center") {
    return (
      <div className="pointer-events-none absolute inset-0 bg-accent/15 ring-2 ring-inset ring-accent/60" />
    );
  }
  // Edge: highlight the half of the pane where the new pane will appear.
  const cls = (() => {
    if (zone.direction === "horizontal" && zone.side === "before") {
      return "left-0 top-0 h-full w-1/2";
    }
    if (zone.direction === "horizontal" && zone.side === "after") {
      return "right-0 top-0 h-full w-1/2";
    }
    if (zone.direction === "vertical" && zone.side === "before") {
      return "left-0 top-0 h-1/2 w-full";
    }
    return "left-0 bottom-0 h-1/2 w-full";
  })();
  return (
    <div
      className={cn(
        "pointer-events-none absolute bg-accent/20 ring-2 ring-inset ring-accent/70",
        cls,
      )}
    />
  );
}
