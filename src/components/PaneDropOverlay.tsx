import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  classifyDropZone,
  endAcornDrag,
  type DropZone,
  getCurrentFilePayload,
  useAcornDragInProgress,
} from "../lib/dnd";
import { useAppStore } from "../store";
import type { PaneId } from "../lib/layout";
import {
  registerWorkspaceTabDropTarget,
  useWorkspaceTabDragSession,
  type WorkspaceTabDragPoint,
} from "../lib/workspaceTabDrag";

interface PaneDropOverlayProps {
  paneId: PaneId;
  acceptFileDrops?: boolean;
}

/**
 * Edge + center drop overlay for a pane body. Tab drops can move or split
 * panes; file drops open a code viewer tab when the pane body is allowed to
 * handle files. Terminal panes opt out so xterm can keep accepting file
 * mentions directly.
 */
export function PaneDropOverlay({
  paneId,
  acceptFileDrops = true,
}: PaneDropOverlayProps) {
  const fileDragging = useAcornDragInProgress();
  const filePayload = fileDragging ? getCurrentFilePayload() : null;
  const tabDrag = useWorkspaceTabDragSession();
  const acceptsFileDrop = acceptFileDrops && filePayload !== null;
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

  // Clear or update highlights when pointer tab drags or native file drags end
  // without firing a dragleave on this overlay.
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
    if (!filePayload && zone) setZone(null);
  }, [computeTabZone, filePayload, tabDrag, zone]);

  function computeZone(): DropZone | null {
    if (!getCurrentFilePayload()) return null;
    return { kind: "center" };
  }

  // Always mount so the very first dragenter into a pane body is captured;
  // toggle pointer-events so the overlay only intercepts drags this pane body
  // can handle.
  return (
    <div
      ref={containerRef}
      className={
        acceptsFileDrop
          ? "absolute inset-0 z-20"
          : "pointer-events-none absolute inset-0 z-20"
      }
      onDragEnter={(e) => {
        if (!acceptsFileDrop) return;
        e.preventDefault();
        setZone(computeZone());
      }}
      onDragOver={(e) => {
        if (!acceptsFileDrop) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const next = computeZone();
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
        if (!acceptsFileDrop) return;
        e.preventDefault();
        try {
          setZone(null);
          const filePayload = getCurrentFilePayload();
          if (filePayload) {
            useAppStore.getState().setFocusedPane(paneId);
            useAppStore.getState().openCodeViewerTab(filePayload.path);
            return;
          }
        } finally {
          endAcornDrag();
        }
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
