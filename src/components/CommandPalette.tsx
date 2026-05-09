import { useMemo } from "react";
import { Command } from "cmdk";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  GitCommit,
  GitPullRequest,
  ListChecks,
  ListPlus,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
  Trash2,
} from "lucide-react";
import { useAppStore } from "../store";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useToasts } from "../lib/toasts";
import type { Session } from "../lib/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const sessions = useAppStore((s) => s.sessions);

  // Derived once per render — sessions array identity is stable from zustand
  // until the underlying list actually changes.
  const sessionItems = useMemo(() => sessions, [sessions]);

  function close() {
    onOpenChange(false);
  }

  async function handleNewSession() {
    try {
      const repoPath = await openDialog({
        directory: true,
        multiple: false,
        title: "Select a git repository",
      });
      if (!repoPath || typeof repoPath !== "string") {
        close();
        return;
      }
      const name = deriveSessionName(repoPath, sessionItems);
      await useAppStore.getState().createSession(name, repoPath);
    } finally {
      close();
    }
  }

  async function handleRefresh() {
    try {
      await useAppStore.getState().refreshSessions();
    } finally {
      close();
    }
  }

  function handleSelectSession(id: string) {
    useAppStore.getState().selectSession(id);
    close();
  }

  async function handleRemoveSession(id: string) {
    try {
      await useAppStore.getState().removeSession(id);
    } finally {
      close();
    }
  }

  function handleSetTab(tab: "todos" | "commits" | "staged" | "prs") {
    useAppStore.getState().setRightTab(tab);
    close();
  }

  async function handleReloadShellEnv() {
    const show = useToasts.getState().show;
    try {
      await api.reloadShellEnv();
      show("Shell environment reloaded. Open a new session to apply.");
    } catch (err) {
      console.error("[CommandPalette] reloadShellEnv failed", err);
      show("Failed to reload shell environment.");
    } finally {
      close();
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
      contentClassName={cn(
        "fixed inset-x-0 top-0 z-50 mx-auto mt-32 max-w-lg",
        "rounded-lg border border-border bg-bg-elevated text-fg shadow-2xl",
        "overflow-hidden",
      )}
      loop
    >
      <div className="border-b border-border px-3 py-2">
        <Command.Input
          autoFocus
          placeholder="Type a command or search..."
          className={cn(
            "w-full bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted",
            "py-1.5",
          )}
        />
      </div>

      <Command.List
        className={cn(
          "max-h-80 overflow-y-auto p-1",
          // Style cmdk items via data attributes
          "[&_[cmdk-item]]:flex [&_[cmdk-item]]:items-center [&_[cmdk-item]]:gap-2",
          "[&_[cmdk-item]]:cursor-pointer [&_[cmdk-item]]:select-none",
          "[&_[cmdk-item]]:rounded-md [&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2",
          "[&_[cmdk-item]]:text-sm [&_[cmdk-item]]:text-fg-muted",
          "[&_[cmdk-item][data-selected='true']]:bg-bg-sidebar",
          "[&_[cmdk-item][data-selected='true']]:text-fg",
          "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3",
          "[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium",
          "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider",
          "[&_[cmdk-group-heading]]:text-fg-muted/70",
        )}
      >
        <Command.Empty className="px-3 py-6 text-center text-sm text-fg-muted">
          No results.
        </Command.Empty>

        <Command.Group heading="Sessions">
          <Command.Item value="new-session" onSelect={handleNewSession}>
            <Plus size={14} className="text-accent" />
            <span>New session</span>
          </Command.Item>
          <Command.Item value="refresh-sessions" onSelect={handleRefresh}>
            <RefreshCw size={14} className="text-fg-muted" />
            <span>Refresh sessions</span>
          </Command.Item>
        </Command.Group>

        {sessionItems.length > 0 ? (
          <Command.Group heading="Switch session">
            {sessionItems.map((session) => (
              <Command.Item
                key={`switch-${session.id}`}
                value={`switch ${session.name} ${session.branch}`}
                onSelect={() => handleSelectSession(session.id)}
                keywords={[session.name, session.branch]}
              >
                <Sparkles size={14} className="text-fg-muted" />
                <span className="truncate">Switch to {session.name}</span>
                <span className="ml-auto truncate text-xs text-fg-muted/80">
                  {session.branch}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading="View">
          <Command.Item
            value="view-todos"
            onSelect={() => handleSetTab("todos")}
          >
            <ListChecks size={14} className="text-fg-muted" />
            <span>View Todos</span>
          </Command.Item>
          <Command.Item
            value="view-commits"
            onSelect={() => handleSetTab("commits")}
          >
            <GitCommit size={14} className="text-fg-muted" />
            <span>View Commits</span>
          </Command.Item>
          <Command.Item
            value="view-staged"
            onSelect={() => handleSetTab("staged")}
          >
            <ListPlus size={14} className="text-fg-muted" />
            <span>View Staged</span>
          </Command.Item>
          <Command.Item
            value="view-prs"
            onSelect={() => handleSetTab("prs")}
            keywords={["pull requests", "pr", "github"]}
          >
            <GitPullRequest size={14} className="text-fg-muted" />
            <span>View Pull Requests</span>
          </Command.Item>
        </Command.Group>

        <Command.Group heading="Terminal">
          <Command.Item
            value="reload-shell-env"
            onSelect={() => void handleReloadShellEnv()}
            keywords={["dotfile", "zshenv", "lang", "editor", "env", "locale"]}
          >
            <Terminal size={14} className="text-fg-muted" />
            <span>Reload shell environment</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⇧⌘,
            </span>
          </Command.Item>
        </Command.Group>

        {sessionItems.length > 0 ? (
          <Command.Group heading="Danger zone">
            {sessionItems.map((session) => (
              <Command.Item
                key={`remove-${session.id}`}
                value={`remove ${session.name}`}
                onSelect={() => handleRemoveSession(session.id)}
                keywords={[session.name, "delete", "remove"]}
              >
                <Trash2 size={14} className="text-danger" />
                <span className="truncate">
                  Remove session: {session.name}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}

function deriveSessionName(repoPath: string, existing: Session[]): string {
  const base =
    repoPath.split(/[\\/]/).filter(Boolean).pop() ??
    `session-${existing.length + 1}`;
  let candidate = base;
  let n = 2;
  const taken = new Set(existing.map((s) => s.name));
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}
