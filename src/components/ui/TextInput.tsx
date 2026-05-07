import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export const TEXT_INPUT_CLASS =
  "h-7 w-full rounded-md border border-border bg-bg px-2 font-mono text-xs text-fg outline-none focus:border-accent";

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput({ className, type = "text", spellCheck = false, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        spellCheck={spellCheck}
        className={cn(TEXT_INPUT_CLASS, className)}
        {...rest}
      />
    );
  },
);
