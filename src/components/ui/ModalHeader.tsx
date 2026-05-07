import { X } from "lucide-react";
import { type ReactNode } from "react";

interface ModalHeaderProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Rendered before the close button. Use for action buttons (e.g. external link). */
  actions?: ReactNode;
  titleId?: string;
  onClose: () => void;
}

export function ModalHeader({
  title,
  subtitle,
  icon,
  actions,
  titleId,
  onClose,
}: ModalHeaderProps) {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <div className="min-w-0">
          <h3
            id={titleId}
            className="truncate text-sm font-semibold tracking-tight text-fg"
          >
            {title}
          </h3>
          {subtitle ? (
            <p className="truncate font-mono text-xs text-fg-muted">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded p-1 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
