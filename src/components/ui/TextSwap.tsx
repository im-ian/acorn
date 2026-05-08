/**
 * Wraps a string that flips between states (e.g. "Merge" ↔ "Merging…")
 * so the rendered span gets a fresh `key` whenever the text changes.
 *
 * Why this exists: WKWebView (Tauri's macOS webview) sometimes leaves a
 * stale paint of the previous text alongside the new one when a single
 * DOM node's text content swaps mid-CSS-transition (typically when
 * `disabled:opacity-60` + Tailwind's blanket `transition` class are both
 * in play). Forcing React to unmount and remount the span on every text
 * change sidesteps the buggy layer reuse.
 *
 * Usage:
 *
 * ```tsx
 * <button disabled={busy}>
 *   <TextSwap>{busy ? "Saving…" : "Save"}</TextSwap>
 * </button>
 * ```
 */
export function TextSwap({ children }: { children: string }) {
  return <span key={children}>{children}</span>;
}
