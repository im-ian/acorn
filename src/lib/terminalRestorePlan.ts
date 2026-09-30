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
  /**
   * Paint `snapshot` onto the fresh xterm and leave it on the alt screen.
   * The daemon ring is cursor-addressed, and `?1049h` clears that screen
   * and homes the cursor, so neither can rebuild an overlay TUI.
   */
  preserveOverlay: boolean;
}

const ALT_SCREEN_MODES = new Set(["47", "1047", "1049"]);

const ALT_SCREEN_ENTER_PREFIXES: readonly Uint8Array[] = [
  Uint8Array.of(0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68),
  Uint8Array.of(0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x37, 0x68),
  Uint8Array.of(0x1b, 0x5b, 0x3f, 0x34, 0x37, 0x68),
];

/**
 * Drop one leading alt-screen enter. `?1049h` clears xterm's alt buffer and
 * homes the cursor, so an attach prelude that arrives after a restored
 * overlay frame wipes it. Mouse and paste modes in the rest of the chunk stay.
 */
export function withoutAltScreenEnterPrefix(bytes: Uint8Array): Uint8Array {
  for (const prefix of ALT_SCREEN_ENTER_PREFIXES) {
    if (bytes.byteLength < prefix.byteLength) continue;
    let matches = true;
    for (let i = 0; i < prefix.byteLength; i += 1) {
      if (bytes[i] !== prefix[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return bytes.subarray(prefix.byteLength);
  }
  return bytes;
}

/** True when the serialized screen is still on the alternate buffer. */
export function snapshotKeepsAlternateScreen(input: string): boolean {
  let alt = false;
  // Fresh regex: a shared /g pattern keeps lastIndex across calls.
  for (const match of input.matchAll(/\u001b\[\?([0-9;]*)([hl])/g)) {
    const enable = match[2] === "h";
    for (const param of match[1].split(";")) {
      if (ALT_SCREEN_MODES.has(param)) alt = enable;
    }
  }
  return alt;
}

function liveOverlaySnapshot(
  handoff: string | null,
  disk: string | null,
): { snapshot: string; source: TerminalRestoreSource } | null {
  // A normal-buffer handoff is newer than disk: the overlay has exited.
  if (handoff !== null) {
    if (!snapshotKeepsAlternateScreen(handoff)) return null;
    return { snapshot: handoff, source: "handoff" };
  }
  if (disk !== null && snapshotKeepsAlternateScreen(disk)) {
    return { snapshot: disk, source: "disk" };
  }
  return null;
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
    const overlay = liveOverlaySnapshot(handoff, disk);
    if (overlay) {
      return {
        snapshot: overlay.snapshot,
        source: overlay.source,
        replayScrollback: false,
        preserveOverlay: true,
      };
    }
    return {
      snapshot: null,
      source: null,
      replayScrollback: true,
      preserveOverlay: false,
    };
  }
  if (handoff !== null) {
    return {
      snapshot: handoff,
      source: "handoff",
      replayScrollback: false,
      preserveOverlay: false,
    };
  }
  if (disk !== null) {
    return {
      snapshot: disk,
      source: "disk",
      replayScrollback: false,
      preserveOverlay: false,
    };
  }
  // No local snapshot is restored, so let daemon attach replay bytes written
  // between PTY spawn and stream attachment, including the first shell prompt.
  return {
    snapshot: null,
    source: null,
    replayScrollback: true,
    preserveOverlay: false,
  };
}
