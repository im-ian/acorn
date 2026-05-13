/**
 * Helpers for the `acorn:open-settings` event, which the Tauri menu and
 * in-app components both dispatch when the user (or the app itself)
 * wants the Settings modal to open. Centralized so the payload shape
 * accepted by both the Tauri event-bus listener and the DOM
 * `window.addEventListener` handler stays in lockstep.
 */

/**
 * Pluck a tab id out of an open-settings event payload. Accepts:
 * * A bare string ("background-sessions").
 * * An object with a `tab` string property (`{ tab: "background-sessions" }`).
 *
 * Returns `null` when no useable tab id can be extracted so the caller
 * falls back to a default `setOpen(true)` that preserves the user's
 * last manual tab selection.
 */
export function extractTabFromEvent(detail: unknown): string | null {
  if (typeof detail === "string" && detail.length > 0) {
    return detail;
  }
  if (
    detail !== null &&
    typeof detail === "object" &&
    "tab" in detail &&
    typeof (detail as { tab: unknown }).tab === "string" &&
    (detail as { tab: string }).tab.length > 0
  ) {
    return (detail as { tab: string }).tab;
  }
  return null;
}
