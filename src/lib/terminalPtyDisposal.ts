type Disposal = () => void;

const pending = new Map<string, number>();

export function cancelPendingTerminalPtyDisposal(sessionId: string): void {
  const handle = pending.get(sessionId);
  if (handle === undefined) return;
  window.clearTimeout(handle);
  pending.delete(sessionId);
}

export function scheduleTerminalPtyDisposal(
  sessionId: string,
  disposal: Disposal,
): void {
  cancelPendingTerminalPtyDisposal(sessionId);
  const handle = window.setTimeout(() => {
    pending.delete(sessionId);
    disposal();
  }, 250);
  pending.set(sessionId, handle);
}

export function hasPendingTerminalPtyDisposal(sessionId: string): boolean {
  return pending.has(sessionId);
}
