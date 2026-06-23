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
  // Floating rounded accent card matching the pane chrome: inset from the
  // edges with the same corner radius, instead of a flat edge-to-edge fill.
  const base =
    "pointer-events-none absolute rounded-[var(--acorn-pane-radius)] bg-accent/15 ring-1 ring-inset ring-accent/60";
  if (zone.kind === "center") {
    return <div className={cn(base, "inset-1.5")} />;
  }
  // Edge: preview the half of the pane where the new pane will appear.
  const cls = (() => {
    if (zone.direction === "horizontal" && zone.side === "before") {
      return "left-1.5 top-1.5 bottom-1.5 w-[calc(50%-0.75rem)]";
    }
    if (zone.direction === "horizontal" && zone.side === "after") {
      return "right-1.5 top-1.5 bottom-1.5 w-[calc(50%-0.75rem)]";
    }
    if (zone.direction === "vertical" && zone.side === "before") {
      return "left-1.5 right-1.5 top-1.5 h-[calc(50%-0.75rem)]";
    }
    return "left-1.5 right-1.5 bottom-1.5 h-[calc(50%-0.75rem)]";
  })();
  return <div className={cn(base, cls)} />;
}
