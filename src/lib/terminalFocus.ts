export interface TerminalFocusDetail {
  sessionId: string;
  canvasTarget?: "reveal" | "center";
}

let pendingSessionId: string | null = null;

/**
 * A real text field should keep the keyboard. The xterm helper textarea is
 * the previous terminal's focus, and a session switch has to take it.
 */
export function terminalFocusBlockedByTextEntry(
  active: EventTarget | null,
): boolean {
  if (!(active instanceof HTMLElement)) return false;
  if (
    active instanceof HTMLTextAreaElement &&
    active.classList.contains("xterm-helper-textarea")
  ) {
    return false;
  }
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLSelectElement ||
    active.getAttribute("contenteditable") === "true"
  );
}

export function rememberTerminalFocus(sessionId: string): void {
  pendingSessionId = sessionId;
}

export function clearTerminalFocus(sessionId: string): void {
  if (pendingSessionId === sessionId) pendingSessionId = null;
}

/** One-shot. A remount that missed the focus event claims the keyboard. */
export function takeTerminalFocus(sessionId: string): boolean {
  if (pendingSessionId !== sessionId) return false;
  pendingSessionId = null;
  return true;
}

export function queueTerminalFocus(
  sessionId: string,
  detail: Omit<TerminalFocusDetail, "sessionId"> = {},
): void {
  if (typeof window === "undefined") return;
  requestAnimationFrame(() => {
    if (terminalFocusBlockedByTextEntry(document.activeElement)) return;
    rememberTerminalFocus(sessionId);
    window.dispatchEvent(
      new CustomEvent<TerminalFocusDetail>("acorn:focus-session", {
        detail: { sessionId, ...detail },
      }),
    );
  });
}
