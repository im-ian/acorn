import { useEffect, useState } from "react";
import type { PaneId } from "./layout";

export interface WorkspaceTabDragPayload {
  tabId: string;
  fromPaneId: PaneId;
}

export interface WorkspaceTabDragPoint {
  x: number;
  y: number;
}

export interface WorkspaceTabDragRect {
  width: number;
  height: number;
}

export interface WorkspaceTabDragSession {
  payload: WorkspaceTabDragPayload;
  title: string;
  pointer: WorkspaceTabDragPoint;
  offset: WorkspaceTabDragPoint;
  sourceRect: WorkspaceTabDragRect;
}

interface WorkspaceTabDropTarget {
  id: string;
  priority: number;
  getRect: () => DOMRect | null;
  onDrop: (
    payload: WorkspaceTabDragPayload,
    point: WorkspaceTabDragPoint,
  ) => void;
}

let currentDrag: WorkspaceTabDragSession | null = null;
let dragRevision = 0;
const listeners = new Set<() => void>();
const dropTargets = new Map<string, WorkspaceTabDropTarget>();

function notify(): void {
  dragRevision += 1;
  for (const fn of listeners) fn();
}

function containsPoint(rect: DOMRect, point: WorkspaceTabDragPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

export function beginWorkspaceTabDrag(session: WorkspaceTabDragSession): void {
  currentDrag = session;
  notify();
}

export function updateWorkspaceTabDrag(point: WorkspaceTabDragPoint): void {
  if (!currentDrag) return;
  if (currentDrag.pointer.x === point.x && currentDrag.pointer.y === point.y) {
    return;
  }
  currentDrag = { ...currentDrag, pointer: point };
  notify();
}

export function cancelWorkspaceTabDrag(): void {
  if (!currentDrag) return;
  currentDrag = null;
  notify();
}

export function finishWorkspaceTabDrag(point?: WorkspaceTabDragPoint): void {
  const session = currentDrag;
  if (!session) return;
  const dropPoint = point ?? session.pointer;
  const targets = [...dropTargets.values()].sort(
    (a, b) => b.priority - a.priority,
  );

  currentDrag = null;
  notify();

  for (const target of targets) {
    const rect = target.getRect();
    if (!rect || !containsPoint(rect, dropPoint)) continue;
    target.onDrop(session.payload, dropPoint);
    return;
  }
}

export function getWorkspaceTabDragSession(): WorkspaceTabDragSession | null {
  return currentDrag;
}

export function registerWorkspaceTabDropTarget(
  target: WorkspaceTabDropTarget,
): () => void {
  dropTargets.set(target.id, target);
  return () => {
    const current = dropTargets.get(target.id);
    if (current === target) dropTargets.delete(target.id);
  };
}

export function useWorkspaceTabDragSession(): WorkspaceTabDragSession | null {
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

  return currentDrag;
}
