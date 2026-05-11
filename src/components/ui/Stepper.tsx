import { Minus, Plus } from "lucide-react";

interface StepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /**
   * Optional value formatter for floating-point steppers — keeps the
   * displayed number stable (e.g. 1.05 vs 1.0500000000001) without
   * forcing callers to round their canonical value.
   */
  format?: (v: number) => string;
  onChange: (v: number) => void;
}

export function Stepper({
  value,
  min,
  max,
  step = 1,
  unit,
  format,
  onChange,
}: StepperProps) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  // Round-to-step keeps fractional steps (e.g. 0.05) from accumulating
  // FP drift after many clicks.
  const snap = (n: number) => Math.round(n / step) * step;
  const dec = () => onChange(clamp(snap(value - step)));
  const inc = () => onChange(clamp(snap(value + step)));
  const display = format ? format(value) : String(value);
  return (
    <div className="inline-flex h-7 w-fit items-stretch self-start overflow-hidden rounded-md border border-border bg-bg">
      <button
        type="button"
        onClick={dec}
        disabled={value <= min}
        aria-label="Decrease"
        className="flex w-8 items-center justify-center text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Minus size={12} />
      </button>
      <div className="flex min-w-[3.5rem] items-center justify-center border-x border-border px-2 font-mono text-xs tabular-nums text-fg">
        {display}
        {unit ? <span className="ml-0.5 text-fg-muted">{unit}</span> : null}
      </div>
      <button
        type="button"
        onClick={inc}
        disabled={value >= max}
        aria-label="Increase"
        className="flex w-8 items-center justify-center text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
