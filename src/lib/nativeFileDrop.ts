import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { hasNativeFileDropData } from "./fileDrop";
import { useFileExplorerDragSession } from "./fileExplorerDrag";
import {
  dropFilePayloadsAtPoint,
  resolveFileDropTargetAtPoint,
  type FileDropPayload,
  type FileDropPoint,
  type ResolvedFileDropTarget,
} from "./fileDropTargets";

interface NativeDropPosition extends FileDropPoint {
  toLogical?: (scaleFactor: number) => FileDropPoint;
}

interface NativePointResolution {
  point: FileDropPoint;
  target: ResolvedFileDropTarget | null;
}

export type NativeFileDropHoverTarget = ResolvedFileDropTarget;

const DOM_DRAG_POINT_MAX_AGE_MS = 500;

function toLogicalPoint(
  position: NativeDropPosition,
  scaleFactor: number,
): FileDropPoint {
  if (typeof position.toLogical === "function") {
    return position.toLogical(scaleFactor);
  }
  return {
    x: position.x / scaleFactor,
    y: position.y / scaleFactor,
  };
}

function rawPoint(position: NativeDropPosition): FileDropPoint {
  return { x: position.x, y: position.y };
}

function isViewportPoint(point: FileDropPoint): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= window.innerWidth &&
    point.y <= window.innerHeight
  );
}

function samePoint(a: FileDropPoint, b: FileDropPoint): boolean {
  return Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

function uniquePoints(points: FileDropPoint[]): FileDropPoint[] {
  const result: FileDropPoint[] = [];
  for (const point of points) {
    if (result.some((candidate) => samePoint(candidate, point))) continue;
    result.push(point);
  }
  return result;
}

function nativePayloads(paths: string[]): FileDropPayload[] {
  return paths
    .filter(Boolean)
    .map((path) => ({ path, entryKind: "unknown", source: "native" }));
}

function resolveNativePoint(
  position: NativeDropPosition,
  scaleFactor: number,
  payload: FileDropPayload,
  domPoint: FileDropPoint | null,
): NativePointResolution {
  const candidates = uniquePoints([
    ...(domPoint ? [domPoint] : []),
    toLogicalPoint(position, scaleFactor),
    rawPoint(position),
  ]).filter(isViewportPoint);

  for (const point of candidates) {
    const target = resolveFileDropTargetAtPoint(point, payload);
    if (target) return { point, target };
  }

  return { point: candidates[0] ?? toLogicalPoint(position, scaleFactor), target: null };
}

export function useNativeFileDropBridge(): NativeFileDropHoverTarget | null {
  const fileExplorerDrag = useFileExplorerDragSession();
  const [hoverTarget, setHoverTarget] =
    useState<NativeFileDropHoverTarget | null>(null);

  useEffect(() => {
    if (fileExplorerDrag) setHoverTarget(null);
  }, [fileExplorerDrag]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    let scaleFactor = window.devicePixelRatio || 1;
    let unlisten: (() => void) | null = null;
    let currentNativePaths: string[] = [];
    let lastDomDragPoint: { point: FileDropPoint; at: number } | null = null;

    function currentDomDragPoint(): FileDropPoint | null {
      if (!lastDomDragPoint) return null;
      if (performance.now() - lastDomDragPoint.at > DOM_DRAG_POINT_MAX_AGE_MS) {
        return null;
      }
      return lastDomDragPoint.point;
    }

    function onDomDragOver(event: DragEvent): void {
      if (!hasNativeFileDropData(event.dataTransfer)) return;
      lastDomDragPoint = {
        point: { x: event.clientX, y: event.clientY },
        at: performance.now(),
      };
    }

    window.addEventListener("dragover", onDomDragOver, true);

    void getCurrentWindow()
      .scaleFactor()
      .then((factor) => {
        if (!disposed && Number.isFinite(factor) && factor > 0) {
          scaleFactor = factor;
        }
      })
      .catch((err: unknown) => {
        console.debug("[nativeFileDrop] scale factor probe failed", err);
      });

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        if (event.payload.type === "leave") {
          currentNativePaths = [];
          setHoverTarget(null);
          return;
        }
        if (event.payload.type === "enter") {
          currentNativePaths = event.payload.paths;
        }
        if (event.payload.type === "enter" || event.payload.type === "over") {
          const firstPayload = nativePayloads(currentNativePaths)[0];
          if (!firstPayload) {
            setHoverTarget(null);
            return;
          }
          const resolved = resolveNativePoint(
            event.payload.position as NativeDropPosition,
            scaleFactor,
            firstPayload,
            currentDomDragPoint(),
          );
          setHoverTarget(resolved.target);
          return;
        }
        if (event.payload.type !== "drop") return;

        setHoverTarget(null);
        currentNativePaths = [];
        const payloads = nativePayloads(event.payload.paths);
        const firstPayload = payloads[0];
        if (!firstPayload) return;

        const resolved = resolveNativePoint(
          event.payload.position as NativeDropPosition,
          scaleFactor,
          firstPayload,
          currentDomDragPoint(),
        );
        if (!resolved.target) return;
        dropFilePayloadsAtPoint(resolved.point, payloads);
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      })
      .catch((err: unknown) => {
        console.error("[nativeFileDrop] listener setup failed", err);
      });

    return () => {
      disposed = true;
      window.removeEventListener("dragover", onDomDragOver, true);
      unlisten?.();
    };
  }, []);

  return hoverTarget;
}
