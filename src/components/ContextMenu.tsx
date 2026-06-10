import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

interface ContextMenuButton {
  type?: "button";
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  shortcut?: string;
}

interface ContextMenuSubmenu {
  type: "submenu";
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  children: ContextMenuItem[];
}

interface ContextMenuSeparator {
  type: "separator";
}

interface ContextMenuGroupTitle {
  type: "group-title";
  label: string;
}

export type ContextMenuItem =
  | ContextMenuButton
  | ContextMenuSubmenu
  | ContextMenuSeparator
  | ContextMenuGroupTitle;

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
    <ContextMenuPanel
      panelRef={ref}
      items={items}
      position={position}
      onClose={onClose}
    />,
    document.body,
  );
}

interface ContextMenuPanelProps {
  items: ContextMenuItem[];
  position: { left: number; top: number };
  onClose: () => void;
  panelRef?: React.Ref<HTMLDivElement>;
}

function ContextMenuPanel({
  items,
  position,
  onClose,
  panelRef: outerPanelRef,
}: ContextMenuPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<{
    index: number;
    position: { left: number; top: number };
  } | null>(null);

  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    let left = position.left;
    let top = position.top;
    if (left + rect.width > window.innerWidth - 4) {
      left = Math.max(4, window.innerWidth - rect.width - 4);
    }
    if (top + rect.height > window.innerHeight - 4) {
      top = Math.max(4, window.innerHeight - rect.height - 4);
    }
    if (left !== position.left || top !== position.top) {
      panelRef.current.style.left = `${left}px`;
      panelRef.current.style.top = `${top}px`;
    }
  }, [position.left, position.top]);

  return (
    <div
      ref={(node) => {
        panelRef.current = node;
        if (typeof outerPanelRef === "function") outerPanelRef(node);
        else if (outerPanelRef) outerPanelRef.current = node;
      }}
      role="menu"
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 60,
      }}
      onMouseLeave={() => setActiveSubmenu(null)}
      className="min-w-[11rem] rounded-md border border-border bg-bg-elevated shadow-2xl"
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
          if (item.type === "group-title") {
            return (
              <li
                key={i}
                role="presentation"
                className={cn(
                  "px-2.5 pb-1 text-[10px] font-semibold text-fg-muted/70",
                  i === 0 ? "pt-1" : "pt-2",
                )}
              >
                <span className="block truncate">{item.label}</span>
              </li>
            );
          }
          if (item.type === "submenu") {
            const disabled = item.disabled || item.children.length === 0;
            return (
              <li key={i}>
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={activeSubmenu?.index === i}
                  disabled={disabled}
                  onMouseEnter={(event) => {
                    if (disabled) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    setActiveSubmenu({
                      index: i,
                      position: { left: rect.right - 1, top: rect.top },
                    });
                  }}
                  onFocus={(event) => {
                    if (disabled) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    setActiveSubmenu({
                      index: i,
                      position: { left: rect.right - 1, top: rect.top },
                    });
                  }}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2.5 py-1 text-left transition",
                    disabled
                      ? "cursor-not-allowed text-fg-muted/50"
                      : "text-fg hover:bg-bg-sidebar",
                  )}
                >
                  {item.icon ? (
                    <span className="shrink-0 text-fg-muted">{item.icon}</span>
                  ) : null}
                  <span className="flex-1 truncate">{item.label}</span>
                  <span
                    aria-hidden
                    className={cn(
                      "shrink-0 pl-3 font-sans text-[11px]",
                      disabled ? "text-fg-muted/40" : "text-fg-muted",
                    )}
                  >
                    &gt;
                  </span>
                </button>
                {activeSubmenu?.index === i ? (
                  <ContextMenuPanel
                    items={item.children}
                    position={activeSubmenu.position}
                    onClose={onClose}
                  />
                ) : null}
              </li>
            );
          }
          return (
            <li key={i}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onMouseEnter={() => setActiveSubmenu(null)}
                onFocus={() => setActiveSubmenu(null)}
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
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut ? (
                  <kbd
                    aria-hidden
                    className={cn(
                      "shrink-0 pl-3 font-sans text-[11px] tabular-nums tracking-wide",
                      item.disabled ? "text-fg-muted/40" : "text-fg-muted",
                    )}
                  >
                    {item.shortcut}
                  </kbd>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
