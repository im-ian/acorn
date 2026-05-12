/**
 * Drag-and-drop helpers for moving session tabs between panes.
 *
 * The browser's `DataTransfer` is unreliable for custom MIME types in some
 * webviews (notably WKWebView used by Tauri on macOS): the `types` list and
 * `getData()` are restricted in "protected mode" during dragenter/dragover.
 * To work around this we mirror the payload to a module-level variable that
 * lives for the duration of the drag, and use `text/plain` on the
 * `DataTransfer` only as a fallback / OS preview affordance.
 */
import { useEffect, useState } from "react";
import type { Direction, PaneId, SplitSide } from "./layout";

export interface TabDragPayload {
  sessionId: string;
  fromPaneId: PaneId;
}

let currentDrag: TabDragPayload | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function setTabDragPayload(
  e: React.DragEvent,
  payload: TabDragPayload,
): void {
  currentDrag = payload;
  // Some webviews refuse `setData` during dragstart; guard so the drag
  // still works via the module-level mirror even if this fails.
  try {
    e.dataTransfer.setData("text/plain", payload.sessionId);
  } catch {
    // ignore
  }
  e.dataTransfer.effectAllowed = "move";
  notify();
}

export function getCurrentDragPayload(): TabDragPayload | null {
  return currentDrag;
}

export function clearTabDragPayload(): void {
  if (currentDrag === null) return;
  currentDrag = null;
  notify();
}

export function isTabDrag(_e: React.DragEvent): boolean {
  return currentDrag !== null;
}

/**
 * Tracks whether a tab drag is currently in progress anywhere on the page.
 * Used by drop overlays to render and intercept pointer events only during
 * an active drag. Backed by a module-level signal updated synchronously
 * inside `setTabDragPayload` and on window-level dragend / drop.
 */
export function useTabDragInProgress(): boolean {
  const [active, setActive] = useState<boolean>(() => currentDrag !== null);

  useEffect(() => {
    function onChange() {
      setActive(currentDrag !== null);
    }
    listeners.add(onChange);
    function onEnd() {
      clearTabDragPayload();
    }
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
    };
  }, []);

  return active;
}

/**
 * Drop zone classification based on pointer position relative to a rectangle.
 * Edge zones occupy a pixel-based band on each side (clamped so they never
 * exceed ~40% of the smaller pane dimension); the center zone is everything
 * else. Pixel-based thresholds feel consistent across narrow split panes and
 * wide single panes — a fixed percentage made narrow panes nearly all-center.
 */
export type DropZone =
  | { kind: "center" }
  | { kind: "edge"; direction: Direction; side: SplitSide };

const EDGE_PX = 64;
const EDGE_MAX_FRACTION = 0.4;

export function classifyDropZone(
  pointer: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
): DropZone {
  const distLeft = pointer.x - rect.left;
  const distRight = rect.left + rect.width - pointer.x;
  const distTop = pointer.y - rect.top;
  const distBottom = rect.top + rect.height - pointer.y;
  const minDist = Math.min(distLeft, distRight, distTop, distBottom);

  const thresholdX = Math.min(EDGE_PX, rect.width * EDGE_MAX_FRACTION);
  const thresholdY = Math.min(EDGE_PX, rect.height * EDGE_MAX_FRACTION);

  const isHorizontalEdge =
    (minDist === distLeft || minDist === distRight) && minDist < thresholdX;
  const isVerticalEdge =
    (minDist === distTop || minDist === distBottom) && minDist < thresholdY;

  if (!isHorizontalEdge && !isVerticalEdge) return { kind: "center" };

  if (minDist === distLeft) {
    return { kind: "edge", direction: "horizontal", side: "before" };
  }
  if (minDist === distRight) {
    return { kind: "edge", direction: "horizontal", side: "after" };
  }
  if (minDist === distTop) {
    return { kind: "edge", direction: "vertical", side: "before" };
  }
  return { kind: "edge", direction: "vertical", side: "after" };
}
