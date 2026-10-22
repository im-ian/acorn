import { invoke } from "@tauri-apps/api/core";

const MAX_ENTRY_CHARS = 16_000;
const RATE_WINDOW_MS = 10_000;
const MAX_ENTRIES_PER_WINDOW = 20;

let windowStartedAt = 0;
let entriesInWindow = 0;

/**
 * Append one JSON line to the profile's `logs/frontend.log`. Release builds
 * ship without devtools, so this is the only record of a webview-side
 * failure. An error that repeats every frame is capped per window.
 */
export function logFrontendEvent(
  event: string,
  detail: Record<string, unknown> = {},
): void {
  const now = Date.now();
  if (now - windowStartedAt > RATE_WINDOW_MS) {
    windowStartedAt = now;
    entriesInWindow = 0;
  }
  entriesInWindow += 1;
  if (entriesInWindow > MAX_ENTRIES_PER_WINDOW) return;
  const at = new Date(now).toISOString();
  let entry: string;
  try {
    entry = JSON.stringify({ at, event, ...detail });
  } catch {
    entry = JSON.stringify({ at, event });
  }
  void invoke("frontend_log", { entry: entry.slice(0, MAX_ENTRY_CHARS) }).catch(
    () => {
      // Logging must never become a second failure.
    },
  );
}

function errorDetail(value: unknown): Record<string, unknown> {
  return value instanceof Error
    ? { message: value.message, stack: value.stack }
    : { message: String(value) };
}

/** Record uncaught errors and rejections. An exception inside xterm's parse
 *  loop only surfaces here. */
export function installFrontendErrorLog(target: Window = window): void {
  target.addEventListener("error", (event) => {
    logFrontendEvent("window.error", {
      ...errorDetail(event.error ?? event.message),
      source: event.filename,
      line: event.lineno,
      column: event.colno,
    });
  });
  target.addEventListener("unhandledrejection", (event) => {
    logFrontendEvent("unhandledrejection", errorDetail(event.reason));
  });
}
