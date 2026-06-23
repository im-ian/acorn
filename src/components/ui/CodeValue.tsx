import { type ElementType, type HTMLAttributes, type ReactNode } from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";

export type CodeValueDisplay = "block" | "inline";
export type CodeValueSurface = "default" | "muted" | "elevated";
export type CodeValueTone = "default" | "muted";
export type CodeValueOverflow = "truncate" | "wrap" | "breakAll" | "scroll";
export type CodeValueElement = "code" | "pre" | "span" | "div";

export interface CodeValueClassNameOptions {
  display?: CodeValueDisplay;
  surface?: CodeValueSurface;
  tone?: CodeValueTone;
  overflow?: CodeValueOverflow;
  className?: ClassValue;
}

const CODE_VALUE_BASE_CLASS =
  "min-w-0 select-text rounded-md border border-border font-mono text-[11px]";

const CODE_VALUE_DISPLAY_CLASS: Record<CodeValueDisplay, string> = {
  block: "block w-full px-2.5 py-1.5",
  inline: "inline-block max-w-full px-1.5 py-0.5 align-middle leading-4",
};

const CODE_VALUE_SURFACE_CLASS: Record<CodeValueSurface, string> = {
  default: "bg-bg",
  muted: "bg-bg-sidebar/60",
  elevated: "bg-bg-elevated/60",
};

const CODE_VALUE_TONE_CLASS: Record<CodeValueTone, string> = {
  default: "text-fg",
  muted: "text-fg-muted",
};

const CODE_VALUE_OVERFLOW_CLASS: Record<CodeValueOverflow, string> = {
  truncate: "truncate whitespace-nowrap",
  wrap: "whitespace-pre-wrap break-words",
  breakAll: "whitespace-pre-wrap break-all",
  scroll: "overflow-x-auto whitespace-pre",
};

export function codeValueClassName({
  display = "block",
  surface = "default",
  tone = "default",
  overflow = "truncate",
  className,
}: CodeValueClassNameOptions = {}): string {
  return cn(
    CODE_VALUE_BASE_CLASS,
    CODE_VALUE_DISPLAY_CLASS[display],
    CODE_VALUE_SURFACE_CLASS[surface],
    CODE_VALUE_TONE_CLASS[tone],
    CODE_VALUE_OVERFLOW_CLASS[overflow],
    className,
  );
}

export interface CodeValueProps
  extends Omit<HTMLAttributes<HTMLElement>, "className">,
    CodeValueClassNameOptions {
  as?: CodeValueElement;
  children: ReactNode;
}

export function CodeValue({
  as,
  display = "block",
  surface = "default",
  tone = "default",
  overflow = "truncate",
  className,
  children,
  ...props
}: CodeValueProps) {
  const Component: ElementType = as ?? (display === "inline" ? "span" : "code");

  return (
    <Component
      className={codeValueClassName({
        display,
        surface,
        tone,
        overflow,
        className,
      })}
      {...props}
    >
      {children}
    </Component>
  );
}
