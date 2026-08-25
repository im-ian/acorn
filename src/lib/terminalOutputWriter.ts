export interface TerminalOutputWriter {
  enqueue(bytes: Uint8Array): void;
  flushSoon(): void;
  whenIdle(): Promise<void>;
  drainAndDispose(): Promise<void>;
  dispose(): void;
  pendingBytes(): number;
}

interface TerminalOutputWriterOptions {
  write: (bytes: Uint8Array, onParsed: () => void) => void;
  afterWrite: () => void;
  isActive: () => boolean;
  isBackground?: () => boolean;
  activeBatchBytes?: number;
  backgroundBatchBytes?: number;
  inactiveBatchBytes?: number;
  backgroundDelayMs?: number | (() => number);
  inactiveDelayMs?: number;
  maxQueuedBytes?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  setTimeoutFn?: (callback: () => void, timeout: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

// A truecolor TUI frame is ~16KB. Larger active dumps stall WKWebView so
// keystrokes queued during the parse flush as one paste when focus returns.
const DEFAULT_ACTIVE_BATCH_BYTES = 32 * 1024;
const DEFAULT_BACKGROUND_BATCH_BYTES = 256 * 1024;
const DEFAULT_INACTIVE_BATCH_BYTES = 128 * 1024;
const DEFAULT_BACKGROUND_DELAY_MS = 40;
const DEFAULT_INACTIVE_DELAY_MS = 80;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

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

function splitAtSafeByte(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.byteLength <= maxBytes) return bytes.byteLength;
  let take = maxBytes;
  // Walk back over UTF-8 continuation bytes so a codepoint isn't torn.
  while (take > 0 && (bytes[take] & 0xc0) === 0x80) {
    take--;
  }
  // Prefer an ESC boundary so a CSI sequence stays with its payload when
  // it still fits most of the budget.
  const floor = Math.max(1, Math.floor(maxBytes / 2));
  for (let i = take - 1; i >= floor; i--) {
    if (bytes[i] === 0x1b) {
      take = i;
      break;
    }
  }
  return take > 0 ? take : maxBytes;
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
    if (totalBytes >= maxBytes) break;
    if (selected.length > 0 && totalBytes + next.byteLength > maxBytes) {
      break;
    }
    // A single PTY read can be hundreds of KB. Yield between slices so
    // queued keystrokes can run instead of flushing as one paste.
    const room = maxBytes - totalBytes;
    if (next.byteLength > room) {
      const take = splitAtSafeByte(next, room);
      selected.push(next.subarray(0, take));
      queue[0] = next.subarray(take);
      totalBytes += take;
      break;
    }
    selected.push(queue.shift()!);
    totalBytes += next.byteLength;
  }

  return {
    bytes: joinByteChunks(selected, totalBytes),
    byteLength: totalBytes,
  };
}

function resolveDelayMs(value: number | (() => number)): number {
  return typeof value === "function" ? value() : value;
}

export function createTerminalOutputWriter({
  write,
  afterWrite,
  isActive,
  isBackground = () => false,
  activeBatchBytes = DEFAULT_ACTIVE_BATCH_BYTES,
  backgroundBatchBytes = DEFAULT_BACKGROUND_BATCH_BYTES,
  inactiveBatchBytes = DEFAULT_INACTIVE_BATCH_BYTES,
  backgroundDelayMs = DEFAULT_BACKGROUND_DELAY_MS,
  inactiveDelayMs = DEFAULT_INACTIVE_DELAY_MS,
  maxQueuedBytes = DEFAULT_MAX_QUEUED_BYTES,
  requestFrame = window.requestAnimationFrame.bind(window),
  cancelFrame = window.cancelAnimationFrame.bind(window),
  setTimeoutFn = window.setTimeout.bind(window),
  clearTimeoutFn = window.clearTimeout.bind(window),
}: TerminalOutputWriterOptions): TerminalOutputWriter {
  const queue: Uint8Array[] = [];
  const idleResolvers: Array<() => void> = [];
  let queuedBytes = 0;
  let disposed = false;
  let closing = false;
  let writing = false;
  let frame: number | null = null;
  let timer: number | null = null;
  let immediateFlushPending = false;
  let urgentFlush = false;

  const resolveIdleIfReady = () => {
    if (
      writing ||
      queue.length > 0 ||
      frame !== null ||
      timer !== null ||
      immediateFlushPending
    ) {
      return;
    }
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

  const scheduleImmediateFlush = () => {
    if (immediateFlushPending) return;
    immediateFlushPending = true;
    Promise.resolve().then(() => {
      immediateFlushPending = false;
      flush();
    });
  };

  const scheduleFlush = (forceFrame = false, forceUrgent = false) => {
    if (disposed || writing || queue.length === 0) {
      return;
    }
    urgentFlush ||= forceUrgent;

    if (closing || queuedBytes >= maxQueuedBytes) {
      urgentFlush = true;
      cancelScheduledFlush();
      scheduleImmediateFlush();
      return;
    }

    if (frame !== null || timer !== null || immediateFlushPending) return;

    if (forceFrame || isActive()) {
      frame = requestFrame(() => {
        frame = null;
        flush();
      });
      return;
    }

    timer = setTimeoutFn(
      () => {
        timer = null;
        flush();
      },
      isBackground() ? resolveDelayMs(backgroundDelayMs) : inactiveDelayMs,
    );
  };

  const flush = () => {
    if (disposed || writing) {
      resolveIdleIfReady();
      return;
    }
    const useUrgentBudget = urgentFlush || closing || queuedBytes >= maxQueuedBytes;
    urgentFlush = false;
    const maxBytes = useUrgentBudget
      ? Math.max(
          activeBatchBytes,
          backgroundBatchBytes,
          inactiveBatchBytes,
        )
      : isActive()
        ? activeBatchBytes
        : isBackground()
          ? backgroundBatchBytes
          : inactiveBatchBytes;
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
        scheduleFlush(false, closing || queuedBytes >= maxQueuedBytes);
      }
      resolveIdleIfReady();
    });
  };

  const flushSoon = () => {
    if (disposed || queue.length === 0) return;
    cancelScheduledFlush();
    // Frame-paced, normal active batches. Urgent dumps exist for teardown
    // and a saturated queue; promoting a hidden terminal to visible still
    // has to yield so the keyboard can run between frames.
    scheduleFlush(true, false);
  };

  const drainQueuedOutput = () => {
    if (disposed || queue.length === 0) return;
    urgentFlush = true;
    cancelScheduledFlush();
    scheduleImmediateFlush();
  };

  const whenIdle = () => {
    if (
      !writing &&
      queue.length === 0 &&
      frame === null &&
      timer === null &&
      !immediateFlushPending
    ) {
      return Promise.resolve();
    }
    drainQueuedOutput();
    return new Promise<void>((resolve) => {
      idleResolvers.push(resolve);
    });
  };

  return {
    enqueue(bytes) {
      if (disposed || closing || bytes.byteLength === 0) return;
      queue.push(bytes);
      queuedBytes += bytes.byteLength;
      scheduleFlush();
    },
    flushSoon,
    whenIdle,
    async drainAndDispose() {
      if (disposed) return;
      closing = true;
      cancelScheduledFlush();
      drainQueuedOutput();
      await whenIdle();
      disposed = true;
      cancelScheduledFlush();
      while (idleResolvers.length > 0) {
        idleResolvers.shift()?.();
      }
    },
    dispose() {
      disposed = true;
      closing = true;
      cancelScheduledFlush();
      immediateFlushPending = false;
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
