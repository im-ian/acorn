/**
 * Join stdin writes that land in the same turn into one `pty_write`.
 *
 * Wheel-driven TUI mouse reports arrive as many tiny `onData` payloads;
 * each invoke is a Tauri IPC hop. One microtask later they are a single
 * write, which also lets the child see the burst as one stdin read.
 */
export function createPtyWriteCoalescer(
  write: (sessionId: string, data: string) => void,
  schedule: (callback: () => void) => void = queueMicrotask,
): { enqueue: (sessionId: string, data: string) => void; flush: () => void } {
  const pending = new Map<string, string[]>();
  let scheduled = false;

  const drain = () => {
    scheduled = false;
    if (pending.size === 0) return;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [sessionId, chunks] of entries) {
      write(sessionId, chunks.join(""));
    }
  };

  return {
    enqueue(sessionId, data) {
      if (data.length === 0) return;
      const chunks = pending.get(sessionId);
      if (chunks) {
        chunks.push(data);
      } else {
        pending.set(sessionId, [data]);
      }
      if (scheduled) return;
      scheduled = true;
      schedule(drain);
    },
    flush: drain,
  };
}
