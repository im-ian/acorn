import { useAppStore } from "../store";

export function TopBar() {
  const { sessions, activeSessionId } = useAppStore();
  const active = sessions.find((s) => s.id === activeSessionId);

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-bg-elevated px-4">
      <div className="flex items-center gap-2">
        <span className="size-3 rounded-full bg-accent" />
        <span className="font-mono text-sm font-semibold tracking-tight text-fg">
          Acorn
        </span>
        {import.meta.env.DEV ? (
          <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-normal text-accent">
            ai-support
          </span>
        ) : null}
      </div>
      <div className="h-4 w-px bg-border" />
      {active ? (
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-fg">{active.name}</span>
          <span className="text-fg-muted">·</span>
          <span className="truncate font-mono text-xs text-fg-muted">
            {active.worktree_path}
          </span>
        </div>
      ) : (
        <span className="text-sm text-fg-muted">No session selected</span>
      )}
    </header>
  );
}
