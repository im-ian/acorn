/**
 * Drag-and-drop session helpers for Acorn-owned tab and file payloads.
 *
 * The browser's `DataTransfer` is unreliable for custom MIME types in some
 * webviews (notably WKWebView used by Tauri on macOS): the `types` list and
 * `getData()` are restricted in "protected mode" during dragenter/dragover.
 * To work around this we mirror the payload to a module-level variable that
 * lives for the duration of the drag, while `DataTransfer` keeps its native
 * OS preview and drop affordances.
 */
import { useEffect, useState, type DragEvent } from "react";
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
let dragRevision = 0;
const listeners = new Set<() => void>();

function notify(): void {
  dragRevision += 1;
  for (const fn of listeners) fn();
}

export function beginTabDrag(
  e: DragEvent,
  payload: { tabId: string; fromPaneId: PaneId },
): void {
  beginAcornDrag(e, { kind: "tab", ...payload }, {
    effectAllowed: "move",
    text: payload.tabId,
  });
}

export function beginFileDrag(
  e: DragEvent,
  payload: { path: string },
): void {
  beginAcornDrag(e, { kind: "file", path: payload.path }, {
    effectAllowed: "copy",
  });
}

function beginAcornDrag(
  e: DragEvent,
  payload: DragPayload,
  options: { effectAllowed: DataTransfer["effectAllowed"]; text?: string },
): void {
  currentDrag = payload;
  if (options.text !== undefined) {
    try {
      e.dataTransfer.setData("text/plain", options.text);
    } catch {
      // ignore
    }
  }
  e.dataTransfer.effectAllowed = options.effectAllowed;
  notify();
}

export function endAcornDrag(): void {
  if (currentDrag === null) return;
  currentDrag = null;
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

export function isTabDrag(_e: DragEvent): boolean {
  return currentDrag?.kind === "tab";
}

export function isAcornDrag(_e: DragEvent): boolean {
  return currentDrag !== null;
}

export function useAcornDragGlobalCleanup(): void {
  useEffect(() => {
    window.addEventListener("dragend", endAcornDrag);
    window.addEventListener("drop", endAcornDrag);
    return () => {
      window.removeEventListener("dragend", endAcornDrag);
      window.removeEventListener("drop", endAcornDrag);
    };
  }, []);
}

/**
 * Tracks whether an Acorn-owned drag is currently in progress. The hook only
 * subscribes to the drag session; sources and drop targets own lifecycle
 * cleanup directly.
 */
export function useAcornDragInProgress(): boolean {
  const [, setRevision] = useState(dragRevision);

  useEffect(() => {
    function onChange() {
      setRevision(dragRevision);
    }
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return currentDrag !== null;
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
