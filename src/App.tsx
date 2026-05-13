import { useEffect, useMemo, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { RemoveSessionDialog } from "./components/RemoveSessionDialog";
import { RemoveProjectDialog } from "./components/RemoveProjectDialog";
import { LayoutRenderer } from "./components/LayoutRenderer";
import { EQUALIZE_PANES_EVENT } from "./lib/layoutEvents";
import { RightPanel } from "./components/RightPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { CommandPalette } from "./components/CommandPalette";
import {
  ControlSessionGuideModal,
  CONTROL_GUIDE_DISMISSED_KEY,
} from "./components/ControlSessionGuideModal";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalHost } from "./components/TerminalHost";
import { ToastHost } from "./components/ToastHost";
import { UpdateBanner } from "./components/UpdateBanner";
import { api } from "./lib/api";
import { Hotkeys, useHotkeys } from "./lib/hotkeys";
import {
  startNotificationClickHandler,
  startSessionNotificationWatcher,
} from "./lib/notifications";
import { flushAllScrollbacks } from "./lib/scrollback-coordinator";
import { useToasts } from "./lib/toasts";
import { useUpdater } from "./lib/updater-store";
import { useSettings } from "./lib/settings";
import { extractTabFromEvent } from "./lib/settings-events";
import { useAppStore } from "./store";

const FOCUSABLE_SELECTOR =
  "textarea, input:not([type='hidden']), button, [tabindex]:not([tabindex='-1']), a[href]";

function focusPanel(id: "sidebar" | "main" | "right") {
  const panel = document.querySelector(
    `[data-panel-id="${id}"]`,
  ) as HTMLElement | null;
  if (!panel) return;
  // For the main pane, prefer xterm's hidden textarea so keystrokes route
  // straight to the active terminal instead of the first toolbar button.
  const target =
    (panel.querySelector(
      ".xterm-helper-textarea",
    ) as HTMLElement | null) ??
    (panel.querySelector(FOCUSABLE_SELECTOR) as HTMLElement | null);
  target?.focus();
}

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
  const [controlGuideOpen, setControlGuideOpen] = useState(false);
  const sidebarPanelRef = useRef<ImperativePanelHandle | null>(null);
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null);

  useEffect(() => {
    // Order matters: `loadInitialStatus` arms the pane-wipe guard before the
    // first reconcile can run. If the backend reports sessions.json failed
    // to load (corrupt/IO error), the guard prevents the empty session list
    // from zeroing out the persisted layout.
    void useAppStore.getState().loadInitialStatus().then(() => refreshAll());
  }, [refreshAll]);

  // Sync the daemon killswitch from localStorage into the backend on
  // boot. The backend defaults to ENABLED (Q16), and the frontend
  // localStorage entry is the canonical "user's last choice". On a
  // fresh install neither side has a value yet — both default to
  // enabled and stay aligned. On a returning install the user may
  // have disabled the daemon before quitting; this push keeps the
  // backend honest so the first daemon-routed call short-circuits
  // correctly.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem("acorn:daemon-enabled");
    } catch {
      // localStorage blocked — fall back to the backend default.
    }
    if (raw === null) return;
    const enabled = raw === "true";
    void import("./lib/api").then(({ api }) => {
      void api.daemonSetEnabled(enabled).catch((err) => {
        console.warn("[App] daemon killswitch sync failed", err);
      });
    });
  }, []);

  // Auto-update: check once on startup, then every 24h. Both calls are
  // best-effort and non-blocking — surfaced via the App-level
  // `<UpdateBanner />`. Manual recheck stays available in Settings.
  useEffect(() => {
    const updater = useUpdater.getState();
    void updater.init();
    void updater.check();
    const interval = window.setInterval(
      () => void useUpdater.getState().check(),
      24 * 60 * 60 * 1000,
    );
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    return startSessionNotificationWatcher();
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void startNotificationClickHandler().then((d) => {
      if (cancelled) {
        d();
        return;
      }
      dispose = d;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
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

  // Surface the one-time guide modal after the first control-session
  // creation. The store dispatches `acorn:show-control-guide` only when the
  // dismissed-flag is unset, so this handler can stay dumb and just open.
  useEffect(() => {
    const handler = () => setControlGuideOpen(true);
    window.addEventListener("acorn:show-control-guide", handler);
    return () => {
      window.removeEventListener("acorn:show-control-guide", handler);
    };
  }, []);

  // The Tauri app menu fires `acorn:open-settings` when the user picks
  // "Settings..." from the macOS app menu (or hits its Cmd+, accelerator).
  // The same event name is also dispatched as a DOM CustomEvent from
  // inside the app (StatusBar daemon button uses this) — we listen on
  // both transports because Tauri events do not flow through `window`
  // and `window.dispatchEvent` does not reach Tauri listeners.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<unknown>("acorn:open-settings", (event) => {
      const tab = extractTabFromEvent(event.payload);
      if (tab) {
        useSettings.getState().openTab(tab);
      } else {
        useSettings.getState().setOpen(true);
      }
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

    // DOM bridge — components inside the React tree dispatch this to
    // request a specific tab without going through the Tauri event bus.
    const domHandler = (e: Event) => {
      const tab = extractTabFromEvent((e as CustomEvent).detail);
      if (tab) {
        useSettings.getState().openTab(tab);
      } else {
        useSettings.getState().setOpen(true);
      }
    };
    window.addEventListener("acorn:open-settings", domHandler);

    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("acorn:open-settings", domHandler);
    };
  }, []);

  // The IPC server fires `acorn:ipc-sessions-changed` after a control
  // session creates or kills a sibling. Without this listener those
  // mutations would land in the backend and on disk but never surface
  // in the sidebar — the user would only see them after the next app
  // restart. Refresh from the source of truth (`list_sessions`) so we
  // do not have to trust event payload shape across versions.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<unknown>("acorn:ipc-sessions-changed", () => {
      useAppStore.getState().refreshSessions();
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[App] failed to attach ipc-sessions-changed listener", err);
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Drain every live terminal's scrollback to disk before the window is
  // destroyed, so a normal app quit never loses output that the
  // debounced output-driven save has not yet flushed. We block the
  // close, await all flushers (with a hard timeout so a hung flusher
  // can never strand the app open), then call `destroy()` to actually
  // close. Hard kill (kill -9, OS shutdown, crash) bypasses this and
  // falls back to whatever the debounce window happened to write.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    let closing = false;
    const win = getCurrentWindow();
    const FLUSH_DEADLINE_MS = 3000;
    win
      .onCloseRequested(async (event) => {
        if (closing) return;
        closing = true;
        event.preventDefault();
        console.log("[App] close requested — flushing scrollbacks");
        try {
          await Promise.race([
            flushAllScrollbacks(),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error("flush deadline exceeded")),
                FLUSH_DEADLINE_MS,
              ),
            ),
          ]);
          console.log("[App] flush done — destroying window");
        } catch (err) {
          // Flusher rejected or we hit the deadline. Either way still
          // close — losing the last second of scrollback beats a stuck
          // app that ignores the X button.
          console.warn("[App] flush failed or timed out, closing anyway", err);
        }
        try {
          await win.destroy();
        } catch (err) {
          console.error("[App] window destroy failed", err);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[App] failed to attach close-requested listener", err);
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
      [Hotkeys.newSession]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:new-session"));
      },
      [Hotkeys.newIsolatedSession]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:new-isolated-session"));
      },
      [Hotkeys.newControlSession]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:new-control-session"));
      },
      [Hotkeys.addProject]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:add-project"));
      },
      [Hotkeys.focusSidebar]: (e: KeyboardEvent) => {
        e.preventDefault();
        sidebarPanelRef.current?.expand();
        focusPanel("sidebar");
      },
      [Hotkeys.focusMain]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusPanel("main");
      },
      [Hotkeys.focusRight]: (e: KeyboardEvent) => {
        e.preventDefault();
        rightPanelRef.current?.expand();
        focusPanel("right");
      },
      [Hotkeys.toggleSidebar]: (e: KeyboardEvent) => {
        e.preventDefault();
        const panel = sidebarPanelRef.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.expand();
        else panel.collapse();
      },
      [Hotkeys.toggleRightPanel]: (e: KeyboardEvent) => {
        e.preventDefault();
        const panel = rightPanelRef.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.expand();
        else panel.collapse();
      },
      [Hotkeys.clearTerminal]: (e: KeyboardEvent) => {
        // Prefer the terminal whose helper textarea currently owns DOM
        // focus over `state.activeSessionId`. The store's `focusedPaneId`
        // only updates on a mouse-down inside a pane, but typing into an
        // xterm (or pressing a hotkey while the helper textarea has
        // focus) does not — so Cmd+K would otherwise clear whichever
        // pane the user last clicked, not the terminal they are actually
        // working in. Walking up from `document.activeElement` to the
        // nearest `[data-acorn-terminal-slot]` resolves the terminal the
        // user is really looking at.
        let sessionId: string | null = null;
        const focused = document.activeElement as HTMLElement | null;
        const slot = focused?.closest<HTMLElement>(
          "[data-acorn-terminal-slot]",
        );
        if (slot?.dataset.acornTerminalSlot) {
          sessionId = slot.dataset.acornTerminalSlot;
        }
        // Fall back to the store when focus is elsewhere (sidebar,
        // command palette, an empty pane after a split, etc.). Scan all
        // panes so a freshly-split empty pane doesn't silently no-op the
        // hotkey.
        if (!sessionId) {
          const s = useAppStore.getState();
          sessionId = s.activeSessionId;
          if (!sessionId && s.activeProject) {
            const ws = s.workspaces[s.activeProject];
            if (ws) {
              for (const pane of Object.values(ws.panes)) {
                if (pane.activeSessionId) {
                  sessionId = pane.activeSessionId;
                  break;
                }
              }
            }
          }
        }
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
      [Hotkeys.togglePrs]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("prs");
      },
      [Hotkeys.splitVertical]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().splitFocusedPane("horizontal");
      },
      [Hotkeys.splitHorizontal]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().splitFocusedPane("vertical");
      },
      [Hotkeys.equalizePanes]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
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
      [Hotkeys.reloadShellEnv]: (e: KeyboardEvent) => {
        e.preventDefault();
        const show = useToasts.getState().show;
        api
          .reloadShellEnv()
          .then(() => {
            // Existing PTY children keep the env they forked with —
            // surfacing this so the user knows why their already-open
            // session didn't change.
            show("Shell environment reloaded. Open a new session to apply.");
          })
          .catch((err: unknown) => {
            console.error("[App] reloadShellEnv failed", err);
            show("Failed to reload shell environment.");
          });
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
      <UpdateBanner />
      <ToastHost />
      <div className="flex min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="acorn:layout:root">
          <Panel
            ref={sidebarPanelRef}
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
            ref={rightPanelRef}
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
      <ControlSessionGuideModal
        open={controlGuideOpen}
        onClose={(dontShowAgain) => {
          setControlGuideOpen(false);
          if (dontShowAgain && typeof window !== "undefined") {
            window.localStorage.setItem(CONTROL_GUIDE_DISMISSED_KEY, "1");
          }
        }}
      />
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
