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
  surface?: ButtonSurface;
  className?: ClassValue;
}

const BUTTON_BASE_CLASS =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60";

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "px-2 py-1 text-[11px]",
  sm: "px-3 py-1 text-xs",
  md: "px-3 py-1.5 text-xs",
};

function neutralHoverClass(surface: ButtonSurface): string {
  return surface === "dialog"
    ? "hover:bg-bg-sidebar hover:text-fg"
    : "hover:bg-bg-elevated hover:text-fg";
}

function buttonVariantClass(
  variant: ButtonVariant,
  surface: ButtonSurface,
): string {
  switch (variant) {
    case "ghost":
      return cn(
        "text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted",
        neutralHoverClass(surface),
      );
    case "neutral":
      return cn(
        "text-fg disabled:hover:bg-transparent",
        surface === "dialog" ? "hover:bg-bg-sidebar" : "hover:bg-bg-elevated",
      );
    case "outline":
      return cn(
        "border border-border bg-bg text-fg disabled:hover:bg-bg",
        surface === "dialog" ? "hover:bg-bg-sidebar" : "hover:bg-bg-elevated",
      );
    case "primary":
      return "bg-accent font-medium text-white hover:bg-accent/90 disabled:hover:bg-accent";
    case "accentSoft":
      return "bg-accent/15 font-medium text-accent hover:bg-accent/25 disabled:hover:bg-accent/15";
    case "dangerSoft":
      return "bg-danger/15 font-medium text-danger hover:bg-danger/25 disabled:hover:bg-danger/15";
    case "danger":
      return "bg-danger font-medium text-white hover:bg-danger/90 disabled:hover:bg-danger";
    case "dangerGhost":
      return "text-fg-muted hover:bg-danger/10 hover:text-danger disabled:hover:bg-transparent disabled:hover:text-fg-muted";
  }
}

export function buttonClassName({
  variant = "ghost",
  size = "sm",
  surface = "panel",
  className,
}: ButtonClassNameOptions = {}): string {
  return cn(
    BUTTON_BASE_CLASS,
    BUTTON_SIZE_CLASS[size],
    buttonVariantClass(variant, surface),
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
      surface = "panel",
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
      className={buttonClassName({ variant, size, surface, className })}
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
  "inline-flex shrink-0 items-center justify-center rounded transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60";

const ICON_BUTTON_SIZE_CLASS: Record<IconButtonSize, string> = {
  xs: "size-5",
  sm: "size-6",
  md: "size-7",
  lg: "size-8",
};

function iconButtonVariantClass(
  variant: IconButtonVariant,
  surface: ButtonSurface,
): string {
  switch (variant) {
    case "ghost":
      return cn(
        "text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted",
        neutralHoverClass(surface),
      );
    case "neutral":
      return cn(
        "text-fg disabled:hover:bg-transparent",
        surface === "dialog" ? "hover:bg-bg-sidebar" : "hover:bg-bg-elevated",
      );
    case "outline":
      return cn(
        "border border-border bg-bg text-fg disabled:hover:bg-bg",
        surface === "dialog" ? "hover:bg-bg-sidebar" : "hover:bg-bg-elevated",
      );
    case "primary":
      return "bg-accent text-white hover:bg-accent/90 disabled:hover:bg-accent";
    case "dangerGhost":
      return "text-fg-muted hover:bg-danger/10 hover:text-danger disabled:hover:bg-transparent disabled:hover:text-fg-muted";
    case "dangerSoft":
      return "bg-danger/15 text-danger hover:bg-danger/25 disabled:hover:bg-danger/15";
  }
}

export function iconButtonClassName({
  variant = "ghost",
  size = "sm",
  surface = "panel",
  className,
}: IconButtonClassNameOptions = {}): string {
  return cn(
    ICON_BUTTON_BASE_CLASS,
    ICON_BUTTON_SIZE_CLASS[size],
    iconButtonVariantClass(variant, surface),
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
      surface = "panel",
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
      className={iconButtonClassName({ variant, size, surface, className })}
      {...props}
    >
      {children}
    </button>
  ),
);
IconButton.displayName = "IconButton";
