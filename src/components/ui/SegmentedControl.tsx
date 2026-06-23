import type { ClassValue } from "clsx";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type SegmentedControlOrientation = "horizontal" | "vertical";
export type SegmentedControlSize = "xs" | "sm" | "md";
export type SegmentedControlSurface = "panel" | "dialog" | "subtle";
export type SegmentedControlBadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger";

export interface SegmentedControlItem<TId extends string = string> {
  id: TId;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  badgeTone?: SegmentedControlBadgeTone;
  disabled?: boolean;
  ariaLabel?: string;
  className?: ClassValue;
}

export interface SegmentedControlClassNameOptions {
  orientation?: SegmentedControlOrientation;
  className?: ClassValue;
}

const SEGMENTED_CONTROL_ORIENTATION_CLASS: Record<
  SegmentedControlOrientation,
  string
> = {
  horizontal: "flex items-center gap-0.5",
  vertical: "flex flex-col gap-0.5",
};

export function segmentedControlClassName({
  orientation = "horizontal",
  className,
}: SegmentedControlClassNameOptions = {}): string {
  return cn(SEGMENTED_CONTROL_ORIENTATION_CLASS[orientation], className);
}

export interface SegmentedControlButtonClassNameOptions {
  active?: boolean;
  orientation?: SegmentedControlOrientation;
  size?: SegmentedControlSize;
  surface?: SegmentedControlSurface;
  className?: ClassValue;
}

const SEGMENTED_CONTROL_BUTTON_SIZE_CLASS: Record<
  SegmentedControlSize,
  string
> = {
  xs: "px-2 py-1 text-[11px]",
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-xs",
};

const SEGMENTED_CONTROL_BUTTON_ORIENTATION_CLASS: Record<
  SegmentedControlOrientation,
  string
> = {
  horizontal: "justify-center",
  vertical: "w-full justify-start text-left",
};

const SEGMENTED_CONTROL_BUTTON_ACTIVE_CLASS: Record<
  SegmentedControlSurface,
  string
> = {
  panel: "acorn-tab-active-bg text-fg",
  dialog: "acorn-tab-active-bg text-fg",
  subtle: "bg-bg-elevated text-fg",
};

const SEGMENTED_CONTROL_BUTTON_INACTIVE_CLASS: Record<
  SegmentedControlSurface,
  string
> = {
  panel: "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
  dialog: "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
  subtle: "text-fg-muted/80 hover:bg-bg-elevated/40 hover:text-fg",
};

export function segmentedControlButtonClassName({
  active = false,
  orientation = "horizontal",
  size = "sm",
  surface = "panel",
  className,
}: SegmentedControlButtonClassNameOptions = {}): string {
  return cn(
    "relative inline-flex shrink-0 items-center gap-1.5 rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
    SEGMENTED_CONTROL_BUTTON_SIZE_CLASS[size],
    SEGMENTED_CONTROL_BUTTON_ORIENTATION_CLASS[orientation],
    active
      ? SEGMENTED_CONTROL_BUTTON_ACTIVE_CLASS[surface]
      : SEGMENTED_CONTROL_BUTTON_INACTIVE_CLASS[surface],
    className,
  );
}

export interface SegmentedControlBadgeClassNameOptions {
  active?: boolean;
  tone?: SegmentedControlBadgeTone;
  className?: ClassValue;
}

export function segmentedControlBadgeClassName({
  active = false,
  tone = "neutral",
  className,
}: SegmentedControlBadgeClassNameOptions = {}): string {
  return cn(
    "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-medium tabular-nums",
    segmentedControlBadgeToneClass(tone, active),
    className,
  );
}

function segmentedControlBadgeToneClass(
  tone: SegmentedControlBadgeTone,
  active: boolean,
): string {
  switch (tone) {
    case "neutral":
      return active ? "bg-accent/20 text-fg" : "bg-fg-muted/15 text-fg-muted";
    case "accent":
      return active ? "bg-accent/25 text-fg" : "bg-accent/15 text-accent";
    case "success":
      return "bg-emerald-500/20 text-emerald-300";
    case "warning":
      return "bg-warning/15 text-warning";
    case "danger":
      return "bg-danger/15 text-danger";
  }
}

export interface SegmentedControlProps<TId extends string = string>
  extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  activeId: TId;
  items: readonly SegmentedControlItem<TId>[];
  onChange: (id: TId) => void;
  orientation?: SegmentedControlOrientation;
  size?: SegmentedControlSize;
  surface?: SegmentedControlSurface;
  ariaLabel?: string;
}

export function SegmentedControl<TId extends string = string>({
  activeId,
  items,
  onChange,
  orientation = "horizontal",
  size = "sm",
  surface = "panel",
  ariaLabel,
  className,
  ...props
}: SegmentedControlProps<TId>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={segmentedControlClassName({ orientation, className })}
      {...props}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        const hasBadge = item.badge != null && item.badge !== false;
        return (
          <button
            key={item.id}
            type="button"
            disabled={item.disabled}
            aria-label={item.ariaLabel}
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(item.id);
            }}
            className={segmentedControlButtonClassName({
              active,
              orientation,
              size,
              surface,
              className: item.className,
            })}
          >
            {item.icon ? (
              <span
                aria-hidden="true"
                className="inline-flex shrink-0 items-center justify-center"
              >
                {item.icon}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{item.label}</span>
            {hasBadge ? (
              <span
                className={segmentedControlBadgeClassName({
                  active,
                  tone: item.badgeTone,
                })}
              >
                {item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
