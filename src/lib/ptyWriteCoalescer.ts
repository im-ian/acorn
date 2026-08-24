import { invoke } from "@tauri-apps/api/core";

/**
 * Join stdin writes that land in the same turn into one `pty_write`, then
 * send those bursts in submission order per session.
 *
 * Wheel-driven TUI mouse reports arrive as many tiny `onData` payloads;
 * each invoke is a Tauri IPC hop. One microtask later they are a single
 * write. A per-session promise chain keeps the next burst from overtaking
 * an in-flight invoke, which async Tauri commands do not otherwise order.
 */
export function createPtyWriteCoalescer(
  write: (sessionId: string, data: string) => Promise<void> | void,
  schedule: (callback: () => void) => void = queueMicrotask,
): {
  enqueue: (sessionId: string, data: string) => Promise<void>;
  flush: (sessionId?: string) => Promise<void>;
} {
  type SessionPipe = {
    pending: string[];
    chain: Promise<void>;
  };
  const pipes = new Map<string, SessionPipe>();
  let scheduled = false;

  const pipeFor = (sessionId: string): SessionPipe => {
    let pipe = pipes.get(sessionId);
    if (!pipe) {
      pipe = { pending: [], chain: Promise.resolve() };
      pipes.set(sessionId, pipe);
    }
    return pipe;
  };

  const drain = (sessionId: string) => {
    const pipe = pipes.get(sessionId);
    if (!pipe || pipe.pending.length === 0) return;
    const data = pipe.pending.join("");
    pipe.pending = [];
    pipe.chain = pipe.chain.then(() => Promise.resolve(write(sessionId, data)));
  };

  const drainAll = () => {
    scheduled = false;
    for (const sessionId of Array.from(pipes.keys())) drain(sessionId);
  };

  return {
    enqueue(sessionId, data) {
      if (data.length === 0) return Promise.resolve();
      const pipe = pipeFor(sessionId);
      pipe.pending.push(data);
      if (!scheduled) {
        scheduled = true;
        schedule(drainAll);
      }
      return pipe.chain.then(() => {
        // After the already-queued chain, this payload is in `pending` or
        // already folded into the next chained write by drainAll.
        return pipe.chain;
      });
    },
    flush(sessionId) {
      if (sessionId) {
        drain(sessionId);
        return pipes.get(sessionId)?.chain ?? Promise.resolve();
      }
      drainAll();
      return Promise.all(
        Array.from(pipes.values()).map((pipe) => pipe.chain),
      ).then(() => undefined);
    },
  };
}

function encodeStringToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let defaultCoalescer: ReturnType<typeof createPtyWriteCoalescer> | undefined;

function defaultPtyWriteCoalescer() {
  if (!defaultCoalescer) {
    defaultCoalescer = createPtyWriteCoalescer((sessionId, data) =>
      invoke<void>("pty_write", {
        sessionId,
        data: encodeStringToBase64(data),
      }),
    );
  }
  return defaultCoalescer;
}

export function enqueuePtyWrite(
  sessionId: string,
  data: string,
): Promise<void> {
  return defaultPtyWriteCoalescer().enqueue(sessionId, data);
}

export function flushPtyWrite(sessionId?: string): Promise<void> {
  return defaultPtyWriteCoalescer().flush(sessionId);
}
