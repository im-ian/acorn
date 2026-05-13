import { useMemo } from "react";
import { Command, useCommandState } from "cmdk";
import {
  Bot,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitPullRequest,
  ListChecks,
  ListPlus,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
  Trash2,
  Trees,
} from "lucide-react";
import { useAppStore } from "../store";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useToasts } from "../lib/toasts";

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

  // Session-creation actions delegate to Sidebar via window events so the
  // palette matches the hotkey path: when a project is active, Sidebar reuses
  // its repoPath and skips the directory picker. Duplicating the dialog/create
  // logic here previously made these items ignore activeProject and always
  // prompt for a directory, which felt like a project-import flow.
  function handleNewSession() {
    window.dispatchEvent(new CustomEvent("acorn:new-session"));
    close();
  }

  function handleNewIsolatedSession() {
    window.dispatchEvent(new CustomEvent("acorn:new-isolated-session"));
    close();
  }

  function handleNewControlSession() {
    window.dispatchEvent(new CustomEvent("acorn:new-control-session"));
    close();
  }

  function handleAddProject() {
    window.dispatchEvent(new CustomEvent("acorn:add-project"));
    close();
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

  function handleShakeTree() {
    window.dispatchEvent(new CustomEvent("acorn:shake-tree"));
    close();
  }

  async function handleRestartIpc() {
    const show = useToasts.getState().show;
    try {
      await api.ipcRestart();
      show("IPC server restarted.");
    } catch (err) {
      console.error("[CommandPalette] ipcRestart failed", err);
      const message = err instanceof Error ? err.message : String(err);
      show(`Failed to restart IPC server: ${message}`);
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
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⌘T
            </span>
          </Command.Item>
          <Command.Item
            value="new-isolated-session"
            onSelect={handleNewIsolatedSession}
            keywords={["worktree", "isolated", "branch"]}
          >
            <GitBranch size={14} className="text-accent" />
            <span>New isolated session</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⌥⌘T
            </span>
          </Command.Item>
          <Command.Item
            value="new-control-session"
            onSelect={handleNewControlSession}
            keywords={["control", "ipc", "dispatcher", "orchestrator"]}
          >
            <Bot size={14} className="text-accent" />
            <span>New control session</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⌥⇧⌘T
            </span>
          </Command.Item>
          <Command.Item
            value="add-project"
            onSelect={handleAddProject}
            keywords={["project", "import", "repository", "repo", "folder"]}
          >
            <FolderPlus size={14} className="text-accent" />
            <span>Add project</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⇧⌘N
            </span>
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

        <Command.Group heading="IPC">
          <Command.Item
            value="restart-ipc"
            onSelect={() => void handleRestartIpc()}
            keywords={[
              "ipc",
              "control",
              "socket",
              "acorn-ipc",
              "restart",
              "reload",
              "server",
            ]}
          >
            <Bot size={14} className="text-accent" />
            <span>Restart IPC server</span>
          </Command.Item>
        </Command.Group>

        <ShakeTreeItem onSelect={handleShakeTree} />

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
// Hidden palette entry. Only renders when the user has typed at least 2
// characters and the query matches one of the easter-egg trigger words.
const SHAKE_TRIGGERS = [
  "shake",
  "tree",
  "shake tree",
  "나무",
  "흔들",
  "나무 흔들기",
  "acorn",
  "rain",
  "easter",
  "도토리",
];

function ShakeTreeItem({ onSelect }: { onSelect: () => void }) {
  const search = useCommandState(
    (state: { search: string }) => state.search,
  ) as string | undefined;
  const q = (search ?? "").toLowerCase().trim();
  const visible =
    q.length >= 2 &&
    SHAKE_TRIGGERS.some((t) => t.startsWith(q) || q.includes(t));
  if (!visible) return null;
  return (
    <Command.Item
      value="shake-tree-acorn-rain"
      onSelect={onSelect}
      keywords={SHAKE_TRIGGERS}
    >
      <Trees size={14} className="text-accent" />
      <span>Shake the tree</span>
    </Command.Item>
  );
}
