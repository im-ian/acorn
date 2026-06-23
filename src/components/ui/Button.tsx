import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";

export type ButtonVariant =
  | "ghost"
  | "neutral"
  | "outline"
  | "primary"
  | "accentSoft"
  | "dangerSoft"
  | "danger"
  | "dangerGhost";

export type ButtonSize = "xs" | "sm" | "md";
export type ButtonSurface = "panel" | "dialog";

export interface ButtonClassNameOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Retained for API compatibility. Soft Minimal fills derive from the
   * foreground token (theme-safe) and no longer vary by surface.
   */
  surface?: ButtonSurface;
  className?: ClassValue;
}

const BUTTON_BASE_CLASS =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border border-transparent font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "h-6 rounded-md px-2 text-[11px]",
  sm: "h-7 rounded-lg px-3 text-xs",
  md: "h-8 rounded-lg px-3.5 text-xs",
};

function buttonVariantClass(variant: ButtonVariant): string {
  switch (variant) {
    case "ghost":
      return "bg-transparent text-fg-muted hover:bg-fill hover:text-fg disabled:hover:bg-transparent disabled:hover:text-fg-muted";
    case "neutral":
      return "bg-fill text-fg hover:bg-fill-hover disabled:hover:bg-fill";
    case "outline":
      return "border-border bg-transparent text-fg hover:border-accent/45 hover:bg-accent/10 disabled:hover:border-border disabled:hover:bg-transparent";
    case "primary":
      return "bg-accent text-on-accent hover:bg-accent-hover disabled:hover:bg-accent";
    case "accentSoft":
      return "bg-accent/15 text-accent hover:bg-accent/25 disabled:hover:bg-accent/15";
    case "dangerSoft":
      return "bg-danger/15 text-danger hover:bg-danger/25 disabled:hover:bg-danger/15";
    case "danger":
      return "bg-danger text-white hover:bg-danger/90 disabled:hover:bg-danger";
    case "dangerGhost":
      return "bg-transparent text-fg-muted hover:bg-danger/10 hover:text-danger disabled:hover:bg-transparent disabled:hover:text-fg-muted";
  }
}

export function buttonClassName({
  variant = "ghost",
  size = "sm",
  className,
}: ButtonClassNameOptions = {}): string {
  return cn(
    BUTTON_BASE_CLASS,
    BUTTON_SIZE_CLASS[size],
    buttonVariantClass(variant),
    className,
  );
}

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">,
    ButtonClassNameOptions {
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "ghost",
      size = "sm",
      // Destructured to keep it out of the DOM props spread below.
      surface: _surface = "panel",
      className,
      type = "button",
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={buttonClassName({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export type IconButtonVariant =
  | "ghost"
  | "neutral"
  | "outline"
  | "primary"
  | "dangerGhost"
  | "dangerSoft";

export type IconButtonSize = "xs" | "sm" | "md" | "lg";

export interface IconButtonClassNameOptions {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  surface?: ButtonSurface;
  className?: ClassValue;
}

const ICON_BUTTON_BASE_CLASS =
  "inline-flex shrink-0 cursor-pointer items-center justify-center border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50";

const ICON_BUTTON_SIZE_CLASS: Record<IconButtonSize, string> = {
  xs: "size-5 rounded-md",
  sm: "size-6 rounded-md",
  md: "size-7 rounded-lg",
  lg: "size-8 rounded-lg",
};

export function iconButtonClassName({
  variant = "ghost",
  size = "sm",
  className,
}: IconButtonClassNameOptions = {}): string {
  return cn(
    ICON_BUTTON_BASE_CLASS,
    ICON_BUTTON_SIZE_CLASS[size],
    buttonVariantClass(variant),
    className,
  );
}

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">,
    IconButtonClassNameOptions {
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      variant = "ghost",
      size = "sm",
      // Destructured to keep it out of the DOM props spread below.
      surface: _surface = "panel",
      className,
      type = "button",
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={iconButtonClassName({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = "IconButton";
