import { cn } from "../../lib/cn";

interface RadioCardProps<T extends string> {
  name: string;
  value: T;
  current: T;
  label: string;
  description?: string;
  onSelect: (v: T) => void;
}

export function RadioCard<T extends string>({
  name,
  value,
  current,
  label,
  description,
  onSelect,
}: RadioCardProps<T>) {
  const active = current === value;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition",
        active
          ? "border-accent/60 bg-accent/10"
          : "border-border bg-bg hover:border-fg-muted/40",
      )}
    >
      <input
        type="radio"
        name={name}
        checked={active}
        onChange={() => onSelect(value)}
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
