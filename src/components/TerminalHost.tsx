import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getTerminalLimbo } from "../lib/terminalLimbo";
import { useAppStore } from "../store";
import type { Session } from "../lib/types";
import { Terminal } from "./Terminal";

/**
 * Renders one `<Terminal>` per session at the App level so the xterm + PTY
 * survive pane and project switches.
 *
 * Each terminal is portaled into a per-session "target div" that we
 * `appendChild`-move between pane bodies (when a pane is showing the
 * session) and a hidden limbo container (when nothing is showing it). The
 * div's identity stays the same throughout, so React's portal preserves
 * the Terminal subtree without ever remounting it.
 */
export function TerminalHost() {
  const sessions = useAppStore((s) => s.sessions);
  return (
    <>
      {sessions.map((s) => (
        <PortaledTerminal key={s.id} session={s} />
      ))}
    </>
  );
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
    if (!state.activeProject) return null;
    const ws = state.workspaces[state.activeProject];
    if (!ws) return null;
    for (const pane of Object.values(ws.panes)) {
      if (pane.activeSessionId === session.id) return pane.id;
    }
    return null;
  });

  // The workspace layout reference. Splits/merges replace the layout node, so
  // a new reference signals that pane DOM bodies were remounted — even when
  // `visiblePaneId` is unchanged. Without this dep the reattach effect skips
  // re-running and the terminal target stays detached from the new pane body.
  const layoutRef = useAppStore((state) =>
    state.activeProject
      ? state.workspaces[state.activeProject]?.layout ?? null
      : null,
  );

  // Park the target in limbo immediately on mount so React's createPortal
  // has a connected DOM node to render into; full unmount returns it to
  // the document tree so we don't leak the orphaned subtree.
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    if (!target.isConnected) {
      getTerminalLimbo().appendChild(target);
    }
    return () => {
      target.remove();
    };
  }, []);

  // Whenever the visible pane changes, move our target div into that pane's
  // body (or back to limbo). Use rAF so we move after React commits any
  // pending pane mounts, ensuring `[data-pane-body]` is in the DOM.
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      const dest = visiblePaneId
        ? (document.querySelector(
            `[data-pane-body="${cssEscape(visiblePaneId)}"]`,
          ) as HTMLElement | null)
        : null;
      if (dest) {
        if (target.parentElement !== dest) dest.appendChild(target);
      } else {
        const limbo = getTerminalLimbo();
        if (target.parentElement !== limbo) limbo.appendChild(target);
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [visiblePaneId, layoutRef]);

  return createPortal(
    <Terminal
      sessionId={session.id}
      cwd={session.worktree_path}
      startupMode={session.startup_mode}
      isActive={visiblePaneId !== null}
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
