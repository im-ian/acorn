import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  classifyDropZone,
  type DropZone,
  getCurrentDragPayload,
  isTabDrag,
  useTabDragInProgress,
} from "../lib/dnd";
import { useAppStore } from "../store";
import type { PaneId } from "../lib/layout";

interface PaneDropOverlayProps {
  paneId: PaneId;
}

/**
 * Edge + center drop overlay for a pane body. Renders only while a tab is
 * being dragged so it doesn't intercept normal pointer interactions. Drops
 * on edge zones split the target pane in that direction; drops on the center
 * append the moved tab into this pane.
 */
export function PaneDropOverlay({ paneId }: PaneDropOverlayProps) {
  const dragging = useTabDragInProgress();
  const moveTab = useAppStore((s) => s.moveTab);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zone, setZone] = useState<DropZone | null>(null);

  // Clear any lingering highlight when the drag ends without a dragleave
  // event firing on this overlay (e.g., dropped on a sibling pane).
  useEffect(() => {
    if (!dragging && zone) setZone(null);
  }, [dragging, zone]);

  function computeZone(e: React.DragEvent): DropZone | null {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return classifyDropZone(
      { x: e.clientX, y: e.clientY },
      rect,
    );
  }

  // Always mount so the very first dragenter into a pane body is captured;
  // toggle pointer-events so the overlay only intercepts events while a tab
  // drag is actually in progress.
  return (
    <div
      ref={containerRef}
      className={
        dragging
          ? "absolute inset-0 z-20"
          : "pointer-events-none absolute inset-0 z-20"
      }
      onDragEnter={(e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        setZone(computeZone(e));
      }}
      onDragOver={(e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const next = computeZone(e);
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
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the overlay itself, not children.
        if (e.currentTarget === e.target) setZone(null);
      }}
      onDrop={(e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        const payload = getCurrentDragPayload();
        const target = computeZone(e);
        setZone(null);
        if (!payload || !target) return;
        if (target.kind === "center") {
          if (payload.fromPaneId === paneId) return;
          moveTab({
            sessionId: payload.sessionId,
            fromPaneId: payload.fromPaneId,
            toPaneId: paneId,
          });
          return;
        }
        // Edge drop. Avoid the no-op of splitting a pane that holds only the
        // dragged tab — the source would immediately collapse.
        if (payload.fromPaneId === paneId) {
          const fromPane = useAppStore.getState().panes[paneId];
          if (fromPane && fromPane.sessionIds.length <= 1) return;
        }
        moveTab({
          sessionId: payload.sessionId,
          fromPaneId: payload.fromPaneId,
          toPaneId: paneId,
          splitDirection: target.direction,
          splitSide: target.side,
        });
      }}
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
