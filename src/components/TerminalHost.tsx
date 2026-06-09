import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveSessionAgentProvider } from "../lib/agentProvider";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import { getTerminalLimbo } from "../lib/terminalLimbo";
import { isSessionInFocusedPane } from "../lib/multiInput";
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
    const cap = Math.max(maxMountedTerminals, visibleSessionIds.size);
    if (mountedSessionIds.size <= cap) return;
    let cancelled = false;
    void (async () => {
      let daemonAlive: Set<string>;
      try {
        const summaries = await api.daemonListSessions();
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
  }, [maxMountedTerminals, mountedSessionIds, visibleSessionIds]);

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

function visibleTerminalSessionIdKey(state: AppStateSnapshot): string {
  const workspaceId = activeWorkspaceId(state);
  if (!workspaceId) return "";
  const ws = state.workspaces[workspaceId];
  if (!ws) return "";
  return Object.values(ws.panes)
    .map((pane) => pane.activeTabId)
    .filter((id): id is string => Boolean(id))
    .sort()
    .join(SESSION_ID_KEY_SEPARATOR);
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

  // Which pane (in the active workspace) is currently displaying this
  // session as its active tab? null when this session is not visible.
  const visiblePaneId = useAppStore((state) => {
    const workspaceId = activeWorkspaceId(state);
    if (!workspaceId) return null;
    const ws = state.workspaces[workspaceId];
    if (!ws) return null;
    for (const pane of Object.values(ws.panes)) {
      if (pane.activeTabId === session.id) return pane.id;
    }
    return null;
  });

  // The workspace layout reference. Splits/merges replace the layout node, so
  // a new reference signals that pane DOM bodies were remounted — even when
  // `visiblePaneId` is unchanged. Without this dep the reattach effect skips
  // re-running and the terminal target stays detached from the new pane body.
  const layoutRef = useAppStore((state) =>
    activeWorkspaceId(state)
      ? state.workspaces[activeWorkspaceId(state)!]?.layout ?? null
      : null,
  );
  const isFocusedPane = useAppStore((state) =>
    isSessionInFocusedPane(session.id, state.panes, state.focusedPaneId),
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

  // Whenever the visible pane changes, move our target div into that pane's
  // body (or back to limbo). This must run as a layout effect: Terminal's
  // passive mount effect opens xterm and spawns the PTY with the current
  // measured cols/rows, so the target needs to be in its real pane before
  // that effect runs. Waiting for rAF leaves the first spawn fitted against
  // the off-screen limbo size, which narrow panes and agent TUIs expose as
  // stale wrapping/paint until the next resize or tab refit.
  useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const dest = visiblePaneId
      ? (document.querySelector(
          `[data-pane-body="${cssEscape(visiblePaneId)}"]`,
        ) as HTMLElement | null)
      : null;
    const nextParent = dest ?? getTerminalLimbo();
    if (target.parentElement !== nextParent) nextParent.appendChild(target);
  }, [visiblePaneId, layoutRef]);

  return createPortal(
    <Terminal
      sessionId={session.id}
      repoPath={session.repo_path}
      cwd={session.worktree_path}
      agentProvider={resolveSessionAgentProvider(session)}
      pasteAgentProvider={session.agent_provider ?? null}
      isActive={visiblePaneId !== null}
      isFocusedPane={isFocusedPane}
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
