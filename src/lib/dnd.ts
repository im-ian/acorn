/**
 * Drag-and-drop helpers for moving workspace tabs between panes.
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
  kind: "tab";
  tabId: string;
  fromPaneId: PaneId;
}

export interface FileDragPayload {
  kind: "file";
  path: string;
}

export type DragPayload = TabDragPayload | FileDragPayload;

let currentDrag: DragPayload | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function setTabDragPayload(
  e: React.DragEvent,
  payload: { tabId: string; fromPaneId: PaneId },
): void {
  currentDrag = { kind: "tab", ...payload };
  try {
    e.dataTransfer.setData("text/plain", payload.tabId);
  } catch {
    // ignore
  }
  e.dataTransfer.effectAllowed = "move";
  notify();
}

export function setFileDragPayload(
  e: React.DragEvent,
  payload: { path: string },
): void {
  currentDrag = { kind: "file", path: payload.path };
  e.dataTransfer.effectAllowed = "copy";
  notify();
}

export function getCurrentDragPayload(): DragPayload | null {
  return currentDrag;
}

export function getCurrentTabPayload(): TabDragPayload | null {
  return currentDrag?.kind === "tab" ? currentDrag : null;
}

export function getCurrentFilePayload(): FileDragPayload | null {
  return currentDrag?.kind === "file" ? currentDrag : null;
}

export function clearTabDragPayload(): void {
  if (currentDrag === null) return;
  currentDrag = null;
  notify();
}

export function isTabDrag(_e: React.DragEvent): boolean {
  return currentDrag?.kind === "tab";
}

export function isFileDrag(_e: React.DragEvent): boolean {
  return currentDrag?.kind === "file";
}

export function isAcornDrag(_e: React.DragEvent): boolean {
  return currentDrag !== null;
}

/**
 * Tracks whether a tab drag is currently in progress anywhere on the page.
 * Used by drop overlays to render and intercept pointer events only during
 * an active drag. Backed by a module-level signal updated synchronously
 * inside `setTabDragPayload` and on window-level dragend / drop.
 */
export function useAcornDragInProgress(): boolean {
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

export function useTabDragInProgress(): boolean {
  const [active, setActive] = useState<boolean>(
    () => currentDrag?.kind === "tab",
  );

  useEffect(() => {
    function onChange() {
      setActive(currentDrag?.kind === "tab");
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
