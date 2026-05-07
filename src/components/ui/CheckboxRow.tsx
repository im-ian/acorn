import { cn } from "../../lib/cn";

interface CheckboxRowProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

export function CheckboxRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: CheckboxRowProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg px-3 py-2 transition",
        disabled && "cursor-not-allowed opacity-50",
        !disabled && "hover:border-fg-muted/40",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span className="flex flex-col">
        <span className="text-xs font-medium text-fg">{label}</span>
        {description ? (
          <span className="text-[11px] text-fg-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
