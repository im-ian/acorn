import { Minus, Plus } from "lucide-react";

interface StepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}

export function Stepper({
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: StepperProps) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const dec = () => onChange(clamp(value - step));
  const inc = () => onChange(clamp(value + step));
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
        {value}
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
