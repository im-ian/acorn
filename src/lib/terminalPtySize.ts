export const XTVERSION_REPLY = "\x1bP>|xterm.js\x1b\\";

const U16_MAX = 65535;

export function shouldForceCommandPtyResize(term: {
  buffer: { active: { type: string } };
  modes: { mouseTrackingMode: string };
}): boolean {
  // Force a same-size SIGWINCH only before a TUI starts, so a command
  // launched from an already-open shell sees the current pane size.
  // Alternate screen or mouse tracking means a TUI already owns the
  // viewport; pulsing SIGWINCH then shreds overlay redraws.
  return (
    term.buffer.active.type !== "alternate" &&
    term.modes.mouseTrackingMode === "none"
  );
}

export function ptyPixelSize(
  cols: number,
  rows: number,
  cell: { width: number; height: number } | null | undefined,
): { pixelWidth: number; pixelHeight: number } {
  if (
    !cell ||
    cell.width <= 0 ||
    cell.height <= 0 ||
    cols <= 0 ||
    rows <= 0 ||
    !Number.isFinite(cell.width) ||
    !Number.isFinite(cell.height)
  ) {
    return { pixelWidth: 0, pixelHeight: 0 };
  }
  return {
    pixelWidth: toU16(cols * cell.width),
    pixelHeight: toU16(rows * cell.height),
  };
}

export function xtversionReplyForParams(
  params: (number | number[])[],
): string | null {
  const raw = params[0];
  const code = Array.isArray(raw) ? raw[0] : (raw ?? 0);
  if (code !== 0) return null;
  return XTVERSION_REPLY;
}

function toU16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(U16_MAX, Math.round(value));
}
