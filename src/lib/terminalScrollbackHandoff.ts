import { prepareScrollbackForSave } from "./terminalScrollback";

const snapshots = new Map<string, string>();

export function rememberTerminalScrollback(
  sessionId: string,
  serialized: string,
): string {
  const prepared = prepareScrollbackForSave(serialized);
  if (prepared) {
    snapshots.set(sessionId, prepared);
  } else {
    snapshots.delete(sessionId);
  }
  return prepared;
}

export function rememberedTerminalScrollback(sessionId: string): string | null {
  return snapshots.get(sessionId) ?? null;
}

export function clearRememberedTerminalScrollback(sessionId: string): void {
  snapshots.delete(sessionId);
}

export function retainRememberedTerminalScrollbacks(
  liveSessionIds: ReadonlySet<string>,
): void {
  for (const sessionId of snapshots.keys()) {
    if (!liveSessionIds.has(sessionId)) snapshots.delete(sessionId);
  }
}
