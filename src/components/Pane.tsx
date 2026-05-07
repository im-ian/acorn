import {
  Columns2,
  Copy,
  Files,
  FolderOpen,
  GitBranch,
  Pencil,
  PencilLine,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import acornLogo from "../assets/acorn.svg";
import { useAppStore } from "../store";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  getCurrentDragPayload,
  isTabDrag,
  setTabDragPayload,
} from "../lib/dnd";
import {
  hasConfiguredEditor,
  openInConfiguredEditor,
} from "../lib/editor";
import { EQUALIZE_PANES_EVENT } from "../lib/layoutEvents";
import { useSettings } from "../lib/settings";
import type { Direction, PaneId } from "../lib/layout";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { PaneDropOverlay } from "./PaneDropOverlay";
import type { Session, SessionStatus } from "../lib/types";

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-fg-muted",
  running: "bg-accent animate-pulse",
  needs_input: "bg-warning",
  failed: "bg-danger",
  completed: "bg-accent/60",
};

interface PaneProps {
  paneId: PaneId;
}

/**
 * A single workspace pane. Hosts a tab strip and a body with the active
 * session's Terminal mounted. Tabs are draggable and the body is a drop
 * target for tab drags (via {@link PaneDropOverlay}).
 *
 * State (tab list, active session) lives in the global store keyed by
 * `paneId`. The pane itself only renders.
 */
export function Pane({ paneId }: PaneProps) {
  const sessions = useAppStore((s) => s.sessions);
  const pane = useAppStore((s) => s.panes[paneId]);
  const totalPanes = useAppStore((s) => Object.keys(s.panes).length);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const selectSession = useAppStore((s) => s.selectSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitFocusedPane = useAppStore((s) => s.splitFocusedPane);
  const closePane = useAppStore((s) => s.closePane);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(
    null,
  );

  const tabs = useMemo<Session[]>(() => {
    if (!pane) return [];
    const lookup = new Map(sessions.map((s) => [s.id, s] as const));
    const ordered: Session[] = [];
    for (const id of pane.sessionIds) {
      const s = lookup.get(id);
      if (s) ordered.push(s);
    }
    return ordered;
  }, [pane, sessions]);

  const active = useMemo<Session | null>(() => {
    if (!pane?.activeSessionId) return null;
    return tabs.find((t) => t.id === pane.activeSessionId) ?? null;
  }, [pane, tabs]);

  const isFocused = focusedPaneId === paneId;

  // Spawn a new session in the given project. Triggered by double-clicking
  // the empty pane body or the tab strip. We bypass the store wrapper so we
  // can grab the new session id and immediately focus its tab in this pane.
  async function spawnSession(repoPath: string) {
    setFocusedPane(paneId);
    const name = suggestSessionName(repoPath, sessions);
    try {
      const created = await api.createSession(name, repoPath, false);
      await useAppStore.getState().refreshAll();
      selectSession(created.id);
    } catch (err) {
      console.error("[Pane] new session spawn failed", err);
    }
  }

  async function handleNewTabFromStrip() {
    if (tabs.length === 0) return;
    await spawnSession(tabs[0].repo_path);
  }

  async function handleNewTabFromEmpty() {
    // Prefer the pane's project if any tabs exist (shouldn't here), else use
    // the globally active project. With no project at all, do nothing.
    const repoPath =
      tabs[0]?.repo_path ??
      useAppStore.getState().activeProject ??
      null;
    if (!repoPath) return;
    await spawnSession(repoPath);
  }

  return (
    <div
      className="relative flex h-full flex-col bg-bg"
      onMouseDown={() => {
        if (!isFocused) setFocusedPane(paneId);
      }}
    >
      {tabs.length > 0 ? (
        <TabStrip
          paneId={paneId}
          tabs={tabs}
          activeId={active?.id ?? null}
          onSelect={(id) => {
            setFocusedPane(paneId);
            selectSession(id);
          }}
          onClose={(id) => requestRemoveSession(id)}
          onDropReorder={(payload, toIndex) => {
            moveTab({
              sessionId: payload.sessionId,
              fromPaneId: payload.fromPaneId,
              toPaneId: paneId,
              toIndex,
            });
          }}
          onNewTab={handleNewTabFromStrip}
          onSplitTab={(sessionId, direction) => {
            // Move the tab into a fresh pane created on the right (horizontal)
            // or below (vertical) the current pane. Mirrors VS Code's
            // "Split Right / Split Down" command on a tab.
            moveTab({
              sessionId,
              fromPaneId: paneId,
              toPaneId: paneId,
              splitDirection: direction,
              splitSide: "after",
            });
          }}
          onDuplicate={(repoPath) => {
            void spawnSession(repoPath);
          }}
        />
      ) : null}
      <div
        className="relative min-h-0 flex-1"
        data-pane-body={paneId}
        onContextMenu={(e) => {
          // Only react when the body itself is right-clicked (not the
          // terminal output, which has its own native menu via xterm). The
          // terminal portal target sits inside this div, so we filter on the
          // event target identity.
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          e.stopPropagation();
          setFocusedPane(paneId);
          setPaneMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/*
          The actual <Terminal> for the active session lives in <TerminalHost>
          at App level. It is portaled into a per-session target div which
          gets `appendChild`-moved into this pane body when this session is
          active. We render only an EmptyPane fallback here for the
          no-active-session case.
        */}
        {active ? null : (
          <EmptyPane
            onDoubleClick={handleNewTabFromEmpty}
            onContextMenu={(x, y) => {
              setFocusedPane(paneId);
              setPaneMenu({ x, y });
            }}
          />
        )}
        <PaneDropOverlay paneId={paneId} />
      </div>
      <ContextMenu
        open={paneMenu !== null}
        x={paneMenu?.x ?? 0}
        y={paneMenu?.y ?? 0}
        onClose={() => setPaneMenu(null)}
        items={buildPaneMenuItems({
          activeSession: active,
          totalPanes,
          paneId,
          onNewTab: () => void handleNewTabFromEmpty(),
          onSplit: splitFocusedPane,
          onClose: () => closePane(paneId),
          activeProjectFallback: useAppStore.getState().activeProject,
        })}
      />
    </div>
  );
}

function suggestSessionName(repoPath: string, existing: Session[]): string {
  const base =
    repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function EmptyPane({
  onDoubleClick,
  onContextMenu,
}: {
  onDoubleClick: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted hover:text-fg/80 transition cursor-pointer select-none"
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
      role="button"
      tabIndex={0}
      title="Double-click to start a new session"
    >
      <img
        src={acornLogo}
        alt=""
        aria-hidden="true"
        width={56}
        height={56}
        className="opacity-60 transition group-hover:opacity-80"
        draggable={false}
      />
      <p className="text-xs">Drop a tab here or double-click to start a session</p>
    </div>
  );
}

interface TabStripProps {
  paneId: PaneId;
  tabs: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDropReorder: (
    payload: { sessionId: string; fromPaneId: PaneId },
    toIndex: number,
  ) => void;
  onNewTab: () => void;
  onSplitTab: (sessionId: string, direction: Direction) => void;
  onDuplicate: (repoPath: string) => void;
}

function TabStrip({
  paneId,
  tabs,
  activeId,
  onSelect,
  onClose,
  onDropReorder,
  onNewTab,
  onSplitTab,
  onDuplicate,
}: TabStripProps) {
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  function computeInsertIndex(clientX: number): number {
    let idx = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const el = tabRefs.current.get(tabs[i].id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        idx = i;
        break;
      }
    }
    return idx;
  }

  return (
    <div
      ref={stripRef}
      className="relative flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border"
      onDragEnter={(e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        setInsertIndex(computeInsertIndex(e.clientX));
      }}
      onDragOver={(e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setInsertIndex(computeInsertIndex(e.clientX));
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setInsertIndex(null);
      }}
      onDrop={(e) => {
        if (!isTabDrag(e)) return;
        e.preventDefault();
        const payload = getCurrentDragPayload();
        const idx = computeInsertIndex(e.clientX);
        setInsertIndex(null);
        if (!payload) return;
        // No-op: dropping onto the same pane at the same position.
        if (payload.fromPaneId === paneId) {
          const currentIdx = tabs.findIndex((t) => t.id === payload.sessionId);
          if (currentIdx === idx || currentIdx + 1 === idx) return;
        }
        onDropReorder(payload, idx);
      }}
    >
      {tabs.map((tab, i) => (
        <TabItem
          key={tab.id}
          tab={tab}
          paneId={paneId}
          active={tab.id === activeId}
          insertBefore={insertIndex === i}
          onSelect={() => onSelect(tab.id)}
          onClose={() => onClose(tab.id)}
          onCloseOthers={() => {
            for (const t of tabs) {
              if (t.id !== tab.id) onClose(t.id);
            }
          }}
          onCloseAll={() => {
            for (const t of tabs) onClose(t.id);
          }}
          onSplitTab={(direction) => onSplitTab(tab.id, direction)}
          onDuplicate={() => onDuplicate(tab.repo_path)}
          siblingCount={tabs.length}
          registerRef={(el) => {
            if (el) tabRefs.current.set(tab.id, el);
            else tabRefs.current.delete(tab.id);
          }}
        />
      ))}
      {insertIndex === tabs.length ? (
        <span className="my-1 w-0.5 self-stretch bg-accent" aria-hidden />
      ) : null}
      {/*
        Filler captures the empty stretch after the last tab so a double-click
        anywhere in that area opens a new session in the same project. Min
        width keeps it always present even when tabs fill the visible width
        (the strip scrolls horizontally, so the user can scroll past tabs
        and double-click here too).
      */}
      <div
        className="min-w-[2.5rem] flex-1"
        title="Double-click to open a new session in this project"
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return;
          onNewTab();
        }}
      />
    </div>
  );
}

interface TabItemProps {
  tab: Session;
  paneId: PaneId;
  active: boolean;
  insertBefore: boolean;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onSplitTab: (direction: Direction) => void;
  onDuplicate: () => void;
  siblingCount: number;
  registerRef: (el: HTMLDivElement | null) => void;
}

function TabItem({
  tab,
  paneId,
  active,
  insertBefore,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onSplitTab,
  onDuplicate,
  siblingCount,
  registerRef,
}: TabItemProps) {
  const renameSession = useAppStore((s) => s.renameSession);
  // Subscribe to the editor command so the menu's enabled/disabled state
  // updates immediately when the user configures an editor in Settings.
  const editorCommand = useSettings(
    (s) => s.settings.editor.command,
  );
  const editorConfigured = editorCommand.trim().length > 0;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);

  const menuItems: ContextMenuItem[] = [
    {
      label: "Rename",
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
    },
    {
      label: "Duplicate Session",
      icon: <Files size={12} />,
      onClick: onDuplicate,
    },
    { type: "separator" },
    {
      label: "Split Right",
      icon: <SplitSquareHorizontal size={12} />,
      onClick: () => onSplitTab("horizontal"),
      disabled: siblingCount <= 1,
    },
    {
      label: "Split Down",
      icon: <SplitSquareVertical size={12} />,
      onClick: () => onSplitTab("vertical"),
      disabled: siblingCount <= 1,
    },
    {
      label: "Equalize Pane Sizes",
      icon: <Columns2 size={12} />,
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
    },
    { type: "separator" },
    {
      label: "Open Worktree in Editor",
      icon: <PencilLine size={12} />,
      disabled: !editorConfigured,
      onClick: () => {
        void openInConfiguredEditor(tab.worktree_path).catch(
          (err: unknown) => {
            console.error("[Pane] open in editor failed", err);
          },
        );
      },
    },
    {
      label: "Reveal in Finder",
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void openPath(tab.worktree_path).catch((err: unknown) => {
          console.error("[Pane] reveal in finder failed", err);
        });
      },
    },
    {
      label: "Copy Worktree Path",
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(tab.worktree_path);
      },
    },
    {
      label: "Copy Worktree Name",
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(basename(tab.worktree_path));
      },
    },
    {
      label: "Copy Branch Name",
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(tab.branch);
      },
      disabled: !tab.branch,
    },
    {
      label: "Copy Session ID",
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(tab.id);
      },
    },
    { type: "separator" },
    {
      label: "Close",
      icon: <X size={12} />,
      onClick: onClose,
    },
    {
      label: "Close Others",
      onClick: onCloseOthers,
      disabled: siblingCount <= 1,
    },
    {
      label: "Close All",
      onClick: onCloseAll,
      danger: true,
    },
  ];

  return (
    <>
      {insertBefore ? (
        <span className="my-1 w-0.5 self-stretch bg-accent" aria-hidden />
      ) : null}
      <div
        ref={registerRef}
        role="button"
        tabIndex={0}
        draggable={!editing}
        onDragStart={(e) => {
          setTabDragPayload(e, { sessionId: tab.id, fromPaneId: paneId });
        }}
        onClick={editing ? undefined : onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Activate the tab on right-click so the visible context matches the
          // menu target — mirrors VS Code / browser tab behavior.
          if (!active) onSelect();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
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
        className={cn(
          "group relative flex shrink-0 cursor-pointer items-center gap-2 border-r border-border pl-3 pr-1 text-xs transition",
          active
            ? "bg-bg text-fg"
            : "bg-bg-elevated/40 text-fg-muted hover:bg-bg-elevated/70 hover:text-fg",
        )}
      >
        <span
          className={cn("size-1.5 rounded-full", STATUS_DOT[tab.status])}
        />
        {editing ? (
          <TabRenameInput
            initial={tab.name}
            onSubmit={async (next) => {
              setEditing(false);
              if (next && next !== tab.name) {
                await renameSession(tab.id, next);
              }
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className="max-w-[12rem] truncate">{tab.name}</span>
        )}
        {tab.isolated ? (
          <GitBranch
            size={10}
            className="text-fg-muted"
            aria-label="isolated"
          />
        ) : null}
        <button
          type="button"
          aria-label="Close session"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "ml-1 rounded p-0.5 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg",
            active
              ? "opacity-70 hover:opacity-100"
              : "opacity-0 group-hover:opacity-70 hover:opacity-100",
          )}
        >
          <X size={11} />
        </button>
        {active ? (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/30" />
        ) : null}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={menuItems}
      />
    </>
  );
}

interface TabRenameInputProps {
  initial: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function TabRenameInput({ initial, onSubmit, onCancel }: TabRenameInputProps) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
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
      className="w-32 min-w-0 rounded bg-bg-sidebar px-1 text-xs text-fg outline-none ring-1 ring-accent"
    />
  );
}

function buildPaneMenuItems({
  activeSession,
  totalPanes,
  paneId: _paneId,
  onNewTab,
  onSplit,
  onClose,
  activeProjectFallback,
}: {
  activeSession: Session | null;
  totalPanes: number;
  paneId: PaneId;
  onNewTab: () => void;
  onSplit: (direction: Direction) => void;
  onClose: () => void;
  activeProjectFallback: string | null;
}): ContextMenuItem[] {
  const editorReady = hasConfiguredEditor();
  const worktreeItems: ContextMenuItem[] = activeSession
    ? [
        { type: "separator" },
        {
          label: "Open Worktree in Editor",
          icon: <PencilLine size={12} />,
          disabled: !editorReady,
          onClick: () => {
            void openInConfiguredEditor(activeSession.worktree_path).catch(
              (err: unknown) => {
                console.error("[Pane] open in editor failed", err);
              },
            );
          },
        },
        {
          label: "Reveal in Finder",
          icon: <FolderOpen size={12} />,
          onClick: () => {
            void openPath(activeSession.worktree_path).catch(
              (err: unknown) => {
                console.error("[Pane] reveal failed", err);
              },
            );
          },
        },
        {
          label: "Copy Worktree Path",
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(activeSession.worktree_path),
        },
        {
          label: "Copy Worktree Name",
          icon: <Copy size={12} />,
          onClick: () =>
            void copyToClipboard(basename(activeSession.worktree_path)),
        },
      ]
    : [];

  return [
    {
      label: "New Session in This Pane",
      icon: <TerminalIcon size={12} />,
      onClick: onNewTab,
      disabled: !activeSession && activeProjectFallback === null,
    },
    { type: "separator" },
    {
      label: "Split Right",
      icon: <SplitSquareHorizontal size={12} />,
      onClick: () => onSplit("horizontal"),
    },
    {
      label: "Split Down",
      icon: <SplitSquareVertical size={12} />,
      onClick: () => onSplit("vertical"),
    },
    {
      label: "Equalize Pane Sizes",
      icon: <Columns2 size={12} />,
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
      disabled: totalPanes <= 1,
    },
    ...worktreeItems,
    { type: "separator" },
    {
      label: "Close Pane",
      icon: <X size={12} />,
      onClick: onClose,
      disabled: totalPanes <= 1,
      danger: true,
    },
  ];
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn("[Pane] clipboard write failed", err);
  }
}
