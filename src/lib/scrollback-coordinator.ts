/**
 * In-memory registry of "flush this terminal's scrollback to disk now"
 * functions, keyed by session id. Each `Terminal` mount registers its
 * own flusher and unregisters it on unmount, so the App-level
 * `onCloseRequested` handler can drain every live terminal exactly once
 * before the window is destroyed.
 *
 * Flushers are async on purpose — `flushAllScrollbacks` awaits all of
 * them with `Promise.allSettled` so a single failing terminal does not
 * abort the rest of the shutdown sequence.
 */
type FlushFn = () => Promise<void>;

const flushers = new Map<string, FlushFn>();

/**
 * Register `fn` as the flusher for `sessionId`. Returns an unregister
 * callback that only deletes the entry if the value still matches `fn`,
 * so a stale unmount cleanup cannot wipe the live re-mount's flusher
 * (relevant under React.StrictMode's mount → cleanup → mount cycle).
 */
export function registerScrollbackFlusher(
  sessionId: string,
  fn: FlushFn,
): () => void {
  flushers.set(sessionId, fn);
  return () => {
    if (flushers.get(sessionId) === fn) {
      flushers.delete(sessionId);
    }
  };
}

/**
 * Run every registered flusher in parallel. Resolves once all flushers
 * have either completed or rejected — never throws.
 */
export async function flushAllScrollbacks(): Promise<void> {
  if (flushers.size === 0) return;
  await Promise.allSettled(
    Array.from(flushers.values()).map((fn) => fn()),
  );
}
