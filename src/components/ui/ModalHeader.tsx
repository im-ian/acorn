import { X } from "lucide-react";
import { type ReactNode } from "react";
import type { TranslationKey, Translator } from "../../lib/i18n";
import { useTranslation } from "../../lib/useTranslation";
import { Tooltip } from "../Tooltip";
import { IconButton } from "./Button";
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
  const closeButton = (
    <div className="flex shrink-0 items-center gap-1">
      {actions}
      <Tooltip
        label={dt(t, "dialogs.common.close")}
        side="bottom"
      >
        <IconButton
          aria-label={dt(t, "dialogs.common.close")}
          onClick={onClose}
          size="sm"
          surface={variant}
        >
          <X size={14} />
        </IconButton>
      </Tooltip>
    </div>
  );

  // Dialog: Soft Minimal seamless header — no divider, the icon sits in a
  // neutral chip centered against the title block, larger title.
  if (variant === "dialog") {
    return (
      <header className="flex shrink-0 items-start justify-between gap-3 px-4 pt-4 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon ? (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-fill">
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h3
              id={titleId}
              className="truncate text-base font-semibold tracking-tight text-fg"
            >
              {title}
            </h3>
            {subtitle ? (
              <div className="truncate text-xs text-fg-muted">{subtitle}</div>
            ) : null}
          </div>
        </div>
        {closeButton}
      </header>
    );
  }

  // Panel: full-height content viewers keep a structural divider so scrolled
  // body content stays separated from the header.
  return (
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        {icon ? (
          <span className="mt-0.5 flex shrink-0 items-center">{icon}</span>
        ) : null}
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
      {closeButton}
    </header>
  );
}
