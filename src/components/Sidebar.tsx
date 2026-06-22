import {
  Activity,
  Bot,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Home,
  LayoutPanelLeft,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  PencilLine,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { homeDir } from "@tauri-apps/api/path";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "../store";
import {
  AgentProviderIcon,
  resolveSessionAgentProvider,
} from "../lib/agentProvider";
import { api, type WorktreeRemoval } from "../lib/api";
import { cn } from "../lib/cn";
import { openInConfiguredEditor } from "../lib/editor";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  useSettings,
  resolveAiExecutionRequest,
  resolveSessionTitlePrompt,
  type AcornSettings,
  type SessionTitleSource,
} from "../lib/settings";
import {
  canRegenerateSessionTitle,
  canRenameSession,
} from "../lib/sessionTitle";
import {
  hasRecordedWorktree,
  shouldAutoDeleteSessionWorktree,
} from "../lib/sessionWorktree";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { showWorktreeRemovalToast } from "../lib/operationToasts";
import {
  buildLocalSessions,
} from "../lib/sessionGrouping";
import {
  buildLocalSessionFolderGroups,
  buildProjectFolderGroups,
  defaultProjectFolderId,
  findProjectFolderById,
  isDefaultProjectFolder,
  type ProjectFolder,
  type ProjectFolderGroup,
  type ProjectFolderProjectGroup,
} from "../lib/projectFolders";
import {
  applySessionCreateRequest,
  buildSessionCreateRequest,
  resolveActiveSessionScope,
  scopeWithProjectRootLaunch,
  type SessionCreateScope,
} from "../lib/sessionCreation";
import {
  PROJECT_SESSION_CREATE_ACTIONS,
  PROJECT_SESSION_CREATE_MENU,
  type ProjectSessionCreateAction,
  type ProjectSessionCreateMenuItem,
} from "../lib/projectSessionCreateActions";
import {
  planChevronClick,
  planTitleClick,
  type ProjectClickPlan,
} from "../lib/sidebar-actions";
import type {
  Session,
  SessionAgentProvider,
  SessionKind,
  SessionMode,
  SessionStatus,
} from "../lib/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import { RemoveProjectFolderDialog } from "./RemoveProjectFolderDialog";
import { SessionTitleGeneratingIndicator } from "./SessionTitleGeneratingIndicator";
import { Tooltip } from "./Tooltip";

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-fg-muted",
  running: "bg-accent animate-pulse",
  needs_input: "bg-warning",
  failed: "bg-danger",
  completed: "bg-accent/60",
};

const STATUS_ICON: Record<SessionStatus, string> = {
  idle: "text-fg-muted",
  running: "text-accent animate-pulse",
  needs_input: "text-warning",
  failed: "text-danger",
  completed: "text-accent/60",
};

const COLLAPSED_KEY = "acorn:sidebar:collapsed-projects";
const FOLDER_COLLAPSED_KEY = "acorn:sidebar:collapsed-project-folders";
const PROJECT_ITEM_ORDER_KEY = "acorn:sidebar:project-item-order";

const PROJECT_DRAG_PREFIX = "project:";
const FOLDER_DRAG_PREFIX = "folder:";
const SESSION_DRAG_PREFIX = "session:";
const SESSION_FOLDER_DROP_PREFIX = `${SESSION_DRAG_PREFIX}folder:`;
const SESSION_PROJECT_DROP_PREFIX = `${SESSION_DRAG_PREFIX}project:`;
const LOCAL_SESSION_ROOT_DROP_ID = "__local-session-root__";
const LOCAL_TERMINAL_AREA_SELECTOR = "[data-local-terminal-area='true']";

type SidebarTranslationKey = Extract<TranslationKey, `sidebar.${string}`>;

function sidebarText(t: Translator, key: SidebarTranslationKey): string {
  return t(key);
}

type SidebarContextMenuGroup =
  | "session"
  | "workspace"
  | "project"
  | "open"
  | "copy"
  | "danger";

function contextMenuGroupTitle(
  t: Translator,
  group: SidebarContextMenuGroup,
): ContextMenuItem {
  return {
    type: "group-title",
    label: sidebarText(t, `sidebar.contextMenu.${group}`),
  };
}

function statusLabel(t: Translator, status: SessionStatus): string {
  return sidebarText(t, `sidebar.status.${status}`);
}

function isLocalTerminalAreaFocused(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active instanceof HTMLElement
    ? active.closest(LOCAL_TERMINAL_AREA_SELECTOR) !== null
    : false;
}

export function Sidebar() {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const projectFolders = useAppStore((s) => s.projectFolders);
  const sessionFolderIds = useAppStore((s) => s.sessionFolderIds);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeProject = useAppStore((s) => s.activeProject);
  const activeProjectFolderId = useAppStore((s) => s.activeProjectFolderId);
  const selectSession = useAppStore((s) => s.selectSession);
  const focusLocalSessions = useAppStore((s) => s.focusLocalSessions);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  const setActiveProjectFolder = useAppStore((s) => s.setActiveProjectFolder);
  const createProjectFolder = useAppStore((s) => s.createProjectFolder);
  const renameProjectFolder = useAppStore((s) => s.renameProjectFolder);
  const removeProjectFolder = useAppStore((s) => s.removeProjectFolder);
  const removeSession = useAppStore((s) => s.removeSession);
  const confirmDeleteIsolatedWorktrees = useSettings(
    (s) => s.settings.sessions.confirmDeleteIsolatedWorktrees,
  );
  const confirmDeleteEmptyWorktreeWorkspaces = useSettings(
    (s) => s.settings.sessions.confirmDeleteEmptyWorktreeWorkspaces,
  );
  const deleteIsolatedWorktreesWithoutPrompt =
    !confirmDeleteIsolatedWorktrees;
  const deleteEmptyWorktreeWorkspacesWithoutPrompt =
    !confirmDeleteEmptyWorktreeWorkspaces;
  const moveSessionToProjectFolder = useAppStore(
    (s) => s.moveSessionToProjectFolder,
  );
  const createSession = useAppStore((s) => s.createSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const requestRemoveProject = useAppStore((s) => s.requestRemoveProject);
  const addProject = useAppStore((s) => s.addProject);
  const createNewProject = useAppStore((s) => s.createNewProject);
  const reorderProjects = useAppStore((s) => s.reorderProjects);
  const reorderProjectFolders = useAppStore((s) => s.reorderProjectFolders);
  const reorderSessions = useAppStore((s) => s.reorderSessions);
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    loadStringSet(COLLAPSED_KEY),
  );
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() =>
    loadStringSet(FOLDER_COLLAPSED_KEY),
  );
  const [projectItemOrders, setProjectItemOrders] =
    useState<Record<string, string[]>>(() =>
      loadStringArrayRecord(PROJECT_ITEM_ORDER_KEY),
    );
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [settingsProject, setSettingsProject] =
    useState<ProjectFolderProjectGroup | null>(null);
  const [pendingRemoveProjectFolderId, setPendingRemoveProjectFolderId] =
    useState<string | null>(null);

  useEffect(() => {
    saveStringSet(COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  useEffect(() => {
    saveStringSet(FOLDER_COLLAPSED_KEY, collapsedFolders);
  }, [collapsedFolders]);

  useEffect(() => {
    saveStringArrayRecord(PROJECT_ITEM_ORDER_KEY, projectItemOrders);
  }, [projectItemOrders]);

  const projectGroups = useMemo(
    () =>
      buildProjectFolderGroups(
        projects,
        sessions,
        projectFolders,
        sessionFolderIds,
      ),
    [projectFolders, projects, sessionFolderIds, sessions],
  );
  const localWorkspaceGroups = useMemo(
    () =>
      buildLocalSessionFolderGroups(
        projects,
        sessions,
        projectFolders,
        sessionFolderIds,
      ),
    [projectFolders, projects, sessionFolderIds, sessions],
  );
  const allWorkspaceGroups = useMemo(
    () => [...projectGroups, ...localWorkspaceGroups],
    [localWorkspaceGroups, projectGroups],
  );
  const pendingRemoveProjectFolderGroup = useMemo(() => {
    if (!pendingRemoveProjectFolderId) return null;
    for (const project of allWorkspaceGroups) {
      const folderGroup = project.folders.find(
        (candidate) =>
          candidate.folder.id === pendingRemoveProjectFolderId,
      );
      if (folderGroup) return folderGroup;
    }
    return null;
  }, [allWorkspaceGroups, pendingRemoveProjectFolderId]);
  const localSessions = useMemo(
    () => buildLocalSessions(sessions),
    [sessions],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 5px movement avoids hijacking clicks on the project header / session row.
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function expandProject(repoPath: string) {
    setCollapsed((prev) => {
      if (!prev.has(repoPath)) return prev;
      const next = new Set(prev);
      next.delete(repoPath);
      return next;
    });
  }

  function collapseProject(repoPath: string) {
    setCollapsed((prev) => {
      if (prev.has(repoPath)) return prev;
      const next = new Set(prev);
      next.add(repoPath);
      return next;
    });
  }

  function toggleProjectFolder(folderId: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function applyClickPlan(
    plan: ProjectClickPlan,
    project: ProjectFolderProjectGroup,
  ) {
    if (plan.collapseChange === "expand") {
      expandProject(project.repoPath);
    } else if (plan.collapseChange === "collapse") {
      collapseProject(project.repoPath);
    }
    if (plan.shouldActivate) {
      setActiveProject(project.repoPath);
      const target = pickSessionToActivate(project.sessions, activeSessionId);
      if (target) selectSession(target);
    }
  }

  async function onAddExistingProject() {
    try {
      await addProject(sidebarText(t, "sidebar.dialog.selectExistingProject"));
      const error = useAppStore.getState().consumeError();
      if (error) showToast(`${t("toasts.project.addFailed")} ${error}`);
    } catch (e) {
      console.error("add project failed", e);
      showToast(`${t("toasts.project.addFailed")} ${String(e)}`);
    }
  }

  async function onAddProjectFolder(repoPath: string) {
    try {
      const folder = createProjectFolder(repoPath);
      if (!folder) return;
      expandProject(repoPath);
      setActiveProjectFolder(folder.id);
    } catch (e) {
      console.error("create project folder failed", e);
      showToast(`${t("toasts.project.createFailed")} ${String(e)}`);
    }
  }

  async function onAddLocalWorkspace() {
    try {
      const home = await homeDir();
      if (!home) return;
      const folder = createProjectFolder(home);
      if (!folder) return;
      setActiveProjectFolder(folder.id);
    } catch (e) {
      console.error("create local workspace failed", e);
      showToast(`${t("toasts.project.createFailed")} ${String(e)}`);
    }
  }

  async function onAddProjectFolderWorktree(repoPath: string) {
    try {
      const request = buildSessionCreateRequest(
        { sessions, projects },
        {
          repoPath,
          isolated: true,
          kind: "regular",
          mode: "terminal",
          projectScoped: true,
        },
      );
      const created = await applySessionCreateRequest(createSession, request);
      const error = useAppStore.getState().consumeError();
      if (!created || error) {
        showToast(`${t("toasts.session.createFailed")} ${error ?? ""}`.trim());
        return;
      }
      const folder = createProjectFolder(
        created.repo_path,
        created.name,
        created.worktree_path,
      );
      if (!folder) return;
      moveSessionToProjectFolder(created.id, folder.id);
      expandProject(created.repo_path);
      setActiveProjectFolder(folder.id);
      selectSession(created.id);
    } catch (e) {
      console.error("create project worktree folder failed", e);
      showToast(`${t("toasts.session.createFailed")} ${String(e)}`);
    }
  }

  async function removeProjectFolderAndSessions(
    folderGroup: ProjectFolderGroup,
  ) {
    try {
      const removedWorktrees: WorktreeRemoval[] = [];
      for (const session of folderGroup.sessions) {
        const currentState = useAppStore.getState();
        const removedWorktree = await removeSession(
          session.id,
          deleteIsolatedWorktreesWithoutPrompt &&
            shouldAutoDeleteSessionWorktree(
              session,
              currentState.projectFolders,
              currentState.sessions,
            ),
        );
        if (removedWorktree) {
          removedWorktrees.push(removedWorktree);
        }
        const error = useAppStore.getState().consumeError();
        if (error) {
          showToast(`${t("toasts.session.removeFailed")} ${error}`);
          return;
        }
      }
      removeProjectFolder(folderGroup.folder.id);
      if (removedWorktrees.length > 0) {
        showWorktreeRemovalToast(
          removedWorktrees,
          "toasts.project.worktreesRemoved",
          "toasts.project.worktreesRemovedUndo",
          "toasts.project.worktreesRestored",
          "toasts.project.worktreesRestoreFailed",
        );
      }
    } catch (e) {
      console.error("remove project folder failed", e);
      showToast(`${t("toasts.session.removeFailed")} ${String(e)}`);
    }
  }

  async function removeProjectFolderAndWorktree(folder: ProjectFolder) {
    try {
      const removedWorktree = await api.removeWorktree(
        folder.repoPath,
        folder.cwdPath,
      );
      removeProjectFolder(folder.id);
      showWorktreeRemovalToast(
        removedWorktree,
        "toasts.session.worktreeRemoved",
        "toasts.session.worktreeRemovedUndo",
        "toasts.session.worktreeRestored",
        "toasts.session.worktreeRestoreFailed",
        {
          onRestored: () => {
            const restored = createProjectFolder(
              folder.repoPath,
              folder.name,
              folder.cwdPath,
            );
            if (restored) {
              setActiveProjectFolder(restored.id);
            }
          },
        },
      );
    } catch (e) {
      console.error("remove project folder worktree failed", e);
      showToast(`${t("toasts.session.worktreeRemoveFailed")} ${String(e)}`);
    }
  }

  function requestRemoveProjectFolder(folderId: string) {
    const folderGroup = [...projectGroups, ...localWorkspaceGroups]
      .flatMap((project) => project.folders)
      .find((candidate) => candidate.folder.id === folderId);
    if (!folderGroup) return;
    if (folderGroup.sessions.length === 0) {
      if (isWorktreeWorkspace(folderGroup.folder)) {
        if (deleteEmptyWorktreeWorkspacesWithoutPrompt) {
          void removeProjectFolderAndWorktree(folderGroup.folder);
        } else {
          setPendingRemoveProjectFolderId(folderGroup.folder.id);
        }
        return;
      }
      removeProjectFolder(folderGroup.folder.id);
      return;
    }
    setPendingRemoveProjectFolderId(folderGroup.folder.id);
  }

  const onNewSessionRef = useRef<
    (
      isolated: boolean,
      kind: SessionKind,
      scopeOverride?: SessionCreateScope,
      mode?: SessionMode,
    ) => Promise<void>
  >(async () => {});
  const onNewLocalSessionRef = useRef<
    (scopeOverride?: SessionCreateScope) => Promise<void>
  >(async () => {});
  const onAddProjectRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const activeScope = (): SessionCreateScope | null => {
      const state = useAppStore.getState();
      return resolveActiveSessionScope({
        sessions: state.sessions,
        projects: state.projects,
        activeSessionId: state.activeSessionId,
        activeWorkspaceRepoPath: state.activeProject,
        activeWorkspaceCwdPath:
          findProjectFolderById(
            state.projectFolders,
            state.activeProjectFolderId,
          )?.cwdPath ?? null,
        activeProjectFolderId: state.activeProjectFolderId,
      });
    };
    const newSession = () => {
      const scope = activeScope();
      if (isLocalTerminalAreaFocused()) {
        void onNewLocalSessionRef.current(
          scope?.placement.projectScoped === false ? scope : undefined,
        );
        return;
      }
      void onNewSessionRef.current(
        false,
        "regular",
        scope ? scopeWithProjectRootLaunch(scope) : undefined,
      );
    };
    const newIsolated = () => {
      const scope = activeScope();
      const scopedProject =
        scope && scope.placement.projectScoped !== false ? scope : undefined;
      void onNewSessionRef.current(
        true,
        "regular",
        scopedProject,
      );
    };
    const newControl = () => {
      const scope = activeScope();
      const scopedProject =
        scope && scope.placement.projectScoped !== false
          ? scopeWithProjectRootLaunch(scope)
          : undefined;
      void onNewSessionRef.current(
        false,
        "control",
        scopedProject,
      );
    };
    const newChat = () => {
      void onNewSessionRef.current(
        false,
        "regular",
        activeScope() ?? undefined,
        "chat",
      );
    };
    const newProject = () => {
      setNewProjectOpen(true);
    };
    const addProj = () => {
      void onAddProjectRef.current();
    };
    window.addEventListener("acorn:new-session", newSession);
    window.addEventListener("acorn:new-isolated-session", newIsolated);
    window.addEventListener("acorn:new-control-session", newControl);
    window.addEventListener("acorn:new-chat-session", newChat);
    window.addEventListener("acorn:new-project", newProject);
    window.addEventListener("acorn:add-project", addProj);
    return () => {
      window.removeEventListener("acorn:new-session", newSession);
      window.removeEventListener("acorn:new-isolated-session", newIsolated);
      window.removeEventListener("acorn:new-control-session", newControl);
      window.removeEventListener("acorn:new-chat-session", newChat);
      window.removeEventListener("acorn:new-project", newProject);
      window.removeEventListener("acorn:add-project", addProj);
    };
  }, []);

  async function onNewSession(
    isolated: boolean,
    kind: SessionKind,
    scopeOverride?: SessionCreateScope,
    mode: SessionMode = "terminal",
  ) {
    try {
      if (!scopeOverride) {
        const title = isolated
          ? sidebarText(t, "sidebar.dialog.selectIsolatedRepository")
          : kind === "control"
            ? sidebarText(t, "sidebar.dialog.selectControlDirectory")
            : sidebarText(t, "sidebar.dialog.selectDirectory");
        const created = await api.createSessionFromDialog(
          "",
          isolated,
          kind,
          null,
          true,
          title,
          mode,
        );
        if (!created) return;
        await useAppStore.getState().refreshAll();
        selectSession(created.id);
        setCollapsed((prev) => {
          if (!prev.has(created.repo_path)) return prev;
          const next = new Set(prev);
          next.delete(created.repo_path);
          return next;
        });
        return;
      }
      const request = buildSessionCreateRequest(
        { sessions, projects },
        {
          repoPath: scopeOverride.placement.repoPath,
          launch: scopeOverride.launch,
          isolated,
          kind,
          mode,
          projectScoped: scopeOverride.placement.projectScoped,
          projectFolderId: scopeOverride.placement.projectFolderId,
        },
      );
      const created = await applySessionCreateRequest(createSession, request);
      const error = useAppStore.getState().consumeError();
      if (!created || error) {
        showToast(`${t("toasts.session.createFailed")} ${error ?? ""}`.trim());
      }
      setCollapsed((prev) => {
        if (!prev.has(request.repoPath)) return prev;
        const next = new Set(prev);
        next.delete(request.repoPath);
        return next;
      });
    } catch (e) {
      console.error("create session failed", e);
      showToast(`${t("toasts.session.createFailed")} ${String(e)}`);
    }
  }

  async function onNewLocalSession(scopeOverride?: SessionCreateScope) {
    try {
      const repoPath = scopeOverride?.placement.repoPath ?? (await homeDir());
      if (!repoPath) return;
      const created = await applySessionCreateRequest(
        createSession,
        buildSessionCreateRequest(
          { sessions, projects },
          {
            repoPath,
            launch: scopeOverride?.launch,
            projectScoped: false,
            projectFolderId: scopeOverride?.placement.projectFolderId,
          },
        ),
      );
      const error = useAppStore.getState().consumeError();
      if (!created || error) {
        showToast(`${t("toasts.session.createFailed")} ${error ?? ""}`.trim());
      }
    } catch (e) {
      console.error("create local terminal session failed", e);
      showToast(`${t("toasts.session.createFailed")} ${String(e)}`);
    }
  }

  onNewSessionRef.current = onNewSession;
  onNewLocalSessionRef.current = onNewLocalSession;
  onAddProjectRef.current = onAddExistingProject;

  const projectIds = useMemo(
    () => projectGroups.map((p) => projectDragId(p.repoPath)),
    [projectGroups],
  );
  // Scoped collision detection: only consider droppables sharing the active
  // item's namespace. Without this, dragging a project over an expanded
  // project's child session row makes `over.id` resolve to the session,
  // which gets dropped on the floor by onDragEnd.
  const scopedCollision: CollisionDetection = (args) => {
    const activeId = String(args.active.id);
    const filtered = args.droppableContainers.filter((c) => {
      const id = String(c.id);
      if (activeId.startsWith(PROJECT_DRAG_PREFIX)) {
        return id.startsWith(PROJECT_DRAG_PREFIX);
      }
      if (activeId.startsWith(FOLDER_DRAG_PREFIX)) {
        return id.startsWith(FOLDER_DRAG_PREFIX) || isSessionRowDragId(id);
      }
      return id.startsWith(SESSION_DRAG_PREFIX);
    });
    return closestCenter({ ...args, droppableContainers: filtered });
  };

  function onDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  function applyProjectTopLevelOrder(
    project: ProjectFolderProjectGroup,
    activeItemId: string,
    overItemId: string,
  ): boolean {
    const items = buildProjectTopLevelItems(
      project,
      projectItemOrders[project.repoPath] ?? [],
    );
    const ids = items.map((item) => item.id);
    const fromIdx = ids.indexOf(activeItemId);
    const toIdx = ids.indexOf(overItemId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return false;
    const nextIds = arrayMove(ids, fromIdx, toIdx);
    const nextItems = orderProjectTopLevelItems(items, nextIds);
    setProjectItemOrders((prev) =>
      stringArraysEqual(prev[project.repoPath] ?? [], nextIds)
        ? prev
        : { ...prev, [project.repoPath]: nextIds },
    );
    reorderProjectFolders(
      project.repoPath,
      nextItems
        .filter(
          (item): item is ProjectTopLevelFolderItem => item.type === "folder",
        )
        .map((item) => item.folderGroup.folder.id),
    );
    const sessionIds = nextItems
      .filter(
        (item): item is ProjectTopLevelSessionItem => item.type === "session",
      )
      .map((item) => item.session.id);
    if (sessionIds.length > 1) {
      void reorderSessions(project.repoPath, sessionIds);
    }
    return true;
  }

  function applySessionDropToProjectTopLevel(
    project: ProjectFolderProjectGroup,
    activeSession: Session,
    overSessionId: string,
  ): boolean {
    const activeId = sessionDragId(activeSession.id);
    const overId = sessionDragId(overSessionId);
    const items = buildProjectTopLevelItems(
      project,
      projectItemOrders[project.repoPath] ?? [],
    ).filter((item) => item.id !== activeId);
    const overIdx = items.findIndex(
      (item) => item.id === overId && item.type === "session",
    );
    if (overIdx < 0) return false;
    const activeItem: ProjectTopLevelSessionItem = {
      id: activeId,
      type: "session",
      session: activeSession,
      folderId: defaultProjectFolderId(project.repoPath),
    };
    const nextItems = [
      ...items.slice(0, overIdx),
      activeItem,
      ...items.slice(overIdx),
    ];
    const nextIds = nextItems.map((item) => item.id);
    setProjectItemOrders((prev) =>
      stringArraysEqual(prev[project.repoPath] ?? [], nextIds)
        ? prev
        : { ...prev, [project.repoPath]: nextIds },
    );
    return true;
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    if (
      activeId.startsWith(PROJECT_DRAG_PREFIX) &&
      overId.startsWith(PROJECT_DRAG_PREFIX)
    ) {
      const currentOrder = projectGroups.map((p) => p.repoPath);
      const fromIdx = currentOrder.indexOf(
        activeId.slice(PROJECT_DRAG_PREFIX.length),
      );
      const toIdx = currentOrder.indexOf(
        overId.slice(PROJECT_DRAG_PREFIX.length),
      );
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const next = arrayMove(currentOrder, fromIdx, toIdx);
      void reorderProjects(next);
      return;
    }

    if (activeId.startsWith(FOLDER_DRAG_PREFIX)) {
      const activeFolderId = activeId.slice(FOLDER_DRAG_PREFIX.length);
      const project = projectGroups.find((group) =>
        group.folders.some(
          (folderGroup) => folderGroup.folder.id === activeFolderId,
        ),
      );
      if (!project) return;
      applyProjectTopLevelOrder(project, activeId, overId);
      return;
    }

    if (activeId.startsWith(SESSION_DRAG_PREFIX)) {
      const activeSid = activeId.slice(SESSION_DRAG_PREFIX.length);
      const activeSession = sessions.find((s) => s.id === activeSid);
      if (!activeSession) return;
      const activeFolderId = projectFolderIdForSession(
        allWorkspaceGroups,
        activeSid,
      );
      const activeFolder = activeFolderId
        ? projectFolderById(allWorkspaceGroups, activeFolderId)
        : null;

      if (overId.startsWith(SESSION_FOLDER_DROP_PREFIX)) {
        const folderId = overId.slice(SESSION_FOLDER_DROP_PREFIX.length);
        const targetFolder = projectFolderById(allWorkspaceGroups, folderId);
        if (targetFolder?.repoPath !== activeSession.repo_path) return;
        if (
          isSessionDragCrossingLockedWorkspace(
            activeSession,
            activeFolder,
            activeFolderId,
            targetFolder,
            folderId,
          )
        ) {
          return;
        }
        moveSessionToProjectFolder(activeSid, folderId);
        return;
      }

      if (overId.startsWith(SESSION_PROJECT_DROP_PREFIX)) {
        const dropRepoPath = overId.slice(SESSION_PROJECT_DROP_PREFIX.length);
        if (
          dropRepoPath === LOCAL_SESSION_ROOT_DROP_ID &&
          activeSession.project_scoped !== false
        ) {
          return;
        }
        const repoPath =
          dropRepoPath === LOCAL_SESSION_ROOT_DROP_ID
            ? activeSession.repo_path
            : dropRepoPath;
        const targetFolderId = defaultProjectFolderId(repoPath);
        const targetFolder = projectFolderById(
          allWorkspaceGroups,
          targetFolderId,
        );
        if (
          isSessionDragCrossingLockedWorkspace(
            activeSession,
            activeFolder,
            activeFolderId,
            targetFolder,
            targetFolderId,
          )
        ) {
          return;
        }
        if (activeSession.repo_path === repoPath) {
          moveSessionToProjectFolder(activeSid, null);
        }
        return;
      }
    }

    if (
      activeId.startsWith(SESSION_DRAG_PREFIX) &&
      overId.startsWith(SESSION_DRAG_PREFIX)
    ) {
      const activeSid = activeId.slice(SESSION_DRAG_PREFIX.length);
      const overSid = overId.slice(SESSION_DRAG_PREFIX.length);
      const activeSession = sessions.find((s) => s.id === activeSid);
      const overSession = sessions.find((s) => s.id === overSid);
      if (!activeSession || !overSession) return;
      if (
        (activeSession.project_scoped === false) !==
        (overSession.project_scoped === false)
      ) {
        return;
      }
      // Cross-project drops are not supported yet — silently ignore.
      if (activeSession.repo_path !== overSession.repo_path) return;
      const activeFolderId = projectFolderIdForSession(
        allWorkspaceGroups,
        activeSid,
      );
      const overFolderId = projectFolderIdForSession(
        allWorkspaceGroups,
        overSid,
      );
      const activeFolder = activeFolderId
        ? projectFolderById(allWorkspaceGroups, activeFolderId)
        : null;
      const overFolder = overFolderId
        ? projectFolderById(allWorkspaceGroups, overFolderId)
        : null;
      if (
        isSessionDragCrossingLockedWorkspace(
          activeSession,
          activeFolder,
          activeFolderId,
          overFolder,
          overFolderId,
        )
      ) {
        return;
      }
      const project =
        activeSession.project_scoped !== false
          ? (projectGroups.find(
              (group) => group.repoPath === activeSession.repo_path,
            ) ?? null)
          : null;
      if (
        activeSession.project_scoped !== false &&
        project &&
        overFolderId === defaultProjectFolderId(activeSession.repo_path) &&
        activeFolderId !== overFolderId
      ) {
        const movedIntoTopLevel = applySessionDropToProjectTopLevel(
          project,
          activeSession,
          overSid,
        );
        if (movedIntoTopLevel) {
          moveSessionToProjectFolder(activeSid, null);
          const next = orderedSessionIdsAfterDrop(
            project.sessions,
            activeSid,
            overSid,
          );
          if (next) void reorderSessions(activeSession.repo_path, next);
          return;
        }
      }
      if (
        activeSession.project_scoped !== false &&
        activeFolderId === defaultProjectFolderId(activeSession.repo_path) &&
        overFolderId === defaultProjectFolderId(activeSession.repo_path)
      ) {
        if (project && applyProjectTopLevelOrder(project, activeId, overId)) {
          return;
        }
      }
      if (
        activeFolderId &&
        overFolderId &&
        activeFolderId !== overFolderId
      ) {
        moveSessionToProjectFolder(
          activeSid,
          sessionFolderAssignmentForDrop(activeSession, overFolderId),
        );
      }
      const orderedSessions =
        activeSession.project_scoped === false
          ? localSessions
          : (projectGroups.find((g) => g.repoPath === activeSession.repo_path)
              ?.sessions ?? []);
      const next = orderedSessionIdsAfterDrop(
        orderedSessions,
        activeSid,
        overSid,
      );
      if (!next) return;
      void reorderSessions(activeSession.repo_path, next);
    }
  }

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className="text-xs font-medium text-fg-muted">
          {sidebarText(t, "sidebar.projects.title")}
        </h2>
        <div className="flex items-center gap-1">
          <Tooltip
            label={sidebarText(t, "sidebar.projects.newProject")}
            side="left"
          >
            <button
              type="button"
              onClick={() => setNewProjectOpen(true)}
              className="rounded-md p-1.5 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
              aria-label={sidebarText(t, "sidebar.projects.newProject")}
            >
              <FolderPlus size={14} />
            </button>
          </Tooltip>
          <Tooltip
            label={sidebarText(t, "sidebar.projects.addExistingProject")}
            side="left"
          >
            <button
              type="button"
              onClick={onAddExistingProject}
              className="rounded-md p-1.5 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
              aria-label={sidebarText(
                t,
                "sidebar.projects.addExistingProject",
              )}
            >
              <FolderOpen size={14} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="acorn-no-scrollbar flex flex-1 flex-col overflow-y-auto px-1 pb-2">
        <DndContext
          sensors={sensors}
          collisionDetection={scopedCollision}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveDragId(null)}
        >
          {projectGroups.length === 0 ? (
            <EmptyState onOpenProject={onAddExistingProject} />
          ) : (
            <SortableContext
              items={projectIds}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col divide-y divide-border/40 [&>li]:py-1.5 [&>li:first-child]:pt-0.5 [&>li:last-child]:pb-0.5">
                {projectGroups.map((project) => {
                  return (
                    <ProjectGroupView
                      key={project.repoPath}
                      project={project}
                      collapsed={collapsed.has(project.repoPath)}
                      activeSessionId={activeSessionId}
                      isActiveProject={activeProject === project.repoPath}
                      activeProjectFolderId={activeProjectFolderId}
                      topLevelOrder={projectItemOrders[project.repoPath] ?? []}
                      onTitleClick={() =>
                        applyClickPlan(
                          planTitleClick({
                            wasActive: activeProject === project.repoPath,
                            wasCollapsed: collapsed.has(project.repoPath),
                          }),
                          project,
                        )
                      }
                      onChevronClick={() =>
                        applyClickPlan(
                          planChevronClick({
                            wasActive: activeProject === project.repoPath,
                            wasCollapsed: collapsed.has(project.repoPath),
                          }),
                          project,
                        )
                      }
                      onActivate={() => {
                        setActiveProject(project.repoPath);
                        expandProject(project.repoPath);
                        const target = pickSessionToActivate(
                          project.sessions,
                          activeSessionId,
                        );
                        if (target) selectSession(target);
                      }}
                      onSelectFolder={setActiveProjectFolder}
                      onSelectSession={(folderId, sessionId) => {
                        setActiveProjectFolder(folderId);
                        selectSession(sessionId);
                      }}
                      onRemoveSession={(s) => requestRemoveSession(s.id)}
                      onAddSession={(folder, isolated, kind, mode = "terminal") =>
                        onNewSession(
                          isolated,
                          kind,
                          {
                            placement: {
                              repoPath: project.repoPath,
                              projectScoped: true,
                              projectFolderId: folder.id,
                            },
                            launch: {
                              kind: "workspaceCwd",
                              cwdPath: folder.cwdPath,
                            },
                          },
                          mode,
                        )
                      }
                      onAddFolder={() => onAddProjectFolder(project.repoPath)}
                      onAddWorktreeFolder={() =>
                        void onAddProjectFolderWorktree(project.repoPath)
                      }
                      onRenameFolder={renameProjectFolder}
                      onRemoveFolder={requestRemoveProjectFolder}
                      onMoveSessionToFolder={moveSessionToProjectFolder}
                      onRemoveProject={() =>
                        requestRemoveProject(project.repoPath)
                      }
                      onOpenSettings={() => setSettingsProject(project)}
                      collapsedFolderIds={collapsedFolders}
                      onToggleFolder={toggleProjectFolder}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          )}
          <LocalTerminalArea
            groups={localWorkspaceGroups}
            activeSessionId={activeSessionId}
            activeProjectFolderId={activeProjectFolderId}
            collapsedFolderIds={collapsedFolders}
            onCreate={() => onNewLocalSession()}
            onCreateInFolder={(folder) =>
              onNewLocalSession({
                placement: {
                  repoPath: folder.repoPath,
                  projectScoped: false,
                  projectFolderId: folder.id,
                },
                launch: {
                  kind: "workspaceCwd",
                  cwdPath: folder.cwdPath,
                },
              })
            }
            onCreateWorkspace={onAddLocalWorkspace}
            onFocusArea={focusLocalSessions}
            onSelectFolder={setActiveProjectFolder}
            onToggleFolder={toggleProjectFolder}
            onSelectSession={selectSession}
            onRemoveSession={(s) => requestRemoveSession(s.id)}
            onRenameFolder={renameProjectFolder}
            onRemoveFolder={requestRemoveProjectFolder}
            onMoveSessionToFolder={moveSessionToProjectFolder}
          />
          <DragOverlay dropAnimation={null}>
            {activeDragId
              ? renderDragOverlay(activeDragId, projectGroups, sessions, t)
              : null}
          </DragOverlay>
        </DndContext>
      </div>
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreate={async (parentPath, name, ignoreSafeName) => {
          try {
            await createNewProject(parentPath, name, ignoreSafeName);
          } catch (e) {
            showToast(`${t("toasts.project.createFailed")} ${String(e)}`);
            throw e;
          }
        }}
      />
      <ProjectSettingsModal
        project={
          settingsProject
            ? {
                name: settingsProject.name,
                repoPath: settingsProject.repoPath,
              }
            : null
        }
        onClose={() => setSettingsProject(null)}
      />
      <RemoveProjectFolderDialog
        folder={pendingRemoveProjectFolderGroup?.folder ?? null}
        sessions={pendingRemoveProjectFolderGroup?.sessions ?? []}
        worktreeWorkspace={Boolean(
          pendingRemoveProjectFolderGroup &&
            isWorktreeWorkspace(pendingRemoveProjectFolderGroup.folder),
        )}
        deleteWorktrees={Boolean(
          deleteIsolatedWorktreesWithoutPrompt &&
            pendingRemoveProjectFolderGroup?.sessions.some((session) =>
              shouldAutoDeleteSessionWorktree(
                session,
                projectFolders,
                sessions,
              ),
            ),
        )}
        onClose={(choice) => {
          const target = pendingRemoveProjectFolderGroup;
          setPendingRemoveProjectFolderId(null);
          if (!target || choice === "cancel") return;
          if (choice === "folder_and_worktree") {
            void removeProjectFolderAndWorktree(target.folder);
            return;
          }
          if (choice === "folder_only") {
            removeProjectFolder(target.folder.id);
            return;
          }
          void removeProjectFolderAndSessions(target);
        }}
      />
    </aside>
  );
}

function renderDragOverlay(
  activeDragId: string,
  projectGroups: ProjectFolderProjectGroup[],
  sessions: Session[],
  t: Translator,
): React.ReactNode {
  if (activeDragId.startsWith(PROJECT_DRAG_PREFIX)) {
    const repoPath = activeDragId.slice(PROJECT_DRAG_PREFIX.length);
    const group = projectGroups.find((g) => g.repoPath === repoPath);
    if (!group) return null;
    return (
      <ProjectHeaderPreview
        name={group.name}
        count={group.sessions.length}
      />
    );
  }
  if (activeDragId.startsWith(FOLDER_DRAG_PREFIX)) {
    const folderId = activeDragId.slice(FOLDER_DRAG_PREFIX.length);
    const folderGroup = projectGroups
      .flatMap((group) => group.folders)
      .find((group) => group.folder.id === folderId);
    if (!folderGroup) return null;
    return <ProjectFolderPreview folder={folderGroup.folder} />;
  }
  if (activeDragId.startsWith(SESSION_DRAG_PREFIX)) {
    const sid = activeDragId.slice(SESSION_DRAG_PREFIX.length);
    const session = sessions.find((s) => s.id === sid);
    if (!session) return null;
    return <SessionRowPreview session={session} t={t} />;
  }
  return null;
}

function ProjectHeaderPreview({
  name,
  count,
}: {
  name: string;
  count: number;
}) {
  return (
    <div className="flex min-h-8 items-center gap-1 rounded-md bg-bg-elevated/95 px-1 py-1.5 shadow-lg ring-1 ring-border/60">
      <span className="flex size-5 shrink-0 items-center justify-center rounded text-fg-muted">
        <ChevronRight size={14} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pr-2 leading-none">
        <span className="truncate text-sm font-medium leading-5 text-fg">
          {name}
        </span>
        <span className="ml-1 flex h-4 shrink-0 items-center rounded bg-bg-elevated/80 px-1 text-[10px] leading-none text-fg-muted">
          {count}
        </span>
      </span>
    </div>
  );
}

function ProjectFolderPreview({ folder }: { folder: ProjectFolder }) {
  return (
    <div className="flex min-h-7 items-center gap-1 rounded-md bg-bg-elevated/95 px-1.5 py-1 shadow-lg ring-1 ring-border/60">
      <span className="flex size-5 shrink-0 items-center justify-center text-fg-muted">
        <WorkspaceIcon folder={folder} size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-5 text-fg">
        {folder.name}
      </span>
    </div>
  );
}

function SessionRowPreview({
  session,
  t,
}: {
  session: Session;
  t: Translator;
}) {
  const sessionDisplay = useSettings((s) => s.settings.sessionDisplay);
  const titleText = resolveSessionTitle(session, sessionDisplay.title);
  const metadataText = composeSessionMetadata(
    t,
    session,
    sessionDisplay.metadata,
  );
  const agentProvider = sessionDisplay.icons.agentProvider
    ? resolveSessionAgentProvider(session)
    : null;

  return (
    <div className="flex w-full items-start gap-1.5 rounded-md bg-bg-elevated/95 px-2 py-1 shadow-lg ring-1 ring-border/60">
      {sessionDisplay.icons.statusDot ? (
        <SessionStatusMarker
          session={session}
          agentProvider={agentProvider}
          isGeneratingTitle={false}
          generatingLabel={sidebarText(t, "sidebar.aria.generatingSessionTitle")}
          chatLabel={sidebarText(t, "sidebar.aria.chatSession")}
        />
      ) : null}
      <SessionRowLabel
        editing={false}
        session={session}
        titleText={titleText}
        metadataText={metadataText}
        showKindIcons={sessionDisplay.icons.sessionKind}
        t={t}
        onSubmitRename={() => undefined}
        onCancelRename={() => undefined}
      />
    </div>
  );
}

function projectDragId(repoPath: string): string {
  return `${PROJECT_DRAG_PREFIX}${repoPath}`;
}

function folderDragId(id: string): string {
  return `${FOLDER_DRAG_PREFIX}${id}`;
}

function sessionDragId(id: string): string {
  return `${SESSION_DRAG_PREFIX}${id}`;
}

function sessionFolderDropId(folderId: string): string {
  return `${SESSION_FOLDER_DROP_PREFIX}${folderId}`;
}

function sessionProjectDropId(repoPath: string): string {
  return `${SESSION_PROJECT_DROP_PREFIX}${repoPath}`;
}

function projectFolderIdForSession(
  projectGroups: ProjectFolderProjectGroup[],
  sessionId: string,
): string | null {
  for (const project of projectGroups) {
    for (const folderGroup of project.folders) {
      if (folderGroup.sessions.some((session) => session.id === sessionId)) {
        return folderGroup.folder.id;
      }
    }
  }
  return null;
}

function projectFolderById(
  projectGroups: ProjectFolderProjectGroup[],
  folderId: string,
): ProjectFolder | null {
  for (const project of projectGroups) {
    const folderGroup = project.folders.find(
      (candidate) => candidate.folder.id === folderId,
    );
    if (folderGroup) return folderGroup.folder;
  }
  return null;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function isWorktreeWorkspace(folder: ProjectFolder): boolean {
  return (
    normalizeWorkspacePath(folder.cwdPath) !==
    normalizeWorkspacePath(folder.repoPath)
  );
}

function WorkspaceIcon({
  folder,
  size,
  className,
}: {
  folder: ProjectFolder;
  size: number;
  className?: string;
}) {
  const Icon = isWorktreeWorkspace(folder) ? GitBranch : LayoutPanelLeft;
  return <Icon size={size} className={className} />;
}

function canAssignSessionToWorkspace(
  session: Session,
  currentFolder: ProjectFolder | null,
  targetFolder: ProjectFolder,
): boolean {
  if (
    currentFolder &&
    isWorktreeWorkspace(currentFolder) &&
    currentFolder.id !== targetFolder.id
  ) {
    return false;
  }
  if (
    isWorktreeWorkspace(targetFolder) &&
    normalizeWorkspacePath(session.worktree_path) !==
      normalizeWorkspacePath(targetFolder.cwdPath)
  ) {
    return false;
  }
  return true;
}

function isSessionDragCrossingLockedWorkspace(
  session: Session,
  activeFolder: ProjectFolder | null,
  activeFolderId: string | null,
  targetFolder: ProjectFolder | null,
  targetFolderId: string | null,
): boolean {
  if (
    activeFolder &&
    activeFolderId &&
    isWorktreeWorkspace(activeFolder) &&
    targetFolderId !== activeFolderId
  ) {
    return true;
  }
  return Boolean(
    targetFolder &&
      isWorktreeWorkspace(targetFolder) &&
      normalizeWorkspacePath(session.worktree_path) !==
        normalizeWorkspacePath(targetFolder.cwdPath),
  );
}

function workspacePathLabel(folder: ProjectFolder): string | null {
  if (
    normalizeWorkspacePath(folder.cwdPath) ===
    normalizeWorkspacePath(folder.repoPath)
  ) {
    return null;
  }
  return basename(folder.cwdPath) || folder.cwdPath;
}

function projectSessionCreateMenuForWorkspace(
  folder: ProjectFolder,
  includeTerminal: boolean,
): ProjectSessionCreateMenuItem[] {
  return PROJECT_SESSION_CREATE_MENU.filter((item) => {
    if (item.type === "separator") return true;
    if (!includeTerminal && item.action.id === "terminal") return false;
    if (isWorktreeWorkspace(folder) && item.action.id === "isolated") {
      return false;
    }
    return true;
  });
}

interface ProjectTopLevelSessionItem {
  id: string;
  type: "session";
  session: Session;
  folderId: string;
}

interface ProjectTopLevelFolderItem {
  id: string;
  type: "folder";
  folderGroup: ProjectFolderGroup;
}

type ProjectTopLevelItem =
  | ProjectTopLevelSessionItem
  | ProjectTopLevelFolderItem;

function buildProjectTopLevelItems(
  project: ProjectFolderProjectGroup,
  order: readonly string[],
): ProjectTopLevelItem[] {
  const defaultFolderGroup =
    project.folders.find((folderGroup) =>
      isDefaultProjectFolder(folderGroup.folder),
    ) ?? project.folders[0] ?? null;
  const directSessions: ProjectTopLevelItem[] = (
    defaultFolderGroup?.sessions ?? []
  ).map((session) => ({
    id: sessionDragId(session.id),
    type: "session",
    session,
    folderId:
      defaultFolderGroup?.folder.id ?? defaultProjectFolderId(project.repoPath),
  }));
  const folders: ProjectTopLevelItem[] = project.folders
    .filter((folderGroup) => !isDefaultProjectFolder(folderGroup.folder))
    .map((folderGroup) => ({
      id: folderDragId(folderGroup.folder.id),
      type: "folder",
      folderGroup,
    }));
  return orderProjectTopLevelItems([...directSessions, ...folders], order);
}

function orderProjectTopLevelItems(
  items: readonly ProjectTopLevelItem[],
  order: readonly string[],
): ProjectTopLevelItem[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const ordered: ProjectTopLevelItem[] = [];
  for (const id of order) {
    const item = itemById.get(id);
    if (!item || seen.has(id)) continue;
    ordered.push(item);
    seen.add(id);
  }
  for (const item of items) {
    if (!seen.has(item.id)) ordered.push(item);
  }
  return ordered;
}

function isSessionRowDragId(id: string): boolean {
  return (
    id.startsWith(SESSION_DRAG_PREFIX) &&
    !id.startsWith(SESSION_FOLDER_DROP_PREFIX) &&
    !id.startsWith(SESSION_PROJECT_DROP_PREFIX)
  );
}

function sessionFolderAssignmentForDrop(
  session: Session,
  folderId: string,
): string | null {
  return folderId === defaultProjectFolderId(session.repo_path)
    ? null
    : folderId;
}

function orderedSessionIdsAfterDrop(
  orderedSessions: readonly Session[],
  activeSessionId: string,
  overSessionId: string,
): string[] | null {
  if (orderedSessions.length === 0) return null;
  const ids = orderedSessions.map((session) => session.id);
  const overIdx = ids.indexOf(overSessionId);
  if (overIdx < 0) return null;
  const fromIdx = ids.indexOf(activeSessionId);
  if (fromIdx >= 0) {
    if (fromIdx === overIdx) return null;
    return arrayMove(ids, fromIdx, overIdx);
  }
  ids.splice(overIdx, 0, activeSessionId);
  return ids;
}

/**
 * Choose which session to activate when the user clicks a project header.
 * If the already-active session belongs to this project, keep it. Otherwise
 * fall back to the first listed session.
 * Returns null when the project has no sessions.
 */
function pickSessionToActivate(
  projectSessions: Session[],
  currentActiveId: string | null,
): string | null {
  if (projectSessions.length === 0) return null;
  if (
    currentActiveId &&
    projectSessions.some((s) => s.id === currentActiveId)
  ) {
    return currentActiveId;
  }
  return projectSessions[0]?.id ?? null;
}

function projectSessionCreateIcon(id: ProjectSessionCreateAction["id"]) {
  switch (id) {
    case "terminal":
      return <Plus size={12} />;
    case "isolated":
      return <GitBranch size={12} />;
    case "chat":
      return <MessageSquareText size={12} />;
    case "control":
      return <Bot size={12} />;
  }
}

const PROJECT_SESSION_PRIMARY_CREATE_ACTION_IDS = new Set<
  ProjectSessionCreateAction["id"]
>(["terminal", "isolated"]);

function isPrimaryProjectSessionCreateAction(
  action: ProjectSessionCreateAction,
): boolean {
  return PROJECT_SESSION_PRIMARY_CREATE_ACTION_IDS.has(action.id);
}

const PROJECT_SESSION_PRIMARY_CREATE_ACTIONS =
  PROJECT_SESSION_CREATE_ACTIONS.filter(isPrimaryProjectSessionCreateAction);

const PROJECT_SESSION_OVERFLOW_CREATE_ACTIONS =
  PROJECT_SESSION_CREATE_ACTIONS.filter(
    (action) => !isPrimaryProjectSessionCreateAction(action),
  );

interface ProjectGroupViewProps {
  project: ProjectFolderProjectGroup;
  collapsed: boolean;
  activeSessionId: string | null;
  isActiveProject: boolean;
  activeProjectFolderId: string | null;
  topLevelOrder: readonly string[];
  /** Title click: activate (preserve collapse if inactive); ensure expanded if already active. */
  onTitleClick: () => void;
  /** Chevron click: activate + toggle expand. */
  onChevronClick: () => void;
  /** Empty-state row click: activate + expand + select a session. */
  onActivate: () => void;
  onSelectFolder: (folderId: string) => void;
  onSelectSession: (folderId: string, sessionId: string) => void;
  onRemoveSession: (s: Session) => void;
  onAddSession: (
    folder: ProjectFolder,
    isolated: boolean,
    kind: SessionKind,
    mode?: SessionMode,
  ) => void;
  onAddFolder: () => void;
  onAddWorktreeFolder: () => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void;
  onRemoveProject: () => void;
  onOpenSettings: () => void;
  collapsedFolderIds: ReadonlySet<string>;
  onToggleFolder: (folderId: string) => void;
}

function ProjectGroupView({
  project,
  collapsed,
  activeSessionId,
  isActiveProject,
  activeProjectFolderId,
  topLevelOrder,
  onTitleClick,
  onChevronClick,
  onActivate,
  onSelectFolder,
  onSelectSession,
  onRemoveSession,
  onAddSession,
  onAddFolder,
  onAddWorktreeFolder,
  onRenameFolder,
  onRemoveFolder,
  onMoveSessionToFolder,
  onRemoveProject,
  onOpenSettings,
  collapsedFolderIds,
  onToggleFolder,
}: ProjectGroupViewProps) {
  const t = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [createMenu, setCreateMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: projectDragId(project.repoPath) });
  const { setNodeRef: setProjectSessionDropNodeRef } = useDroppable({
    id: sessionProjectDropId(project.repoPath),
  });
  const setProjectHeaderNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setActivatorNodeRef(node);
      setProjectSessionDropNodeRef(node);
    },
    [setActivatorNodeRef, setProjectSessionDropNodeRef],
  );

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const defaultFolderGroup =
    project.folders.find((folderGroup) =>
      isDefaultProjectFolder(folderGroup.folder),
    ) ?? project.folders[0] ?? null;
  const projectSessionCreationFolder = defaultFolderGroup?.folder ?? null;

  const createMenuItems = useMemo<ContextMenuItem[]>(
    () =>
      PROJECT_SESSION_CREATE_MENU.map((item) => {
        if (item.type === "separator") return { type: "separator" };
        const action = item.action;
        return {
          label: sidebarText(t, action.labelKey),
          icon: projectSessionCreateIcon(action.id),
          onClick: () =>
            projectSessionCreationFolder
              ? onAddSession(
                  projectSessionCreationFolder,
                  action.isolated,
                  action.kind,
                  action.mode,
                )
              : undefined,
        };
      }),
    [onAddSession, projectSessionCreationFolder, t],
  );
  const overflowCreateMenuItems = useMemo<ContextMenuItem[]>(
    () => {
      const sessionItems: ContextMenuItem[] =
        PROJECT_SESSION_OVERFLOW_CREATE_ACTIONS.map((action) => {
          return {
            label: sidebarText(t, action.labelKey),
            icon: projectSessionCreateIcon(action.id),
            onClick: () =>
              projectSessionCreationFolder
                ? onAddSession(
                    projectSessionCreationFolder,
                    action.isolated,
                    action.kind,
                    action.mode,
                  )
                : undefined,
          };
        });
      return [
        contextMenuGroupTitle(t, "workspace"),
        {
          label: sidebarText(t, "sidebar.actions.newProjectFolder"),
          icon: <FolderPlus size={12} />,
          onClick: onAddFolder,
        },
        {
          label: sidebarText(
            t,
            "sidebar.actions.newProjectFolderWithWorktree",
          ),
          icon: <GitBranch size={12} />,
          onClick: onAddWorktreeFolder,
        },
        contextMenuGroupTitle(t, "session"),
        ...sessionItems,
      ];
    },
    [
      onAddFolder,
      onAddSession,
      onAddWorktreeFolder,
      projectSessionCreationFolder,
      t,
    ],
  );

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  async function openInFinder(path: string) {
    try {
      await api.fsReveal(path);
    } catch {
      // ignore
    }
  }

  const namedFolderGroups = project.folders.filter(
    (folderGroup) => !isDefaultProjectFolder(folderGroup.folder),
  );
  const projectFoldersForRows = project.folders.map(
    (folderGroup) => folderGroup.folder,
  );
  const topLevelItems = useMemo(
    () => buildProjectTopLevelItems(project, topLevelOrder),
    [project, topLevelOrder],
  );
  const topLevelItemIds = useMemo(
    () => topLevelItems.map((item) => item.id),
    [topLevelItems],
  );

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn("relative", isDragging && "opacity-40")}
    >
      <div
        ref={setProjectHeaderNodeRef}
        {...attributes}
        role="button"
        tabIndex={0}
        onClick={onTitleClick}
        onPointerDown={(e) => {
          listeners?.onPointerDown?.(e);
        }}
        onKeyDown={(e) => {
          listeners?.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTitleClick();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCreateMenu(null);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        aria-label={`${sidebarText(t, "sidebar.aria.project")} ${project.name}`}
        className={cn(
          "group flex min-h-8 items-center gap-1 rounded-md bg-bg-elevated/10 px-1 py-1.5 transition hover:bg-bg-elevated/20",
          isActiveProject && "bg-bg-elevated/30",
        )}
      >
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onChevronClick();
          }}
          aria-label={
            collapsed
              ? sidebarText(t, "sidebar.actions.expandProject")
              : sidebarText(t, "sidebar.actions.collapseProject")
          }
          aria-expanded={!collapsed}
          className="flex size-5 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          <ChevronRight
            size={14}
            className={cn("transition-transform", !collapsed && "rotate-90")}
          />
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 leading-none">
          <span className="truncate text-sm font-medium leading-5 text-fg">
            {project.name}
          </span>
        </span>
        {PROJECT_SESSION_PRIMARY_CREATE_ACTIONS.map((action) => (
          <Tooltip
            key={action.id}
            label={sidebarText(t, action.labelKey)}
            side="bottom"
          >
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setMenu(null);
                setCreateMenu(null);
                if (projectSessionCreationFolder) {
                  onAddSession(
                    projectSessionCreationFolder,
                    action.isolated,
                    action.kind,
                    action.mode,
                  );
                }
              }}
              className="invisible flex size-5 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
              aria-label={sidebarText(t, action.ariaKey)}
            >
              {projectSessionCreateIcon(action.id)}
            </button>
          </Tooltip>
        ))}
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu(null);
            setCreateMenu((current) =>
              current === null ? { x: rect.left, y: rect.bottom + 4 } : null,
            );
          }}
          className="invisible flex size-5 shrink-0 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
          aria-label={sidebarText(t, "sidebar.aria.newSessionMenuInProject")}
          aria-haspopup="menu"
          aria-expanded={createMenu !== null}
        >
          <MoreHorizontal size={13} />
        </button>
        <Tooltip
          label={sidebarText(t, "sidebar.actions.closeProject")}
          side="bottom"
        >
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveProject();
            }}
            className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-danger group-hover:visible"
            aria-label={sidebarText(t, "sidebar.actions.closeProject")}
          >
            <X size={12} />
          </button>
        </Tooltip>
      </div>
      <ContextMenu
        open={createMenu !== null}
        x={createMenu?.x ?? 0}
        y={createMenu?.y ?? 0}
        onClose={() => setCreateMenu(null)}
        items={overflowCreateMenuItems}
      />
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={[
          contextMenuGroupTitle(t, "session"),
          ...createMenuItems,
          contextMenuGroupTitle(t, "workspace"),
          {
            label: sidebarText(t, "sidebar.actions.newProjectFolder"),
            icon: <FolderPlus size={12} />,
            onClick: onAddFolder,
          },
          {
            label: sidebarText(
              t,
              "sidebar.actions.newProjectFolderWithWorktree",
            ),
            icon: <GitBranch size={12} />,
            onClick: onAddWorktreeFolder,
          },
          contextMenuGroupTitle(t, "project"),
          {
            label: sidebarText(t, "sidebar.actions.projectSettings"),
            icon: <SettingsIcon size={12} />,
            onClick: onOpenSettings,
          },
          {
            label: sidebarText(t, "sidebar.actions.revealInFinder"),
            icon: <FolderOpen size={12} />,
            onClick: () => {
              void openInFinder(project.repoPath);
            },
          },
          {
            label: sidebarText(t, "sidebar.actions.copyPath"),
            icon: <Copy size={12} />,
            onClick: () => {
              void copyText(project.repoPath);
            },
          },
          contextMenuGroupTitle(t, "danger"),
          {
            label: sidebarText(t, "sidebar.actions.closeProject"),
            icon: <X size={12} />,
            onClick: onRemoveProject,
          },
        ]}
      />
      {!collapsed ? (
        <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1 pt-0.5">
          <SortableContext
            items={topLevelItemIds}
            strategy={verticalListSortingStrategy}
          >
            {defaultFolderGroup &&
            defaultFolderGroup.sessions.length === 0 &&
            namedFolderGroups.length === 0 ? (
              <li
                role="button"
                tabIndex={0}
                onClick={onActivate}
                onDoubleClick={() =>
                  onAddSession(defaultFolderGroup.folder, false, "regular")
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onAddSession(defaultFolderGroup.folder, false, "regular");
                  }
                }}
                className="flex cursor-pointer items-center justify-center rounded px-3 py-3 text-center text-[11px] text-fg-muted transition select-none hover:bg-bg-elevated/40 hover:text-fg"
              >
                {sidebarText(t, "sidebar.emptyProject.createSession")}
              </li>
            ) : (
              topLevelItems.map((item) =>
                item.type === "session" ? (
                  <SessionRow
                    key={item.id}
                    session={item.session}
                    active={item.session.id === activeSessionId}
                    onSelect={() =>
                      onSelectSession(item.folderId, item.session.id)
                    }
                    onRemove={() => onRemoveSession(item.session)}
                    projectFolders={projectFoldersForRows}
                    currentProjectFolderId={item.folderId}
                    onMoveToProjectFolder={onMoveSessionToFolder}
                  />
                ) : (
                  <ProjectFolderView
                    key={item.id}
                    folderGroup={item.folderGroup}
                    projectFolders={projectFoldersForRows}
                    activeSessionId={activeSessionId}
                    active={activeProjectFolderId === item.folderGroup.folder.id}
                    collapsed={collapsedFolderIds.has(
                      item.folderGroup.folder.id,
                    )}
                    onToggleFolder={() =>
                      onToggleFolder(item.folderGroup.folder.id)
                    }
                    onActivate={() => onSelectFolder(item.folderGroup.folder.id)}
                    onSelectSession={(sessionId) =>
                      onSelectSession(item.folderGroup.folder.id, sessionId)
                    }
                    onRemoveSession={onRemoveSession}
                    onRenameFolder={onRenameFolder}
                    onRemoveFolder={onRemoveFolder}
                    onAddSession={(isolated, kind, mode) =>
                      onAddSession(
                        item.folderGroup.folder,
                        isolated,
                        kind,
                        mode,
                      )
                    }
                    onMoveSessionToFolder={onMoveSessionToFolder}
                  />
                ),
              )
            )}
          </SortableContext>
          {!defaultFolderGroup && namedFolderGroups.length === 0 ? (
            <li
              role="button"
              tabIndex={0}
              onClick={onActivate}
              className="flex cursor-pointer items-center justify-center rounded px-3 py-3 text-center text-[11px] text-fg-muted transition select-none hover:bg-bg-elevated/40 hover:text-fg"
            >
              {sidebarText(t, "sidebar.emptyProject.createSession")}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

interface ProjectFolderViewProps {
  folderGroup: ProjectFolderGroup;
  projectFolders: ProjectFolder[];
  activeSessionId: string | null;
  active: boolean;
  collapsed: boolean;
  onToggleFolder: () => void;
  onActivate: () => void;
  onSelectSession: (sessionId: string) => void;
  onRemoveSession: (session: Session) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onAddSession: (
    isolated: boolean,
    kind: SessionKind,
    mode: SessionMode,
  ) => void;
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void;
}

function ProjectFolderView({
  folderGroup,
  projectFolders,
  activeSessionId,
  active,
  collapsed,
  onToggleFolder,
  onActivate,
  onSelectSession,
  onRemoveSession,
  onRenameFolder,
  onRemoveFolder,
  onAddSession,
  onMoveSessionToFolder,
}: ProjectFolderViewProps) {
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [createMenu, setCreateMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const folder = folderGroup.folder;
  const removable = !isDefaultProjectFolder(folder);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: folderDragId(folder.id) });
  const { setNodeRef: setFolderSessionDropNodeRef } = useDroppable({
    id: sessionFolderDropId(folder.id),
  });
  const setFolderHeaderNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setActivatorNodeRef(node);
      setFolderSessionDropNodeRef(node);
    },
    [setActivatorNodeRef, setFolderSessionDropNodeRef],
  );
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const sessionIds = useMemo(
    () => folderGroup.sessions.map((s) => sessionDragId(s.id)),
    [folderGroup.sessions],
  );
  const folderCreateMenu = useMemo(
    () => projectSessionCreateMenuForWorkspace(folder, true),
    [folder],
  );
  const folderOverflowCreateMenu = useMemo(
    () => projectSessionCreateMenuForWorkspace(folder, false),
    [folder],
  );
  const folderCreateMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      contextMenuGroupTitle(t, "session"),
      ...folderCreateMenu.map((item) => {
        if (item.type === "separator") return { type: "separator" as const };
        const action = item.action;
        return {
          label: sidebarText(t, action.labelKey),
          icon: projectSessionCreateIcon(action.id),
          onClick: () =>
            onAddSession(action.isolated, action.kind, action.mode),
        };
      }),
    ],
    [folderCreateMenu, onAddSession, t],
  );
  const folderOverflowCreateMenuItems = useMemo<ContextMenuItem[]>(
    () => [
      contextMenuGroupTitle(t, "session"),
      ...folderOverflowCreateMenu.map((item) => {
        if (item.type === "separator") return { type: "separator" as const };
        const action = item.action;
        return {
          label: sidebarText(t, action.labelKey),
          icon: projectSessionCreateIcon(action.id),
          onClick: () =>
            onAddSession(action.isolated, action.kind, action.mode),
        };
      }),
    ],
    [folderOverflowCreateMenu, onAddSession, t],
  );

  function submitRename(next: string) {
    setEditing(false);
    onRenameFolder(folder.id, next);
  }

  const workspaceLabel = workspacePathLabel(folder);

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(isDragging && "opacity-40")}
    >
      <div
        ref={setFolderHeaderNodeRef}
        data-sidebar-workspace-id={folder.id}
        {...attributes}
        role="button"
        tabIndex={0}
        onClick={editing ? undefined : onActivate}
        onPointerDown={(e) => {
          if (editing) return;
          listeners?.onPointerDown?.(e);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (editing) return;
          listeners?.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          } else if (e.key === "F2") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCreateMenu(null);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={cn(
          "group/project-folder flex min-h-7 w-full items-center gap-1 rounded-md px-1.5 py-1 text-left transition",
          active
            ? "bg-bg-elevated/50"
            : "bg-bg-elevated/20 hover:bg-bg-elevated/30",
        )}
      >
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFolder();
          }}
          aria-label={sidebarText(
            t,
            collapsed
              ? "sidebar.actions.expandProjectFolder"
              : "sidebar.actions.collapseProjectFolder",
          )}
          aria-expanded={!collapsed}
          className="group/folder-toggle relative flex size-5 shrink-0 self-start items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:bg-bg-elevated focus-visible:text-fg focus-visible:outline-none"
        >
          <WorkspaceIcon
            folder={folder}
            size={13}
            className="transition-opacity group-hover/project-folder:opacity-0 group-focus-visible/folder-toggle:opacity-0"
          />
          <ChevronRight
            size={12}
            className={cn(
              "absolute opacity-0 transition-[opacity,transform] group-hover/project-folder:opacity-100 group-focus-visible/folder-toggle:opacity-100",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <span className="min-w-0 flex-1">
          {editing ? (
            <RenameInput
              initial={folder.name}
              onSubmit={submitRename}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span className="flex min-w-0 flex-col leading-none">
              <span className="block truncate text-[12px] font-medium leading-4 text-fg">
                {folder.name}
              </span>
              {workspaceLabel ? (
                <Tooltip
                  label={folder.cwdPath}
                  side="right"
                  className="min-w-0 max-w-full"
                >
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-3 text-fg-muted">
                    <FolderOpen size={10} className="shrink-0" />
                    <span className="truncate">{workspaceLabel}</span>
                  </span>
                </Tooltip>
              ) : null}
            </span>
          )}
        </span>
        {!editing ? (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Tooltip
              label={sidebarText(t, "sidebar.aria.newSessionInProjectFolder")}
              side="bottom"
            >
              <button
                type="button"
                aria-label={sidebarText(
                  t,
                  "sidebar.aria.newSessionInProjectFolder",
                )}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onAddSession(false, "regular", "terminal");
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover/project-folder:visible group-focus-within/project-folder:visible"
              >
                <Plus size={12} />
              </button>
            </Tooltip>
            <Tooltip
              label={sidebarText(
                t,
                "sidebar.aria.newSessionMenuInProjectFolder",
              )}
              side="bottom"
            >
              <button
                type="button"
                aria-label={sidebarText(
                  t,
                  "sidebar.aria.newSessionMenuInProjectFolder",
                )}
                aria-haspopup="menu"
                aria-expanded={createMenu !== null}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu(null);
                  setCreateMenu((current) =>
                    current === null
                      ? { x: rect.left, y: rect.bottom + 4 }
                      : null,
                  );
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover/project-folder:visible group-focus-within/project-folder:visible"
              >
                <MoreHorizontal size={13} />
              </button>
            </Tooltip>
            {removable ? (
              <Tooltip
                label={sidebarText(t, "sidebar.actions.removeProjectFolder")}
                side="bottom"
              >
                <button
                  type="button"
                  aria-label={sidebarText(
                    t,
                    "sidebar.actions.removeProjectFolder",
                  )}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFolder(folder.id);
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-danger group-hover/project-folder:visible group-focus-within/project-folder:visible"
                >
                  <Trash2 size={12} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
      <ContextMenu
        open={createMenu !== null}
        x={createMenu?.x ?? 0}
        y={createMenu?.y ?? 0}
        onClose={() => setCreateMenu(null)}
        items={folderOverflowCreateMenuItems}
      />
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={[
          ...folderCreateMenuItems,
          contextMenuGroupTitle(t, "workspace"),
          {
            label: sidebarText(t, "sidebar.actions.renameProjectFolder"),
            icon: <Pencil size={12} />,
            onClick: () => setEditing(true),
          },
          {
            label: sidebarText(t, "sidebar.actions.revealInFinder"),
            icon: <FolderOpen size={12} />,
            onClick: () => {
              void api.fsReveal(folder.cwdPath);
            },
          },
          {
            label: sidebarText(t, "sidebar.actions.copyPath"),
            icon: <Copy size={12} />,
            onClick: () => {
              void copyToClipboard(folder.cwdPath);
            },
          },
          contextMenuGroupTitle(t, "danger"),
          {
            label: sidebarText(t, "sidebar.actions.removeProjectFolder"),
            icon: <Trash2 size={12} />,
            onClick: () => onRemoveFolder(folder.id),
            disabled: !removable,
          },
        ]}
      />
      {!collapsed ? (
        <SortableContext
          items={sessionIds}
          strategy={verticalListSortingStrategy}
        >
          <ul className="ml-4 flex flex-col gap-0.5 border-l border-border pl-1 pt-0.5">
            {folderGroup.sessions.length === 0 ? (
              <li
                className="flex items-center justify-center rounded px-3 py-2 text-center text-[11px] text-fg-muted select-none"
              >
                {sidebarText(t, "sidebar.emptyProjectFolder.noSessions")}
              </li>
            ) : (
              folderGroup.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRemove={() => onRemoveSession(session)}
                  projectFolders={projectFolders}
                  currentProjectFolderId={folder.id}
                  onMoveToProjectFolder={onMoveSessionToFolder}
                />
              ))
            )}
          </ul>
        </SortableContext>
      ) : null}
    </li>
  );
}

interface SessionRowProps {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
  projectFolders?: readonly ProjectFolder[];
  currentProjectFolderId?: string;
  onMoveToProjectFolder?: (
    sessionId: string,
    folderId: string | null,
  ) => void;
}

function SessionRow({
  session,
  active,
  onSelect,
  onRemove,
  projectFolders = [],
  currentProjectFolderId,
  onMoveToProjectFolder,
}: SessionRowProps) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const renameSession = useAppStore((s) => s.renameSession);
  const generateSessionTitle = useAppStore((s) => s.generateSessionTitle);
  const editorCommand = useSettings((s) => s.settings.editor.command);
  const editorConfigured = editorCommand.trim().length > 0;
  const sessionDisplay = useSettings((s) => s.settings.sessionDisplay);
  const showAgentProviderIcons = sessionDisplay.icons.agentProvider;
  const namedProjectFolders = projectFolders.filter(
    (folder) => !isDefaultProjectFolder(folder),
  );
  const currentProjectFolder = projectFolders.find(
    (folder) => folder.id === currentProjectFolderId,
  );
  const currentWorkspaceCwd = currentProjectFolder?.cwdPath ?? null;
  const hideWorkspaceDuplicateContext =
    currentProjectFolder !== undefined &&
    currentWorkspaceCwd !== null &&
    isWorktreeWorkspace(currentProjectFolder) &&
    normalizeWorkspacePath(session.worktree_path) ===
      normalizeWorkspacePath(currentWorkspaceCwd);
  const titleText = resolveSessionTitle(session, sessionDisplay.title);
  const metadataText = composeSessionMetadata(
    t,
    session,
    sessionDisplay.metadata,
    {
      hideBranch:
        hideWorkspaceDuplicateContext &&
        currentWorkspaceCwd !== null &&
        session.branch === basename(currentWorkspaceCwd),
      hideWorkingDirectory: hideWorkspaceDuplicateContext,
    },
  );
  const hoverDetails = sessionDisplay.showDetailsOnHover
    ? buildSessionHoverDetails(t, session)
    : null;
  const isGeneratingTitle = useAppStore((s) =>
    Boolean(s.generatingSessionTitleIds[session.id]),
  );
  const canRename = canRenameSession(session, { isGeneratingTitle });
  const canRegenerateTitle =
    canRegenerateSessionTitle(session) && !isGeneratingTitle;
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sessionDragId(session.id) });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    if (isGeneratingTitle && editing) setEditing(false);
  }, [editing, isGeneratingTitle]);

  async function regenerateTitle() {
    const settings = useSettings.getState().settings;
    const status = await generateSessionTitle(
      session.id,
      resolveAiExecutionRequest(settings),
      resolveSessionTitlePrompt(settings),
      true,
    );
    if (status === "not_ready") {
      showToast(t("toasts.session.titleNotReady"));
    } else if (status !== "generated") {
      showToast(t("toasts.session.titleRegenerateSkipped"));
    }
  }

  const agentProvider = showAgentProviderIcons
    ? resolveSessionAgentProvider(session)
    : null;
  const folderMoveMenuItems: ContextMenuItem[] = [];
  const targetFolderMenuItems: ContextMenuItem[] = [];
  if (onMoveToProjectFolder) {
    const defaultProjectFolder = projectFolders.find(isDefaultProjectFolder);
    const rootMoveMenuItems: ContextMenuItem[] = [];
    if (
      currentProjectFolder &&
      defaultProjectFolder &&
      !isDefaultProjectFolder(currentProjectFolder) &&
      canAssignSessionToWorkspace(
        session,
        currentProjectFolder,
        defaultProjectFolder,
      )
    ) {
      rootMoveMenuItems.push({
        label: sidebarText(t, "sidebar.actions.moveToProjectRoot"),
        icon: <Home size={12} />,
        onClick: () => onMoveToProjectFolder(session.id, null),
      });
    }
    for (const folder of namedProjectFolders) {
      if (folder.id === currentProjectFolderId) continue;
      if (
        !canAssignSessionToWorkspace(
          session,
          currentProjectFolder ?? null,
          folder,
        )
      ) {
        continue;
      }
      targetFolderMenuItems.push({
        label: folder.name,
        icon: <WorkspaceIcon folder={folder} size={12} />,
        onClick: () => onMoveToProjectFolder(session.id, folder.id),
      });
    }
    const moveToMenuItems: ContextMenuItem[] = [
      ...rootMoveMenuItems,
      ...(rootMoveMenuItems.length > 0 && targetFolderMenuItems.length > 0
        ? [{ type: "separator" as const }]
        : []),
      ...targetFolderMenuItems,
    ];
    if (moveToMenuItems.length > 0) {
      folderMoveMenuItems.push({
        type: "submenu",
        label: sidebarText(t, "sidebar.actions.moveToProjectFolder"),
        icon: <Folder size={12} />,
        children: moveToMenuItems,
      });
    }
  }

  const sessionMenuItems: ContextMenuItem[] = [
    contextMenuGroupTitle(t, "session"),
    {
      label: sidebarText(t, "sidebar.actions.rename"),
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
      disabled: !canRename,
    },
    {
      label: sidebarText(t, "sidebar.actions.regenerateName"),
      icon: <Sparkles size={12} />,
      onClick: () => void regenerateTitle(),
      disabled: !canRegenerateTitle,
    },
    ...(folderMoveMenuItems.length > 0
      ? [contextMenuGroupTitle(t, "workspace"), ...folderMoveMenuItems]
      : []),
    contextMenuGroupTitle(t, "open"),
    {
      label: sidebarText(t, "sidebar.actions.openWorktreeInEditor"),
      icon: <PencilLine size={12} />,
      disabled: !editorConfigured,
      onClick: () => {
        void openInConfiguredEditor(session.worktree_path).catch(
          (err: unknown) => {
            console.error("[Sidebar] open in editor failed", err);
          },
        );
      },
    },
    {
      label: sidebarText(t, "sidebar.actions.revealInFinder"),
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void api.fsReveal(session.worktree_path).catch((err: unknown) => {
          console.error("[Sidebar] reveal failed", err);
        });
      },
    },
    contextMenuGroupTitle(t, "copy"),
    {
      type: "submenu",
      label: sidebarText(t, "sidebar.actions.copy"),
      icon: <Copy size={12} />,
      children: [
        {
          label: sidebarText(t, "sidebar.actions.worktreePath"),
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(session.worktree_path),
        },
        {
          label: sidebarText(t, "sidebar.actions.worktreeName"),
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(basename(session.worktree_path)),
        },
        {
          label: sidebarText(t, "sidebar.actions.branchName"),
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(session.branch),
          disabled: !session.branch,
        },
        {
          label: sidebarText(t, "sidebar.actions.sessionId"),
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(session.id),
        },
      ],
    },
    contextMenuGroupTitle(t, "danger"),
    {
      label: sidebarText(t, "sidebar.actions.removeSessionMenu"),
      icon: <Trash2 size={12} />,
      onClick: onRemove,
    },
  ];

  const row = (
    <div
      ref={setActivatorNodeRef}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={editing ? undefined : onSelect}
      onPointerDown={(e) => {
        if (editing) return;
        listeners?.onPointerDown?.(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (canRename) setEditing(true);
      }}
      onKeyDown={(e) => {
        if (editing) return;
        listeners?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "F2") {
          e.preventDefault();
          if (canRename) setEditing(true);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "group flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left transition",
        active
          ? "bg-bg-elevated/70"
          : "bg-bg-elevated/30 hover:bg-bg-elevated/50",
        isDragging && "opacity-40",
      )}
    >
      {sessionDisplay.icons.statusDot || isGeneratingTitle ? (
        <SessionStatusMarker
          session={session}
          agentProvider={agentProvider}
          isGeneratingTitle={isGeneratingTitle}
          generatingLabel={sidebarText(t, "sidebar.aria.generatingSessionTitle")}
          chatLabel={sidebarText(t, "sidebar.aria.chatSession")}
        />
      ) : null}
      <SessionRowLabel
        editing={editing}
        session={session}
        titleText={titleText}
        metadataText={metadataText}
        showKindIcons={sessionDisplay.icons.sessionKind}
        hideWorktreeIcon={hideWorkspaceDuplicateContext}
        t={t}
        onSubmitRename={async (next) => {
          setEditing(false);
          if (canRename && next && next !== session.name) {
            await renameSession(session.id, next);
            const error = useAppStore.getState().consumeError();
            if (error) showToast(`${t("toasts.session.renameFailed")} ${error}`);
          }
        }}
        onCancelRename={() => setEditing(false)}
      />
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={sidebarText(t, "sidebar.actions.removeSession")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-danger group-hover:visible"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );

  return (
    <li ref={setNodeRef} style={style}>
      {hoverDetails ? (
        <Tooltip label={hoverDetails} side="right" multiline className="w-full">
          {row}
        </Tooltip>
      ) : (
        row
      )}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={sessionMenuItems}
      />
    </li>
  );
}

interface SessionRowLabelProps {
  editing: boolean;
  session: Session;
  titleText: string;
  metadataText: string;
  showKindIcons: boolean;
  hideWorktreeIcon?: boolean;
  t: Translator;
  onSubmitRename: (value: string) => void | Promise<void>;
  onCancelRename: () => void;
}

function SessionRowLabel({
  editing,
  session,
  titleText,
  metadataText,
  showKindIcons,
  hideWorktreeIcon = false,
  t,
  onSubmitRename,
  onCancelRename,
}: SessionRowLabelProps) {
  // Live cwd wins when a PTY is alive — a recorded worktree path doesn't
  // describe where the user is *now*. Static flags (`isolated` / static
  // `in_worktree`) only apply as fallback when the session has no live PTY,
  // in which case `liveInWorktree[id]` is `undefined`.
  const liveInWorktree = useAppStore((s) => s.liveInWorktree[session.id]);
  const inWorktree = liveInWorktree ?? hasRecordedWorktree(session);
  const body = (
    <span className="min-w-0 flex-1">
      <span className="flex h-5 items-center gap-1">
        {editing ? (
          <RenameInput
            initial={session.name}
            onSubmit={onSubmitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="truncate text-[13px] font-medium leading-5 text-fg">
            {titleText}
          </span>
        )}
        {showKindIcons && inWorktree && !hideWorktreeIcon ? (
          <GitBranch
            size={10}
            className="shrink-0 text-fg-muted"
            aria-label={sidebarText(t, "sidebar.aria.worktree")}
          />
        ) : null}
        {showKindIcons && session.kind === "control" ? (
          <Bot
            size={10}
            className="shrink-0 text-accent"
            aria-label={sidebarText(t, "sidebar.aria.controlSession")}
          />
        ) : null}
      </span>
      {metadataText ? (
        <span className="block truncate text-[11px] text-fg-muted">
          {metadataText}
        </span>
      ) : null}
    </span>
  );

  return body;
}

function SessionStatusMarker({
  session,
  agentProvider,
  isGeneratingTitle,
  generatingLabel,
  chatLabel,
}: {
  session: Session;
  agentProvider: SessionAgentProvider | null;
  isGeneratingTitle: boolean;
  generatingLabel: string;
  chatLabel: string;
}) {
  return (
    <span className="flex h-5 w-3 shrink-0 items-center justify-center">
      {isGeneratingTitle ? (
        <SessionTitleGeneratingIndicator label={generatingLabel} side="right" />
      ) : session.mode === "chat" ? (
        <Tooltip label={chatLabel} side="right">
          <MessageSquareText
            size={12}
            className={cn("shrink-0", STATUS_ICON[session.status])}
          />
        </Tooltip>
      ) : agentProvider ? (
        <Tooltip label={agentProvider} side="right">
          <AgentProviderIcon
            provider={agentProvider}
            className={cn("size-3", STATUS_ICON[session.status])}
          />
        </Tooltip>
      ) : (
        <span
          className={cn("size-1.5 rounded-full", STATUS_DOT[session.status])}
        />
      )}
    </span>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[Sidebar] clipboard write failed", err);
  }
}

interface RenameInputProps {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function RenameInput({ initial, onSubmit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initial);

  return (
    <input
      type="text"
      autoFocus
      draggable={false}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value.trim());
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onSubmit(value.trim())}
      className="min-w-0 w-full flex-1 rounded border border-accent/50 bg-bg px-1 py-0.5 text-[13px] font-medium text-fg outline-none focus:border-accent"
    />
  );
}

function EmptyState({ onOpenProject }: { onOpenProject: () => void }) {
  const t = useTranslation();

  return (
    <button
      type="button"
      onClick={onOpenProject}
      className="mx-1 flex cursor-pointer items-center justify-center rounded px-2 py-6 text-center text-xs text-fg-muted transition hover:bg-bg-elevated/40 hover:text-fg focus:outline-none"
    >
      {sidebarText(t, "sidebar.emptyProjects.openProject")}
    </button>
  );
}

interface LocalTerminalAreaProps {
  groups: ProjectFolderProjectGroup[];
  activeSessionId: string | null;
  activeProjectFolderId: string | null;
  collapsedFolderIds: ReadonlySet<string>;
  onCreate: () => void;
  onCreateInFolder: (folder: ProjectFolder) => void;
  onCreateWorkspace: () => void;
  onFocusArea: () => void;
  onSelectFolder: (folderId: string) => void;
  onToggleFolder: (folderId: string) => void;
  onSelectSession: (id: string) => void;
  onRemoveSession: (session: Session) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void;
}

function LocalTerminalArea({
  groups,
  activeSessionId,
  activeProjectFolderId,
  collapsedFolderIds,
  onCreate,
  onCreateInFolder,
  onCreateWorkspace,
  onFocusArea,
  onSelectFolder,
  onToggleFolder,
  onSelectSession,
  onRemoveSession,
  onRenameFolder,
  onRemoveFolder,
  onMoveSessionToFolder,
}: LocalTerminalAreaProps) {
  const t = useTranslation();
  const sessions = useMemo(
    () => groups.flatMap((group) => group.sessions),
    [groups],
  );
  const hasNamedWorkspaces = groups.some((group) =>
    group.folders.some((folderGroup) =>
      !isDefaultProjectFolder(folderGroup.folder),
    ),
  );
  const { setNodeRef: setRootDropNodeRef } = useDroppable({
    id: sessionProjectDropId(LOCAL_SESSION_ROOT_DROP_ID),
    disabled: groups.length === 0,
  });
  const sessionIds = useMemo(
    () => sessions.map((s) => sessionDragId(s.id)),
    [sessions],
  );

  return (
    <section
      tabIndex={-1}
      data-local-terminal-area="true"
      aria-label={sidebarText(t, "sidebar.aria.localTerminalSessions")}
      onMouseDown={(e) => {
        e.currentTarget.focus();
        onFocusArea();
      }}
      className={cn(
        "mt-4 flex min-h-28 shrink-0 flex-col pt-2",
        "rounded-md focus:outline-none",
      )}
    >
      <header
        ref={setRootDropNodeRef}
        className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"
      >
        <h2 className="text-xs font-medium text-fg-muted">
          {sidebarText(t, "sidebar.localTerminals.title")}
        </h2>
        <div className="flex items-center gap-1">
          <Tooltip
            label={sidebarText(t, "sidebar.localTerminals.newSession")}
            side="bottom"
          >
            <button
              type="button"
              aria-label={sidebarText(t, "sidebar.localTerminals.newSession")}
              onClick={(e) => {
                e.stopPropagation();
                onCreate();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="rounded-md p-1.5 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <Plus size={14} />
            </button>
          </Tooltip>
          <Tooltip
            label={sidebarText(t, "sidebar.localTerminals.newWorkspace")}
            side="bottom"
          >
            <button
              type="button"
              aria-label={sidebarText(t, "sidebar.localTerminals.newWorkspace")}
              onClick={(e) => {
                e.stopPropagation();
                onCreateWorkspace();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="rounded-md p-1.5 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <LayoutPanelLeft size={13} />
            </button>
          </Tooltip>
        </div>
      </header>
      {sessions.length > 0 && !hasNamedWorkspaces ? (
        <div onDoubleClick={(e) => e.stopPropagation()}>
          <SortableContext
            items={sessionIds}
            strategy={verticalListSortingStrategy}
          >
            <ul className="flex flex-col gap-0.5">
              {sessions.map((session) => (
                <LocalSessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRemove={() => onRemoveSession(session)}
                />
              ))}
            </ul>
          </SortableContext>
        </div>
      ) : null}
      {hasNamedWorkspaces ? (
        <ul className="flex flex-col gap-0.5">
          {groups.map((group) => {
            const defaultFolderGroup =
              group.folders.find((folderGroup) =>
                isDefaultProjectFolder(folderGroup.folder),
              ) ?? group.folders[0] ?? null;
            const namedFolderGroups = group.folders.filter(
              (folderGroup) => !isDefaultProjectFolder(folderGroup.folder),
            );
            return (
              <li key={group.repoPath} className="flex flex-col gap-0.5">
                {defaultFolderGroup?.sessions.length ? (
                  <SortableContext
                    items={defaultFolderGroup.sessions.map((session) =>
                      sessionDragId(session.id),
                    )}
                    strategy={verticalListSortingStrategy}
                  >
                    <ul className="flex flex-col gap-0.5">
                      {defaultFolderGroup.sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          active={session.id === activeSessionId}
                          onSelect={() => onSelectSession(session.id)}
                          onRemove={() => onRemoveSession(session)}
                          projectFolders={group.folders.map(
                            (folderGroup) => folderGroup.folder,
                          )}
                          currentProjectFolderId={
                            defaultFolderGroup.folder.id
                          }
                          onMoveToProjectFolder={onMoveSessionToFolder}
                        />
                      ))}
                    </ul>
                  </SortableContext>
                ) : null}
                {namedFolderGroups.map((folderGroup) => (
                  <LocalWorkspaceView
                    key={folderGroup.folder.id}
                    folderGroup={folderGroup}
                    projectFolders={group.folders.map(
                      (candidate) => candidate.folder,
                    )}
                    activeSessionId={activeSessionId}
                    active={activeProjectFolderId === folderGroup.folder.id}
                    collapsed={collapsedFolderIds.has(folderGroup.folder.id)}
                    onToggleFolder={() => onToggleFolder(folderGroup.folder.id)}
                    onActivate={() => onSelectFolder(folderGroup.folder.id)}
                    onCreateSession={() => onCreateInFolder(folderGroup.folder)}
                    onSelectSession={onSelectSession}
                    onRemoveSession={onRemoveSession}
                    onRenameFolder={onRenameFolder}
                    onRemoveFolder={onRemoveFolder}
                    onMoveSessionToFolder={onMoveSessionToFolder}
                  />
                ))}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div
        role="button"
        tabIndex={0}
        aria-label={
          sessions.length > 0
            ? sidebarText(t, "sidebar.localTerminals.newSession")
            : undefined
        }
        onDoubleClick={onCreate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCreate();
          }
        }}
        className="mx-1 mt-1 flex items-center justify-center rounded px-3 py-3 text-center text-[11px] text-fg-muted select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-border"
      >
        {sessions.length === 0 && groups.length === 0
            ? sidebarText(t, "sidebar.localTerminals.empty")
            : null}
      </div>
    </section>
  );
}

interface LocalWorkspaceViewProps {
  folderGroup: ProjectFolderGroup;
  projectFolders: ProjectFolder[];
  activeSessionId: string | null;
  active: boolean;
  collapsed: boolean;
  onToggleFolder: () => void;
  onActivate: () => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onRemoveSession: (session: Session) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onRemoveFolder: (folderId: string) => void;
  onMoveSessionToFolder: (sessionId: string, folderId: string | null) => void;
}

function LocalWorkspaceView({
  folderGroup,
  projectFolders,
  activeSessionId,
  active,
  collapsed,
  onToggleFolder,
  onActivate,
  onCreateSession,
  onSelectSession,
  onRemoveSession,
  onRenameFolder,
  onRemoveFolder,
  onMoveSessionToFolder,
}: LocalWorkspaceViewProps) {
  const t = useTranslation();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const folder = folderGroup.folder;
  const { setNodeRef } = useDroppable({
    id: sessionFolderDropId(folder.id),
  });
  const sessionIds = useMemo(
    () => folderGroup.sessions.map((session) => sessionDragId(session.id)),
    [folderGroup.sessions],
  );
  const workspaceLabel = workspacePathLabel(folder);

  function submitRename(next: string) {
    setEditing(false);
    onRenameFolder(folder.id, next);
  }

  const menuItems: ContextMenuItem[] = [
    contextMenuGroupTitle(t, "session"),
    {
      label: sidebarText(t, "sidebar.localTerminals.newSession"),
      icon: <Plus size={12} />,
      onClick: onCreateSession,
    },
    contextMenuGroupTitle(t, "workspace"),
    {
      label: sidebarText(t, "sidebar.actions.renameProjectFolder"),
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
    },
    {
      label: sidebarText(t, "sidebar.actions.revealInFinder"),
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void api.fsReveal(folder.cwdPath);
      },
    },
    {
      label: sidebarText(t, "sidebar.actions.copyPath"),
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(folder.cwdPath);
      },
    },
    contextMenuGroupTitle(t, "danger"),
    {
      label: sidebarText(t, "sidebar.actions.removeProjectFolder"),
      icon: <Trash2 size={12} />,
      onClick: () => onRemoveFolder(folder.id),
    },
  ];

  return (
    <div
      ref={setNodeRef}
      data-sidebar-workspace-id={folder.id}
      className="flex flex-col gap-0.5"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={editing ? undefined : onActivate}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          } else if (e.key === "F2") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className={cn(
          "group/local-workspace flex min-h-7 w-full items-center gap-1 rounded-md px-1.5 py-1 text-left transition",
          active
            ? "bg-bg-elevated/50"
            : "bg-bg-elevated/20 hover:bg-bg-elevated/30",
        )}
      >
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFolder();
          }}
          aria-label={sidebarText(
            t,
            collapsed
              ? "sidebar.actions.expandProjectFolder"
              : "sidebar.actions.collapseProjectFolder",
          )}
          aria-expanded={!collapsed}
          className="group/local-workspace-toggle relative flex size-5 shrink-0 self-start items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg focus-visible:bg-bg-elevated focus-visible:text-fg focus-visible:outline-none"
        >
          <WorkspaceIcon
            folder={folder}
            size={13}
            className="transition-opacity group-hover/local-workspace:opacity-0 group-focus-visible/local-workspace-toggle:opacity-0"
          />
          <ChevronRight
            size={12}
            className={cn(
              "absolute opacity-0 transition-[opacity,transform] group-hover/local-workspace:opacity-100 group-focus-visible/local-workspace-toggle:opacity-100",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <span className="min-w-0 flex-1">
          {editing ? (
            <RenameInput
              initial={folder.name}
              onSubmit={submitRename}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <span className="flex min-w-0 flex-col leading-none">
              <span className="block truncate text-[12px] font-medium leading-4 text-fg">
                {folder.name}
              </span>
              {workspaceLabel ? (
                <Tooltip
                  label={folder.cwdPath}
                  side="right"
                  className="min-w-0 max-w-full"
                >
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-3 text-fg-muted">
                    <FolderOpen size={10} className="shrink-0" />
                    <span className="truncate">{workspaceLabel}</span>
                  </span>
                </Tooltip>
              ) : null}
            </span>
          )}
        </span>
        {!editing ? (
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Tooltip
              label={sidebarText(t, "sidebar.localTerminals.newSession")}
              side="bottom"
            >
              <button
                type="button"
                aria-label={sidebarText(t, "sidebar.localTerminals.newSession")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateSession();
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover/local-workspace:visible group-focus-within/local-workspace:visible"
              >
                <Plus size={12} />
              </button>
            </Tooltip>
            <Tooltip
              label={sidebarText(t, "sidebar.actions.removeProjectFolder")}
              side="bottom"
            >
              <button
                type="button"
                aria-label={sidebarText(t, "sidebar.actions.removeProjectFolder")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveFolder(folder.id);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-danger group-hover/local-workspace:visible group-focus-within/local-workspace:visible"
              >
                <Trash2 size={12} />
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={menuItems}
      />
      {!collapsed ? (
        <SortableContext
          items={sessionIds}
          strategy={verticalListSortingStrategy}
        >
          <ul className="ml-4 flex flex-col gap-0.5 border-l border-border pl-1 pt-0.5">
            {folderGroup.sessions.length === 0 ? (
              <li className="flex items-center justify-center rounded px-3 py-2 text-center text-[11px] text-fg-muted select-none">
                {sidebarText(t, "sidebar.emptyProjectFolder.noSessions")}
              </li>
            ) : (
              folderGroup.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRemove={() => onRemoveSession(session)}
                  projectFolders={projectFolders}
                  currentProjectFolderId={folder.id}
                  onMoveToProjectFolder={onMoveSessionToFolder}
                />
              ))
            )}
          </ul>
        </SortableContext>
      ) : null}
    </div>
  );
}

interface LocalSessionRowProps {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function LocalSessionRow({
  session,
  active,
  onSelect,
  onRemove,
}: LocalSessionRowProps) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const renameSession = useAppStore((s) => s.renameSession);
  const generateSessionTitle = useAppStore((s) => s.generateSessionTitle);
  const sessionDisplay = useSettings((s) => s.settings.sessionDisplay);
  const titleText = resolveSessionTitle(session, sessionDisplay.title);
  const metadataText = composeSessionMetadata(
    t,
    session,
    sessionDisplay.metadata,
  );
  const agentProvider = sessionDisplay.icons.agentProvider
    ? resolveSessionAgentProvider(session)
    : null;
  const hoverDetails = sessionDisplay.showDetailsOnHover
    ? buildSessionHoverDetails(t, session)
    : null;
  const isGeneratingTitle = useAppStore((s) =>
    Boolean(s.generatingSessionTitleIds[session.id]),
  );
  const canRename = canRenameSession(session, { isGeneratingTitle });
  const canRegenerateTitle =
    canRegenerateSessionTitle(session) && !isGeneratingTitle;
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sessionDragId(session.id) });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  useEffect(() => {
    if (isGeneratingTitle && editing) setEditing(false);
  }, [editing, isGeneratingTitle]);

  async function regenerateTitle() {
    const settings = useSettings.getState().settings;
    const status = await generateSessionTitle(
      session.id,
      resolveAiExecutionRequest(settings),
      resolveSessionTitlePrompt(settings),
      true,
    );
    if (status === "not_ready") {
      showToast(t("toasts.session.titleNotReady"));
    } else if (status !== "generated") {
      showToast(t("toasts.session.titleRegenerateSkipped"));
    }
  }

  const menuItems: ContextMenuItem[] = [
    {
      label: sidebarText(t, "sidebar.actions.rename"),
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
      disabled: !canRename,
    },
    {
      label: sidebarText(t, "sidebar.actions.regenerateName"),
      icon: <Sparkles size={12} />,
      onClick: () => void regenerateTitle(),
      disabled: !canRegenerateTitle,
    },
    { type: "separator" },
    {
      label: sidebarText(t, "sidebar.actions.revealInFinder"),
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void api.fsReveal(session.worktree_path).catch((err: unknown) => {
          console.error("[Sidebar] reveal failed", err);
        });
      },
    },
    {
      label: sidebarText(t, "sidebar.actions.copyWorktreePath"),
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.worktree_path),
    },
    { type: "separator" },
    {
      label: sidebarText(t, "sidebar.actions.removeSessionMenu"),
      icon: <Trash2 size={12} />,
      onClick: onRemove,
    },
  ];

  const row = (
    <div
      ref={setActivatorNodeRef}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={editing ? undefined : onSelect}
      onPointerDown={(e) => {
        if (editing) return;
        listeners?.onPointerDown?.(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (canRename) setEditing(true);
      }}
      onKeyDown={(e) => {
        if (editing) return;
        listeners?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        } else if (e.key === "F2") {
          e.preventDefault();
          if (canRename) setEditing(true);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "group flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-left transition",
        active
          ? "bg-bg-elevated/70"
          : "bg-bg-elevated/30 hover:bg-bg-elevated/50",
        isDragging && "opacity-40",
      )}
    >
      {sessionDisplay.icons.statusDot || isGeneratingTitle ? (
        <SessionStatusMarker
          session={session}
          agentProvider={agentProvider}
          isGeneratingTitle={isGeneratingTitle}
          generatingLabel={sidebarText(t, "sidebar.aria.generatingSessionTitle")}
          chatLabel={sidebarText(t, "sidebar.aria.chatSession")}
        />
      ) : null}
      <SessionRowLabel
        editing={editing}
        session={session}
        titleText={titleText}
        metadataText={metadataText}
        showKindIcons={sessionDisplay.icons.sessionKind}
        t={t}
        onSubmitRename={async (next) => {
          setEditing(false);
          if (canRename && next && next !== session.name) {
            await renameSession(session.id, next);
            const error = useAppStore.getState().consumeError();
            if (error) showToast(`${t("toasts.session.renameFailed")} ${error}`);
          }
        }}
        onCancelRename={() => setEditing(false)}
      />
      <span
        role="button"
        aria-label={sidebarText(t, "sidebar.actions.removeSession")}
        tabIndex={0}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }
        }}
        className="invisible rounded p-1 text-fg-muted transition hover:text-danger group-hover:visible"
      >
        <Trash2 size={12} />
      </span>
    </div>
  );

  return (
    <li ref={setNodeRef} style={style}>
      {hoverDetails ? (
        <Tooltip label={hoverDetails} side="right" multiline className="w-full">
          {row}
        </Tooltip>
      ) : (
        row
      )}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={menuItems}
      />
    </li>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function resolveSessionTitle(
  session: Session,
  source: SessionTitleSource,
): string {
  switch (source) {
    case "workingDirectory":
      return basename(session.worktree_path) || session.name;
    case "branch":
      return session.branch || session.name;
    case "name":
    default:
      return session.name;
  }
}

function composeSessionMetadata(
  t: Translator,
  session: Session,
  metadata: AcornSettings["sessionDisplay"]["metadata"],
  options: {
    hideBranch?: boolean;
    hideWorkingDirectory?: boolean;
  } = {},
): string {
  const parts: string[] = [];
  if (metadata.branch && session.branch && !options.hideBranch) {
    parts.push(session.branch);
  }
  if (metadata.workingDirectory && !options.hideWorkingDirectory) {
    const dir = basename(session.worktree_path);
    if (dir) parts.push(dir);
  }
  if (metadata.status) parts.push(statusLabel(t, session.status));
  return parts.join(" · ");
}

function buildSessionHoverDetails(t: Translator, session: Session): ReactNode {
  const branch =
    session.branch || sidebarText(t, "sidebar.metadata.detached");

  return (
    <span className="flex w-72 max-w-full flex-col gap-1.5">
      <SessionHoverDetailRow
        icon={<Tag size={12} />}
        label={sidebarText(t, "sidebar.metadata.name")}
        value={session.name}
      />
      <SessionHoverDetailRow
        icon={<GitBranch size={12} />}
        label={sidebarText(t, "sidebar.metadata.branch")}
        value={branch}
        valueClassName="font-mono"
      />
      <SessionHoverDetailRow
        icon={<Folder size={12} />}
        label={sidebarText(t, "sidebar.metadata.workingDirectory")}
        value={session.worktree_path}
        valueClassName="break-all font-mono"
      />
      <SessionHoverDetailRow
        icon={<Activity size={12} />}
        iconClassName={STATUS_ICON[session.status]}
        label={sidebarText(t, "sidebar.metadata.status")}
        value={statusLabel(t, session.status)}
        valueClassName={STATUS_ICON[session.status]}
      />
      {session.kind === "control" ? (
        <SessionHoverDetailRow
          icon={<Bot size={12} />}
          iconClassName="text-accent"
          label={sidebarText(t, "sidebar.metadata.kind")}
          value={sidebarText(t, "sidebar.metadata.controlSession")}
        />
      ) : null}
      {session.isolated ? (
        <SessionHoverFlag
          icon={<GitBranch size={12} />}
          value={sidebarText(t, "sidebar.metadata.isolatedWorktree")}
        />
      ) : null}
    </span>
  );
}

function SessionHoverDetailRow({
  icon,
  iconClassName,
  label,
  value,
  valueClassName,
}: {
  icon: ReactNode;
  iconClassName?: string;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <span className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border/70 bg-bg/60 text-fg-muted",
          iconClassName,
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] leading-3 text-fg-muted">
          {label}
        </span>
        <span
          className={cn(
            "block min-w-0 break-words text-[11px] leading-snug text-fg",
            valueClassName,
          )}
        >
          {value}
        </span>
      </span>
    </span>
  );
}

function SessionHoverFlag({
  icon,
  value,
}: {
  icon: ReactNode;
  value: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 rounded border border-border/60 bg-bg/40 px-1.5 py-1 text-[11px] leading-none text-fg">
      <span
        aria-hidden="true"
        className="flex size-4 shrink-0 items-center justify-center rounded bg-bg-elevated/70 text-fg-muted"
      >
        {icon}
      </span>
      <span className="min-w-0 truncate">{value}</span>
    </span>
  );
}

function loadStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // ignore
  }
  return new Set();
}

function saveStringSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    // ignore
  }
}

function loadStringArrayRecord(key: string): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record: Record<string, string[]> = {};
    for (const [recordKey, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const ids = value.filter((x): x is string => typeof x === "string");
      if (ids.length > 0) record[recordKey] = Array.from(new Set(ids));
    }
    return record;
  } catch {
    return {};
  }
}

function saveStringArrayRecord(
  key: string,
  record: Record<string, string[]>,
): void {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // ignore
  }
}

function stringArraysEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
