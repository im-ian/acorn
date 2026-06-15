export type TerminalRestoreSource = "handoff" | "disk";

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
  return {
    snapshot: null,
    source: null,
    replayScrollback: false,
  };
}
