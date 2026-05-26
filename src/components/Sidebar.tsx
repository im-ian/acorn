import {
  Bot,
  ChevronRight,
  CircleX,
  Columns2,
  Copy,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GripVertical,
  Pencil,
  PencilLine,
  Plus,
  SquareX,
  Trash2,
  X,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { homeDir } from "@tauri-apps/api/path";
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
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
import { cn } from "../lib/cn";
import { openInConfiguredEditor } from "../lib/editor";
import type { TranslationKey, Translator } from "../lib/i18n";
import { formatHotkey, Hotkeys } from "../lib/hotkeys";
import { EQUALIZE_PANES_EVENT } from "../lib/layoutEvents";
import {
  useSettings,
  type AcornSettings,
  type SessionTitleSource,
} from "../lib/settings";
import { canRenameSession } from "../lib/sessionTitle";
import { hasRecordedWorktree } from "../lib/sessionWorktree";
import { useTranslation } from "../lib/useTranslation";
import {
  buildLocalSessions,
  buildProjectGroups,
  type ProjectGroup,
} from "../lib/sessionGrouping";
import {
  applySessionCreateRequest,
  buildLocalSessionCreateRequest,
  buildSessionCreateRequest,
  buildSessionCreateRequestFromScope,
  resolveActiveSessionScope,
  type SessionCreateScope,
} from "../lib/sessionCreation";
import {
  planChevronClick,
  planTitleClick,
  type ProjectClickPlan,
} from "../lib/sidebar-actions";
import type { Session, SessionKind, SessionStatus } from "../lib/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { NewProjectDialog } from "./NewProjectDialog";
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

const PROJECT_DRAG_PREFIX = "project:";
const SESSION_DRAG_PREFIX = "session:";
const LOCAL_TERMINAL_AREA_SELECTOR = "[data-local-terminal-area='true']";

type SidebarTranslationKey = Extract<TranslationKey, `sidebar.${string}`>;

function sidebarText(t: Translator, key: SidebarTranslationKey): string {
  return t(key);
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
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeProject = useAppStore((s) => s.activeProject);
  const selectSession = useAppStore((s) => s.selectSession);
  const focusLocalSessions = useAppStore((s) => s.focusLocalSessions);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  const createSession = useAppStore((s) => s.createSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const requestRemoveProject = useAppStore((s) => s.requestRemoveProject);
  const addProject = useAppStore((s) => s.addProject);
  const createNewProject = useAppStore((s) => s.createNewProject);
  const reorderProjects = useAppStore((s) => s.reorderProjects);
  const reorderSessions = useAppStore((s) => s.reorderSessions);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  const projectGroups = useMemo(
    () => buildProjectGroups(projects, sessions),
    [projects, sessions],
  );
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

  function applyClickPlan(plan: ProjectClickPlan, project: ProjectGroup) {
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
      const repoPath = await open({
        directory: true,
        multiple: false,
        title: sidebarText(t, "sidebar.dialog.selectExistingProject"),
      });
      if (!repoPath || typeof repoPath !== "string") return;
      await addProject(repoPath);
    } catch (e) {
      console.error("add project failed", e);
    }
  }

  const onNewSessionRef = useRef<
    (
      isolated: boolean,
      kind: SessionKind,
      scopeOverride?: SessionCreateScope,
    ) => Promise<void>
  >(async () => {});
  const onNewLocalSessionRef = useRef<() => Promise<void>>(async () => {});
  const onAddProjectRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const activeScope = (): SessionCreateScope | null => {
      const state = useAppStore.getState();
      return resolveActiveSessionScope({
        sessions: state.sessions,
        projects: state.projects,
        activeSessionId: state.activeSessionId,
        activeWorkspaceRepoPath: state.activeProject,
      });
    };
    const newSession = () => {
      if (isLocalTerminalAreaFocused()) {
        void onNewLocalSessionRef.current();
        return;
      }
      void onNewSessionRef.current(false, "regular", activeScope() ?? undefined);
    };
    const newIsolated = () => {
      const scope = activeScope();
      void onNewSessionRef.current(
        true,
        "regular",
        scope?.projectScoped === false ? undefined : (scope ?? undefined),
      );
    };
    const newControl = () => {
      const scope = activeScope();
      void onNewSessionRef.current(
        false,
        "control",
        scope?.projectScoped === false ? undefined : (scope ?? undefined),
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
    window.addEventListener("acorn:new-project", newProject);
    window.addEventListener("acorn:add-project", addProj);
    return () => {
      window.removeEventListener("acorn:new-session", newSession);
      window.removeEventListener("acorn:new-isolated-session", newIsolated);
      window.removeEventListener("acorn:new-control-session", newControl);
      window.removeEventListener("acorn:new-project", newProject);
      window.removeEventListener("acorn:add-project", addProj);
    };
  }, []);

  async function onNewSession(
    isolated: boolean,
    kind: SessionKind,
    scopeOverride?: SessionCreateScope,
  ) {
    try {
      const pickedPath =
        scopeOverride?.repoPath ??
        (await open({
          directory: true,
          multiple: false,
          title: isolated
            ? sidebarText(t, "sidebar.dialog.selectIsolatedRepository")
            : kind === "control"
              ? sidebarText(t, "sidebar.dialog.selectControlDirectory")
              : sidebarText(t, "sidebar.dialog.selectDirectory"),
        }));
      if (!pickedPath || typeof pickedPath !== "string") return;
      const request = buildSessionCreateRequest(
        { sessions, projects },
        {
          repoPath: pickedPath,
          isolated,
          kind,
          projectScoped:
            scopeOverride?.projectScoped ??
            (isolated || kind === "control" ? true : undefined),
        },
      );
      await applySessionCreateRequest(createSession, request);
      setCollapsed((prev) => {
        if (!prev.has(request.repoPath)) return prev;
        const next = new Set(prev);
        next.delete(request.repoPath);
        return next;
      });
    } catch (e) {
      console.error("create session failed", e);
    }
  }

  async function onNewLocalSession() {
    try {
      const home = await homeDir();
      if (!home) return;
      await applySessionCreateRequest(
        createSession,
        buildLocalSessionCreateRequest({ sessions, projects }, home),
      );
    } catch (e) {
      console.error("create local terminal session failed", e);
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
    const prefix = activeId.startsWith(PROJECT_DRAG_PREFIX)
      ? PROJECT_DRAG_PREFIX
      : SESSION_DRAG_PREFIX;
    const filtered = args.droppableContainers.filter((c) =>
      String(c.id).startsWith(prefix),
    );
    return closestCenter({ ...args, droppableContainers: filtered });
  };

  function onDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
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
      const orderedSessions =
        activeSession.project_scoped === false
          ? localSessions
          : (projectGroups.find((g) => g.repoPath === activeSession.repo_path)
              ?.sessions ?? []);
      if (orderedSessions.length === 0) return;
      const ids = orderedSessions.map((s) => s.id);
      const fromIdx = ids.indexOf(activeSid);
      const toIdx = ids.indexOf(overSid);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      const next = arrayMove(ids, fromIdx, toIdx);
      void reorderSessions(activeSession.repo_path, next);
    }
  }

  return (
    <aside className="flex h-full w-full flex-col bg-bg-sidebar">
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
                {projectGroups.map((project) => (
                  <ProjectGroupView
                    key={project.repoPath}
                    project={project}
                    collapsed={collapsed.has(project.repoPath)}
                    activeSessionId={activeSessionId}
                    isActiveProject={activeProject === project.repoPath}
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
                    onSelectSession={selectSession}
                    onRemoveSession={(s) => requestRemoveSession(s.id)}
                    onAddSession={(isolated, kind) =>
                      onNewSession(isolated, kind, {
                        repoPath: project.repoPath,
                        projectScoped: true,
                      })
                    }
                    onRemoveProject={() =>
                      requestRemoveProject(project.repoPath)
                    }
                  />
                ))}
              </ul>
            </SortableContext>
          )}
          <LocalTerminalArea
            sessions={localSessions}
            activeSessionId={activeSessionId}
            onCreate={onNewLocalSession}
            onFocusArea={focusLocalSessions}
            onSelectSession={selectSession}
            onRemoveSession={(s) => requestRemoveSession(s.id)}
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
          await createNewProject(parentPath, name, ignoreSafeName);
        }}
      />
    </aside>
  );
}

function renderDragOverlay(
  activeDragId: string,
  projectGroups: ProjectGroup[],
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
      <span className="flex size-4 shrink-0 items-center justify-center text-fg-muted/60">
        <GripVertical size={12} />
      </span>
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

function SessionRowPreview({
  session,
  t,
}: {
  session: Session;
  t: Translator;
}) {
  const showAgentProviderIcons = useSettings(
    (s) => s.settings.sessionDisplay.icons.agentProvider,
  );
  const agentProvider = showAgentProviderIcons
    ? resolveSessionAgentProvider(session)
    : null;

  return (
    <div className="flex w-full items-start gap-1.5 rounded-md bg-bg-elevated/95 px-2 py-1 shadow-lg ring-1 ring-border/60">
      <span className="mt-1 flex shrink-0 items-center text-fg-muted/60">
        <GripVertical size={10} />
      </span>
      <span className="flex h-5 w-3 shrink-0 items-center justify-center">
        {agentProvider ? (
          <Tooltip label={agentProvider} side="right">
            <AgentProviderIcon
              provider={agentProvider}
              className={cn("size-3", STATUS_ICON[session.status])}
            />
          </Tooltip>
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full",
              STATUS_DOT[session.status],
            )}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex h-5 items-center gap-1">
          <span className="truncate text-[13px] font-medium leading-5 text-fg">
            {session.name}
          </span>
          {hasRecordedWorktree(session) ? (
            <GitBranch size={10} className="shrink-0 text-fg-muted" />
          ) : null}
        </span>
        <span className="block truncate text-[11px] text-fg-muted">
          {session.branch} · {statusLabel(t, session.status)}
        </span>
      </span>
    </div>
  );
}

function projectDragId(repoPath: string): string {
  return `${PROJECT_DRAG_PREFIX}${repoPath}`;
}

function sessionDragId(id: string): string {
  return `${SESSION_DRAG_PREFIX}${id}`;
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

interface ProjectGroupViewProps {
  project: ProjectGroup;
  collapsed: boolean;
  activeSessionId: string | null;
  isActiveProject: boolean;
  /** Title click: activate (preserve collapse if inactive); ensure expanded if already active. */
  onTitleClick: () => void;
  /** Chevron click: activate + toggle expand. */
  onChevronClick: () => void;
  /** Empty-state row click: activate + expand + select a session. */
  onActivate: () => void;
  onSelectSession: (id: string) => void;
  onRemoveSession: (s: Session) => void;
  onAddSession: (isolated: boolean, kind: SessionKind) => void;
  onRemoveProject: () => void;
}

function ProjectGroupView({
  project,
  collapsed,
  activeSessionId,
  isActiveProject,
  onTitleClick,
  onChevronClick,
  onActivate,
  onSelectSession,
  onRemoveSession,
  onAddSession,
  onRemoveProject,
}: ProjectGroupViewProps) {
  const t = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: projectDragId(project.repoPath) });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const sessionIds = useMemo(
    () => project.sessions.map((s) => sessionDragId(s.id)),
    [project.sessions],
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
      await openPath(path);
    } catch {
      // ignore
    }
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn("relative", isDragging && "opacity-40")}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onTitleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTitleClick();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        aria-label={`${sidebarText(t, "sidebar.aria.project")} ${project.name}`}
        className={cn(
          "group flex min-h-8 items-center gap-1 rounded-md px-1 py-1.5 hover:bg-bg-elevated/40",
          isActiveProject && "bg-bg-elevated/30",
        )}
      >
        <Tooltip
          label={sidebarText(t, "sidebar.actions.dragToReorder")}
          side="bottom"
        >
          <span
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            aria-label={sidebarText(t, "sidebar.aria.dragToReorderProject")}
            className="invisible flex size-4 shrink-0 cursor-grab items-center justify-center text-fg-muted/60 active:cursor-grabbing group-hover:visible"
          >
            <GripVertical size={12} />
          </span>
        </Tooltip>
        <button
          type="button"
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
          <span className="ml-1 flex h-4 shrink-0 items-center rounded bg-bg-elevated/80 px-1 text-[10px] leading-none text-fg-muted">
            {project.sessions.length}
          </span>
        </span>
        <Tooltip
          label={sidebarText(t, "sidebar.actions.newSession")}
          side="bottom"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddSession(false, "regular");
            }}
            className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
            aria-label={sidebarText(t, "sidebar.aria.newSessionInProject")}
          >
            <Plus size={12} />
          </button>
        </Tooltip>
        <Tooltip
          label={sidebarText(t, "sidebar.actions.newIsolatedSessionWorktree")}
          side="bottom"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddSession(true, "regular");
            }}
            className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
            aria-label={sidebarText(
              t,
              "sidebar.actions.newIsolatedSessionWorktree",
            )}
          >
            <GitBranch size={12} />
          </button>
        </Tooltip>
        <Tooltip
          label={sidebarText(t, "sidebar.actions.newControlSession")}
          side="bottom"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddSession(false, "control");
            }}
            className="invisible flex size-5 items-center justify-center rounded text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
            aria-label={sidebarText(
              t,
              "sidebar.aria.newControlSessionInProject",
            )}
          >
            <Bot size={12} />
          </button>
        </Tooltip>
        <Tooltip
          label={sidebarText(t, "sidebar.actions.closeProject")}
          side="bottom"
        >
          <button
            type="button"
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
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={[
          {
            label: sidebarText(t, "sidebar.actions.newSession"),
            icon: <Plus size={12} />,
            onClick: () => onAddSession(false, "regular"),
          },
          {
            label: sidebarText(t, "sidebar.actions.newIsolatedSession"),
            icon: <GitBranch size={12} />,
            onClick: () => onAddSession(true, "regular"),
          },
          {
            label: sidebarText(t, "sidebar.actions.newControlSession"),
            icon: <Bot size={12} />,
            onClick: () => onAddSession(false, "control"),
          },
          { type: "separator" },
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
          { type: "separator" },
          {
            label: sidebarText(t, "sidebar.actions.closeProject"),
            icon: <X size={12} />,
            onClick: onRemoveProject,
          },
        ]}
      />
      {!collapsed ? (
        <SortableContext
          items={sessionIds}
          strategy={verticalListSortingStrategy}
        >
          <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1 pt-0.5">
            {project.sessions.length === 0 ? (
              <li
                role="button"
                tabIndex={0}
                onClick={onActivate}
                onDoubleClick={() => onAddSession(false, "regular")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onAddSession(false, "regular");
                  }
                }}
                className="flex cursor-pointer items-center justify-center rounded px-3 py-3 text-center text-[11px] text-fg-muted transition select-none hover:bg-bg-elevated/40 hover:text-fg"
              >
                {sidebarText(t, "sidebar.emptyProject.createSession")}
              </li>
            ) : (
              project.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  projectSessions={project.sessions}
                  active={session.id === activeSessionId}
                  onSelect={() => onSelectSession(session.id)}
                  onRemove={() => onRemoveSession(session)}
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
  projectSessions: Session[];
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function SessionRow({
  session,
  projectSessions,
  active,
  onSelect,
  onRemove,
}: SessionRowProps) {
  const t = useTranslation();
  const renameSession = useAppStore((s) => s.renameSession);
  const editorCommand = useSettings((s) => s.settings.editor.command);
  const editorConfigured = editorCommand.trim().length > 0;
  const sessionDisplay = useSettings((s) => s.settings.sessionDisplay);
  const showAgentProviderIcons = sessionDisplay.icons.agentProvider;
  const titleText = resolveSessionTitle(session, sessionDisplay.title);
  const metadataText = composeSessionMetadata(
    t,
    session,
    sessionDisplay.metadata,
  );
  const hoverDetails = sessionDisplay.showDetailsOnHover
    ? buildSessionHoverDetails(t, session)
    : null;
  const isGeneratingTitle = useAppStore((s) =>
    Boolean(s.generatingSessionTitleIds[session.id]),
  );
  const canRename = canRenameSession(session, { isGeneratingTitle });
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

  async function duplicate() {
    const base = session.name;
    const taken = new Set(useAppStore.getState().sessions.map((s) => s.name));
    let next = `${base}-copy`;
    let n = 2;
    while (taken.has(next)) {
      next = `${base}-copy-${n}`;
      n += 1;
    }
    try {
      // Route through the store wrapper so the duplicate gets the same
      // post-create treatment as Cmd+T and Pane "Duplicate Session": land
      // next to the active tab, auto-select, and auto-focus xterm. Carries
      // the source session's `kind` so a control session stays a control
      // session (preserves its IPC-dispatch role).
      const state = useAppStore.getState();
      await applySessionCreateRequest(
        state.createSession,
        buildSessionCreateRequestFromScope(
          { sessions: state.sessions, projects: state.projects },
          {
            repoPath: session.repo_path,
            projectScoped: session.project_scoped !== false,
          },
          {
            name: next,
            isolated: session.isolated,
            kind: session.kind,
          },
        ),
      );
    } catch (err) {
      console.error("[Sidebar] duplicate session failed", err);
    }
  }

  const otherSiblings = useMemo(
    () => projectSessions.filter((s) => s.id !== session.id),
    [projectSessions, session.id],
  );
  const agentProvider = showAgentProviderIcons
    ? resolveSessionAgentProvider(session)
    : null;

  const sessionMenuItems: ContextMenuItem[] = [
    {
      label: sidebarText(t, "sidebar.actions.rename"),
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
      disabled: !canRename,
    },
    {
      label: sidebarText(t, "sidebar.actions.duplicateSession"),
      icon: <Files size={12} />,
      onClick: () => void duplicate(),
    },
    { type: "separator" },
    {
      label: sidebarText(t, "sidebar.actions.equalizePaneSizes"),
      icon: <Columns2 size={12} />,
      shortcut: formatHotkey(Hotkeys.equalizePanes),
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
    },
    { type: "separator" },
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
        void openPath(session.worktree_path).catch((err: unknown) => {
          console.error("[Sidebar] reveal failed", err);
        });
      },
    },
    { type: "separator" },
    {
      label: sidebarText(t, "sidebar.actions.copyWorktreePath"),
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.worktree_path),
    },
    {
      label: sidebarText(t, "sidebar.actions.copyWorktreeName"),
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(basename(session.worktree_path)),
    },
    {
      label: sidebarText(t, "sidebar.actions.copyBranchName"),
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.branch),
      disabled: !session.branch,
    },
    {
      label: sidebarText(t, "sidebar.actions.copySessionId"),
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.id),
    },
    { type: "separator" },
    {
      label: sidebarText(t, "sidebar.actions.remove"),
      icon: <Trash2 size={12} />,
      onClick: onRemove,
    },
    {
      label: sidebarText(t, "sidebar.actions.removeOthersInProject"),
      icon: <CircleX size={12} />,
      disabled: otherSiblings.length === 0,
      onClick: () => {
        const request = useAppStore.getState().requestRemoveSession;
        for (const s of otherSiblings) request(s.id);
      },
    },
    {
      label: sidebarText(t, "sidebar.actions.removeAllInProject"),
      icon: <SquareX size={12} />,
      disabled: projectSessions.length === 0,
      onClick: () => {
        const request = useAppStore.getState().requestRemoveSession;
        for (const s of projectSessions) request(s.id);
      },
    },
  ];

  const row = (
    <div
        role="button"
        tabIndex={0}
        onClick={editing ? undefined : onSelect}
        onKeyDown={(e) => {
          if (editing) return;
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
          active ? "bg-bg-elevated" : "hover:bg-bg-elevated/60",
          isDragging && "opacity-40",
        )}
      >
        <span
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          aria-label={sidebarText(t, "sidebar.aria.dragToReorderSession")}
          className="invisible mt-1 flex shrink-0 cursor-grab items-center text-fg-muted/60 active:cursor-grabbing group-hover:visible"
        >
          <GripVertical size={10} />
        </span>
        {sessionDisplay.icons.statusDot ? (
          <span className="flex h-5 w-3 shrink-0 items-center justify-center">
            {agentProvider ? (
              <Tooltip label={agentProvider} side="right">
                <AgentProviderIcon
                  provider={agentProvider}
                  className={cn("size-3", STATUS_ICON[session.status])}
                />
              </Tooltip>
            ) : (
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  STATUS_DOT[session.status],
                )}
              />
            )}
          </span>
        ) : null}
        <SessionRowLabel
          editing={editing}
          session={session}
          titleText={titleText}
          metadataText={metadataText}
          showKindIcons={sessionDisplay.icons.sessionKind}
          isGeneratingTitle={isGeneratingTitle}
          t={t}
          onSubmitRename={async (next) => {
            setEditing(false);
            if (canRename && next && next !== session.name) {
              await renameSession(session.id, next);
            }
          }}
          onCancelRename={() => setEditing(false)}
        />
        <span
          role="button"
          aria-label={sidebarText(t, "sidebar.actions.removeSession")}
          tabIndex={0}
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
  isGeneratingTitle: boolean;
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
  isGeneratingTitle,
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
        {isGeneratingTitle && !editing ? (
          <SessionTitleGeneratingIndicator
            label={sidebarText(t, "sidebar.aria.generatingSessionTitle")}
            side="right"
          />
        ) : null}
        {showKindIcons && inWorktree ? (
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
      value={value}
      onChange={(e) => setValue(e.target.value)}
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
      className="min-w-0 flex-1 rounded border border-accent/50 bg-bg px-1 py-0.5 text-[13px] font-medium text-fg outline-none focus:border-accent"
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
  sessions: Session[];
  activeSessionId: string | null;
  onCreate: () => void;
  onFocusArea: () => void;
  onSelectSession: (id: string) => void;
  onRemoveSession: (session: Session) => void;
}

function LocalTerminalArea({
  sessions,
  activeSessionId,
  onCreate,
  onFocusArea,
  onSelectSession,
  onRemoveSession,
}: LocalTerminalAreaProps) {
  const t = useTranslation();
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
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className="text-xs font-medium text-fg-muted">
          {sidebarText(t, "sidebar.localTerminals.title")}
        </h2>
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
      </header>
      {sessions.length > 0 ? (
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
        {sessions.length === 0
          ? sidebarText(t, "sidebar.localTerminals.empty")
          : null}
      </div>
    </section>
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
  const renameSession = useAppStore((s) => s.renameSession);
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

  async function duplicate() {
    const base = session.name;
    const taken = new Set(useAppStore.getState().sessions.map((s) => s.name));
    let next = `${base}-copy`;
    let n = 2;
    while (taken.has(next)) {
      next = `${base}-copy-${n}`;
      n += 1;
    }
    const state = useAppStore.getState();
    await applySessionCreateRequest(
      state.createSession,
      buildSessionCreateRequestFromScope(
        { sessions: state.sessions, projects: state.projects },
        { repoPath: session.repo_path, projectScoped: false },
        { name: next },
      ),
    );
  }

  const menuItems: ContextMenuItem[] = [
    {
      label: sidebarText(t, "sidebar.actions.rename"),
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
      disabled: !canRename,
    },
    {
      label: sidebarText(t, "sidebar.actions.duplicateSession"),
      icon: <Files size={12} />,
      onClick: () => void duplicate(),
    },
    { type: "separator" },
    {
      label: sidebarText(t, "sidebar.actions.revealInFinder"),
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void openPath(session.worktree_path).catch((err: unknown) => {
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
      label: sidebarText(t, "sidebar.actions.remove"),
      icon: <Trash2 size={12} />,
      onClick: onRemove,
    },
  ];

  const row = (
    <div
      role="button"
      tabIndex={0}
      onClick={editing ? undefined : onSelect}
      onKeyDown={(e) => {
        if (editing) return;
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
        active ? "bg-bg-elevated" : "hover:bg-bg-elevated/60",
        isDragging && "opacity-40",
      )}
    >
      <span
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        aria-label={sidebarText(t, "sidebar.aria.dragToReorderSession")}
        className="invisible mt-1 flex shrink-0 cursor-grab items-center text-fg-muted/60 active:cursor-grabbing group-hover:visible"
      >
        <GripVertical size={10} />
      </span>
      {sessionDisplay.icons.statusDot ? (
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          {agentProvider ? (
            <Tooltip label={agentProvider} side="right">
              <AgentProviderIcon
                provider={agentProvider}
                className={cn("size-3", STATUS_ICON[session.status])}
              />
            </Tooltip>
          ) : (
            <span
              className={cn(
                "size-1.5 rounded-full",
                STATUS_DOT[session.status],
              )}
            />
          )}
        </span>
      ) : null}
      <SessionRowLabel
        editing={editing}
        session={session}
        titleText={titleText}
        metadataText={metadataText}
        showKindIcons={sessionDisplay.icons.sessionKind}
        isGeneratingTitle={isGeneratingTitle}
        t={t}
        onSubmitRename={async (next) => {
          setEditing(false);
          if (canRename && next && next !== session.name) {
            await renameSession(session.id, next);
          }
        }}
        onCancelRename={() => setEditing(false)}
      />
      <span
        role="button"
        aria-label={sidebarText(t, "sidebar.actions.removeSession")}
        tabIndex={0}
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
): string {
  const parts: string[] = [];
  if (metadata.branch && session.branch) parts.push(session.branch);
  if (metadata.workingDirectory) {
    const dir = basename(session.worktree_path);
    if (dir) parts.push(dir);
  }
  if (metadata.status) parts.push(statusLabel(t, session.status));
  return parts.join(" · ");
}

function buildSessionHoverDetails(t: Translator, session: Session): string {
  const lines = [
    `${sidebarText(t, "sidebar.metadata.name")}: ${session.name}`,
    `${sidebarText(t, "sidebar.metadata.branch")}: ${
      session.branch || sidebarText(t, "sidebar.metadata.detached")
    }`,
    `${sidebarText(t, "sidebar.metadata.workingDirectory")}: ${
      session.worktree_path
    }`,
    `${sidebarText(t, "sidebar.metadata.status")}: ${statusLabel(
      t,
      session.status,
    )}`,
  ];
  if (session.kind === "control") {
    lines.push(
      `${sidebarText(t, "sidebar.metadata.kind")}: ${sidebarText(
        t,
        "sidebar.metadata.controlSession",
      )}`,
    );
  }
  if (session.isolated) {
    lines.push(sidebarText(t, "sidebar.metadata.isolatedWorktree"));
  }
  return lines.join("\n");
}

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
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

function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore
  }
}
