/** Visible one-second ticks an xterm write may stay unparsed before the
 *  terminal counts as dead. A 512KB batch normally parses well under one. */
export const OUTPUT_STALL_TICKS = 5;

interface WriterProgress {
  writing: boolean;
  completed: number;
  visible: boolean;
}

/**
 * xterm runs every parsed chunk through one loop. If anything throws inside
 * it, the loop is never scheduled again: later writes queue forever, the
 * screen freezes, and input still reaches the PTY. That shows up here as one
 * write that never completes. Hidden ticks are not counted, because WKWebView
 * throttles timers in a hidden window and slow is not dead.
 */
export function createOutputStallDetector(threshold = OUTPUT_STALL_TICKS) {
  let ticks = 0;
  let lastCompleted = -1;
  let reported = false;
  return {
    /** Call once a second. True once per stuck write, after it has been in
     *  flight for `threshold` visible ticks. */
    tick({ writing, completed, visible }: WriterProgress): boolean {
      if (!writing || completed !== lastCompleted) {
        lastCompleted = completed;
        ticks = 0;
        reported = false;
        return false;
      }
      if (!visible || reported) return false;
      ticks += 1;
      reported = ticks >= threshold;
      return reported;
    },
  };
}

const RECOVERY_WINDOW_MS = 5 * 60_000;
const MAX_RECOVERIES_PER_WINDOW = 3;
const recoveryTimes = new Map<string, number[]>();

/** A terminal that dies again on every remount must not remount forever. */
export function takeTerminalRecoveryBudget(
  sessionId: string,
  now = Date.now(),
): boolean {
  const recent = (recoveryTimes.get(sessionId) ?? []).filter(
    (at) => now - at < RECOVERY_WINDOW_MS,
  );
  const allowed = recent.length < MAX_RECOVERIES_PER_WINDOW;
  if (allowed) recent.push(now);
  recoveryTimes.set(sessionId, recent);
  return allowed;
}
