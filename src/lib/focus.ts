/**
 * DOM-focus resolvers used by hotkey handlers and the focus syncer.
 *
 * Every terminal is rendered into a stable target div tagged with
 * `data-acorn-terminal-slot="<sessionId>"`. Walking up from the document's
 * `activeElement` to the nearest such slot is the only reliable way to learn
 * which terminal the user is actually interacting with — `focusedPaneId` in
 * the store only updates on synthetic React events, and the terminal's
 * helper textarea sits outside that fiber tree.
 */
export function findFocusedSessionId(): string | null {
  if (typeof document === "undefined") return null;
  const focused = document.activeElement as HTMLElement | null;
  const slot = focused?.closest<HTMLElement>("[data-acorn-terminal-slot]");
  return slot?.dataset.acornTerminalSlot ?? null;
}
