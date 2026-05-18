import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { getTerminalLimbo } from "../lib/terminalLimbo";
import { isSessionInFocusedPane } from "../lib/multiInput";
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
      if (pane.activeTabId === session.id) return pane.id;
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
      cwd={session.worktree_path}
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
