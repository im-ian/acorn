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

export type PtyGridSize = {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
};

/** One-cell shrink used to force a tty SIGWINCH when geometry is unchanged. */
export function sigwinchPulseSize(size: PtyGridSize): PtyGridSize | null {
  if (size.rows > 1) {
    const rows = size.rows - 1;
    return {
      ...size,
      rows,
      pixelHeight:
        size.pixelHeight > 0
          ? Math.max(1, Math.round((size.pixelHeight * rows) / size.rows))
          : 0,
    };
  }
  if (size.cols > 1) {
    const cols = size.cols - 1;
    return {
      ...size,
      cols,
      pixelWidth:
        size.pixelWidth > 0
          ? Math.max(1, Math.round((size.pixelWidth * cols) / size.cols))
          : 0,
    };
  }
  return null;
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

function toU16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(U16_MAX, Math.round(value));
}
