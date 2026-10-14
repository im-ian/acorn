/** Minimum pointer travel before a press is treated as a select-drag. */
export const TERMINAL_MOUSE_SELECT_THRESHOLD_PX = 8;

export type TerminalMouseTrackingReleaseAction = "click" | "keep-selection";

/**
 * Decide whether a mouse-tracking press should go to the TUI or stay as a
 * local selection for right-click paste.
 *
 * A trackpad click often jitters past the drag threshold without covering a
 * second cell, so xterm ends with an empty selection. Overlay close buttons
 * live in one cell; that press must still replay as a click. Any selected
 * text — including a one-character drag — is kept for paste. Double/triple
 * click is always a word/line select.
 */
export function terminalMouseTrackingReleaseAction(args: {
  selecting: boolean;
  selectedTextLength: number;
  clickCount: number;
}): TerminalMouseTrackingReleaseAction {
  if (!args.selecting) return "click";
  if (args.clickCount >= 2) return "keep-selection";
  if (args.selectedTextLength > 0) return "keep-selection";
  return "click";
}

/**
 * The first press of a multi-click already opens the link. Later presses
 * report detail >= 2 and would open another tab for the same gesture.
 */
export function terminalLinkPressShouldOpen(detail: number): boolean {
  return detail < 2;
}

/**
 * A mouse-tracking app sees the same click and opens the URL itself.
 * Keep the press when the terminal is the one opening it.
 * Alt and Shift select or encode a modifier report, and so does a
 * modifier that is not the link chord. Those presses stay with the app.
 * A plain click in modifier-click mode stays with the app.
 */
export function terminalLinkClickShouldReachApp(args: {
  mouseTracking: boolean;
  hasLink: boolean;
  linkActivation: "click" | "modifier-click";
  modifierHeld: boolean;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  if (!args.mouseTracking || !args.hasLink) return true;
  if (args.altKey || args.shiftKey) return true;
  if ((args.ctrlKey || args.metaKey) && !args.modifierHeld) return true;
  if (args.linkActivation === "modifier-click" && !args.modifierHeld) {
    return true;
  }
  return false;
}
