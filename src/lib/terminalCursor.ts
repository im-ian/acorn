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

export function nextCursorApplicationOverride(
  current: boolean,
  parameter: number | undefined,
): boolean {
  const value = parameter ?? 1;
  if (value === 0) return false;
  if (Number.isInteger(value) && value >= 1 && value <= 6) return true;
  return current;
}
