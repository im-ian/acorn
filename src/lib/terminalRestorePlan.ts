export type TerminalRestoreSource = "handoff" | "disk";

// CSI that turns off mouse tracking, SGR encoding, and bracketed paste
// in xterm without touching alt-screen. Cmd+K uses this as the escape
// hatch when a crashed TUI left those modes stuck on.
export const MOUSE_PASTE_RESET_CSI =
  "\x1b[?2004l\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

export function isDaemonEnabledFromStorage(
  read: () => string | null = () => {
    try {
      return window.localStorage.getItem("acorn:daemon-enabled");
    } catch {
      return null;
    }
  },
): boolean {
  return read() !== "false";
}

export function assumeDaemonAliveForRestore({
  listedAlive,
  listFailed,
  daemonEnabled,
}: {
  listedAlive: boolean;
  listFailed: boolean;
  daemonEnabled: boolean;
}): boolean {
  if (listedAlive) return true;
  return listFailed && daemonEnabled;
}

export interface TerminalRestorePlan {
  snapshot: string | null;
  source: TerminalRestoreSource | null;
  replayScrollback: boolean;
}

export function planTerminalRestore({
  daemonAlive,
  handoff,
  disk,
}: {
  daemonAlive: boolean;
  handoff: string | null;
  disk: string | null;
}): TerminalRestorePlan {
  if (daemonAlive) {
    return {
      snapshot: null,
      source: null,
      replayScrollback: true,
    };
  }
  if (handoff !== null) {
    return {
      snapshot: handoff,
      source: "handoff",
      replayScrollback: false,
    };
  }
  if (disk !== null) {
    return {
      snapshot: disk,
      source: "disk",
      replayScrollback: false,
    };
  }
  // No local snapshot is restored, so let daemon attach replay bytes written
  // between PTY spawn and stream attachment, including the first shell prompt.
  return {
    snapshot: null,
    source: null,
    replayScrollback: true,
  };
}
