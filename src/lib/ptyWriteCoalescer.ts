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
  type Waiter = {
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  type SessionPipe = {
    pending: string[];
    hopWaiters: Waiter[];
    idleWaiters: Waiter[];
    inFlight: boolean;
  };
  const pipes = new Map<string, SessionPipe>();
  let scheduled = false;

  const pipeFor = (sessionId: string): SessionPipe => {
    let pipe = pipes.get(sessionId);
    if (!pipe) {
      pipe = {
        pending: [],
        hopWaiters: [],
        idleWaiters: [],
        inFlight: false,
      };
      pipes.set(sessionId, pipe);
    }
    return pipe;
  };

  const waitUntilIdle = (pipe: SessionPipe): Promise<void> => {
    if (!pipe.inFlight && pipe.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      pipe.idleWaiters.push({ resolve, reject });
    });
  };

  const settleIdle = (pipe: SessionPipe, error: unknown | null) => {
    if (pipe.inFlight || pipe.pending.length > 0) return;
    const waiters = pipe.idleWaiters;
    pipe.idleWaiters = [];
    if (error) {
      for (const waiter of waiters) waiter.reject(error);
      return;
    }
    for (const waiter of waiters) waiter.resolve();
  };

  const sendPending = (sessionId: string) => {
    const pipe = pipes.get(sessionId);
    if (!pipe || pipe.inFlight || pipe.pending.length === 0) return;
    const data = pipe.pending.join("");
    const hopWaiters = pipe.hopWaiters;
    pipe.pending = [];
    pipe.hopWaiters = [];
    pipe.inFlight = true;
    void Promise.resolve()
      .then(() => write(sessionId, data))
      .then(
        () => {
          pipe.inFlight = false;
          for (const waiter of hopWaiters) waiter.resolve();
          sendPending(sessionId);
          settleIdle(pipe, null);
        },
        (error) => {
          pipe.inFlight = false;
          for (const waiter of hopWaiters) waiter.reject(error);
          sendPending(sessionId);
          settleIdle(pipe, error);
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
      const hop = new Promise<void>((resolve, reject) => {
        pipe.hopWaiters.push({ resolve, reject });
      });
      if (!scheduled) {
        scheduled = true;
        schedule(kickAll);
      }
      return hop;
    },
    flush(sessionId) {
      if (sessionId) {
        sendPending(sessionId);
        const pipe = pipes.get(sessionId);
        return pipe ? waitUntilIdle(pipe) : Promise.resolve();
      }
      kickAll();
      return Promise.all(
        Array.from(pipes.values()).map((pipe) => waitUntilIdle(pipe)),
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
