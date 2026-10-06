import { cn } from "../../lib/cn";
import { SettingAnchor } from "./settingHighlight";

interface CheckboxRowProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  /** DOM id used by Settings search to scroll this control into view. */
  settingId?: string;
}

export function CheckboxRow({
  label,
  description,
  checked,
  disabled,
  onChange,
  settingId,
}: CheckboxRowProps) {
  const row = (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-bg px-3 py-2 transition",
        disabled && "cursor-not-allowed opacity-50",
        !disabled && "hover:border-fg-muted/40",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="acorn-check mt-0.5"
      />
      <span className="flex flex-col">
        <span className="text-xs font-medium text-fg">{label}</span>
        {description ? (
          <span className="text-[11px] text-fg-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
  if (!settingId) return row;
  return <SettingAnchor id={settingId}>{row}</SettingAnchor>;
}
