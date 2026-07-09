export interface TerminalOutputWriter {
  enqueue(bytes: Uint8Array): void;
  flushSoon(): void;
  whenIdle(): Promise<void>;
  dispose(): void;
  pendingBytes(): number;
}

interface TerminalOutputWriterOptions {
  write: (bytes: Uint8Array, onParsed: () => void) => void;
  afterWrite: () => void;
  isActive: () => boolean;
  activeBatchBytes?: number;
  inactiveBatchBytes?: number;
  inactiveDelayMs?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  setTimeoutFn?: (callback: () => void, timeout: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

const DEFAULT_ACTIVE_BATCH_BYTES = 512 * 1024;
const DEFAULT_INACTIVE_BATCH_BYTES = 128 * 1024;
const DEFAULT_INACTIVE_DELAY_MS = 80;

function joinByteChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function takeBatch(
  queue: Uint8Array[],
  maxBytes: number,
): { bytes: Uint8Array; byteLength: number } | null {
  if (queue.length === 0) return null;

  const selected: Uint8Array[] = [];
  let totalBytes = 0;
  while (queue.length > 0) {
    const next = queue[0];
    if (selected.length > 0 && totalBytes + next.byteLength > maxBytes) {
      break;
    }
    selected.push(queue.shift()!);
    totalBytes += next.byteLength;
    if (totalBytes >= maxBytes) break;
  }

  return {
    bytes: joinByteChunks(selected, totalBytes),
    byteLength: totalBytes,
  };
}

export function createTerminalOutputWriter({
  write,
  afterWrite,
  isActive,
  activeBatchBytes = DEFAULT_ACTIVE_BATCH_BYTES,
  inactiveBatchBytes = DEFAULT_INACTIVE_BATCH_BYTES,
  inactiveDelayMs = DEFAULT_INACTIVE_DELAY_MS,
  requestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame = window.cancelAnimationFrame.bind(window),
  setTimeoutFn = window.setTimeout.bind(window),
  clearTimeoutFn = window.clearTimeout.bind(window),
}: TerminalOutputWriterOptions): TerminalOutputWriter {
  const queue: Uint8Array[] = [];
  const idleResolvers: Array<() => void> = [];
  let queuedBytes = 0;
  let disposed = false;
  let writing = false;
  let frame: number | null = null;
  let timer: number | null = null;

  const resolveIdleIfReady = () => {
    if (writing || queue.length > 0 || frame !== null || timer !== null) return;
    while (idleResolvers.length > 0) {
      idleResolvers.shift()?.();
    }
  };

  const cancelScheduledFlush = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };

  const scheduleFlush = (forceFrame = false) => {
    if (
      disposed ||
      writing ||
      queue.length === 0 ||
      frame !== null ||
      timer !== null
    ) {
      return;
    }

    if (forceFrame || isActive()) {
      frame = requestFrame(() => {
        frame = null;
        flush();
      });
      return;
    }

    timer = setTimeoutFn(() => {
      timer = null;
      flush();
    }, inactiveDelayMs);
  };

  const flush = () => {
    if (disposed || writing) {
      resolveIdleIfReady();
      return;
    }
    const maxBytes = isActive() ? activeBatchBytes : inactiveBatchBytes;
    const batch = takeBatch(queue, maxBytes);
    if (!batch) {
      resolveIdleIfReady();
      return;
    }
    queuedBytes -= batch.byteLength;
    writing = true;
    write(batch.bytes, () => {
      writing = false;
      if (!disposed) {
        afterWrite();
        scheduleFlush();
      }
      resolveIdleIfReady();
    });
  };

  const flushSoon = () => {
    if (disposed || queue.length === 0) return;
    cancelScheduledFlush();
    scheduleFlush(true);
  };

  return {
    enqueue(bytes) {
      if (disposed || bytes.byteLength === 0) return;
      queue.push(bytes);
      queuedBytes += bytes.byteLength;
      scheduleFlush();
    },
    flushSoon,
    whenIdle() {
      if (
        !writing &&
        queue.length === 0 &&
        frame === null &&
        timer === null
      ) {
        return Promise.resolve();
      }
      flushSoon();
      return new Promise<void>((resolve) => {
        idleResolvers.push(resolve);
      });
    },
    dispose() {
      disposed = true;
      cancelScheduledFlush();
      queue.length = 0;
      queuedBytes = 0;
      while (idleResolvers.length > 0) {
        idleResolvers.shift()?.();
      }
    },
    pendingBytes() {
      return queuedBytes;
    },
  };
}
