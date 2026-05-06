import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: string;
  /** Where the tooltip appears relative to the trigger. Default: "bottom". */
  side?: "top" | "bottom" | "left" | "right";
  /** Delay before showing on hover, in ms. Default: 250. */
  delay?: number;
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
  children,
  className,
}: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
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
              role="tooltip"
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                transform: position.transform,
                zIndex: 9999,
              }}
              className="pointer-events-none whitespace-nowrap rounded border border-border bg-bg-elevated px-2 py-0.5 text-[11px] font-normal text-fg shadow-md"
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
