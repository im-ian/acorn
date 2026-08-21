import type { Terminal as XTerm } from "@xterm/xterm";

interface XtermWheelInternals {
  _core?: {
    element?: HTMLElement;
    _renderService?: {
      dimensions?: { css?: { cell?: { height: number } } };
    };
  };
}

// xterm.js emits at most ONE wheel mouse-report per wheel event — and, for an
// alt-screen app without mouse tracking, at most one arrow key — no matter how
// many lines the delta was worth. It also damps any wheel event under 50px to
// 30% before deciding whether to emit anything at all, so most trackpad events
// resolve to zero lines and are dropped entirely. Real terminals (iTerm2,
// Ghostty, kitty) send one report per scrolled line, which is why a TUI that
// takes the wheel over — Claude Code's REPL enables `?1049` plus
// `?1000`/`?1002`/`?1003`/`?1006` — scrolls normally there and crawls here.
//
// Convert the delta to lines ourselves and replay the event once per line.
// xterm still encodes the report (or the arrow key), so the active mouse
// protocol, the modifier bits and the cell coordinates stay its job.
const APP_WHEEL_TRACKING_MODES = new Set(["vt200", "drag", "any"]);
// Trackpad momentum carries hundreds of pixels per event; each reported line
// is one `pty_write` IPC round trip, so cap the burst. Scaled by the scroll
// speed so raising the setting still raises the ceiling.
// ponytail: per-report writes are fine at this cap; coalesce `writeToPty` into
// a microtask if PTY IPC ever shows up in a profile.
const MAX_LINES_PER_EVENT = 8;
// Replayed events must survive xterm's own pixel→line conversion: at least one
// line for the current cell height and `scrollSensitivity`, and above its 50px
// trackpad-damping threshold.
function replayDeltaPx(cellHeight: number, speed: number): number {
  return Math.max(50, (cellHeight * 2) / speed);
}

/**
 * Wheel delta → number of lines to report, carrying the sub-line remainder so
 * a slow trackpad drag still scrolls instead of rounding to zero forever.
 */
export function wheelScrollLineCount({
  deltaY,
  deltaMode,
  cellHeight,
  rows,
  carry,
  speed = 1,
}: {
  deltaY: number;
  deltaMode: number;
  cellHeight: number;
  rows: number;
  carry: number;
  speed?: number;
}): { lines: number; carry: number } {
  if (deltaY === 0 || !Number.isFinite(deltaY) || cellHeight <= 0) {
    return { lines: 0, carry };
  }
  const raw =
    (deltaMode === WheelEvent.DOM_DELTA_LINE
      ? deltaY
      : deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? deltaY * rows
        : deltaY / cellHeight) * speed;
  const total = carry + raw;
  const lines = Math.trunc(total);
  const cap = Math.max(1, Math.round(MAX_LINES_PER_EVENT * speed));
  if (Math.abs(lines) > cap) {
    // Dropping the carry keeps a clamped burst from queueing a backlog that
    // scrolls on after the fingers stop.
    return { lines: Math.sign(lines) * cap, carry: 0 };
  }
  return { lines, carry: total - lines };
}

/** Whether the foreground application, not the viewport, owns the wheel. */
function applicationOwnsWheel(term: XTerm): boolean {
  return (
    APP_WHEEL_TRACKING_MODES.has(term.modes.mouseTrackingMode) ||
    term.buffer.active.type === "alternate"
  );
}

/**
 * @param getSpeed Terminal scroll-speed multiplier, read per event so the
 *   setting applies live. Mirrors xterm's own `scrollSensitivity`, which
 *   covers the viewport (scrollback) path this handler leaves alone.
 */
export function patchTerminalWheelScroll(
  term: XTerm,
  getSpeed: () => number = () => 1,
): () => void {
  const core = (term as unknown as XtermWheelInternals)._core;
  let carry = 0;
  let replaying = false;

  term.attachCustomWheelEventHandler((event) => {
    // Replayed events are the ones xterm is meant to turn into reports.
    if (replaying) return true;
    // Modified wheels keep xterm's own meaning (shift = local scroll, alt/ctrl
    // = fast scroll) and the app-level zoom guard.
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
      return true;
    }
    if (!applicationOwnsWheel(term)) return true;
    const element = core?.element;
    const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 0;
    if (!element || cellHeight <= 0) return true;

    const rawSpeed = getSpeed();
    const speed =
      Number.isFinite(rawSpeed) && rawSpeed > 0 ? rawSpeed : 1;
    const next = wheelScrollLineCount({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      cellHeight,
      rows: term.rows,
      carry,
      speed,
    });
    carry = next.carry;
    // xterm cancels the event on the reporting path but not on the alt-screen
    // fallback; swallowing it here keeps the webview from rubber-banding.
    event.preventDefault();
    if (next.lines === 0) return false;

    const magnitude = replayDeltaPx(cellHeight, speed);
    const deltaY = next.lines > 0 ? magnitude : -magnitude;
    replaying = true;
    try {
      for (let i = 0; i < Math.abs(next.lines); i++) {
        element.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY,
            deltaMode: WheelEvent.DOM_DELTA_PIXEL,
            clientX: event.clientX,
            clientY: event.clientY,
            screenX: event.screenX,
            screenY: event.screenY,
            bubbles: false,
            cancelable: true,
          }),
        );
      }
    } finally {
      replaying = false;
    }
    return false;
  });

  return () => {
    term.attachCustomWheelEventHandler(() => true);
  };
}
