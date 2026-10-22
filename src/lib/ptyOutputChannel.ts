import { SERIALIZE_TO_IPC_FN, transformCallback } from "@tauri-apps/api/core";

/** How long a missing index may hold back later chunks before it counts as
 *  lost. A fetch-path payload normally lands within milliseconds. */
export const PTY_OUTPUT_GAP_TIMEOUT_MS = 2000;

interface RawChannelMessage {
  index: number;
  message?: unknown;
  end?: boolean;
}

interface ReceiverOptions {
  onGap: () => void;
  gapTimeoutMs?: number;
}

/**
 * Delivers `{ index, message }` frames in index order, like Tauri's own
 * `Channel`, but does not wait forever for one that never comes.
 *
 * Tauri sends payloads over 1KB through a follow-up `fetch` and only logs a
 * failed one. Its `Channel` then parks every later chunk behind the missing
 * index for the rest of the mount: the screen freezes while input still
 * reaches the PTY. Here the gap is skipped once it has held output back for
 * `gapTimeoutMs`, and `onGap` tells the caller a chunk was dropped.
 */
export function createOrderedChannelReceiver(
  onMessage: (message: unknown) => void,
  { onGap, gapTimeoutMs = PTY_OUTPUT_GAP_TIMEOUT_MS }: ReceiverOptions,
) {
  const pending = new Map<number, unknown>();
  let next = 0;
  let gapTimer: number | null = null;
  let disposed = false;

  const clearGapTimer = () => {
    if (gapTimer === null) return;
    window.clearTimeout(gapTimer);
    gapTimer = null;
  };

  const drain = () => {
    while (!disposed && pending.has(next)) {
      const message = pending.get(next);
      pending.delete(next);
      next += 1;
      onMessage(message);
    }
  };

  const skipGap = () => {
    gapTimer = null;
    if (disposed || pending.size === 0) return;
    next = Math.min(...pending.keys());
    drain();
    onGap();
    if (pending.size > 0) armGapTimer();
  };

  const armGapTimer = () => {
    if (gapTimer === null) {
      gapTimer = window.setTimeout(skipGap, gapTimeoutMs);
    }
  };

  return {
    receive(raw: RawChannelMessage) {
      // `end` only marks the Rust side dropping the channel; disposal is
      // owned by the subscriber.
      if (disposed || raw.end || raw.index < next) return;
      pending.set(raw.index, raw.message);
      drain();
      if (pending.size === 0) clearGapTimer();
      else armGapTimer();
    },
    dispose() {
      disposed = true;
      clearGapTimer();
      pending.clear();
    },
  };
}

export interface PtyOutputChannel {
  readonly id: number;
  dispose(): void;
  toJSON(): string;
}

/** Drop-in for `new Channel(onMessage)` as a command argument. */
export function createPtyOutputChannel(
  onMessage: (message: unknown) => void,
  options: ReceiverOptions,
): PtyOutputChannel {
  const receiver = createOrderedChannelReceiver(onMessage, options);
  const id = transformCallback((raw: RawChannelMessage) => receiver.receive(raw));
  const ipcValue = () => `__CHANNEL__:${id}`;
  return {
    id,
    [SERIALIZE_TO_IPC_FN]: ipcValue,
    toJSON: ipcValue,
    dispose() {
      receiver.dispose();
      (
        window as typeof window & {
          __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
        }
      ).__TAURI_INTERNALS__?.unregisterCallback?.(id);
    },
  } as PtyOutputChannel;
}
