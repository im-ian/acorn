import { useState, type ReactElement } from "react";
import { CommandRunDialog } from "../CommandRunDialog";
import { cn } from "../../lib/cn";

interface CommandHintProps {
  /**
   * The shell command to suggest. Rendered verbatim in a monospace code
   * block; on click opens [`CommandRunDialog`] so the user can copy or
   * launch it in a fresh terminal session.
   */
  command: string;
  /**
   * Working directory for the "Run" path. When provided, the dialog
   * spawns a regular session rooted here. When null, the dialog falls
   * back to the first known project — the [`CommandRunDialog`] resolves
   * this so callers without an obvious repo context (e.g. global
   * settings) can still surface the hint.
   */
  repoPath: string | null;
  className?: string;
}

/**
 * Inline clickable code block for actionable shell commands surfaced in
 * the UI (e.g. `gh auth login` inside the no-access banner). Clicking
 * opens a confirmation dialog with copy / run actions, so the command
 * never executes from a single accidental click.
 */
export function CommandHint({
  command,
  repoPath,
  className,
}: CommandHintProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Click to copy or run"
        className={cn(
          "inline-flex max-w-full items-center rounded border border-border bg-bg-sidebar/70 px-1.5 py-0.5 text-left font-mono text-[11px] text-fg transition hover:border-accent/60 hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
          className,
        )}
      >
        <span className="truncate">{command}</span>
      </button>
      <CommandRunDialog
        open={open}
        command={command}
        repoPath={repoPath}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
