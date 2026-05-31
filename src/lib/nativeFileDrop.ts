import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { api } from "./api";
import { formatTerminalFileMention } from "./fileMention";
import { visibleMultiInputSessionIds } from "./multiInput";
import { useAppStore } from "../store";

interface DropPoint {
  x: number;
  y: number;
}

interface NativeDropPosition extends DropPoint {
  toLogical?: (scaleFactor: number) => DropPoint;
}

interface TerminalDropTarget {
  sessionId: string;
  cwd: string;
}

function toLogicalPoint(
  position: NativeDropPosition,
  scaleFactor: number,
): DropPoint {
  if (typeof position.toLogical === "function") {
    return position.toLogical(scaleFactor);
  }
  return {
    x: position.x / scaleFactor,
    y: position.y / scaleFactor,
  };
}

export function terminalDropTargetAtPoint(
  point: DropPoint,
): TerminalDropTarget | null {
  const element = document.elementFromPoint(
    point.x,
    point.y,
  ) as HTMLElement | null;
  const slot = element?.closest<HTMLElement>("[data-acorn-terminal-slot]");
  if (!slot?.dataset.acornTerminalSlot) return null;
  if (!slot.closest("[data-pane-body]")) return null;

  const sessionId = slot.dataset.acornTerminalSlot;
  const session = useAppStore
    .getState()
    .sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  return { sessionId, cwd: session.worktree_path };
}

function ptyWriteTargets(primarySessionId: string): string[] {
  const state = useAppStore.getState();
  const targets = state.multiInputEnabled
    ? visibleMultiInputSessionIds(state.panes)
    : [primarySessionId];
  return targets.length > 0 ? targets : [primarySessionId];
}

function writePathsToTerminal(target: TerminalDropTarget, paths: string[]): void {
  if (paths.length === 0) return;
  const data = paths
    .map((path) => formatTerminalFileMention(path, target.cwd))
    .join("");
  for (const sessionId of ptyWriteTargets(target.sessionId)) {
    void api.ptyWrite(sessionId, data).catch((err: unknown) => {
      console.error("[nativeFileDrop] pty_write failed", err);
    });
  }
}

export function useNativeFileDropTerminalBridge(): void {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let disposed = false;
    let scaleFactor = window.devicePixelRatio || 1;
    let unlisten: (() => void) | null = null;

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
        if (disposed || event.payload.type !== "drop") return;
        const point = toLogicalPoint(
          event.payload.position as NativeDropPosition,
          scaleFactor,
        );
        const target = terminalDropTargetAtPoint(point);
        if (!target) return;
        writePathsToTerminal(target, event.payload.paths);
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
      unlisten?.();
    };
  }, []);
}
