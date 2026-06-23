import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";
import { StatusDot, type StatusDotSize, type StatusTone } from "./StatusDot";

export type StatusBadgeSize = "xs" | "sm" | "md";

export interface StatusBadgeClassNameOptions {
  tone?: StatusTone;
  size?: StatusBadgeSize;
  pulse?: boolean;
  className?: ClassValue;
}

const STATUS_BADGE_SIZE_CLASS: Record<StatusBadgeSize, string> = {
  xs: "gap-1 rounded px-1.5 py-0.5 text-[9px] leading-3",
  sm: "gap-1.5 rounded px-1.5 py-0.5 text-[10px] leading-4",
  md: "gap-1.5 rounded-md px-2 py-1 text-xs leading-4",
};

const STATUS_BADGE_DOT_SIZE: Record<StatusBadgeSize, StatusDotSize> = {
  xs: "xs",
  sm: "sm",
  md: "sm",
};

const STATUS_BADGE_ICON_CLASS: Record<StatusBadgeSize, string> = {
  xs: "size-2.5",
  sm: "size-3",
  md: "size-3.5",
};

const STATUS_BADGE_TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-fg-muted/15 text-fg-muted ring-fg-muted/10",
  success: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/20",
  warning: "bg-warning/15 text-warning ring-warning/20",
  danger: "bg-danger/15 text-danger ring-danger/20",
  accent: "bg-accent/15 text-accent ring-accent/20",
};

export function statusBadgeClassName({
  tone = "neutral",
  size = "sm",
  pulse = false,
  className,
}: StatusBadgeClassNameOptions = {}): string {
  return cn(
    "inline-flex shrink-0 items-center whitespace-nowrap font-medium ring-1",
    STATUS_BADGE_SIZE_CLASS[size],
    STATUS_BADGE_TONE_CLASS[tone],
    pulse && "animate-pulse",
    className,
  );
}

export interface StatusBadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "className">,
    StatusBadgeClassNameOptions {
  children?: ReactNode;
  dot?: boolean;
  icon?: ReactNode;
}

export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(
  (
    {
      tone = "neutral",
      size = "sm",
      pulse = false,
      dot = false,
      icon,
      className,
      children,
      ...props
    },
    ref,
  ) => (
    <span
      ref={ref}
      className={statusBadgeClassName({ tone, size, pulse, className })}
      {...props}
    >
      {dot ? (
        <StatusDot
          tone={tone}
          size={STATUS_BADGE_DOT_SIZE[size]}
          pulse={pulse}
        />
      ) : null}
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "inline-flex shrink-0 items-center justify-center",
            STATUS_BADGE_ICON_CLASS[size],
          )}
        >
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  ),
);
StatusBadge.displayName = "StatusBadge";
