import { forwardRef, type HTMLAttributes } from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "accent";
export type StatusDotSize = "xs" | "sm" | "md" | "lg";

export interface StatusDotClassNameOptions {
  tone?: StatusTone;
  size?: StatusDotSize;
  pulse?: boolean;
  className?: ClassValue;
}

const STATUS_DOT_SIZE_CLASS: Record<StatusDotSize, string> = {
  xs: "size-1",
  sm: "size-1.5",
  md: "size-2",
  lg: "size-2.5",
};

const STATUS_DOT_TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-fg-muted/70",
  success: "bg-emerald-400",
  warning: "bg-warning",
  danger: "bg-danger",
  accent: "bg-accent",
};

export function statusDotClassName({
  tone = "neutral",
  size = "sm",
  pulse = false,
  className,
}: StatusDotClassNameOptions = {}): string {
  return cn(
    "inline-block shrink-0 rounded-full",
    STATUS_DOT_SIZE_CLASS[size],
    STATUS_DOT_TONE_CLASS[tone],
    pulse && "animate-pulse",
    className,
  );
}

export interface StatusDotProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className">,
    StatusDotClassNameOptions {}

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(
  (
    {
      tone = "neutral",
      size = "sm",
      pulse = false,
      className,
      "aria-hidden": ariaHidden = true,
      ...props
    },
    ref,
  ) => (
    <span
      ref={ref}
      aria-hidden={ariaHidden}
      className={statusDotClassName({ tone, size, pulse, className })}
      {...props}
    />
  ),
);
StatusDot.displayName = "StatusDot";
