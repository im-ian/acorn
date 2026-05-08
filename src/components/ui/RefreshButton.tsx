import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { cn } from "../../lib/cn";

interface RefreshButtonProps {
  onClick: () => void | Promise<void>;
  /** Parent-owned in-flight flag. true → spin, false→true edge → show ✓. */
  loading: boolean;
  /** Icon size in px. Default 14. */
  size?: number;
  /** Tooltip + accessible name. */
  title?: string;
  ariaLabel?: string;
  /** Extra classes for the button element. */
  className?: string;
}

const SUCCESS_HOLD_MS = 1100;
const FADE_MS = 250;

/**
 * Refresh icon button that briefly swaps to a green ✓ when an in-flight
 * refresh completes, then fades back to the refresh glyph. The parent owns
 * the `loading` flag; the button only animates the visual feedback layer.
 */
export function RefreshButton({
  onClick,
  loading,
  size = 14,
  title = "Refresh",
  ariaLabel,
  className,
}: RefreshButtonProps) {
  const [showSuccess, setShowSuccess] = useState(false);
  const prevLoadingRef = useRef(loading);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // Trigger success only on a true → false edge (an actual completion),
    // not on initial mount with `loading=false`.
    if (prevLoadingRef.current && !loading) {
      setShowSuccess(true);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => {
        setShowSuccess(false);
        timerRef.current = null;
      }, SUCCESS_HOLD_MS);
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      title={title}
      aria-label={ariaLabel ?? title}
      className={cn(
        "relative inline-flex items-center justify-center rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {/* Reserve space so the absolute icons don't collapse the button. */}
      <span
        aria-hidden
        className="inline-block"
        style={{ width: size, height: size }}
      />
      <RefreshCw
        size={size}
        aria-hidden
        className={cn(
          "absolute transition-opacity",
          loading && "animate-spin",
          showSuccess ? "opacity-0" : "opacity-100",
        )}
        style={{ transitionDuration: `${FADE_MS}ms` }}
      />
      <Check
        size={size}
        strokeWidth={3}
        aria-hidden
        className={cn(
          "absolute text-emerald-400 transition-opacity",
          showSuccess ? "opacity-100" : "opacity-0",
        )}
        style={{ transitionDuration: `${FADE_MS}ms` }}
      />
    </button>
  );
}
