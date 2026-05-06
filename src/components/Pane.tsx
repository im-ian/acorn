import { GitBranch, Terminal as TerminalIcon, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAppStore } from "../store";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  getCurrentDragPayload,
  isTabDrag,
  setTabDragPayload,
} from "../lib/dnd";
import type { PaneId } from "../lib/layout";
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
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const selectSession = useAppStore((s) => s.selectSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const moveTab = useAppStore((s) => s.moveTab);

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
        />
      ) : null}
      <div
        className="relative min-h-0 flex-1"
        data-pane-body={paneId}
      >
        {/*
          The actual <Terminal> for the active session lives in <TerminalHost>
          at App level. It is portaled into a per-session target div which
          gets `appendChild`-moved into this pane body when this session is
          active. We render only an EmptyPane fallback here for the
          no-active-session case.
        */}
        {active ? null : <EmptyPane onDoubleClick={handleNewTabFromEmpty} />}
        <PaneDropOverlay paneId={paneId} />
      </div>
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

function EmptyPane({ onDoubleClick }: { onDoubleClick: () => void }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 text-fg-muted hover:text-fg/80 transition cursor-pointer select-none"
      onDoubleClick={onDoubleClick}
      role="button"
      tabIndex={0}
      title="Double-click to start a new session"
    >
      <TerminalIcon size={28} className="opacity-40" />
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
}

function TabStrip({
  paneId,
  tabs,
  activeId,
  onSelect,
  onClose,
  onDropReorder,
  onNewTab,
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
  registerRef: (el: HTMLDivElement | null) => void;
}

function TabItem({
  tab,
  paneId,
  active,
  insertBefore,
  onSelect,
  onClose,
  registerRef,
}: TabItemProps) {
  return (
    <>
      {insertBefore ? (
        <span className="my-1 w-0.5 self-stretch bg-accent" aria-hidden />
      ) : null}
      <div
        ref={registerRef}
        role="button"
        tabIndex={0}
        draggable
        onDragStart={(e) => {
          setTabDragPayload(e, { sessionId: tab.id, fromPaneId: paneId });
        }}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
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
        <span className="max-w-[12rem] truncate">{tab.name}</span>
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
    </>
  );
}
