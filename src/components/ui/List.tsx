import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn";

export type ListBoxInset = "none" | "default" | "sidebar" | "nested";
export type ListBoxLayout = "block" | "flex";
export type ListBoxSpacing = "none" | "tight" | "normal";
export type ListBoxText = "none" | "xs";

export type ListRowDensity =
  | "none"
  | "default"
  | "balanced"
  | "compact"
  | "sidebar";
export type ListRowSurface = "panel" | "dialog" | "subtle" | "sidebar";

const LIST_BOX_INSET_CLASS: Record<ListBoxInset, string> = {
  none: "",
  default: "px-1 py-1",
  sidebar: "px-1.5 pb-1.5 pt-1",
  nested: "pl-1 pt-0.5",
};

const LIST_BOX_TEXT_CLASS: Record<ListBoxText, string> = {
  none: "",
  xs: "text-xs",
};

const LIST_BOX_SPACING_CLASS: Record<
  ListBoxLayout,
  Record<ListBoxSpacing, string>
> = {
  block: {
    none: "",
    tight: "space-y-0.5",
    normal: "space-y-1.5",
  },
  flex: {
    none: "flex flex-col",
    tight: "flex flex-col gap-0.5",
    normal: "flex flex-col gap-1.5",
  },
};

const LIST_ROW_DENSITY_CLASS: Record<ListRowDensity, string> = {
  none: "",
  default: "px-3 py-2",
  balanced: "p-2",
  compact: "px-3 py-1.5",
  sidebar: "px-2 py-1",
};

const LIST_ROW_INTERACTIVE_CLASS: Record<ListRowSurface, string> = {
  panel: "hover:bg-bg-elevated/60 focus-visible:bg-bg-elevated/60",
  dialog: "hover:bg-bg-sidebar focus-visible:bg-bg-sidebar",
  subtle: "hover:bg-bg-elevated/40 focus-visible:bg-bg-elevated/40",
  sidebar: "hover:bg-bg-elevated/40 focus-visible:bg-bg-elevated/40",
};

interface ListBoxClassOptions {
  inset?: ListBoxInset;
  layout?: ListBoxLayout;
  spacing?: ListBoxSpacing;
  text?: ListBoxText;
  className?: string;
}

export function listBoxClassName({
  inset = "default",
  layout = "block",
  spacing = "tight",
  text = "xs",
  className,
}: ListBoxClassOptions = {}): string {
  return cn(
    LIST_BOX_SPACING_CLASS[layout][spacing],
    LIST_BOX_INSET_CLASS[inset],
    LIST_BOX_TEXT_CLASS[text],
    className,
  );
}

interface ListRowClassOptions {
  density?: ListRowDensity;
  surface?: ListRowSurface;
  interactive?: boolean;
  selected?: boolean;
  selectedClassName?: string;
  disabled?: boolean;
  className?: string;
}

export function listRowClassName({
  density = "default",
  surface = "panel",
  interactive = false,
  selected = false,
  selectedClassName = "bg-bg-elevated",
  disabled = false,
  className,
}: ListRowClassOptions = {}): string {
  return cn(
    "rounded-md",
    LIST_ROW_DENSITY_CLASS[density],
    interactive && "transition focus-visible:outline-none",
    interactive && LIST_ROW_INTERACTIVE_CLASS[surface],
    selected && selectedClassName,
    disabled && "opacity-60",
    className,
  );
}

interface ListBoxProps extends HTMLAttributes<HTMLUListElement> {
  inset?: ListBoxInset;
  layout?: ListBoxLayout;
  spacing?: ListBoxSpacing;
  text?: ListBoxText;
}

export function ListBox({
  inset,
  layout,
  spacing,
  text,
  className,
  ...props
}: ListBoxProps) {
  return (
    <ul
      className={listBoxClassName({
        inset,
        layout,
        spacing,
        text,
        className,
      })}
      {...props}
    />
  );
}

interface ListRowProps extends HTMLAttributes<HTMLLIElement> {
  density?: ListRowDensity;
  surface?: ListRowSurface;
  interactive?: boolean;
  selected?: boolean;
  selectedClassName?: string;
  disabled?: boolean;
}

export function ListRow({
  density,
  surface,
  interactive,
  selected,
  selectedClassName,
  disabled,
  className,
  ...props
}: ListRowProps) {
  return (
    <li
      className={listRowClassName({
        density,
        surface,
        interactive,
        selected,
        selectedClassName,
        disabled,
        className,
      })}
      {...props}
    />
  );
}

interface ListRowButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  density?: ListRowDensity;
  surface?: ListRowSurface;
  selected?: boolean;
  selectedClassName?: string;
  disabled?: boolean;
}

export function ListRowButton({
  density,
  surface,
  selected,
  selectedClassName,
  disabled,
  className,
  type = "button",
  ...props
}: ListRowButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={listRowClassName({
        density,
        surface,
        interactive: true,
        selected,
        selectedClassName,
        disabled,
        className: cn("w-full text-left", className),
      })}
      {...props}
    />
  );
}

interface ListActionRowProps extends ListRowProps {
  onOpen: () => void;
}

export function ListActionRow({
  onOpen,
  onDoubleClick,
  onKeyDown,
  interactive = true,
  ...props
}: ListActionRowProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <ListRow
      role="button"
      tabIndex={0}
      interactive={interactive}
      onDoubleClick={onDoubleClick ?? onOpen}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

interface ListEmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function ListEmptyState({
  className,
  children,
  ...props
}: ListEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center px-4 text-center text-xs leading-5 text-fg-muted",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
