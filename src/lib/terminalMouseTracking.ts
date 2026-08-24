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
