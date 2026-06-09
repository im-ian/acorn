import { api } from "./api";
import { resolveSessionAgentProvider } from "./agentProvider";
import { formatTerminalFileMention } from "./fileMention";
import type { PaneId } from "./layout";
import { visibleMultiInputSessionIds } from "./multiInput";
import type { SessionAgentProvider } from "./types";
import { useAppStore } from "../store";

export type FileDropEntryKind = "file" | "directory" | "unknown";
export type FileDropSource = "explorer" | "native";
export type FileDropPurpose = "preview" | "terminal" | "tab";

export interface FileDropPayload {
  path: string;
  entryKind: FileDropEntryKind;
  source: FileDropSource;
}

export interface FileDropPoint {
  x: number;
  y: number;
}

export interface FileDropRectSnapshot {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ResolvedFileDropTarget =
  | {
      kind: "tab-strip";
      purpose: "tab";
      paneId: PaneId;
      path?: string;
      rect: FileDropRectSnapshot;
    }
  | {
      kind: "pane-body";
      purpose: "preview" | "terminal";
      paneId: PaneId;
      path?: string;
      rect: FileDropRectSnapshot;
    };

interface FileDropTargetRegistration {
  id: string;
  priority: number;
  getRect: () => DOMRect | null;
  resolve: (
    payload: FileDropPayload,
    point: FileDropPoint,
    rect: DOMRect,
  ) => ResolvedFileDropTarget | null;
}

interface TerminalDropTarget {
  sessionId: string;
  cwd: string;
  agentProvider: SessionAgentProvider | null;
}

const dropTargets = new Map<string, FileDropTargetRegistration>();
let targetRevision = 0;
const targetListeners = new Set<() => void>();

function notifyTargetsChanged(): void {
  targetRevision += 1;
  for (const fn of targetListeners) fn();
}

function rectSnapshot(rect: DOMRect): FileDropRectSnapshot {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function containsPoint(rect: DOMRect, point: FileDropPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function isOpenable(payload: FileDropPayload): boolean {
  return payload.entryKind !== "directory";
}

function terminalDropTargetForPane(paneId: PaneId): TerminalDropTarget | null {
  const state = useAppStore.getState();
  const activeTabId = state.panes[paneId]?.activeTabId;
  if (!activeTabId) return null;
  const session = state.sessions.find((candidate) => candidate.id === activeTabId);
  if (!session || session.mode === "chat") return null;
  return {
    sessionId: session.id,
    cwd: session.worktree_path,
    agentProvider: resolveSessionAgentProvider(session),
  };
}

function ptyWriteTargets(primarySessionId: string): string[] {
  const state = useAppStore.getState();
  const targets = state.multiInputEnabled
    ? visibleMultiInputSessionIds(state.panes)
    : [primarySessionId];
  return targets.length > 0 ? targets : [primarySessionId];
}

function writePayloadsToTerminal(
  target: TerminalDropTarget,
  payloads: FileDropPayload[],
): void {
  const data = payloads
    .filter((payload) => payload.path)
    .map((payload) =>
      formatTerminalFileMention(payload.path, target.cwd, {
        agentProvider: target.agentProvider,
      }),
    )
    .join("");
  if (!data) return;

  for (const sessionId of ptyWriteTargets(target.sessionId)) {
    void api.ptyWrite(sessionId, data).catch((err: unknown) => {
      console.error("[fileDropTargets] pty_write failed", err);
    });
  }
}

async function openPayloadsInPane(
  paneId: PaneId,
  payloads: FileDropPayload[],
): Promise<void> {
  const openable = payloads.filter((payload) => payload.path && isOpenable(payload));
  if (openable.length === 0) return;

  const store = useAppStore.getState();
  store.setFocusedPane(paneId);
  for (const payload of openable) {
    if (payload.source === "native") {
      await api.fsGrantExternalFile(payload.path);
    }
    useAppStore.getState().openCodeViewerTab(payload.path);
  }
}

export function registerFileDropTarget(
  target: FileDropTargetRegistration,
): () => void {
  dropTargets.set(target.id, target);
  notifyTargetsChanged();
  return () => {
    const current = dropTargets.get(target.id);
    if (current === target) {
      dropTargets.delete(target.id);
      notifyTargetsChanged();
    }
  };
}

export function registerTabStripFileDropTarget(
  paneId: PaneId,
  getRect: () => DOMRect | null,
): () => void {
  return registerFileDropTarget({
    id: `file-tab-strip:${paneId}`,
    priority: 30,
    getRect,
    resolve: (payload, _point, rect) => {
      if (!isOpenable(payload)) return null;
      return {
        kind: "tab-strip",
        purpose: "tab",
        paneId,
        path: payload.path,
        rect: rectSnapshot(rect),
      };
    },
  });
}

export function registerPaneBodyFileDropTarget(
  paneId: PaneId,
  getRect: () => DOMRect | null,
): () => void {
  return registerFileDropTarget({
    id: `file-pane-body:${paneId}`,
    priority: 10,
    getRect,
    resolve: (payload, _point, rect) => {
      const terminalTarget = terminalDropTargetForPane(paneId);
      if (terminalTarget) {
        return {
          kind: "pane-body",
          purpose: "terminal",
          paneId,
          path: payload.path,
          rect: rectSnapshot(rect),
        };
      }
      if (!isOpenable(payload)) return null;
      return {
        kind: "pane-body",
        purpose: "preview",
        paneId,
        path: payload.path,
        rect: rectSnapshot(rect),
      };
    },
  });
}

export function resolveFileDropTargetAtPoint(
  point: FileDropPoint,
  payload: FileDropPayload,
): ResolvedFileDropTarget | null {
  const targets = [...dropTargets.values()].sort(
    (a, b) => b.priority - a.priority,
  );
  for (const target of targets) {
    const rect = target.getRect();
    if (!rect || !containsPoint(rect, point)) continue;
    const resolved = target.resolve(payload, point, rect);
    if (resolved) return resolved;
  }
  return null;
}

export function applyFileDropTarget(
  target: ResolvedFileDropTarget,
  payloads: FileDropPayload[],
): void {
  if (target.kind === "pane-body" && target.purpose === "terminal") {
    const terminalTarget = terminalDropTargetForPane(target.paneId);
    if (!terminalTarget) return;
    useAppStore.getState().setFocusedPane(target.paneId);
    writePayloadsToTerminal(terminalTarget, payloads);
    return;
  }

  void openPayloadsInPane(target.paneId, payloads).catch((err: unknown) => {
    console.error("[fileDropTargets] file open failed", err);
  });
}

export function dropFilePayloadsAtPoint(
  point: FileDropPoint,
  payloads: FileDropPayload[],
): ResolvedFileDropTarget | null {
  const first = payloads[0];
  if (!first) return null;
  const target = resolveFileDropTargetAtPoint(point, first);
  if (!target) return null;
  applyFileDropTarget(target, payloads);
  return target;
}

export function getFileDropTargetRevision(): number {
  return targetRevision;
}

export function subscribeFileDropTargetChanges(fn: () => void): () => void {
  targetListeners.add(fn);
  return () => {
    targetListeners.delete(fn);
  };
}

export function clearFileDropTargetsForTest(): void {
  dropTargets.clear();
  notifyTargetsChanged();
}
