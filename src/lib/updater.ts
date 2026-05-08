import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

/**
 * Acorn auto-updater facade.
 *
 * Wraps `@tauri-apps/plugin-updater` so the rest of the app talks to one
 * Promise-based API and never has to know whether an Update handle is
 * still valid (the handle becomes stale after `installAndRelaunch`).
 *
 * Behavior contract:
 *   - `checkForUpdate()` returns the available `Update` or `null`. Errors
 *     are surfaced to the caller — never swallowed — so the Settings UI
 *     can display them.
 *   - The check itself is non-blocking and side-effect free; nothing is
 *     downloaded or applied unless the caller explicitly invokes
 *     `downloadAndInstall(update)` on the returned handle.
 *   - We do not auto-relaunch the app behind the user's back. The
 *     "install and relaunch" button is always an explicit user gesture.
 */

export type { Update };

/**
 * Check the configured update endpoint. Returns the `Update` handle when
 * a newer version is available, otherwise `null`. Throws on transport /
 * signature / configuration errors so callers can surface them.
 */
export async function checkForUpdate(): Promise<Update | null> {
  const update = await check();
  return update ?? null;
}

/**
 * Resolve the running app's semantic version (as reported by Tauri).
 * Used by the Settings UI to show "Acorn 0.1.0".
 */
export async function getCurrentVersion(): Promise<string> {
  return getVersion();
}

/**
 * Download and install an update, then ask Tauri to relaunch. The caller
 * should treat this as the destructive final step: after the relaunch
 * call resolves the host process is being torn down.
 */
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
}
