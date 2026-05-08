import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export type ModalVariant = "dialog" | "panel";
export type ModalSize = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "5xl";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  variant?: ModalVariant;
  size?: ModalSize;
  ariaLabelledBy?: string;
  ariaLabel?: string;
  /**
   * Extra className applied to the inner content container. Use sparingly —
   * size + variant should cover most needs.
   */
  className?: string;
  children: ReactNode;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
  "5xl": "max-w-5xl",
};

const BACKDROP_DIALOG = "flex items-start justify-center px-4 pt-24";
const BACKDROP_PANEL = "flex flex-col px-4 py-6";

const CONTENT_DIALOG =
  "w-full overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-2xl";
const CONTENT_PANEL =
  "mx-auto flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-2xl";

/**
 * Returns true once the component has mounted on the client. Used to delay
 * `createPortal` until `document` is available — Tauri's WKWebView always
 * runs in a browser context, but guarding the first render keeps the
 * Modal robust if the component is ever rendered server-side or under a
 * test runner without a DOM.
 */
function useHasMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

export function Modal({
  open,
  onClose,
  variant = "panel",
  size = "md",
  ariaLabelledBy,
  ariaLabel,
  className,
  children,
}: ModalProps) {
  const mounted = useHasMounted();
  if (!open || !mounted) return null;
  const isDialog = variant === "dialog";
  // Portal to <body> so every Modal renders as a top-level sibling. This
  // prevents stacking-context surprises (transformed/clipped ancestors
  // breaking `position: fixed`) and avoids the WKWebView paint artifacts
  // we saw when one Modal contained another.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledBy}
      aria-label={ariaLabel}
      className={cn(
        "fixed inset-0 z-50 bg-black/55",
        isDialog ? BACKDROP_DIALOG : BACKDROP_PANEL,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          isDialog ? CONTENT_DIALOG : CONTENT_PANEL,
          SIZE_CLASS[size],
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
