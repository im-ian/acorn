import {
  ChevronRight,
  Copy,
  Files,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GripVertical,
  Pencil,
  PencilLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { openInConfiguredEditor } from "../lib/editor";
import { useSettings } from "../lib/settings";
import {
  planChevronClick,
  planTitleClick,
  type ProjectClickPlan,
} from "../lib/sidebar-actions";
import type { Project, Session, SessionStatus } from "../lib/types";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Tooltip } from "./Tooltip";

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-fg-muted",
  running: "bg-accent animate-pulse",
  needs_input: "bg-warning",
  failed: "bg-danger",
  completed: "bg-accent/60",
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  running: "Running",
  needs_input: "Needs input",
  failed: "Failed",
  completed: "Completed",
};

const COLLAPSED_KEY = "acorn:sidebar:collapsed-projects";

interface ProjectGroup {
  repoPath: string;
  name: string;
  sessions: Session[];
}

type DropPosition = "before" | "after";

interface ProjectDropTarget {
  repoPath: string;
  position: DropPosition;
}

const PROJECT_DRAG_MIME = "application/x-acorn-project";

export function Sidebar() {
  const {
    sessions,
    projects,
    activeSessionId,
    activeProject,
    selectSession,
    setActiveProject,
    createSession,
    requestRemoveSession,
    requestRemoveProject,
    addProject,
    reorderProjects,
  } = useAppStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  const [draggingProject, setDraggingProject] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProjectDropTarget | null>(null);

  useEffect(() => {
    saveCollapsed(collapsed);
  }, [collapsed]);

  const projectGroups = useMemo(
    () => buildProjectGroups(projects, sessions),
    [projects, sessions],
  );

  function onProjectDragStart(e: React.DragEvent, repoPath: string) {
    setDraggingProject(repoPath);
    try {
      e.dataTransfer.setData(PROJECT_DRAG_MIME, repoPath);
      e.dataTransfer.setData("text/plain", repoPath);
    } catch {
      // Some webviews block setData during dragstart; module-level state
      // (`draggingProject`) covers this fallback.
    }
    e.dataTransfer.effectAllowed = "move";
  }

  function onProjectDragOver(
    e: React.DragEvent,
    repoPath: string,
  ) {
    if (draggingProject === null) return;
    if (draggingProject === repoPath) {
      // Hovering over self — clear any preview.
      if (dropTarget !== null) setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const position: DropPosition =
      e.clientY - rect.top < rect.height / 2 ? "before" : "after";
    if (
      dropTarget?.repoPath !== repoPath ||
      dropTarget.position !== position
    ) {
      setDropTarget({ repoPath, position });
    }
  }

  function onProjectDragLeave() {
    // Defer clearing — another sibling's dragover will fire immediately.
    // We rely on the next dragover or dragend to update state.
  }

  async function onProjectDrop(e: React.DragEvent) {
    if (draggingProject === null || dropTarget === null) {
      setDraggingProject(null);
      setDropTarget(null);
      return;
    }
    e.preventDefault();
    const sourcePath = draggingProject;
    const target = dropTarget;
    setDraggingProject(null);
    setDropTarget(null);

    const currentOrder = projectGroups.map((p) => p.repoPath);
    const without = currentOrder.filter((p) => p !== sourcePath);
    const targetIndex = without.indexOf(target.repoPath);
    if (targetIndex < 0) return;
    const insertAt = target.position === "before" ? targetIndex : targetIndex + 1;
    const next = [
      ...without.slice(0, insertAt),
      sourcePath,
      ...without.slice(insertAt),
    ];
    if (arraysEqual(next, currentOrder)) return;
    await reorderProjects(next);
  }

  function onProjectDragEnd() {
    setDraggingProject(null);
    setDropTarget(null);
  }

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

  async function onAddProject() {
    try {
      const repoPath = await open({
        directory: true,
        multiple: false,
        title: "Select a directory",
      });
      if (!repoPath || typeof repoPath !== "string") return;
      await addProject(repoPath);
    } catch (e) {
      console.error("add project failed", e);
    }
  }

  const onNewSessionRef = useRef<
    (isolated: boolean, repoOverride?: string) => Promise<void>
  >(async () => {});
  const onAddProjectRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const newSession = () => {
      const project = useAppStore.getState().activeProject;
      void onNewSessionRef.current(false, project ?? undefined);
    };
    const newIsolated = () => {
      const project = useAppStore.getState().activeProject;
      void onNewSessionRef.current(true, project ?? undefined);
    };
    const addProj = () => {
      void onAddProjectRef.current();
    };
    window.addEventListener("acorn:new-session", newSession);
    window.addEventListener("acorn:new-isolated-session", newIsolated);
    window.addEventListener("acorn:add-project", addProj);
    return () => {
      window.removeEventListener("acorn:new-session", newSession);
      window.removeEventListener("acorn:new-isolated-session", newIsolated);
      window.removeEventListener("acorn:add-project", addProj);
    };
  }, []);

  async function onNewSession(isolated: boolean, repoOverride?: string) {
    try {
      const repoPath =
        repoOverride ??
        (await open({
          directory: true,
          multiple: false,
          title: isolated
            ? "Select a git repository (isolated worktree)"
            : "Select a directory",
        }));
      if (!repoPath || typeof repoPath !== "string") return;
      const name = suggestName(repoPath, sessions);
      await createSession(name, repoPath, isolated);
      setCollapsed((prev) => {
        if (!prev.has(repoPath)) return prev;
        const next = new Set(prev);
        next.delete(repoPath);
        return next;
      });
    } catch (e) {
      console.error("create session failed", e);
    }
  }

  onNewSessionRef.current = onNewSession;
  onAddProjectRef.current = onAddProject;

  return (
    <aside className="flex h-full w-full flex-col bg-bg-sidebar">
      <header className="flex items-center justify-between gap-2 px-3 py-3">
        <h2 className="text-sm font-medium tracking-tight text-fg-muted">
          Projects
        </h2>
        <Tooltip label="Add project" side="left">
          <button
            type="button"
            onClick={onAddProject}
            className="rounded-md p-1.5 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            aria-label="Add project"
          >
            <FolderPlus size={14} />
          </button>
        </Tooltip>
      </header>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {projectGroups.length === 0 ? (
          <EmptyState />
        ) : (
          <ul
            className="flex flex-col divide-y divide-border/40 [&>li]:py-1.5 [&>li:first-child]:pt-0.5 [&>li:last-child]:pb-0.5"
            onDrop={onProjectDrop}
            onDragOver={(e) => {
              if (draggingProject !== null) e.preventDefault();
            }}
          >
            {projectGroups.map((project) => (
              <ProjectGroupView
                key={project.repoPath}
                project={project}
                collapsed={collapsed.has(project.repoPath)}
                activeSessionId={activeSessionId}
                isActiveProject={activeProject === project.repoPath}
                isDragging={draggingProject === project.repoPath}
                dropIndicator={
                  dropTarget?.repoPath === project.repoPath
                    ? dropTarget.position
                    : null
                }
                onDragStart={(e) => onProjectDragStart(e, project.repoPath)}
                onDragOver={(e) => onProjectDragOver(e, project.repoPath)}
                onDragLeave={onProjectDragLeave}
                onDragEnd={onProjectDragEnd}
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
                onAddSession={(isolated) =>
                  onNewSession(isolated, project.repoPath)
                }
                onRemoveProject={() => requestRemoveProject(project.repoPath)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/**
 * Choose which session to activate when the user clicks a project header.
 * If the already-active session belongs to this project, keep it. Otherwise
 * fall back to the first listed session (backend lists newest-first).
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

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface ProjectGroupViewProps {
  project: ProjectGroup;
  collapsed: boolean;
  activeSessionId: string | null;
  isActiveProject: boolean;
  isDragging: boolean;
  dropIndicator: "before" | "after" | null;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  /** Title click: activate (preserve collapse if inactive); ensure expanded if already active. */
  onTitleClick: () => void;
  /** Chevron click: activate + toggle expand. */
  onChevronClick: () => void;
  /** Empty-state row click: activate + expand + select a session. */
  onActivate: () => void;
  onSelectSession: (id: string) => void;
  onRemoveSession: (s: Session) => void;
  onAddSession: (isolated: boolean) => void;
  onRemoveProject: () => void;
}

function ProjectGroupView({
  project,
  collapsed,
  activeSessionId,
  isActiveProject,
  isDragging,
  dropIndicator,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDragEnd,
  onTitleClick,
  onChevronClick,
  onActivate,
  onSelectSession,
  onRemoveSession,
  onAddSession,
  onRemoveProject,
}: ProjectGroupViewProps) {
  const rowRef = useRef<HTMLLIElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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
      ref={rowRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDragEnd={onDragEnd}
      className={cn(
        "relative",
        isDragging && "opacity-40",
      )}
    >
      {dropIndicator === "before" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded bg-accent"
        />
      ) : null}
      {dropIndicator === "after" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded bg-accent"
        />
      ) : null}
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
        aria-label={`Project ${project.name}`}
        className={cn(
          "group flex items-center gap-1 rounded-md px-1 py-1.5 hover:bg-bg-elevated/40",
          isActiveProject && "bg-bg-elevated/30",
        )}
      >
        <Tooltip label="Drag to reorder" side="bottom">
          <span
            draggable
            onDragStart={onDragStart}
            onClick={(e) => e.stopPropagation()}
            aria-label="Drag to reorder project"
            className="invisible flex shrink-0 cursor-grab items-center text-fg-muted/60 active:cursor-grabbing group-hover:visible"
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
          aria-label={collapsed ? "Expand project" : "Collapse project"}
          aria-expanded={!collapsed}
          className="flex shrink-0 items-center justify-center rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          <ChevronRight
            size={14}
            className={cn(
              "transition-transform",
              !collapsed && "rotate-90",
            )}
          />
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <FolderGit2 size={12} className="shrink-0 text-fg-muted" />
          <span className="truncate text-sm font-medium text-fg">
            {project.name}
          </span>
          <span className="ml-1 shrink-0 rounded bg-bg-elevated/80 px-1 text-[10px] text-fg-muted">
            {project.sessions.length}
          </span>
        </span>
        <Tooltip label="New session" side="bottom">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddSession(false);
            }}
            className="invisible rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
            aria-label="New session in this project"
          >
            <Plus size={12} />
          </button>
        </Tooltip>
        <Tooltip label="New isolated session (worktree)" side="bottom">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAddSession(true);
            }}
            className="invisible rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg group-hover:visible"
            aria-label="New isolated session (worktree)"
          >
            <GitBranch size={12} />
          </button>
        </Tooltip>
        <Tooltip label="Close project" side="bottom">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemoveProject();
            }}
            className="invisible rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-danger group-hover:visible"
            aria-label="Close project"
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
            label: "New session",
            icon: <Plus size={12} />,
            onClick: () => onAddSession(false),
          },
          {
            label: "New isolated session",
            icon: <GitBranch size={12} />,
            onClick: () => onAddSession(true),
          },
          { type: "separator" },
          {
            label: "Reveal in Finder",
            icon: <FolderOpen size={12} />,
            onClick: () => {
              void openInFinder(project.repoPath);
            },
          },
          {
            label: "Copy path",
            icon: <Copy size={12} />,
            onClick: () => {
              void copyText(project.repoPath);
            },
          },
          { type: "separator" },
          {
            label: "Close project",
            icon: <X size={12} />,
            onClick: onRemoveProject,
          },
        ]}
      />
      {!collapsed ? (
        <ul className="ml-3 flex flex-col gap-0.5 border-l border-border pl-1 pt-0.5">
          {project.sessions.length === 0 ? (
            <li
              role="button"
              tabIndex={0}
              onClick={onActivate}
              onDoubleClick={() => onAddSession(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onAddSession(false);
                }
              }}
              className="cursor-pointer rounded px-2 py-1 text-[11px] text-fg-muted transition select-none hover:bg-bg-elevated/40 hover:text-fg"
            >
              No sessions. Add one with{" "}
              <Plus size={10} className="inline" /> or{" "}
              <GitBranch size={10} className="inline" />, or double-click here.
            </li>
          ) : (
            project.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                onSelect={() => onSelectSession(session.id)}
                onRemove={() => onRemoveSession(session)}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

interface SessionRowProps {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function SessionRow({ session, active, onSelect, onRemove }: SessionRowProps) {
  const renameSession = useAppStore((s) => s.renameSession);
  const sessions = useAppStore((s) => s.sessions);
  const editorCommand = useSettings((s) => s.settings.editor.command);
  const editorConfigured = editorCommand.trim().length > 0;
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  async function duplicate() {
    const base = session.name;
    const taken = new Set(sessions.map((s) => s.name));
    let next = `${base}-copy`;
    let n = 2;
    while (taken.has(next)) {
      next = `${base}-copy-${n}`;
      n += 1;
    }
    try {
      // Carry the source session's startup mode onto the duplicate so
      // the duplicate respawns with the same kind of process, regardless
      // of the current global default.
      await api.createSession(
        next,
        session.repo_path,
        session.isolated,
        session.startup_mode,
      );
      await useAppStore.getState().refreshAll();
    } catch (err) {
      console.error("[Sidebar] duplicate session failed", err);
    }
  }

  const sessionMenuItems: ContextMenuItem[] = [
    {
      label: "Rename",
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
    },
    {
      label: "Duplicate Session",
      icon: <Files size={12} />,
      onClick: () => void duplicate(),
    },
    { type: "separator" },
    {
      label: "Open Worktree in Editor",
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
      label: "Reveal in Finder",
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void openPath(session.worktree_path).catch((err: unknown) => {
          console.error("[Sidebar] reveal failed", err);
        });
      },
    },
    {
      label: "Copy Worktree Path",
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.worktree_path),
    },
    {
      label: "Copy Worktree Name",
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(basename(session.worktree_path)),
    },
    {
      label: "Copy Branch Name",
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.branch),
      disabled: !session.branch,
    },
    {
      label: "Copy Session ID",
      icon: <Copy size={12} />,
      onClick: () => void copyToClipboard(session.id),
    },
    { type: "separator" },
    {
      label: "Remove",
      icon: <Trash2 size={12} />,
      onClick: onRemove,
      danger: true,
    },
  ];

  return (
    <li>
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
            setEditing(true);
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
        )}
      >
        <span
          className={cn(
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            STATUS_DOT[session.status],
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            {editing ? (
              <RenameInput
                initial={session.name}
                onSubmit={async (next) => {
                  setEditing(false);
                  if (next && next !== session.name) {
                    await renameSession(session.id, next);
                  }
                }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <span className="truncate text-[13px] font-medium text-fg">
                {session.name}
              </span>
            )}
            {session.isolated ? (
              <GitBranch
                size={10}
                className="shrink-0 text-fg-muted"
                aria-label="isolated worktree"
              />
            ) : null}
          </span>
          <span className="block truncate text-[11px] text-fg-muted">
            {session.branch} · {STATUS_LABEL[session.status]}
          </span>
        </span>
        <span
          role="button"
          aria-label="Remove session"
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

function EmptyState() {
  return (
    <div className="px-3 py-6 text-xs text-fg-muted">
      No projects yet. Click <span className="text-fg">+</span> to add one.
    </div>
  );
}

function buildProjectGroups(
  projects: Project[],
  sessions: Session[],
): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>();
  // Preserve incoming order: backend sorts by user-defined `position`.
  for (const project of projects) {
    map.set(project.repo_path, {
      repoPath: project.repo_path,
      name: project.name,
      sessions: [],
    });
  }
  for (const session of sessions) {
    let group = map.get(session.repo_path);
    if (!group) {
      // Backfill: a session with no matching project entry — show it anyway,
      // appended at the end so user-defined ordering for known projects wins.
      group = {
        repoPath: session.repo_path,
        name: basename(session.repo_path),
        sessions: [],
      };
      map.set(session.repo_path, group);
    }
    group.sessions.push(session);
  }
  for (const group of map.values()) {
    group.sessions.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }
  return Array.from(map.values());
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function suggestName(repoPath: string, existing: Session[]): string {
  const base = basename(repoPath);
  let candidate = base;
  let n = 2;
  const taken = new Set(existing.map((s) => s.name));
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
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
