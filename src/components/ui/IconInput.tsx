import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface IconInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  /** Optional leading adornment (e.g. a `<Search />` icon). */
  leading?: ReactNode;
  /** Optional trailing adornment (toggle buttons, clear button, …). */
  trailing?: ReactNode;
  /** Adds a danger-colored border + input text to signal an error. */
  invalid?: boolean;
}

/**
 * Shared input shell that wraps a bare `<input>` with optional leading
 * and trailing adornments. Visual baseline (height, radius, border,
 * background, focus ring) matches `TextInput` so search/filter rows in
 * sidebar-style surfaces stay consistent with form rows in dialogs.
 */
export const IconInput = forwardRef<HTMLInputElement, IconInputProps>(
  function IconInput(
    { leading, trailing, invalid, className, type = "text", spellCheck = false, ...rest },
    ref,
  ) {
    return (
      <div
        className={cn(
          "flex h-7 items-center gap-1 rounded-md border bg-bg px-2 focus-within:border-accent",
          invalid ? "border-rose-500/60" : "border-border",
          className,
        )}
      >
        {leading ? (
          <span className="shrink-0 text-fg-muted">{leading}</span>
        ) : null}
        <input
          ref={ref}
          type={type}
          spellCheck={spellCheck}
          className={cn(
            "flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-fg-muted/60",
            invalid ? "text-rose-400" : "text-fg",
          )}
          {...rest}
        />
        {trailing ? (
          <span className="flex shrink-0 items-center gap-1">{trailing}</span>
        ) : null}
      </div>
    );
  },
);
