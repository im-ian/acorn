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
// Convert the delta to lines ourselves, then replay a single LINE-mode
// tick when that is at least one line. PIXEL replays have to beat xterm's
// 50px damper and device-pixel conversion; a tall cell rounds a 50px tick
// to zero, so the TUI receives no report. xterm still encodes the report
// (or the arrow key), and it emits at most one report per WheelEvent, so
// the line count's magnitude is a threshold, not a repeat.
//
// A trackpad gesture is many events. Replaying each one floods a
// fullscreen TUI. Claude Code keys off the XTVERSION name `xterm.js`: a
// report more than 40ms after the previous one scrolls three lines, and a
// tighter run scrolls one. The torn frame from that jump leaves the cursor
// mid-viewport, so a later click misses the "Jump to bottom" pill. One
// report per 32ms stays inside the one-line window. Whole lines inside
// that window are dropped, not queued. A decaying tail (same direction,
// each sample at most 75% of the previous one, three times, under 50px)
// is momentum and is dropped too. A one-pixel slowdown stays a drag.
const APP_WHEEL_TRACKING_MODES = new Set(["vt200", "drag", "any"]);
// Trackpad momentum carries hundreds of pixels per event. The cap bounds
// how many lines a flick can accumulate in `carry` so it cannot queue a
// backlog that scrolls on after the fingers stop.
const MAX_LINES_PER_EVENT = 8;
// Just inside Claude Code's 40ms wheel-flood notch. Wider gaps are a new
// notch and get tripled; this window does not.
const MIN_WHEEL_REPORT_INTERVAL_MS = 32;
// A pause longer than this is a new gesture, not the previous flick's tail.
const TRACKPAD_GESTURE_GAP_MS = 200;
// 60→40→30→20 crosses this. 20→19 does not, so a slowing drag still reports.
const MOMENTUM_DECAY_RATIO = 0.75;

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
export function applicationOwnsWheel(term: XTerm): boolean {
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
  now: () => number = () => performance.now(),
): () => void {
  const core = (term as unknown as XtermWheelInternals)._core;
  let carry = 0;
  let replaying = false;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  let previousDeltaY = 0;
  let previousDeltaAt = Number.NEGATIVE_INFINITY;
  let shrinkRun = 0;

  const momentumTail = (deltaY: number, at: number): boolean => {
    const fresh = at - previousDeltaAt > TRACKPAD_GESTURE_GAP_MS;
    const shrinking =
      !fresh &&
      previousDeltaY !== 0 &&
      deltaY !== 0 &&
      Math.sign(deltaY) === Math.sign(previousDeltaY) &&
      Math.abs(deltaY) <= Math.abs(previousDeltaY) * MOMENTUM_DECAY_RATIO &&
      Math.abs(deltaY) < 50;
    previousDeltaY = deltaY;
    previousDeltaAt = at;
    shrinkRun = shrinking ? shrinkRun + 1 : 0;
    return shrinkRun >= 3;
  };

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

    const at = now();
    if (momentumTail(event.deltaY, at)) {
      event.preventDefault();
      carry = 0;
      return false;
    }
    const burst = at - lastReportAt < MIN_WHEEL_REPORT_INTERVAL_MS;

    // Native PIXEL events at/above 50px already survive xterm's damper.
    // Leave the first of those to xterm so a real mouse wheel stays one
    // report. A same-window follow-up is the rest of the gesture.
    if (
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
      Math.abs(event.deltaY) >= 50
    ) {
      if (burst) {
        event.preventDefault();
        return false;
      }
      lastReportAt = at;
      return true;
    }

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
    if (burst) {
      carry = 0;
      return false;
    }
    lastReportAt = at;

    replaying = true;
    try {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: next.lines > 0 ? 1 : -1,
          deltaX: 0,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY,
          view: event.view,
          bubbles: false,
          cancelable: true,
        }),
      );
    } finally {
      replaying = false;
    }
    return false;
  });

  return () => {
    term.attachCustomWheelEventHandler(() => true);
  };
}
