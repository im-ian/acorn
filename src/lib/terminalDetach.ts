/**
 * Tracks terminal sessions the eviction policy is about to *detach* rather than
 * delete. The {@link Terminal} unmount cleanup consults this set to choose
 * between `pty_detach` (keep the daemon shell + ring alive for a later
 * re-attach) and `pty_kill` (tear the shell down for good).
 *
 * Only the LRU eviction path in {@link TerminalHost} marks sessions here, and
 * only after confirming they are daemon-backed. Genuine session deletion leaves
 * the set untouched, so its unmount falls through to `pty_kill` as before.
 */
const detaching = new Set<string>();

/** Flag `sessionId` so its next unmount detaches instead of kills. */
export function markTerminalDetaching(sessionId: string): void {
  detaching.add(sessionId);
}

/**
 * Returns `true` and clears the flag if `sessionId` was marked for detach.
 * Single-shot: a later deletion-driven unmount of the same id correctly falls
 * through to kill because the flag is gone.
 */
export function consumeTerminalDetaching(sessionId: string): boolean {
  return detaching.delete(sessionId);
}
