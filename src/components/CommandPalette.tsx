import { useMemo } from "react";
import { Command, useCommandState } from "cmdk";
import {
  AlertCircle,
  Bell,
  Bot,
  Columns3,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Kanban,
  LayoutTemplate,
  ListChecks,
  ListPlus,
  MessageSquareText,
  Plus,
  RefreshCw,
  Scan,
  Sparkles,
  Terminal,
  Trash2,
  Trees,
} from "lucide-react";
import { RESET_PANEL_SIZES_EVENT } from "../lib/layoutEvents";
import { useAppStore, type WorkspaceViewMode } from "../store";
import { api } from "../lib/api";
import { requestNewAutonomousGoalSession } from "../lib/autonomousGoal";
import { cn } from "../lib/cn";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  buildSessionCreateRequest,
  resolveActiveSessionScope,
} from "../lib/sessionCreation";
import { suggestDefaultSessionName } from "../lib/sessionName";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import type { SessionNotificationKind } from "../lib/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}

type CommandPaletteTranslationKey = Extract<
  TranslationKey,
  `commandPalette.${string}`
>;

function cpt(t: Translator, key: CommandPaletteTranslationKey): string {
  return t(key);
}

function workspaceModeLabel(t: Translator, mode: WorkspaceViewMode): string {
  if (mode === "kanban") return t("workspace.mode.kanban");
  if (mode === "canvas") return t("workspace.mode.canvas");
  return t("workspace.mode.panes");
}

function nextWorkspaceMode(mode: WorkspaceViewMode): WorkspaceViewMode {
  if (mode === "panes") return "kanban";
  if (mode === "kanban") return "canvas";
  return "panes";
}

const ACTIVITY_KIND_KEYS: Record<
  SessionNotificationKind,
  CommandPaletteTranslationKey
> = {
  waiting_for_input: "commandPalette.activity.kind.waitingForInput",
  errored: "commandPalette.activity.kind.errored",
};

function activityKindLabel(
  t: Translator,
  kind: SessionNotificationKind,
): string {
  return cpt(t, ACTIVITY_KIND_KEYS[kind]);
}

function ActivityKindIcon({ kind }: { kind: SessionNotificationKind }) {
  if (kind === "errored") {
    return <AlertCircle size={14} className="text-danger" />;
  }
  return <Bell size={14} className="text-warning" />;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const sessions = useAppStore((s) => s.sessions);
  const notifications = useAppStore((s) => s.sessionNotifications);
  const workspaceViewMode = useAppStore((s) => s.workspaceViewMode);
  const t = useTranslation();
  const nextWorkspaceViewMode: WorkspaceViewMode =
    nextWorkspaceMode(workspaceViewMode);
  const NextWorkspaceViewIcon =
    nextWorkspaceViewMode === "kanban"
      ? Kanban
      : nextWorkspaceViewMode === "canvas"
        ? Scan
        : Columns3;

  // Derived once per render — sessions array identity is stable from zustand
  // until the underlying list actually changes.
  const sessionItems = useMemo(() => sessions, [sessions]);
  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => !notification.readAt),
    [notifications],
  );

  function close() {
    onOpenChange(false);
  }

  // Terminal session actions delegate to Sidebar via window events so the
  // palette matches the hotkey path: when a project is active, Sidebar reuses
  // its repoPath and skips the directory picker.
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

  function handleNewAutonomousGoalSession() {
    requestNewAutonomousGoalSession();
    close();
  }

  async function handleNewChatSession() {
    const show = useToasts.getState().show;
    try {
      const state = useAppStore.getState();
      const scope = resolveActiveSessionScope({
        sessions: state.sessions,
        projects: state.projects,
        activeSessionId: state.activeSessionId,
        activeWorkspaceRepoPath: state.activeProject,
        activeWorkspaceCwdPath: activeProjectFolderCwdPath(state),
        activeProjectFolderId: state.activeProjectFolderId,
      });

      if (!scope) {
        const created = await api.createSessionFromDialog(
          suggestDefaultSessionName(state.sessions),
          false,
          "regular",
          null,
          true,
          undefined,
          "chat",
        );
        if (!created) return;
        await useAppStore.getState().refreshAll();
        useAppStore.getState().selectSession(created.id);
        return;
      }

      const request = buildSessionCreateRequest(
        { sessions: state.sessions, projects: state.projects },
        {
          repoPath: scope.placement.repoPath,
          launch: scope.launch,
          projectScoped: scope.placement.projectScoped,
          mode: "chat",
          projectFolderId: scope.placement.projectFolderId,
        },
      );
      const cwdPath =
        request.cwdPath === request.repoPath ? undefined : request.cwdPath;
      const created = await state.createSession(
        request.name,
        request.repoPath,
        request.isolated,
        request.kind,
        request.agentProvider,
        request.projectScoped,
        request.mode,
        request.projectFolderId,
        cwdPath,
      );
      const error = useAppStore.getState().consumeError();
      if (!created || error) {
        show(`${t("toasts.session.createFailed")} ${error ?? ""}`.trim());
      }
    } catch (err) {
      console.error("[CommandPalette] create chat session failed", err);
      show(`${t("toasts.session.createFailed")} ${String(err)}`);
    } finally {
      close();
    }
  }

  function handleAddProject() {
    window.dispatchEvent(new CustomEvent("acorn:add-project"));
    close();
  }

  function handleNewProject() {
    window.dispatchEvent(new CustomEvent("acorn:new-project"));
    close();
  }

  async function handleRefresh() {
    const show = useToasts.getState().show;
    try {
      await useAppStore.getState().refreshSessions();
      const error = useAppStore.getState().consumeError();
      if (error) show(`${t("toasts.session.refreshFailed")} ${error}`);
    } finally {
      close();
    }
  }

  function handleSelectSession(id: string) {
    useAppStore.getState().openSessionSurface(id);
    close();
  }

  function handleOpenActivity(notificationId: string, sessionId: string) {
    const state = useAppStore.getState();
    state.markSessionNotificationRead(notificationId);
    state.openSessionSurface(sessionId, { centerInCanvas: true });
    close();
  }

  async function handleRemoveSession(id: string) {
    const show = useToasts.getState().show;
    try {
      await useAppStore.getState().removeSession(id);
      const error = useAppStore.getState().consumeError();
      if (error) show(`${t("toasts.session.removeFailed")} ${error}`);
    } finally {
      close();
    }
  }

  function handleSetTab(tab: "todos" | "commits" | "staged" | "prs") {
    useAppStore.getState().setRightTab(tab);
    close();
  }

  function handleToggleWorkspaceView() {
    useAppStore.getState().setWorkspaceViewMode(nextWorkspaceViewMode);
    close();
  }

  function handleResetPanelSizes() {
    window.dispatchEvent(new CustomEvent(RESET_PANEL_SIZES_EVENT));
    close();
  }

  async function handleReloadShellEnv() {
    const show = useToasts.getState().show;
    try {
      await api.reloadShellEnv();
      show(cpt(t, "commandPalette.toasts.shellEnvReloaded"));
    } catch (err) {
      console.error("[CommandPalette] reloadShellEnv failed", err);
      show(cpt(t, "commandPalette.toasts.shellEnvReloadFailed"));
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
      show(cpt(t, "commandPalette.toasts.ipcRestarted"));
    } catch (err) {
      console.error("[CommandPalette] ipcRestart failed", err);
      const message = err instanceof Error ? err.message : String(err);
      show(
        `${cpt(t, "commandPalette.toasts.ipcRestartFailedPrefix")} ${message}`,
      );
    } finally {
      close();
    }
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={cpt(t, "commandPalette.dialogLabel")}
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
          placeholder={cpt(t, "commandPalette.placeholder")}
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
          {cpt(t, "commandPalette.empty")}
        </Command.Empty>

        <Command.Group heading={cpt(t, "commandPalette.groups.sessions")}>
          <Command.Item value="new-session" onSelect={handleNewSession}>
            <Plus size={14} className="text-accent" />
            <span>{cpt(t, "commandPalette.commands.newSession")}</span>
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
            <span>{cpt(t, "commandPalette.commands.newIsolatedSession")}</span>
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
            <span>{cpt(t, "commandPalette.commands.newControlSession")}</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⌥⇧⌘T
            </span>
          </Command.Item>
          <Command.Item
            value="new-chat-session"
            onSelect={handleNewChatSession}
            keywords={["chat", "conversation", "messages"]}
          >
            <MessageSquareText size={14} className="text-accent" />
            <span>{cpt(t, "commandPalette.commands.newChatSession")}</span>
          </Command.Item>
          <Command.Item
            value="new-autonomous-goal-session"
            onSelect={handleNewAutonomousGoalSession}
            keywords={["autonomous", "goal", "agent", "codex", "claude"]}
          >
            <Sparkles size={14} className="text-accent" />
            <span>
              {cpt(t, "commandPalette.commands.newAutonomousGoalSession")}
            </span>
          </Command.Item>
          <Command.Item
            value="new-project"
            onSelect={handleNewProject}
            keywords={["project", "create", "repository", "repo", "folder"]}
          >
            <FolderPlus size={14} className="text-accent" />
            <span>{cpt(t, "commandPalette.commands.newProject")}</span>
          </Command.Item>
          <Command.Item
            value="add-project"
            onSelect={handleAddProject}
            keywords={["project", "import", "repository", "repo", "folder"]}
          >
            <FolderOpen size={14} className="text-accent" />
            <span>{cpt(t, "commandPalette.commands.addExistingProject")}</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⇧⌘N
            </span>
          </Command.Item>
          <Command.Item value="refresh-sessions" onSelect={handleRefresh}>
            <RefreshCw size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.refreshSessions")}</span>
          </Command.Item>
        </Command.Group>

        {sessionItems.length > 0 ? (
          <Command.Group heading={cpt(t, "commandPalette.groups.switchSession")}>
            {sessionItems.map((session) => (
              <Command.Item
                key={`switch-${session.id}`}
                value={`switch ${session.name} ${session.branch}`}
                onSelect={() => handleSelectSession(session.id)}
                keywords={[session.name, session.branch]}
              >
                <Sparkles size={14} className="text-fg-muted" />
                <span className="truncate">
                  {cpt(t, "commandPalette.commands.switchSessionPrefix")}{" "}
                  {session.name}
                </span>
                <span className="ml-auto truncate text-xs text-fg-muted/80">
                  {session.branch}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        {unreadNotifications.length > 0 ? (
          <Command.Group heading={cpt(t, "commandPalette.groups.activity")}>
            {unreadNotifications.map((notification) => (
              <Command.Item
                key={`activity-${notification.id}`}
                value={`activity ${notification.projectName} ${notification.sessionName} ${notification.kind}`}
                onSelect={() =>
                  handleOpenActivity(notification.id, notification.sessionId)
                }
                keywords={[
                  notification.projectName,
                  notification.sessionName,
                  notification.repoPath,
                  notification.kind,
                  activityKindLabel(t, notification.kind),
                  "unread",
                  "activity",
                  "notification",
                ]}
              >
                <ActivityKindIcon kind={notification.kind} />
                <span className="truncate">
                  {activityKindLabel(t, notification.kind)} ·{" "}
                  {notification.sessionName}
                </span>
                <span className="ml-auto truncate text-xs text-fg-muted/80">
                  {notification.projectName}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}

        <Command.Group heading={cpt(t, "commandPalette.groups.view")}>
          <Command.Item
            value="toggle-workspace-view"
            onSelect={handleToggleWorkspaceView}
            keywords={[
              "workspace",
              "view",
              "panes",
              "pane",
              "kanban",
              "board",
              "canvas",
            ]}
          >
            <NextWorkspaceViewIcon size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.toggleWorkspaceView")}</span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              {workspaceModeLabel(t, nextWorkspaceViewMode)}
            </span>
          </Command.Item>
          <Command.Item
            value="view-todos"
            onSelect={() => handleSetTab("todos")}
          >
            <ListChecks size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.viewTodos")}</span>
          </Command.Item>
          <Command.Item
            value="view-commits"
            onSelect={() => handleSetTab("commits")}
          >
            <GitCommit size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.viewCommits")}</span>
          </Command.Item>
          <Command.Item
            value="view-staged"
            onSelect={() => handleSetTab("staged")}
          >
            <ListPlus size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.viewStaged")}</span>
          </Command.Item>
          <Command.Item
            value="view-prs"
            onSelect={() => handleSetTab("prs")}
            keywords={["pull requests", "pr", "github"]}
          >
            <GitPullRequest size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.viewPullRequests")}</span>
          </Command.Item>
          <Command.Item
            value="reset-panel-sizes"
            onSelect={handleResetPanelSizes}
            keywords={[
              "reset",
              "restore",
              "panel",
              "sidebar",
              "layout",
              "size",
              "default",
              "복구",
              "초기화",
            ]}
          >
            <LayoutTemplate size={14} className="text-fg-muted" />
            <span>{cpt(t, "commandPalette.commands.resetPanelSizes")}</span>
          </Command.Item>
        </Command.Group>

        <Command.Group heading={cpt(t, "commandPalette.groups.terminal")}>
          <Command.Item
            value="reload-shell-env"
            onSelect={() => void handleReloadShellEnv()}
            keywords={["dotfile", "zshenv", "lang", "editor", "env", "locale"]}
          >
            <Terminal size={14} className="text-fg-muted" />
            <span>
              {cpt(t, "commandPalette.commands.reloadShellEnvironment")}
            </span>
            <span className="ml-auto truncate text-xs text-fg-muted/80">
              ⇧⌘,
            </span>
          </Command.Item>
        </Command.Group>

        <Command.Group heading={cpt(t, "commandPalette.groups.ipc")}>
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
            <span>{cpt(t, "commandPalette.commands.restartIpcServer")}</span>
          </Command.Item>
        </Command.Group>

        <ShakeTreeItem onSelect={handleShakeTree} t={t} />

        {sessionItems.length > 0 ? (
          <Command.Group heading={cpt(t, "commandPalette.groups.dangerZone")}>
            {sessionItems.map((session) => (
              <Command.Item
                key={`remove-${session.id}`}
                value={`remove ${session.name}`}
                onSelect={() => handleRemoveSession(session.id)}
                keywords={[session.name, "delete", "remove"]}
              >
                <Trash2 size={14} className="text-danger" />
                <span className="truncate">
                  {cpt(t, "commandPalette.commands.removeSessionPrefix")}{" "}
                  {session.name}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}

function activeProjectFolderCwdPath(
  state: ReturnType<typeof useAppStore.getState>,
): string | null {
  const folderId = state.activeProjectFolderId;
  if (!folderId) return null;
  for (const folders of Object.values(state.projectFolders)) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (folder) return folder.cwdPath;
  }
  return null;
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

function ShakeTreeItem({
  onSelect,
  t,
}: {
  onSelect: () => void;
  t: Translator;
}) {
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
      <span>{cpt(t, "commandPalette.commands.shakeTree")}</span>
    </Command.Item>
  );
}
