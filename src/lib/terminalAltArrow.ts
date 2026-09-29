export interface AltArrowKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface AltArrowScreen {
  /** Full-screen app. It already decodes xterm's CSI 1;3 form. */
  alternateScreen: boolean;
  /** Mouse reports mean a TUI owns the key, even on the normal buffer. */
  mouseTracking: boolean;
  /** DECCKM. Plain up/down must use SS3 so the shell's arrow binding matches. */
  applicationCursor: boolean;
}

/**
 * Bytes to write for an unmodified Alt+arrow, or null to leave the key
 * with xterm.
 *
 * xterm encodes Alt+Left as CSI 1;3D. Shell line editors do not bind that
 * sequence, so they insert the unmatched tail ";3D". Meta-b/meta-f and
 * plain arrows are already bound. Alternate-screen and mouse-tracking
 * apps keep the CSI form.
 */
export function lineEditorAltArrowSequence(
  event: AltArrowKey,
  screen: AltArrowScreen,
): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (screen.alternateScreen || screen.mouseTracking) return null;
  switch (event.key) {
    case "ArrowLeft":
      return "\x1bb";
    case "ArrowRight":
      return "\x1bf";
    case "ArrowUp":
      return screen.applicationCursor ? "\x1bOA" : "\x1b[A";
    case "ArrowDown":
      return screen.applicationCursor ? "\x1bOB" : "\x1b[B";
    default:
      return null;
  }
}
