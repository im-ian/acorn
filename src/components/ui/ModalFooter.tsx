import { type HTMLAttributes } from "react";
import type { ClassValue } from "clsx";
import { cn } from "../../lib/cn";

export type ModalFooterVariant = "plain" | "sidebar";
export type ModalFooterAlign = "start" | "center" | "end" | "between";

const MODAL_FOOTER_VARIANT_CLASS: Record<ModalFooterVariant, string> = {
  plain: "",
  sidebar: "bg-bg-sidebar/40",
};

const MODAL_FOOTER_ALIGN_CLASS: Record<ModalFooterAlign, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};

export interface ModalFooterClassNameOptions {
  variant?: ModalFooterVariant;
  align?: ModalFooterAlign;
  className?: ClassValue;
}

export function modalFooterClassName({
  variant = "plain",
  align = "end",
  className,
}: ModalFooterClassNameOptions = {}): string {
  return cn(
    "flex items-center gap-2 border-t border-border px-4 py-3",
    MODAL_FOOTER_VARIANT_CLASS[variant],
    MODAL_FOOTER_ALIGN_CLASS[align],
    className,
  );
}

export interface ModalFooterProps
  extends Omit<HTMLAttributes<HTMLElement>, "className">,
    ModalFooterClassNameOptions {}

export function ModalFooter({
  variant,
  align,
  className,
  ...props
}: ModalFooterProps) {
  return (
    <footer
      className={modalFooterClassName({ variant, align, className })}
      {...props}
    />
  );
}
