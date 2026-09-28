import { RefreshCw } from "lucide-react";
import type { ContextMenuItem } from "../components/ContextMenu";
import { shouldForceCommandPtyResize } from "./terminalPtySize";

export const TERMINAL_REFRESH_EVENT = "acorn:terminal-refresh";

export interface TerminalRefreshDetail {
  sessionId: string;
}

export type TerminalRefreshRedraw = "form-feed" | "sigwinch";

export type TerminalRefreshMouseEncoding = "DEFAULT" | "SGR" | "SGR_PIXELS";

export interface TerminalRefreshModes {
  alternateScreen: boolean;
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  bracketedPasteMode: boolean;
  mouseTrackingMode: string;
  mouseEncoding: TerminalRefreshMouseEncoding | null;
}

export function terminalRefreshRedraw(term: {
  buffer: { active: { type: string } };
  modes: { mouseTrackingMode: string };
}): TerminalRefreshRedraw {
  // Form-feed is a keystroke. A shell prompt redraws on it. A TUI that
  // owns the viewport must only see SIGWINCH, or the key lands in the app.
  return shouldForceCommandPtyResize(term) ? "form-feed" : "sigwinch";
}

/**
 * CSI that puts a fresh xterm back into the modes the foreground process
 * already believes are on. RIS clears those locally, and a TUI will not
 * re-send them on SIGWINCH. Alt-screen is included only when it was active:
 * the attach prelude deliberately omits it.
 */
export function terminalRefreshRestoreSequence(
  modes: TerminalRefreshModes,
): string {
  let out = "";
  if (modes.alternateScreen) out += "\x1b[?1049h";
  if (modes.applicationCursorKeysMode) out += "\x1b[?1h";
  if (modes.applicationKeypadMode) out += "\x1b[?66h";
  if (modes.bracketedPasteMode) out += "\x1b[?2004h";
  switch (modes.mouseTrackingMode) {
    case "x10":
      out += "\x1b[?9h";
      break;
    case "vt200":
      out += "\x1b[?1000h";
      break;
    case "drag":
      out += "\x1b[?1002h";
      break;
    case "any":
      out += "\x1b[?1003h";
      break;
    default:
      break;
  }
  if (modes.mouseTrackingMode !== "none") {
    if (modes.mouseEncoding === "SGR") out += "\x1b[?1006h";
    if (modes.mouseEncoding === "SGR_PIXELS") out += "\x1b[?1016h";
  }
  return out;
}

export function requestTerminalRefresh(sessionId: string): void {
  // Unmounted sessions are left alone. Clearing the DEC tracker would make
  // the next attach replay an overlay ring, and there is no grid size here
  // to pulse SIGWINCH with.
  window.dispatchEvent(
    new CustomEvent<TerminalRefreshDetail>(TERMINAL_REFRESH_EVENT, {
      detail: { sessionId },
      cancelable: true,
    }),
  );
}

export function terminalRefreshMenuItem(
  label: string,
  sessionId: string,
): ContextMenuItem {
  return {
    label,
    icon: <RefreshCw size={12} />,
    onClick: () => requestTerminalRefresh(sessionId),
  };
}
