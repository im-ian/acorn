import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";

export type NoticeTone =
  | "danger"
  | "info"
  | "neutral"
  | "success"
  | "warning";

export type NoticeDensity = "default" | "compact";

export interface NoticeClassNameOptions {
  tone?: NoticeTone;
  density?: NoticeDensity;
  className?: ClassValue;
}

const NOTICE_BASE_CLASS = "rounded-lg border leading-snug";

const NOTICE_DENSITY_CLASS: Record<NoticeDensity, string> = {
  default: "px-3 py-2 text-xs",
  compact: "px-3 py-1.5 text-[11px]",
};

const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
  danger: "border-danger/40 bg-danger/10 text-danger",
  info: "border-accent/35 bg-accent/10 text-fg",
  neutral: "border-border bg-bg-sidebar/40 text-fg-muted",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warning: "border-warning/40 bg-warning/10 text-warning",
};

const NOTICE_ICON_TONE_CLASS: Record<NoticeTone, string> = {
  danger: "text-danger",
  info: "text-accent",
  neutral: "text-fg-muted",
  success: "text-emerald-300",
  warning: "text-warning",
};

export function noticeClassName({
  tone = "neutral",
  density = "default",
  className,
}: NoticeClassNameOptions = {}): string {
  return cn(
    NOTICE_BASE_CLASS,
    NOTICE_DENSITY_CLASS[density],
    NOTICE_TONE_CLASS[tone],
    className,
  );
}

export interface NoticeProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className">,
    NoticeClassNameOptions {
  children: ReactNode;
  icon?: ReactNode;
}

export const Notice = forwardRef<HTMLDivElement, NoticeProps>(
  (
    {
      tone = "neutral",
      density = "default",
      className,
      icon,
      children,
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        noticeClassName({ tone, density, className }),
        icon ? "flex items-start gap-2" : null,
      )}
      {...props}
    >
      {icon ? (
        <span className={cn("mt-0.5 shrink-0", NOTICE_ICON_TONE_CLASS[tone])}>
          {icon}
        </span>
      ) : null}
      {icon ? <div className="min-w-0 flex-1">{children}</div> : children}
    </div>
  ),
);
Notice.displayName = "Notice";
