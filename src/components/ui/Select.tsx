import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const SELECT_CLASS =
  "h-7 rounded-md border border-border bg-bg px-2 font-mono text-xs text-fg outline-none focus:border-accent";

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(SELECT_CLASS, className)} {...rest}>
        {children}
      </select>
    );
  },
);
