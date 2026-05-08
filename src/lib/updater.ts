import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Acorn auto-updater facade.
 *
 * Wraps `@tauri-apps/plugin-updater` so the rest of the app talks to one
 * Promise-based API and never has to know whether an Update handle is
 * still valid (the handle becomes stale after the install completes).
 *
 * Behavior contract:
 *   - `checkForUpdate()` returns the available `Update` or `null`. Errors
 *     are surfaced to the caller — never swallowed — so the Settings UI
 *     can display them.
 *   - The check itself is non-blocking and side-effect free; nothing is
 *     downloaded or applied unless the caller explicitly invokes
 *     `installUpdate(update)` on the returned handle.
 *   - `installUpdate` does NOT auto-relaunch silently — it explicitly
 *     calls `plugin-process::relaunch` so the user-clicked
 *     "Install & relaunch" button fulfills its name. macOS Tauri builds
 *     don't restart on their own after `downloadAndInstall`; without an
 *     explicit relaunch the new bundle would only be picked up on the
 *     user's next manual launch.
 */

export type { DownloadEvent, Update };

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
 * Download and install an update, then ask Tauri to relaunch. After
 * `relaunch()` resolves the host process is being torn down — any code
 * that runs afterwards in the renderer is a transient ghost.
 *
 * `onProgress` is forwarded straight through `downloadAndInstall`, so
 * callers can surface a download progress bar or log to the console for
 * post-mortem diagnosis when an update misbehaves.
 */
export async function installUpdate(
  update: Update,
  onProgress?: (event: DownloadEvent) => void,
): Promise<void> {
  await update.downloadAndInstall((event) => {
    onProgress?.(event);
  });
  await relaunch();
}
