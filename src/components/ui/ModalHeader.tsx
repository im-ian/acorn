import { X } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { TranslationKey, Translator } from "../../lib/i18n";
import { useTranslation } from "../../lib/useTranslation";
import { type ModalVariant } from "./Modal";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface ModalHeaderProps {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Rendered before the close button. Use for action buttons (e.g. external link). */
  actions?: ReactNode;
  titleId?: string;
  /**
   * Surface variant for hover styling. "dialog" sits on bg-bg-elevated and
   * hovers go darker; "panel" sits on bg-bg and hovers go lighter.
   */
  variant?: ModalVariant;
  onClose: () => void;
}

export function ModalHeader({
  title,
  subtitle,
  icon,
  actions,
  titleId,
  variant = "panel",
  onClose,
}: ModalHeaderProps) {
  const t = useTranslation();
  const hoverBg =
    variant === "dialog" ? "hover:bg-bg-sidebar" : "hover:bg-bg-elevated";
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
            <div className="truncate text-xs text-fg-muted">{subtitle}</div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <button
          type="button"
          aria-label={dt(t, "dialogs.common.close")}
          onClick={onClose}
          className={cn(
            "rounded p-1 text-fg-muted transition hover:text-fg",
            hoverBg,
          )}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
