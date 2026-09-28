type Disposal = () => void | Promise<void>;

const pending = new Map<string, number>();
const mountEpoch = new Map<string, number>();

export function beginTerminalMount(sessionId: string): number {
  cancelPendingTerminalPtyDisposal(sessionId);
  const next = (mountEpoch.get(sessionId) ?? 0) + 1;
  mountEpoch.set(sessionId, next);
  return next;
}

export function isCurrentTerminalMount(sessionId: string, epoch: number): boolean {
  return mountEpoch.get(sessionId) === epoch;
}

export function cancelPendingTerminalPtyDisposal(sessionId: string): void {
  const handle = pending.get(sessionId);
  if (handle === undefined) return;
  window.clearTimeout(handle);
  pending.delete(sessionId);
}

export function scheduleTerminalPtyDisposal(
  sessionId: string,
  epoch: number,
  disposal: Disposal,
  waitFor?: Promise<unknown>,
): void {
  cancelPendingTerminalPtyDisposal(sessionId);
  const handle = window.setTimeout(() => {
    pending.delete(sessionId);
    // The grace timer can elapse while `pty_spawn` is still polling the
    // daemon socket. Reap only after that spawn settles, and only if this
    // mount is still the current one — a remount cancels the timer or
    // advances the epoch while the spawn is in flight.
    void (async () => {
      try {
        await waitFor;
      } catch {
        // The command can fail after the PTY exists.
      }
      if (!isCurrentTerminalMount(sessionId, epoch)) return;
      await disposal();
    })();
  }, 250);
  pending.set(sessionId, handle);
}

export function hasPendingTerminalPtyDisposal(sessionId: string): boolean {
  return pending.has(sessionId);
}
