import { invoke } from "@tauri-apps/api/core";

/**
 * Join stdin writes into one `pty_write` per in-flight hop, per session.
 *
 * TUI mouse reports arrive as many tiny `onData` payloads. Each invoke is a
 * Tauri IPC hop that does not complete until the daemon acks, so chaining
 * one write per event makes a drag wait N round-trips. Accumulate
 * everything that lands while a hop is in flight and send it as the next
 * burst when that hop settles.
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
    inFlight: boolean;
    chain: Promise<void>;
  };
  const pipes = new Map<string, SessionPipe>();
  let scheduled = false;

  const pipeFor = (sessionId: string): SessionPipe => {
    let pipe = pipes.get(sessionId);
    if (!pipe) {
      pipe = { pending: [], inFlight: false, chain: Promise.resolve() };
      pipes.set(sessionId, pipe);
    }
    return pipe;
  };

  const whenIdle = (pipe: SessionPipe): Promise<void> => {
    if (!pipe.inFlight && pipe.pending.length === 0) {
      return Promise.resolve();
    }
    return pipe.chain.then(() => whenIdle(pipe));
  };

  const sendPending = (sessionId: string) => {
    const pipe = pipes.get(sessionId);
    if (!pipe || pipe.inFlight || pipe.pending.length === 0) return;
    const data = pipe.pending.join("");
    pipe.pending = [];
    pipe.inFlight = true;
    pipe.chain = Promise.resolve()
      .then(() => write(sessionId, data))
      .then(
        () => {
          pipe.inFlight = false;
          sendPending(sessionId);
        },
        () => {
          pipe.inFlight = false;
          sendPending(sessionId);
        },
      );
  };

  const kickAll = () => {
    scheduled = false;
    for (const sessionId of Array.from(pipes.keys())) sendPending(sessionId);
  };

  return {
    enqueue(sessionId, data) {
      if (data.length === 0) return Promise.resolve();
      const pipe = pipeFor(sessionId);
      pipe.pending.push(data);
      if (!scheduled) {
        scheduled = true;
        schedule(kickAll);
      }
      return whenIdle(pipe);
    },
    flush(sessionId) {
      if (sessionId) {
        sendPending(sessionId);
        const pipe = pipes.get(sessionId);
        return pipe ? whenIdle(pipe) : Promise.resolve();
      }
      kickAll();
      return Promise.all(
        Array.from(pipes.values()).map((pipe) => whenIdle(pipe)),
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
