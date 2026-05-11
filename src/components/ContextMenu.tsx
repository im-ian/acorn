import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

interface ContextMenuButton {
  type?: "button";
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface ContextMenuSeparator {
  type: "separator";
}

export type ContextMenuItem = ContextMenuButton | ContextMenuSeparator;

interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - rect.width - 4);
    }
    if (top + rect.height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - rect.height - 4);
    }
    setPosition({ left, top });
  }, [open, x, y]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 60,
      }}
      className="min-w-[9rem] overflow-hidden rounded-md border border-border bg-bg-elevated shadow-2xl"
    >
      <ul className="py-1 text-[12px]">
        {items.map((item, i) => {
          if (item.type === "separator") {
            return (
              <li
                key={i}
                role="separator"
                aria-orientation="horizontal"
                className="my-1 h-px bg-border"
              />
            );
          }
          return (
            <li key={i}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  onClose();
                  item.onClick();
                }}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2.5 py-1 text-left transition",
                  item.disabled
                    ? "cursor-not-allowed text-fg-muted/50"
                    : "text-fg hover:bg-bg-sidebar",
                )}
              >
                {item.icon ? (
                  <span className="shrink-0 text-fg-muted">{item.icon}</span>
                ) : null}
                <span className="truncate">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
