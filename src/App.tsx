import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { RightPanel } from "./components/RightPanel";
import { ResizeHandle } from "./components/ResizeHandle";
import { AcornRain } from "./components/AcornRain";
import { AgentResumeModal } from "./components/AgentResumeModal";
import { StagedRevMismatchModal } from "./components/StagedRevMismatchModal";
import { CommandPalette } from "./components/CommandPalette";
import {
  ControlSessionGuideModal,
  CONTROL_GUIDE_DISMISSED_KEY,
} from "./components/ControlSessionGuideModal";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalHost } from "./components/TerminalHost";
import { ToastHost } from "./components/ToastHost";
import { UpdateBanner } from "./components/UpdateBanner";
import {
  api,
  STAGED_REV_MISMATCH_EVENT,
  type AgentKind,
  type ResumeCandidate,
  type StagedRevMismatch,
} from "./lib/api";
import {
  Hotkeys,
  shouldUseTinykeysToggleMultiInputFallback,
  useHotkeys,
} from "./lib/hotkeys";
import {
  EQUALIZE_PANES_EVENT,
  EXPAND_PANEL_EVENT,
  type ExpandPanelDetail,
  RESET_PANEL_SIZES_EVENT,
} from "./lib/layoutEvents";
import {
  startNotificationClickHandler,
  startSessionNotificationWatcher,
} from "./lib/notifications";
import { findFocusedSessionId } from "./lib/focus";
import { flushAllScrollbacks } from "./lib/scrollback-coordinator";
import { useToasts } from "./lib/toasts";
import { useUpdater } from "./lib/updater-store";
import {
  normalizeUiScalePercent,
  UI_SCALE_PERCENT_STEP,
  useSettings,
} from "./lib/settings";
import { applyBackgroundVars, clearBackgroundVars } from "./lib/background";
import { applyTheme, useThemes } from "./lib/themes";
import { extractTabFromEvent } from "./lib/settings-events";
import { useAppStore } from "./store";
import type { TranslationKey, Translator } from "./lib/i18n";
import { useTranslation } from "./lib/useTranslation";

const FOCUSABLE_SELECTOR =
  "textarea, input:not([type='hidden']), button, [tabindex]:not([tabindex='-1']), a[href]";

const SIDEBAR_DEFAULT_SIZE = 18;
const SIDEBAR_MIN_SIZE = 12;
const RIGHT_PANEL_DEFAULT_SIZE = 26;
const RIGHT_PANEL_MIN_SIZE = 16;

type AppTranslationKey = Extract<TranslationKey, `app.${string}`>;

function appText(t: Translator, key: AppTranslationKey): string {
  return t(key);
}

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

function updateUiScalePercent(delta: number) {
  const settings = useSettings.getState().settings;
  useSettings.getState().patchAppearance({
    uiScalePercent: normalizeUiScalePercent(
      settings.appearance.uiScalePercent + delta,
      settings.appearance.uiScalePercent,
    ),
  });
}

function focusPaneTerminal(paneId: string) {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(paneId)
      : paneId.replace(/(["\\\]\[])/g, "\\$1");
  const pane = document.querySelector(
    `[data-pane-body="${escaped}"]`,
  ) as HTMLElement | null;
  const target =
    (pane?.querySelector(".xterm-helper-textarea") as HTMLElement | null) ??
    (pane?.querySelector(FOCUSABLE_SELECTOR) as HTMLElement | null);
  target?.focus();
}

function focusAdjacentPane(direction: "left" | "right" | "up" | "down") {
  useAppStore.getState().focusAdjacentPane(direction);
  requestAnimationFrame(() => {
    focusPaneTerminal(useAppStore.getState().focusedPaneId);
  });
}

function App() {
  const t = useTranslation();
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
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [resumeCandidates, setResumeCandidates] = useState<
    Map<string, { agent: AgentKind; candidate: ResumeCandidate }>
  >(new Map());
  const [stagedRevMismatch, setStagedRevMismatch] =
    useState<StagedRevMismatch | null>(null);

  const toggleMultiInput = useCallback(() => {
    const enabled = useAppStore.getState().toggleMultiInput();
    useToasts
      .getState()
      .show(
        enabled
          ? appText(t, "app.toast.multiInputOn")
          : appText(t, "app.toast.multiInputOff"),
      );
  }, [t]);
  const sidebarPanelRef = useRef<ImperativePanelHandle | null>(null);
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null);
  const themes = useThemes((s) => s.themes);
  const refreshThemes = useThemes((s) => s.refresh);
  const appearance = useSettings((s) => s.settings.appearance);

  useEffect(() => {
    void refreshThemes();
  }, [refreshThemes]);

  useEffect(() => {
    // Pull at mount + listen. The pull defeats a listener-mount-
    // after-emit race: if the daemon boot thread reconciled before
    // this effect attached, the AppState cache still holds the
    // result.
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void api
      .stagedRevMismatchStatus()
      .then((m) => {
        if (!cancelled && m) setStagedRevMismatch(m);
      })
      .catch((err) => {
        console.error(
          "[App] staged_rev_mismatch_status pull failed",
          err,
        );
      });
    listen<StagedRevMismatch>(STAGED_REV_MISMATCH_EVENT, (event) => {
      if (!cancelled) setStagedRevMismatch(event.payload);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error(
          "[App] staged-rev-mismatch listener attach failed",
          err,
        );
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const theme = themes.find((t) => t.id === appearance.themeId) ?? themes[0];
    if (theme) {
      applyTheme(theme.id, theme.css);
    }
  }, [appearance.themeId, themes]);

  useEffect(() => {
    if (
      appearance.background.relativePath &&
      (appearance.background.applyToApp ||
        appearance.background.applyToTerminal)
    ) {
      void applyBackgroundVars(appearance.background);
    } else {
      clearBackgroundVars();
    }
  }, [
    appearance.background.relativePath,
    appearance.background.fit,
    appearance.background.opacity,
    appearance.background.blur,
    appearance.background.applyToApp,
    appearance.background.applyToTerminal,
  ]);

  // Probe every persisted session for a "이전 대화" candidate exactly
  // once per Acorn launch — at mount, not on focus. The intended UX is
  // "boot Acorn after a system off-and-on, get a one-shot prompt per
  // session to pick up where I left off", which includes sessions that
  // live in non-focused panes (multi-pane layouts) where `activeSessionId`
  // alone would never surface them. Results land in `resumeCandidates`
  // keyed by session id; the rendered modal is a pure derivation of
  // `activeSessionId × resumeCandidates`, so dismissal only needs to
  // drop the entry — no separate "currently shown" state to keep in
  // sync.
  // Probe each session for a "이전 대화" candidate exactly once per
  // Acorn launch. Per-session ref dedup so the effect re-firing when
  // zustand pushes a new `sessions` array reference (boot rehydrate,
  // reconcile, refresh) does NOT re-probe sessions we already checked.
  // That dedup is what holds the "cold boot only" UX promise: after
  // the user finishes a claude run and the persister updates
  // `claude.id`, the in-memory map stays stable, so the modal never
  // pops mid-session.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const resumeModalEnabled = useSettings(
    (s) => s.settings.experiments.resumeModal,
  );
  const probedSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!resumeModalEnabled) return;
    const toProbe = sessionIds.filter(
      (sid) => !probedSessionsRef.current.has(sid),
    );
    if (toProbe.length === 0) return;
    // Mark *before* the await so a concurrent effect run (caused by
    // the same `sessions` array re-emitting a new reference during
    // boot) does not race to launch a duplicate probe for the same
    // id. We deliberately do NOT use an `if (cancelled) return` gate
    // on the `.then` — when the effect re-runs and cleans the prior
    // run, the in-flight probe still needs to land its result, and
    // the functional `setResumeCandidates(prev => ...)` is race-safe.
    for (const sid of toProbe) probedSessionsRef.current.add(sid);
    void Promise.all(
      toProbe.map(async (sid) => {
        const [claude, codex] = await Promise.all([
          api.getClaudeResumeCandidate(sid).catch(() => null),
          api.getCodexResumeCandidate(sid).catch(() => null),
        ]);
        const pick = pickResumeCandidate(claude, codex);
        return pick ? ([sid, pick] as const) : null;
      }),
    )
      .then((entries) => {
        const additions = entries.filter(
          (e): e is readonly [string, { agent: AgentKind; candidate: ResumeCandidate }] =>
            e !== null,
        );
        if (additions.length === 0) return;
        setResumeCandidates((prev) => {
          const next = new Map(prev);
          for (const [sid, pick] of additions) next.set(sid, pick);
          return next;
        });
      })
      .catch(() => {
        // Best-effort probe — failures here just mean a session won't
        // surface its modal on this boot. The next launch retries.
      });
  }, [sessionIds, resumeModalEnabled]);

  const resumeCandidate = useMemo(() => {
    if (!activeSessionId) return null;
    const entry = resumeCandidates.get(activeSessionId);
    if (!entry) return null;
    return {
      sessionId: activeSessionId,
      agent: entry.agent,
      candidate: entry.candidate,
    };
  }, [activeSessionId, resumeCandidates]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--acorn-ui-scale",
      String(appearance.uiScalePercent / 100),
    );
  }, [appearance.uiScalePercent]);

  useEffect(() => {
    // Order matters: `loadInitialStatus` arms the pane-wipe guard before the
    // first reconcile can run. If the backend reports sessions.json failed
    // to load (corrupt/IO error), the guard prevents the empty session list
    // from zeroing out the persisted layout.
    void useAppStore.getState().loadInitialStatus().then(() => refreshAll());
  }, [refreshAll]);

  // Keep `focusedPaneId` synced with the terminal whose helper textarea
  // currently owns DOM focus. The pane body's mousedown listener handles
  // the click-into-terminal case; this `focusin` syncer covers
  // keyboard-driven focus moves (Tab cycling, programmatic .focus(),
  // workspace switches) so every focus-dependent hotkey — Cmd+T, Cmd+W,
  // Cmd+Shift+D, Cmd+]/[ — targets the pane the user is actually
  // working in.
  useEffect(() => {
    const handler = () => {
      const sid = findFocusedSessionId();
      if (!sid) return;
      const state = useAppStore.getState();
      if (!state.activeProject) return;
      const ws = state.workspaces[state.activeProject];
      if (!ws) return;
      for (const [pid, pane] of Object.entries(ws.panes)) {
        if (pane.sessionIds.includes(sid)) {
          if (ws.focusedPaneId !== pid) state.setFocusedPane(pid);
          return;
        }
      }
    };
    document.addEventListener("focusin", handler);
    return () => document.removeEventListener("focusin", handler);
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<unknown>("acorn:toggle-multi-input", () => {
      toggleMultiInput();
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[App] failed to attach multi-input listener", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [toggleMultiInput]);

  // Refresh the "live cwd is inside a linked worktree" map whenever the
  // window regains focus — the user may have `cd`'d into a worktree (or
  // out of one) while we were backgrounded, and the icon should reflect
  // that without waiting for the next session-list refresh.
  useEffect(() => {
    const onFocus = () => {
      void useAppStore.getState().refreshLiveInWorktree();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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

  // Restore the root layout (sidebar + right panel) and equalize the
  // workspace pane splits when the command palette fires the reset event.
  // Useful when the user has nudged the 1px handle into a barely-visible
  // strip and wants a one-shot way back to the default layout.
  useEffect(() => {
    const handler = () => {
      sidebarPanelRef.current?.expand();
      sidebarPanelRef.current?.resize(SIDEBAR_DEFAULT_SIZE);
      rightPanelRef.current?.expand();
      rightPanelRef.current?.resize(RIGHT_PANEL_DEFAULT_SIZE);
      window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
    };
    window.addEventListener(RESET_PANEL_SIZES_EVENT, handler);
    return () => window.removeEventListener(RESET_PANEL_SIZES_EVENT, handler);
  }, []);

  // ResizeHandle dispatches this on double-click when the adjacent panel
  // is collapsed. Expand to minSize via the imperative ref so the panel
  // animates from its current state instead of jumping straight to the
  // last user-set size.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ExpandPanelDetail>).detail;
      if (!detail) return;
      if (detail.panelId === "sidebar") {
        sidebarPanelRef.current?.expand();
        sidebarPanelRef.current?.resize(SIDEBAR_MIN_SIZE);
      } else if (detail.panelId === "right") {
        rightPanelRef.current?.expand();
        rightPanelRef.current?.resize(RIGHT_PANEL_MIN_SIZE);
      }
    };
    window.addEventListener(EXPAND_PANEL_EVENT, handler);
    return () => window.removeEventListener(EXPAND_PANEL_EVENT, handler);
  }, []);

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
        // focus over `state.activeSessionId`. The app-level `focusin`
        // listener keeps `focusedPaneId` synced for clicks, but a hotkey
        // pressed *while* an xterm has focus has no intervening event
        // that would have re-synced — so resolve the real target via
        // `document.activeElement` walk.
        let sessionId = findFocusedSessionId();
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
      [Hotkeys.toggleFiles]: (e: KeyboardEvent) => {
        e.preventDefault();
        const panel = rightPanelRef.current;
        const state = useAppStore.getState();
        if (!panel) {
          state.setRightTab("files");
          return;
        }
        if (panel.isCollapsed()) {
          panel.expand();
          state.setRightTab("files");
        } else if (state.rightTab === "files") {
          panel.collapse();
        } else {
          state.setRightTab("files");
        }
      },
      [Hotkeys.uiScaleDown]: (e: KeyboardEvent) => {
        e.preventDefault();
        updateUiScalePercent(-UI_SCALE_PERCENT_STEP);
      },
      [Hotkeys.uiScaleDownShift]: (e: KeyboardEvent) => {
        e.preventDefault();
        updateUiScalePercent(-UI_SCALE_PERCENT_STEP);
      },
      [Hotkeys.uiScaleUp]: (e: KeyboardEvent) => {
        e.preventDefault();
        updateUiScalePercent(UI_SCALE_PERCENT_STEP);
      },
      [Hotkeys.uiScaleUpShift]: (e: KeyboardEvent) => {
        e.preventDefault();
        updateUiScalePercent(UI_SCALE_PERCENT_STEP);
      },
      [Hotkeys.uiScaleReset]: (e: KeyboardEvent) => {
        e.preventDefault();
        useSettings.getState().patchAppearance({ uiScalePercent: 100 });
      },
      [Hotkeys.toggleMultiInput]: (e: KeyboardEvent) => {
        e.preventDefault();
        if (!shouldUseTinykeysToggleMultiInputFallback()) return;
        toggleMultiInput();
      },
      [Hotkeys.focusPaneLeft]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("left");
      },
      [Hotkeys.focusPaneRight]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("right");
      },
      [Hotkeys.focusPaneUp]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("up");
      },
      [Hotkeys.focusPaneDown]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("down");
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
            show(
              appText(
                t,
                "app.toast.shellEnvironmentReloaded",
              ),
            );
          })
          .catch((err: unknown) => {
            console.error("[App] reloadShellEnv failed", err);
            show(
              appText(
                t,
                "app.toast.shellEnvironmentReloadFailed",
              ),
            );
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
    [t, toggleMultiInput],
  );

  useHotkeys(bindings);

  return (
    <div className="acorn-app-shell relative flex h-screen w-screen flex-col bg-bg text-fg">
      <div className="acorn-bg-app" aria-hidden="true" />
      <div className="relative z-10">
        <UpdateBanner />
      </div>
      <ToastHost />
      <div className="relative z-10 flex min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId="acorn:layout:root">
          <Panel
            ref={sidebarPanelRef}
            id="sidebar"
            order={1}
            defaultSize={SIDEBAR_DEFAULT_SIZE}
            minSize={SIDEBAR_MIN_SIZE}
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
            defaultSize={RIGHT_PANEL_DEFAULT_SIZE}
            minSize={RIGHT_PANEL_MIN_SIZE}
            maxSize={50}
            collapsible
            collapsedSize={0}
          >
            <RightPanel />
          </Panel>
        </PanelGroup>
      </div>
      <div className="relative z-10">
        <StatusBar />
      </div>
      <TerminalHost />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <AcornRain />
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
      <StagedRevMismatchModal
        mismatch={stagedRevMismatch}
        onDismiss={() => setStagedRevMismatch(null)}
      />
      <AgentResumeModal
        sessionId={resumeCandidate?.sessionId ?? ""}
        agent={resumeCandidate?.agent ?? "claude"}
        candidate={resumeCandidate?.candidate ?? null}
        onDismiss={() => {
          const dismissed = resumeCandidate?.sessionId;
          if (!dismissed) return;
          setResumeCandidates((prev) => {
            if (!prev.has(dismissed)) return prev;
            const next = new Map(prev);
            next.delete(dismissed);
            return next;
          });
        }}
      />
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

/**
 * Decide which agent's resume candidate to show first when both are
 * non-null. Larger `lastActivityUnix` wins so the user is offered the
 * conversation they most recently touched. `lastActivityUnix === 0`
 * means the transcript path could not be stat'd; treat as oldest.
 */
function pickResumeCandidate(
  claude: ResumeCandidate | null,
  codex: ResumeCandidate | null,
): { agent: AgentKind; candidate: ResumeCandidate } | null {
  if (claude && codex) {
    return claude.lastActivityUnix >= codex.lastActivityUnix
      ? { agent: "claude", candidate: claude }
      : { agent: "codex", candidate: codex };
  }
  if (claude) return { agent: "claude", candidate: claude };
  if (codex) return { agent: "codex", candidate: codex };
  return null;
}

export default App;
