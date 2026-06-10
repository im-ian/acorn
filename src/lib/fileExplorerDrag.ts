import { useEffect, useState } from "react";
import {
  dropFilePayloadsAtPoint,
  getFileDropTargetRevision,
  resolveFileDropTargetAtPoint,
  subscribeFileDropTargetChanges,
  type FileDropPayload,
  type FileDropPoint,
  type ResolvedFileDropTarget,
} from "./fileDropTargets";

export interface FileExplorerDragSession {
  payload: FileDropPayload;
  pointer: FileDropPoint;
}

let currentDrag: FileExplorerDragSession | null = null;
let dragRevision = 0;
const dragListeners = new Set<() => void>();

function notifyDragChanged(): void {
  dragRevision += 1;
  for (const fn of dragListeners) fn();
}

export function beginFileExplorerDrag(session: FileExplorerDragSession): void {
  currentDrag = session;
  notifyDragChanged();
}

export function updateFileExplorerDrag(point: FileDropPoint): void {
  if (!currentDrag) return;
  if (currentDrag.pointer.x === point.x && currentDrag.pointer.y === point.y) {
    return;
  }
  currentDrag = { ...currentDrag, pointer: point };
  notifyDragChanged();
}

export function cancelFileExplorerDrag(): void {
  if (!currentDrag) return;
  currentDrag = null;
  notifyDragChanged();
}

export function finishFileExplorerDrag(point?: FileDropPoint): void {
  const session = currentDrag;
  if (!session) return;
  const dropPoint = point ?? session.pointer;
  currentDrag = null;
  notifyDragChanged();
  dropFilePayloadsAtPoint(dropPoint, [session.payload]);
}

export function getFileExplorerDragSession(): FileExplorerDragSession | null {
  return currentDrag;
}

export function useFileExplorerDragSession(): FileExplorerDragSession | null {
  const [, setRevision] = useState(dragRevision);

  useEffect(() => {
    function onChange() {
      setRevision(dragRevision);
    }
    dragListeners.add(onChange);
    return () => {
      dragListeners.delete(onChange);
    };
  }, []);

  return currentDrag;
}

export function useFileExplorerDragHoverTarget():
  | ResolvedFileDropTarget
  | null {
  const session = useFileExplorerDragSession();
  const [, setTargetRevision] = useState(getFileDropTargetRevision());

  useEffect(() => {
    return subscribeFileDropTargetChanges(() => {
      setTargetRevision(getFileDropTargetRevision());
    });
  }, []);

  if (!session) return null;
  return resolveFileDropTargetAtPoint(session.pointer, session.payload);
}
