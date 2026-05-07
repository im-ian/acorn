import { type ReactNode } from "react";
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
  if (!open) return null;
  const isDialog = variant === "dialog";
  return (
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
    </div>
  );
}
