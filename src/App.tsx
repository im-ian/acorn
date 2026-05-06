import { useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { RemoveSessionDialog } from "./components/RemoveSessionDialog";
import { RemoveProjectDialog } from "./components/RemoveProjectDialog";
import { LayoutRenderer } from "./components/LayoutRenderer";
import { RightPanel } from "./components/RightPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalHost } from "./components/TerminalHost";
import { Hotkeys, useHotkeys } from "./lib/hotkeys";
import { startSessionNotificationWatcher } from "./lib/notifications";
import { useSettings } from "./lib/settings";
import { useAppStore } from "./store";

function App() {
  const refreshAll = useAppStore((s) => s.refreshAll);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const layout = useAppStore((s) => s.layout);
  const pendingRemoveId = useAppStore((s) => s.pendingRemoveId);
  const pendingRemoveProject = useAppStore((s) => s.pendingRemoveProject);
  const clearPendingRemove = useAppStore((s) => s.clearPendingRemove);
  const clearPendingRemoveProject = useAppStore(
    (s) => s.clearPendingRemoveProject,
  );
  const removeSession = useAppStore((s) => s.removeSession);
  const removeProject = useAppStore((s) => s.removeProject);
  const pendingRemove = sessions.find((s) => s.id === pendingRemoveId) ?? null;
  const pendingProject =
    projects.find((p) => p.repo_path === pendingRemoveProject) ?? null;
  const pendingProjectSessions = pendingProject
    ? sessions.filter((s) => s.repo_path === pendingProject.repo_path)
    : [];
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    return startSessionNotificationWatcher();
  }, []);

  // Periodically probe each session's transcript JSONL to infer live status
  // (idle/running). The Rust side does the file work; this just kicks the tick.
  useEffect(() => {
    const tick = () => useAppStore.getState().pollSessionStatuses();
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, []);

  // Skip the confirmation dialog for non-isolated sessions when the user has
  // opted out via Settings. Isolated worktrees always prompt because the
  // delete-worktree choice still matters.
  useEffect(() => {
    if (!pendingRemove) return;
    const confirm = useSettings.getState().settings.sessions.confirmRemove;
    if (confirm || pendingRemove.isolated) return;
    clearPendingRemove();
    removeSession(pendingRemove.id, false);
  }, [pendingRemove, clearPendingRemove, removeSession]);

  // The Tauri app menu fires `acorn:open-settings` when the user picks
  // "Settings..." from the macOS app menu (or hits its Cmd+, accelerator).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<unknown>("acorn:open-settings", () => {
      useSettings.getState().setOpen(true);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[App] failed to attach settings listener", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const bindings = useMemo(
    () => ({
      [Hotkeys.openPalette]: (e: KeyboardEvent) => {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      },
      [Hotkeys.clearTerminal]: (e: KeyboardEvent) => {
        const sessionId = useAppStore.getState().activeSessionId;
        if (!sessionId) return;
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("acorn:terminal-clear", {
            detail: { sessionId },
          }),
        );
      },
      [Hotkeys.toggleTodos]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("todos");
      },
      [Hotkeys.toggleCommits]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("commits");
      },
      [Hotkeys.toggleStaged]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("staged");
      },
      [Hotkeys.splitVertical]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().splitFocusedPane("horizontal");
      },
      [Hotkeys.splitHorizontal]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().splitFocusedPane("vertical");
      },
      [Hotkeys.closeTab]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().closeFocusedTab();
      },
      [Hotkeys.nextTab]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleTab(1);
      },
      [Hotkeys.prevTab]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleTab(-1);
      },
      [Hotkeys.nextProject]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleProject(1);
      },
      [Hotkeys.prevProject]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleProject(-1);
      },
      [Hotkeys.openSettings]: (e: KeyboardEvent) => {
        e.preventDefault();
        useSettings.getState().setOpen(true);
      },
      [Hotkeys.closeEmptyPane]: (e: KeyboardEvent) => {
        // Only collapse the focused pane when it's empty, so Escape stays
        // available for inputs, dialogs, and the command palette.
        const { focusedPaneId, panes } = useAppStore.getState();
        const pane = panes[focusedPaneId];
        if (!pane || pane.sessionIds.length > 0) return;
        const total = Object.keys(panes).length;
        if (total <= 1) return;
        e.preventDefault();
        useAppStore.getState().closePane(focusedPaneId);
      },
    }),
    [],
  );

  useHotkeys(bindings);

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-fg">
      <div className="flex min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="acorn:layout:root">
          <Panel
            id="sidebar"
            order={1}
            defaultSize={18}
            minSize={12}
            maxSize={40}
            collapsible
            collapsedSize={0}
          >
            <Sidebar />
          </Panel>
          <ResizeHandle />
          <Panel id="main" order={2} defaultSize={56} minSize={30}>
            <LayoutRenderer node={layout} />
          </Panel>
          <ResizeHandle />
          <Panel
            id="right"
            order={3}
            defaultSize={26}
            minSize={16}
            maxSize={50}
            collapsible
            collapsedSize={0}
          >
            <RightPanel />
          </Panel>
        </PanelGroup>
      </div>
      <StatusBar />
      <TerminalHost />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettingsModal />
      <RemoveSessionDialog
        session={pendingRemove}
        onClose={(choice) => {
          const target = pendingRemove;
          clearPendingRemove();
          if (!target || choice === "cancel") return;
          removeSession(target.id, choice === "session_and_worktree");
        }}
      />
      <RemoveProjectDialog
        project={pendingProject}
        sessions={pendingProjectSessions}
        onClose={(choice) => {
          const target = pendingProject;
          clearPendingRemoveProject();
          if (!target || choice === "cancel") return;
          removeProject(target.repo_path, choice === "project_and_worktrees");
        }}
      />
    </div>
  );
}

export default App;
