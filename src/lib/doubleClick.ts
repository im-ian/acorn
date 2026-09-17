import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 8;

/**
 * Recognise a double-click from two `click` events instead of listening for
 * the browser's `dblclick`.
 *
 * Chromium derives `dblclick` from the OS rule on Windows: the second click
 * has to land within `GetSystemMetrics(SM_CXDOUBLECLK) / 2` — 2px by default —
 * of the first and inside `GetDoubleClickTime()`. A double-click that drifts
 * even slightly never produces `dblclick` at all, only two `click`s, so every
 * "double-click the empty area to start a session" affordance silently does
 * nothing on Windows. WebKit on macOS is far more forgiving, which is why the
 * same gesture works there. Counting the clicks ourselves makes the gesture
 * behave the same on every platform.
 */
export function useSyntheticDoubleClick(
  onDoubleClick: () => void,
): (event: ReactMouseEvent) => void {
  const previous = useRef<{ at: number; x: number; y: number } | null>(null);
  return (event) => {
    const last = previous.current;
    previous.current = {
      at: event.timeStamp,
      x: event.clientX,
      y: event.clientY,
    };
    if (!last) return;
    if (event.timeStamp - last.at > DOUBLE_CLICK_MS) return;
    if (Math.abs(event.clientX - last.x) > DOUBLE_CLICK_SLOP_PX) return;
    if (Math.abs(event.clientY - last.y) > DOUBLE_CLICK_SLOP_PX) return;
    previous.current = null;
    onDoubleClick();
  };
}
