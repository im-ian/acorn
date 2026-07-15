import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveSessionAgentProvider } from "../lib/agentProvider";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import { getTerminalLimbo } from "../lib/terminalLimbo";
import { isSessionInFocusedPane } from "../lib/multiInput";
import { findProjectFolderById } from "../lib/projectFolders";
import { markTerminalDetaching } from "../lib/terminalDetach";
import { selectTerminalsToEvict } from "../lib/terminalEviction";
import { useAppStore } from "../store";
import type { Session } from "../lib/types";
import { Terminal } from "./Terminal";

/**
 * Lazily renders terminals at the App level so xterm + PTY state survives
 * pane and project switches after a session has been shown once. Persisted
 * sessions that are not visible stay unmounted at boot; mounting every saved
 * tab would otherwise respawn every shell and restore every scrollback file at
 * the same time.
 *
 * Each terminal is portaled into a per-session "target div" that we
 * `appendChild`-move between pane bodies (when a pane is showing the
 * session) and a hidden limbo container (when nothing is showing it). The
 * div's identity stays the same throughout, so React's portal preserves
 * the Terminal subtree without ever remounting it.
 */
export function TerminalHost() {
  const sessions = useAppStore((s) => s.sessions);
  const maxMountedTerminals = useSettings(
    (s) => s.settings.terminal.maxMountedTerminals,
  );
  const detachOffscreenTerminals = useSettings(
    (s) => s.settings.terminal.detachOffscreenTerminals,
  );
  const visibleSessionIdKey = useAppStore(visibleTerminalSessionIdKey);
  const visibleSessionIds = useMemo(
    () => parseSessionIdKey(visibleSessionIdKey),
    [visibleSessionIdKey],
  );
  const [mountedSessionIds, setMountedSessionIds] = useState<Set<string>>(
    () => visibleSessionIds,
  );
  const terminalSessionIds = useMemo(
    () =>
      new Set(sessions.filter((s) => s.mode !== "chat").map((s) => s.id)),
    [sessions],
  );

  useEffect(() => {
    setMountedSessionIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (terminalSessionIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      for (const id of visibleSessionIds) {
        if (!terminalSessionIds.has(id)) continue;
        if (!next.has(id)) changed = true;
        next.add(id);
      }
      return changed || next.size !== current.size ? next : current;
    });
  }, [terminalSessionIds, visibleSessionIds]);

  // Mounted session ids ordered least-recently-visible → most-recent. Drives
  // which terminals the eviction policy sheds first when over the mount cap.
  const recencyRef = useRef<string[]>([]);
  const daemonEvictionProbeRef = useRef<
    ReturnType<typeof api.daemonListSessions> | null
  >(null);
  useEffect(() => {
    const next = recencyRef.current.filter((id) => terminalSessionIds.has(id));
    for (const id of visibleSessionIds) {
      if (!terminalSessionIds.has(id)) continue;
      const at = next.indexOf(id);
      if (at !== -1) next.splice(at, 1);
      next.push(id);
    }
    recencyRef.current = next;
  }, [terminalSessionIds, visibleSessionIds]);

  // When more terminals are mounted than the cap allows, detach the
  // least-recently-visible off-screen *daemon* sessions to reclaim their xterm
  // buffers. In-process sessions cannot be re-attached after a detach, so we
  // confirm the alive daemon set before choosing victims and never evict
  // anything outside it. Runs only while over the cap, so steady state costs
  // nothing.
  useEffect(() => {
    if (!detachOffscreenTerminals) return;
    const cap = Math.max(maxMountedTerminals, visibleSessionIds.size);
    if (mountedSessionIds.size <= cap) return;
    let cancelled = false;
    void (async () => {
      let daemonAlive: Set<string>;
      try {
        let probe = daemonEvictionProbeRef.current;
        if (!probe) {
          const promise = api.daemonListSessions().finally(() => {
            if (daemonEvictionProbeRef.current === promise) {
              daemonEvictionProbeRef.current = null;
            }
          });
          daemonEvictionProbeRef.current = promise;
          probe = promise;
        }
        const summaries = await probe;
        daemonAlive = new Set(
          summaries.filter((s) => s.alive).map((s) => s.id),
        );
      } catch {
        // Cannot confirm evictability — leave terminals mounted rather than
        // risk killing a live in-process shell.
        return;
      }
      if (cancelled) return;
      const victims = selectTerminalsToEvict({
        mounted: [...mountedSessionIds],
        visible: visibleSessionIds,
        recency: recencyRef.current,
        daemonAlive,
        max: cap,
      });
      if (victims.length === 0) return;
      // Mark before unmounting so each Terminal's cleanup detaches (keeping the
      // daemon shell alive) instead of killing it.
      for (const id of victims) markTerminalDetaching(id);
      setMountedSessionIds((current) => {
        let changed = false;
        const next = new Set(current);
        for (const id of victims) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : current;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    detachOffscreenTerminals,
    maxMountedTerminals,
    mountedSessionIds,
    visibleSessionIds,
  ]);

  return (
    <>
      {sessions
        .filter(
          (s) =>
            s.mode !== "chat" &&
            (mountedSessionIds.has(s.id) || visibleSessionIds.has(s.id)),
        )
        .map((s) => (
          <PortaledTerminal key={s.id} session={s} />
        ))}
    </>
  );
}

const SESSION_ID_KEY_SEPARATOR = "\u0000";

type AppStateSnapshot = ReturnType<typeof useAppStore.getState>;

interface TerminalWorkspaceContext {
  id: string;
  name: string;
  path: string;
}

function visibleTerminalSessionIdKey(state: AppStateSnapshot): string {
  const workspaceId = activeWorkspaceId(state);
  const ids: string[] = [];
  if (workspaceId) {
    const ws = state.workspaces[workspaceId];
    if (ws) {
      ids.push(
        ...Object.values(ws.panes)
          .flatMap((pane) =>
            state.workspaceViewMode === "canvas"
              ? pane.tabIds
              : [pane.activeTabId],
          )
          .filter((id): id is string => Boolean(id)),
      );
    }
  }
  if (state.terminalPopupSessionId) ids.push(state.terminalPopupSessionId);
  return [...new Set(ids)].sort().join(SESSION_ID_KEY_SEPARATOR);
}

function visibleTerminalTargetKey(
  state: AppStateSnapshot,
  sessionId: string,
): string | null {
  if (state.terminalPopupSessionId === sessionId) {
    return `popover:${sessionId}`;
  }
  const workspaceId = activeWorkspaceId(state);
  if (!workspaceId) return null;
  const ws = state.workspaces[workspaceId];
  if (!ws) return null;
  if (
    state.workspaceViewMode === "canvas" &&
    Object.values(ws.panes).some((pane) => pane.tabIds.includes(sessionId))
  ) {
    return `canvas:${sessionId}`;
  }
  for (const pane of Object.values(ws.panes)) {
    if (pane.activeTabId === sessionId) return `pane:${pane.id}`;
  }
  return null;
}

function terminalDestinationForTargetKey(
  targetKey: string | null,
): HTMLElement | null {
  if (!targetKey) return null;
  if (targetKey.startsWith("popover:")) {
    const sessionId = targetKey.slice("popover:".length);
    return document.querySelector(
      `[data-terminal-popover-body="${cssEscape(sessionId)}"]`,
    ) as HTMLElement | null;
  }
  if (targetKey.startsWith("canvas:")) {
    const sessionId = targetKey.slice("canvas:".length);
    return document.querySelector(
      `[data-canvas-terminal-body="${cssEscape(sessionId)}"]`,
    ) as HTMLElement | null;
  }
  if (targetKey.startsWith("pane:")) {
    const paneId = targetKey.slice("pane:".length);
    return document.querySelector(
      `[data-pane-body="${cssEscape(paneId)}"]`,
    ) as HTMLElement | null;
  }
  return null;
}

function terminalTargetIsPopover(targetKey: string | null): boolean {
  return Boolean(targetKey?.startsWith("popover:"));
}

function terminalTargetIsCanvas(targetKey: string | null): boolean {
  return Boolean(targetKey?.startsWith("canvas:"));
}

function terminalTargetNeedsDomRetry(targetKey: string | null): boolean {
  return terminalTargetIsPopover(targetKey) || terminalTargetIsCanvas(targetKey);
}

function parseSessionIdKey(key: string): Set<string> {
  if (!key) return new Set();
  return new Set(key.split(SESSION_ID_KEY_SEPARATOR));
}

function PortaledTerminal({ session }: { session: Session }) {
  // Stable target div for this session. Created lazily once and never
  // replaced — moved between DOM parents via direct appendChild instead.
  const targetRef = useRef<HTMLDivElement | null>(null);
  if (!targetRef.current) {
    const el = document.createElement("div");
    el.dataset.acornTerminalSlot = session.id;
    el.style.position = "absolute";
    el.style.inset = "0";
    targetRef.current = el;
  }

  const visibleTargetKey = useAppStore((state) =>
    visibleTerminalTargetKey(state, session.id),
  );

  // The workspace layout reference. Splits/merges replace the layout node, so
  // a new reference signals that pane DOM bodies were remounted — even when
  // the visible target is unchanged. Without this dep the reattach effect
  // skips re-running and the terminal target stays detached from the new body.
  const layoutRef = useAppStore((state) =>
    activeWorkspaceId(state)
      ? state.workspaces[activeWorkspaceId(state)!]?.layout ?? null
      : null,
  );
  const isFocusedPane = useAppStore((state) =>
    terminalTargetIsPopover(visibleTargetKey)
      ? true
      : terminalTargetIsCanvas(visibleTargetKey)
        ? state.activeSessionId === session.id
      : isSessionInFocusedPane(session.id, state.panes, state.focusedPaneId),
  );
  const workspaceKey = useAppStore((state) =>
    workspaceContextKeyForSession(state, session.id),
  );
  const workspace = useMemo(
    () => parseWorkspaceContextKey(workspaceKey),
    [workspaceKey],
  );

  // Full unmount removes the stable portal target so we do not leak an
  // orphaned terminal subtree.
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    return () => {
      target.remove();
    };
  }, []);

  // Whenever the visible target changes, move our target div into that pane,
  // popover body, or back to limbo. Keep looking briefly if the target has not
  // landed in the DOM yet.
  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let frame: number | null = null;
    let attempts = 0;
    const move = () => {
      const dest = terminalDestinationForTargetKey(visibleTargetKey);
      const nextParent = dest ?? getTerminalLimbo();
      if (target.parentElement !== nextParent) nextParent.appendChild(target);
      if (
        dest === null &&
        terminalTargetNeedsDomRetry(visibleTargetKey) &&
        attempts < 30
      ) {
        attempts += 1;
        frame = requestAnimationFrame(move);
      }
    };
    move();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [visibleTargetKey, layoutRef]);

  return createPortal(
    <Terminal
      sessionId={session.id}
      repoPath={session.repo_path}
      cwd={session.worktree_path}
      workspaceId={workspace?.id ?? null}
      workspaceName={workspace?.name ?? null}
      workspacePath={workspace?.path ?? null}
      agentProvider={resolveSessionAgentProvider(session)}
      pasteAgentProvider={session.agent_provider ?? null}
      isActive={visibleTargetKey !== null}
      isFocusedPane={isFocusedPane}
      autoFocusOnActive={terminalTargetIsPopover(visibleTargetKey)}
    />,
    targetRef.current,
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/(["\\\]\[])/g, "\\$1");
}

function activeWorkspaceId(state: AppStateSnapshot): string | null {
  return state.activeProjectFolderId ?? state.activeProject;
}

function workspaceContextKeyForSession(
  state: AppStateSnapshot,
  sessionId: string,
): string {
  for (const [workspaceId, ws] of Object.entries(state.workspaces)) {
    for (const pane of Object.values(ws.panes)) {
      if (!pane.tabIds.includes(sessionId)) continue;
      const folder = findProjectFolderById(state.projectFolders, workspaceId);
      if (folder) {
        return encodeWorkspaceContext({
          id: folder.id,
          name: folder.name,
          path: folder.cwdPath,
        });
      }
      if (!workspaceId.startsWith("project-folder:")) {
        return encodeWorkspaceContext({
          id: workspaceId,
          name: "Default",
          path: workspaceId,
        });
      }
      return "";
    }
  }
  return "";
}

function encodeWorkspaceContext(context: TerminalWorkspaceContext): string {
  return JSON.stringify(context);
}

function parseWorkspaceContextKey(key: string): TerminalWorkspaceContext | null {
  if (!key) return null;
  try {
    const value = JSON.parse(key) as Partial<TerminalWorkspaceContext>;
    if (
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.path === "string"
    ) {
      return {
        id: value.id,
        name: value.name,
        path: value.path,
      };
    }
  } catch {
    // Ignore malformed persisted/debug state and fall back to no workspace hint.
  }
  return null;
}
