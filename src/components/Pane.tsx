import {
  CircleX,
  Columns2,
  Copy,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  Pencil,
  PencilLine,
  SplitSquareHorizontal,
  SplitSquareVertical,
  SquareX,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  useEffect,
  type CSSProperties,
} from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../store";
import { CodeViewer } from "./CodeViewer";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import type { TranslationKey, Translator } from "../lib/i18n";
import {
  getCurrentFilePayload,
  getCurrentTabPayload,
  isAcornDrag,
  isTabDrag,
  setTabDragPayload,
} from "../lib/dnd";
import {
  hasConfiguredEditor,
  openInConfiguredEditor,
} from "../lib/editor";
import { EQUALIZE_PANES_EVENT } from "../lib/layoutEvents";
import { useSettings } from "../lib/settings";
import { useTranslation } from "../lib/useTranslation";
import type { Direction, PaneId } from "../lib/layout";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { PaneDropOverlay } from "./PaneDropOverlay";
import type { Session, SessionKind, SessionStatus } from "../lib/types";
import {
  makeSessionWorkspaceTab,
  type CodeWorkspaceTab,
  type SessionWorkspaceTab,
} from "../lib/workspaceTabs";

const STATUS_DOT: Record<SessionStatus, string> = {
  idle: "bg-fg-muted",
  running: "bg-accent animate-pulse",
  needs_input: "bg-warning",
  failed: "bg-danger",
  completed: "bg-accent/60",
};

type PaneTranslationKey = Extract<TranslationKey, `pane.${string}`>;

function paneT(t: Translator, key: PaneTranslationKey): string {
  return t(key);
}

interface PaneProps {
  paneId: PaneId;
}

type PaneTab =
  | (SessionWorkspaceTab & { session: Session })
  | CodeWorkspaceTab;

/**
 * A single workspace pane. Hosts a tab strip and a body with the active
 * session's Terminal mounted. Tabs are draggable and the body is a drop
 * target for tab drags (via {@link PaneDropOverlay}).
 *
 * State (tab list, active session) lives in the global store keyed by
 * `paneId`. The pane itself only renders.
 */
export function Pane({ paneId }: PaneProps) {
  const t = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const pane = useAppStore((s) => s.panes[paneId]);
  const totalPanes = useAppStore((s) => Object.keys(s.panes).length);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const selectTab = useAppStore((s) => s.selectTab);
  const createSession = useAppStore((s) => s.createSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const closeWorkspaceTab = useAppStore((s) => s.closeWorkspaceTab);
  const moveTab = useAppStore((s) => s.moveTab);
  const splitFocusedPane = useAppStore((s) => s.splitFocusedPane);
  const closePane = useAppStore((s) => s.closePane);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Pane body hosts the active session's Terminal via a portal target
  // `appendChild`-moved in by TerminalHost. The terminal is rendered at App
  // level, so its React fiber tree is a sibling of every pane — React
  // synthetic `onMouseDown` on this pane never fires for clicks inside the
  // terminal. Without this listener, clicking into a terminal leaves
  // `focusedPaneId` pointing at the previously focused pane, and split / tab
  // shortcuts (Cmd+Shift+D, Cmd+W, …) act on the wrong pane.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const handler = () => setFocusedPane(paneId);
    node.addEventListener("mousedown", handler);
    return () => node.removeEventListener("mousedown", handler);
  }, [paneId, setFocusedPane]);

  const workspaceTabs = useAppStore((s) => s.workspaceTabs);
  const tabs = useMemo<PaneTab[]>(() => {
    if (!pane) return [];
    const lookup = new Map(sessions.map((s) => [s.id, s] as const));
    const ordered: PaneTab[] = [];
    for (const id of pane.tabIds) {
      const s = lookup.get(id);
      if (s) {
        ordered.push({
          ...makeSessionWorkspaceTab({
            id: s.id,
            title: s.name,
            repoPath: s.repo_path,
          }),
          session: s,
        });
        continue;
      }
      const workspaceTab = workspaceTabs[id];
      if (workspaceTab?.kind === "code") {
        ordered.push({
          kind: "code",
          id: workspaceTab.id,
          title: workspaceTab.title,
          repoPath: workspaceTab.repoPath,
          lifecycle: workspaceTab.lifecycle,
          path: workspaceTab.path,
        });
      }
    }
    return ordered;
  }, [pane, sessions, workspaceTabs]);

  const active = useMemo<PaneTab | null>(() => {
    if (!pane?.activeTabId) return null;
    return tabs.find((t) => t.id === pane.activeTabId) ?? null;
  }, [pane, tabs]);

  const isFocused = focusedPaneId === paneId;

  // Spawn a new session in the given project. Triggered by double-clicking
  // the empty pane body or the tab strip. `setFocusedPane` first so
  // `store.createSession` lands the new tab next to *this* pane's active
  // tab, then routes through the store wrapper for consistent placement
  // and selection (browser-style "next to active").
  async function spawnSession(
    repoPath: string,
    kind: SessionKind = "regular",
  ) {
    setFocusedPane(paneId);
    const name = suggestSessionName(repoPath, sessions);
    await createSession(name, repoPath, false, kind);
  }

  // Fork an existing claude/codex conversation into a new Acorn session.
  // Inherits the parent's cwd and queues the explicit fork command into
  // the new shell's stdin so the user does not retype it. We bypass the
  // shim's fork-env branch deliberately — the shim may not even be on
  // PATH in the user's resolved shell (a kaku-style rc that prepends
  // user bin dirs buries it), so relying on a command line that maps to
  // the actual CLI flags works regardless of shim availability. The
  // user's existing `claude` alias (e.g. `--dangerously-skip-permissions`)
  // expands the first token, leaving our `--resume <id> --fork-session`
  // args intact.
  async function forkSession(
    parent: Session,
    kind: "claude" | "codex",
    parentAgentId: string,
    isolated: boolean,
  ) {
    setFocusedPane(paneId);
    const name = suggestSessionName(parent.repo_path, sessions);
    try {
      const created = await api.createSession(
        name,
        parent.repo_path,
        isolated,
      );
      // Claude resolves `--resume <uuid>` by looking under
      // `~/.claude/projects/<slug-of-cwd>/<uuid>.jsonl`.
      //
      // For a same-cwd fork (`isolated: false`) the new Acorn session
      // inherits `parent.repo_path` as its worktree, so the slug is
      // identical to the parent's and `claude --resume` finds the file
      // without any staging. We rely on `api.createSession` honouring
      // `isolated: false` by reusing the parent worktree path verbatim;
      // a future change there would silently break the same-cwd fork.
      //
      // For a new-worktree fork (`isolated: true`) the new worktree
      // lives under `.acorn/worktrees/<name>/` with a different slug,
      // so we stage a copy of the parent transcript into that slug
      // before queuing the resume. Codex stores rollouts cwd-
      // independently under `$CODEX_HOME/sessions/`, so neither branch
      // requires staging for codex.
      if (kind === "claude" && isolated) {
        try {
          await api.prepareClaudeFork(parentAgentId, created.worktree_path);
        } catch (err) {
          console.error("[Pane] prepare_claude_fork failed", err);
        }
      }
      const command =
        kind === "claude"
          ? `claude --resume ${parentAgentId} --fork-session`
          : `codex fork ${parentAgentId}`;
      useAppStore.getState().setPendingTerminalInput(created.id, command);
      await useAppStore.getState().refreshAll();
      selectTab(created.id);
    } catch (err) {
      console.error("[Pane] fork session failed", err);
    }
  }

  async function handleNewTabFromStrip() {
    if (tabs.length === 0) return;
    await spawnSession(tabs[0].repoPath);
  }

  async function handleNewTabFromEmpty() {
    // Prefer the pane's project if any tabs exist (shouldn't here), else use
    // the globally active project. With no project at all, do nothing.
    const repoPath =
      tabs[0]?.repoPath ??
      useAppStore.getState().activeProject ??
      null;
    if (!repoPath) return;
    await spawnSession(repoPath);
  }

  const hasProjects = projects.length > 0;

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
            selectTab(id);
          }}
          onClose={(id) => {
            const tab = tabs.find((t) => t.id === id);
            if (tab?.kind === "session") requestRemoveSession(id);
            else closeWorkspaceTab(id);
          }}
          onDropReorder={(payload, toIndex) => {
            moveTab({
              tabId: payload.tabId,
              fromPaneId: payload.fromPaneId,
              toPaneId: paneId,
              toIndex,
            });
          }}
          onNewTab={handleNewTabFromStrip}
          onSplitTab={(tabId, direction) => {
            // Move the tab into a fresh pane created on the right (horizontal)
            // or below (vertical) the current pane. Mirrors VS Code's
            // "Split Right / Split Down" command on a tab.
            moveTab({
              tabId,
              fromPaneId: paneId,
              toPaneId: paneId,
              splitDirection: direction,
              splitSide: "after",
            });
          }}
          onDuplicate={(repoPath, kind) => {
            void spawnSession(repoPath, kind);
          }}
          onFork={(parent, kind, parentAgentId, isolated) => {
            void forkSession(parent, kind, parentAgentId, isolated);
          }}
        />
      ) : null}
      <div
        ref={bodyRef}
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
          no-active-session case — or a CodeViewer when the active tab is
          a frontend-owned code tab instead of a PTY session.
        */}
        {active?.kind === "code" ? (
          <CodeViewer
            path={active.path}
            isActive={isFocused}
          />
        ) : null}
        {active ? null : (
          <EmptyPane
            hasProjects={hasProjects}
            onDoubleClick={
              hasProjects
                ? handleNewTabFromEmpty
                : () =>
                    window.dispatchEvent(new CustomEvent("acorn:new-project"))
            }
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
          t,
          activeSession: active?.kind === "session" ? active.session : null,
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
  hasProjects,
  onDoubleClick,
  onContextMenu,
}: {
  hasProjects: boolean;
  onDoubleClick: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const t = useTranslation();

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
    >
      {hasProjects ? (
        <>
          <TerminalIcon size={28} className="opacity-40" />
          <p className="text-xs">
            {paneT(t, "pane.empty.dropTabOrDoubleClick")}
          </p>
        </>
      ) : (
        <>
          <FolderPlus size={28} className="opacity-40" />
          <p className="text-xs">
            {paneT(t, "pane.empty.createProject")}
          </p>
        </>
      )}
    </div>
  );
}

interface TabStripProps {
  paneId: PaneId;
  tabs: PaneTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onDropReorder: (
    payload: { tabId: string; fromPaneId: PaneId },
    toIndex: number,
  ) => void;
  onNewTab: () => void;
  onSplitTab: (tabId: string, direction: Direction) => void;
  onDuplicate: (repoPath: string, kind: SessionKind) => void;
  onFork: (
    parent: Session,
    kind: "claude" | "codex",
    parentAgentId: string,
    isolated: boolean,
  ) => void;
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
  onFork,
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
        if (!isAcornDrag(e)) return;
        e.preventDefault();
        setInsertIndex(computeInsertIndex(e.clientX));
      }}
      onDragOver={(e) => {
        if (!isAcornDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = isTabDrag(e) ? "move" : "copy";
        setInsertIndex(computeInsertIndex(e.clientX));
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setInsertIndex(null);
      }}
      onDrop={(e) => {
        if (!isAcornDrag(e)) return;
        e.preventDefault();
        const idx = computeInsertIndex(e.clientX);
        setInsertIndex(null);
        const filePayload = getCurrentFilePayload();
        if (filePayload) {
          useAppStore.getState().setFocusedPane(paneId);
          useAppStore.getState().openCodeViewerTab(filePayload.path);
          return;
        }
        const payload = getCurrentTabPayload();
        if (!payload) return;
        // No-op: dropping onto the same pane at the same position.
        if (payload.fromPaneId === paneId) {
          const currentIdx = tabs.findIndex((t) => t.id === payload.tabId);
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
          onDuplicate={
            tab.kind === "session"
              ? () => onDuplicate(tab.session.repo_path, tab.session.kind)
              : undefined
          }
          onFork={
            tab.kind === "session"
              ? (kind, parentAgentId, isolated) =>
                  onFork(tab.session, kind, parentAgentId, isolated)
              : undefined
          }
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
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return;
          onNewTab();
        }}
      />
    </div>
  );
}

interface TabItemProps {
  tab: PaneTab;
  paneId: PaneId;
  active: boolean;
  insertBefore: boolean;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onSplitTab: (direction: Direction) => void;
  onDuplicate?: () => void;
  onFork?: (
    kind: "claude" | "codex",
    parentAgentId: string,
    isolated: boolean,
  ) => void;
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
  onFork,
  siblingCount,
  registerRef,
}: TabItemProps) {
  const t = useTranslation();
  const renameSession = useAppStore((s) => s.renameSession);
  const session = tab.kind === "session" ? tab.session : null;
  const tabPath = tab.kind === "session" ? tab.session.worktree_path : tab.path;
  const liveInWorktree = useAppStore((s) =>
    session ? s.liveInWorktree[session.id] : false,
  );
  // Subscribe to the editor command so the menu's enabled/disabled state
  // updates immediately when the user configures an editor in Settings.
  const editorCommand = useSettings(
    (s) => s.settings.editor.command,
  );
  const editorConfigured = editorCommand.trim().length > 0;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  // Per-session agent detection result, refreshed each time the context
  // menu opens. Null while loading; the menu rebuilds when this resolves
  // so the Fork item gets the right label / enabled state.
  const [agent, setAgent] = useState<{
    claude: string | null;
    codex: string | null;
  } | null>(null);

  useEffect(() => {
    if (!menu || !session) return;
    setAgent(null);
    let cancelled = false;
    api
      .detectSessionAgent(session.id)
      .then((res) => {
        if (!cancelled) setAgent(res);
      })
      .catch((err) => {
        console.error("[Pane.Fork] detect failed", {
          sessionId: session.id,
          err,
        });
        if (!cancelled) setAgent({ claude: null, codex: null });
      });
    return () => {
      cancelled = true;
    };
  }, [menu, session]);

  const forkItems: ContextMenuItem[] = (() => {
    if (!agent || !onFork) return [];
    const items: ContextMenuItem[] = [];
    const both = agent.claude && agent.codex;
    if (agent.claude) {
      items.push({
        label: both
          ? paneT(t, "pane.menu.forkClaudeSession")
          : paneT(t, "pane.menu.forkSession"),
        icon: <GitFork size={12} />,
        onClick: () => onFork("claude", agent.claude!, false),
      });
      items.push({
        label: both
          ? paneT(t, "pane.menu.forkClaudeInNewWorktree")
          : paneT(t, "pane.menu.forkInNewWorktree"),
        icon: <GitBranch size={12} />,
        onClick: () => onFork("claude", agent.claude!, true),
      });
    }
    if (agent.codex) {
      items.push({
        label: both
          ? paneT(t, "pane.menu.forkCodexSession")
          : paneT(t, "pane.menu.forkSession"),
        icon: <GitFork size={12} />,
        onClick: () => onFork("codex", agent.codex!, false),
      });
      items.push({
        label: both
          ? paneT(t, "pane.menu.forkCodexInNewWorktree")
          : paneT(t, "pane.menu.forkInNewWorktree"),
        icon: <GitBranch size={12} />,
        onClick: () => onFork("codex", agent.codex!, true),
      });
    }
    return items.length > 0
      ? [...items, { type: "separator" } as ContextMenuItem]
      : [];
  })();

  const menuItems: ContextMenuItem[] = [
    {
      label: paneT(t, "pane.menu.rename"),
      icon: <Pencil size={12} />,
      onClick: () => setEditing(true),
      disabled: !session,
    },
    {
      label: paneT(t, "pane.menu.duplicateSession"),
      icon: <Files size={12} />,
      onClick: () => onDuplicate?.(),
      disabled: !onDuplicate,
    },
    { type: "separator" },
    ...forkItems,
    {
      label: paneT(t, "pane.menu.splitRight"),
      icon: <SplitSquareHorizontal size={12} />,
      onClick: () => onSplitTab("horizontal"),
      disabled: siblingCount <= 1,
    },
    {
      label: paneT(t, "pane.menu.splitDown"),
      icon: <SplitSquareVertical size={12} />,
      onClick: () => onSplitTab("vertical"),
      disabled: siblingCount <= 1,
    },
    {
      label: paneT(t, "pane.menu.equalizePaneSizes"),
      icon: <Columns2 size={12} />,
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
    },
    { type: "separator" },
    {
      label: session
        ? paneT(t, "pane.menu.openWorktreeInEditor")
        : paneT(t, "pane.menu.openFileInEditor"),
      icon: <PencilLine size={12} />,
      disabled: !editorConfigured,
      onClick: () => {
        void openInConfiguredEditor(tabPath).catch(
          (err: unknown) => {
            console.error("[Pane] open in editor failed", err);
          },
        );
      },
    },
    {
      label: paneT(t, "pane.menu.revealInFinder"),
      icon: <FolderOpen size={12} />,
      onClick: () => {
        void openPath(tabPath).catch((err: unknown) => {
          console.error("[Pane] reveal in finder failed", err);
        });
      },
    },
    { type: "separator" },
    {
      label: session
        ? paneT(t, "pane.menu.copyWorktreePath")
        : paneT(t, "pane.menu.copyFilePath"),
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(tabPath);
      },
    },
    {
      label: session
        ? paneT(t, "pane.menu.copyWorktreeName")
        : paneT(t, "pane.menu.copyFileName"),
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(basename(tabPath));
      },
    },
    {
      label: paneT(t, "pane.menu.copyBranchName"),
      icon: <Copy size={12} />,
      onClick: () => {
        if (session) void copyToClipboard(session.branch);
      },
      disabled: !session?.branch,
    },
    {
      label: paneT(t, "pane.menu.copySessionId"),
      icon: <Copy size={12} />,
      onClick: () => {
        void copyToClipboard(tab.id);
      },
      disabled: !session,
    },
    { type: "separator" },
    {
      label: paneT(t, "pane.menu.close"),
      icon: <X size={12} />,
      onClick: onClose,
    },
    {
      label: paneT(t, "pane.menu.closeOthers"),
      icon: <CircleX size={12} />,
      onClick: onCloseOthers,
      disabled: siblingCount <= 1,
    },
    {
      label: paneT(t, "pane.menu.closeAll"),
      icon: <SquareX size={12} />,
      onClick: onCloseAll,
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
        style={
          !editing
            ? ({ WebkitUserDrag: "element" } as CSSProperties)
            : undefined
        }
        onDragStart={(e) => {
          setTabDragPayload(e, { tabId: tab.id, fromPaneId: paneId });
        }}
        onClick={editing ? undefined : onSelect}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (session) setEditing(true);
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
            if (session) setEditing(true);
          }
        }}
        className={cn(
          "group relative flex shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-border pl-3 pr-1 text-xs transition",
          active
            ? "bg-bg text-fg"
            : "bg-bg-elevated/40 text-fg-muted hover:bg-bg-elevated/70 hover:text-fg",
        )}
      >
        <span
          className={cn(
            "pointer-events-none size-1.5 rounded-full",
            session ? STATUS_DOT[session.status] : "bg-fg-muted/50",
          )}
        />
        {editing ? (
          <TabRenameInput
            initial={tab.title}
            onSubmit={async (next) => {
              setEditing(false);
              if (session && next && next !== session.name) {
                await renameSession(session.id, next);
              }
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span className="pointer-events-none max-w-[12rem] truncate">
            {tab.title}
          </span>
        )}
        {session &&
        (liveInWorktree ?? (session.isolated || session.in_worktree)) ? (
          <GitBranch
            size={10}
            className="pointer-events-none text-fg-muted"
            aria-label={paneT(t, "pane.aria.worktree")}
          />
        ) : null}
        <button
          type="button"
          aria-label={
            session
              ? paneT(t, "pane.aria.closeSession")
              : paneT(t, "pane.aria.closeTab")
          }
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "rounded p-0.5 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg",
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
  t,
  activeSession,
  totalPanes,
  paneId: _paneId,
  onNewTab,
  onSplit,
  onClose,
  activeProjectFallback,
}: {
  t: Translator;
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
          label: paneT(t, "pane.menu.openWorktreeInEditor"),
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
          label: paneT(t, "pane.menu.revealInFinder"),
          icon: <FolderOpen size={12} />,
          onClick: () => {
            void openPath(activeSession.worktree_path).catch(
              (err: unknown) => {
                console.error("[Pane] reveal failed", err);
              },
            );
          },
        },
        { type: "separator" },
        {
          label: paneT(t, "pane.menu.copyWorktreePath"),
          icon: <Copy size={12} />,
          onClick: () => void copyToClipboard(activeSession.worktree_path),
        },
        {
          label: paneT(t, "pane.menu.copyWorktreeName"),
          icon: <Copy size={12} />,
          onClick: () =>
            void copyToClipboard(basename(activeSession.worktree_path)),
        },
      ]
    : [];

  return [
    {
      label: paneT(t, "pane.menu.newSessionInThisPane"),
      icon: <TerminalIcon size={12} />,
      onClick: onNewTab,
      disabled: !activeSession && activeProjectFallback === null,
    },
    { type: "separator" },
    {
      label: paneT(t, "pane.menu.splitRight"),
      icon: <SplitSquareHorizontal size={12} />,
      onClick: () => onSplit("horizontal"),
    },
    {
      label: paneT(t, "pane.menu.splitDown"),
      icon: <SplitSquareVertical size={12} />,
      onClick: () => onSplit("vertical"),
    },
    {
      label: paneT(t, "pane.menu.equalizePaneSizes"),
      icon: <Columns2 size={12} />,
      onClick: () => {
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
      disabled: totalPanes <= 1,
    },
    ...worktreeItems,
    { type: "separator" },
    {
      label: paneT(t, "pane.menu.closePane"),
      icon: <X size={12} />,
      onClick: onClose,
      disabled: totalPanes <= 1,
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
