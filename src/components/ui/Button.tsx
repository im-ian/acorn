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
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50";

const BUTTON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px]",
  sm: "h-7 px-3 text-xs",
  md: "h-8 px-3.5 text-xs",
};

function neutralHoverClass(surface: ButtonSurface): string {
  return surface === "dialog"
    ? "hover:bg-bg-sidebar/90 hover:text-fg"
    : "hover:bg-bg-elevated/90 hover:text-fg";
}

function neutralFillClass(surface: ButtonSurface): string {
  return surface === "dialog"
    ? "border-border/70 bg-bg-sidebar/70 text-fg shadow-sm shadow-black/5 hover:border-fg-muted/30 hover:bg-bg-sidebar"
    : "border-border/70 bg-bg-elevated/70 text-fg shadow-sm shadow-black/5 hover:border-fg-muted/30 hover:bg-bg-elevated";
}

function neutralDisabledClass(surface: ButtonSurface): string {
  return surface === "dialog"
    ? "disabled:hover:border-border/70 disabled:hover:bg-bg-sidebar/70"
    : "disabled:hover:border-border/70 disabled:hover:bg-bg-elevated/70";
}

function buttonVariantClass(
  variant: ButtonVariant,
  surface: ButtonSurface,
): string {
  switch (variant) {
    case "ghost":
      return cn(
        "bg-transparent text-fg-muted shadow-none disabled:hover:bg-transparent disabled:hover:text-fg-muted",
        neutralHoverClass(surface),
      );
    case "neutral":
      return cn(
        neutralFillClass(surface),
        neutralDisabledClass(surface),
      );
    case "outline":
      return "border-border bg-transparent text-fg shadow-none hover:border-accent/45 hover:bg-accent/10 disabled:hover:border-border disabled:hover:bg-transparent";
    case "primary":
      return "border-accent bg-accent text-on-accent shadow-sm shadow-accent/20 hover:border-accent-hover hover:bg-accent-hover disabled:hover:border-accent disabled:hover:bg-accent";
    case "accentSoft":
      return "border-accent/25 bg-accent/15 text-accent hover:border-accent/45 hover:bg-accent/25 disabled:hover:border-accent/25 disabled:hover:bg-accent/15";
    case "dangerSoft":
      return "border-danger/25 bg-danger/15 text-danger hover:border-danger/45 hover:bg-danger/25 disabled:hover:border-danger/25 disabled:hover:bg-danger/15";
    case "danger":
      return "border-danger bg-danger text-white shadow-sm shadow-danger/20 hover:bg-danger/90 disabled:hover:bg-danger";
    case "dangerGhost":
      return "bg-transparent text-fg-muted shadow-none hover:border-danger/30 hover:bg-danger/10 hover:text-danger disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-fg-muted";
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
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50";

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
        "bg-transparent text-fg-muted shadow-none disabled:hover:bg-transparent disabled:hover:text-fg-muted",
        neutralHoverClass(surface),
      );
    case "neutral":
      return cn(
        neutralFillClass(surface),
        neutralDisabledClass(surface),
      );
    case "outline":
      return "border-border bg-transparent text-fg shadow-none hover:border-accent/45 hover:bg-accent/10 disabled:hover:border-border disabled:hover:bg-transparent";
    case "primary":
      return "border-accent bg-accent text-on-accent shadow-sm shadow-accent/20 hover:border-accent-hover hover:bg-accent-hover disabled:hover:border-accent disabled:hover:bg-accent";
    case "dangerGhost":
      return "bg-transparent text-fg-muted shadow-none hover:border-danger/30 hover:bg-danger/10 hover:text-danger disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-fg-muted";
    case "dangerSoft":
      return "border-danger/25 bg-danger/15 text-danger hover:border-danger/45 hover:bg-danger/25 disabled:hover:border-danger/25 disabled:hover:bg-danger/15";
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
