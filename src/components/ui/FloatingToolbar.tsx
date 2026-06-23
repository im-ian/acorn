import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";

export type FloatingToolbarPosition = "top-right" | "bottom-right";

export interface FloatingToolbarClassNameOptions {
  position?: FloatingToolbarPosition;
  className?: ClassValue;
}

const FLOATING_TOOLBAR_BASE_CLASS =
  "absolute z-20 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-lg border border-border bg-bg-elevated/95 p-1 shadow-lg backdrop-blur";

const FLOATING_TOOLBAR_POSITION_CLASS: Record<
  FloatingToolbarPosition,
  string
> = {
  "top-right": "right-3 top-3",
  "bottom-right": "bottom-3 right-3",
};

export function floatingToolbarClassName({
  position = "top-right",
  className,
}: FloatingToolbarClassNameOptions = {}): string {
  return cn(
    FLOATING_TOOLBAR_BASE_CLASS,
    FLOATING_TOOLBAR_POSITION_CLASS[position],
    className,
  );
}

export interface FloatingToolbarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className">,
    FloatingToolbarClassNameOptions {
  children: ReactNode;
  zIndex?: CSSProperties["zIndex"];
}

export const FloatingToolbar = forwardRef<
  HTMLDivElement,
  FloatingToolbarProps
>(
  (
    {
      position = "top-right",
      className,
      role = "toolbar",
      style,
      zIndex,
      children,
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      role={role}
      className={floatingToolbarClassName({ position, className })}
      style={zIndex === undefined ? style : { ...style, zIndex }}
      {...props}
    >
      {children}
    </div>
  ),
);
FloatingToolbar.displayName = "FloatingToolbar";
