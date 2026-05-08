import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /**
   * Tooltip content. A string keeps the legacy single-line look; pass a
   * `ReactNode` (e.g. multiple lines) and set `multiline` to switch the
   * container to a wrappable layout.
   */
  label: ReactNode;
  /** Where the tooltip appears relative to the trigger. Default: "bottom". */
  side?: "top" | "bottom" | "left" | "right";
  /** Delay before showing on hover, in ms. Default: 250. */
  delay?: number;
  /**
   * Allow the tooltip to span multiple lines. The container drops
   * `whitespace-nowrap`, applies a sensible max width, and respects
   * embedded newlines (`whitespace-pre-line`). Use for "full name + extra
   * info" hovers on truncated rows.
   */
  multiline?: boolean;
  children: ReactNode;
  className?: string;
}

interface TooltipPosition {
  top: number;
  left: number;
  transform: string;
}

const GAP = 6;

function computePosition(
  rect: DOMRect,
  side: NonNullable<TooltipProps["side"]>,
): TooltipPosition {
  switch (side) {
    case "top":
      return {
        top: rect.top - GAP,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, -100%)",
      };
    case "left":
      return {
        top: rect.top + rect.height / 2,
        left: rect.left - GAP,
        transform: "translate(-100%, -50%)",
      };
    case "right":
      return {
        top: rect.top + rect.height / 2,
        left: rect.right + GAP,
        transform: "translate(0, -50%)",
      };
    case "bottom":
    default:
      return {
        top: rect.bottom + GAP,
        left: rect.left + rect.width / 2,
        transform: "translate(-50%, 0)",
      };
  }
}

/**
 * Tooltip rendered through a portal so it escapes ancestor `overflow:auto`
 * clipping and z-index stacking contexts. Visibility is driven by explicit
 * pointer events on the trigger, not Tailwind `group-hover`, to avoid
 * cross-talk when nested inside other `group` containers.
 */
export function Tooltip({
  label,
  side = "bottom",
  delay = 250,
  multiline = false,
  children,
  className,
}: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const clearTimer = useCallback(() => {
    if (showTimer.current !== null) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearTimer();
    showTimer.current = window.setTimeout(() => {
      const el = triggerRef.current;
      if (!el) return;
      // Use the inner trigger (first child element) for accurate
      // anchoring; falls back to the wrapper rect.
      const target =
        (el.firstElementChild as HTMLElement | null) ?? el;
      setPosition(computePosition(target.getBoundingClientRect(), side));
    }, delay);
  }, [clearTimer, delay, side]);

  const hide = useCallback(() => {
    clearTimer();
    setPosition(null);
  }, [clearTimer]);

  useEffect(() => {
    if (position === null) return;
    // Hide on scroll/resize so the tooltip never sits at a stale anchor.
    const onMove = () => hide();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [position, hide]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  // Clamp the tooltip into the viewport AFTER it has been measured. The
  // initial `computePosition` anchors at the trigger center, which can
  // leave the bubble overflowing on the right (or above the top) when the
  // trigger sits near a screen edge — e.g. the status bar or a sidebar.
  useLayoutEffect(() => {
    if (position === null) return;
    const el = tooltipRef.current;
    if (!el) return;
    const PAD = 8;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let dx = 0;
    let dy = 0;
    if (rect.left < PAD) dx = PAD - rect.left;
    else if (rect.right > vw - PAD) dx = vw - PAD - rect.right;
    if (rect.top < PAD) dy = PAD - rect.top;
    else if (rect.bottom > vh - PAD) dy = vh - PAD - rect.bottom;
    if (dx !== 0 || dy !== 0) {
      // Mutate the style imperatively so we don't trigger a re-render and
      // re-clamp loop. The transform that originated the centering is
      // preserved; we only adjust the absolute origin.
      el.style.left = `${position.left + dx}px`;
      el.style.top = `${position.top + dy}px`;
    }
  }, [position]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={hide}
        className={`inline-flex ${className ?? ""}`}
      >
        {children}
      </span>
      {position !== null
        ? createPortal(
            <span
              ref={tooltipRef}
              role="tooltip"
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                transform: position.transform,
                zIndex: 9999,
              }}
              className={
                multiline
                  ? "pointer-events-none max-w-xs whitespace-pre-line break-words rounded border border-border bg-bg-elevated px-2 py-1 text-[11px] font-normal leading-snug text-fg shadow-md"
                  : "pointer-events-none whitespace-nowrap rounded border border-border bg-bg-elevated px-2 py-0.5 text-[11px] font-normal text-fg shadow-md"
              }
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
