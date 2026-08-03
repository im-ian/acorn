import type { TerminalCursorStyle } from "./settings";

export type XtermCursorStyle = "block" | "bar" | "underline";

export function xtermCursorStyle(
  style: TerminalCursorStyle,
): XtermCursorStyle {
  switch (style) {
    case "outline":
      return "bar";
    case "pill":
      return "bar";
    default:
      return style;
  }
}

/** Resolve the native cursor shape selected by a DECSCUSR control sequence. */
export function cursorStyleFromDecscusr(
  parameter: number | undefined,
): XtermCursorStyle | null {
  const value = parameter ?? 1;
  if (value === 1 || value === 2) return "block";
  if (value === 3 || value === 4) return "underline";
  if (value === 5 || value === 6) return "bar";
  return null;
}

export function nextCursorApplicationOverride(
  current: boolean,
  parameter: number | undefined,
): boolean {
  const value = parameter ?? 1;
  if (value === 0) return false;
  if (Number.isInteger(value) && value >= 1 && value <= 6) return true;
  return current;
}
