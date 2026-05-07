import { type ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-fg-muted">{hint}</span> : null}
    </div>
  );
}
