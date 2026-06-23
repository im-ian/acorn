import {
  Fragment,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";
import { listBoxClassName, listRowClassName } from "./List";

function withAnimationDelay(
  style: CSSProperties | undefined,
  delayMs: number | undefined,
): CSSProperties | undefined {
  if (delayMs == null) return style;
  return { animationDelay: `${delayMs}ms`, ...style };
}

export interface SkeletonBlockProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children" | "className"> {
  className?: ClassValue;
  delayMs?: number;
}

export function SkeletonBlock({
  className,
  delayMs,
  style,
  ...props
}: SkeletonBlockProps) {
  return (
    <span
      {...props}
      aria-hidden={props["aria-hidden"] ?? true}
      className={cn("block animate-pulse rounded bg-fg-muted/10", className)}
      style={withAnimationDelay(style, delayMs)}
    />
  );
}

export function SkeletonCircle({ className, ...props }: SkeletonBlockProps) {
  return (
    <SkeletonBlock
      className={cn("size-7 rounded-full bg-fg-muted/15", className)}
      {...props}
    />
  );
}

export interface SkeletonTextProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "className"> {
  className?: ClassValue;
  delayStepMs?: number;
  lineClassName?: ClassValue;
  lines?: number;
  widths?: readonly string[];
}

export function SkeletonText({
  className,
  delayStepMs = 0,
  lineClassName,
  lines = 3,
  widths,
  ...props
}: SkeletonTextProps) {
  return (
    <div
      {...props}
      aria-hidden={props["aria-hidden"] ?? true}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {Array.from({ length: lines }).map((_, index) => (
        <SkeletonBlock
          key={index}
          className={cn("h-3", lineClassName)}
          delayMs={index * delayStepMs}
          style={
            widths?.length
              ? { width: widths[index % widths.length] }
              : undefined
          }
        />
      ))}
    </div>
  );
}

export interface SkeletonRowProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  children?: ReactNode;
  className?: ClassValue;
  delayMs?: number;
}

export function SkeletonRow({
  children,
  className,
  delayMs,
  style,
  ...props
}: SkeletonRowProps) {
  return (
    <div
      {...props}
      aria-hidden={props["aria-hidden"] ?? true}
      className={cn(
        listRowClassName({ className: "flex items-center gap-2" }),
        className,
      )}
      style={withAnimationDelay(style, delayMs)}
    >
      {children ?? (
        <>
          <SkeletonBlock
            className="h-3 w-12 shrink-0 bg-fg-muted/15"
            delayMs={delayMs}
          />
          <SkeletonBlock
            className="h-3 w-full max-w-[60%]"
            delayMs={delayMs}
          />
          <SkeletonBlock
            className="ml-auto h-3 w-10 shrink-0"
            delayMs={delayMs}
          />
        </>
      )}
    </div>
  );
}

export interface SkeletonListProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "className"> {
  className?: ClassValue;
  count?: number;
  renderRow?: (index: number) => ReactNode;
  rowClassName?: ClassValue;
  rowDelayStepMs?: number;
}

export function SkeletonList({
  className,
  count = 6,
  renderRow,
  rowClassName,
  rowDelayStepMs = 80,
  ...props
}: SkeletonListProps) {
  return (
    <div
      {...props}
      aria-hidden={props["aria-hidden"] ?? true}
      className={listBoxClassName({ className: cn(className) })}
    >
      {Array.from({ length: count }).map((_, index) =>
        renderRow ? (
          <Fragment key={index}>{renderRow(index)}</Fragment>
        ) : (
          <SkeletonRow
            key={index}
            className={rowClassName}
            delayMs={index * rowDelayStepMs}
          />
        ),
      )}
    </div>
  );
}
