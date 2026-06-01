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
import { FolderPermissionWarmupModal } from "./components/FolderPermissionWarmupModal";
import {
  api,
  AGENT_HOOK_STATUS_EVENT,
  STAGED_REV_MISMATCH_EVENT,
  type AgentKind,
  type ResumeCandidate,
  type StagedRevMismatch,
} from "./lib/api";
import {
  DEFAULT_HOTKEYS,
  hotkeyBindingsFor,
  shouldUseTinykeysToggleMultiInputFallback,
  useHotkeys,
  type HotkeyBindings,
} from "./lib/hotkeys";
import {
  TERMINAL_CONVERSATION_NAV_EVENT,
  type ConversationNavigationDirection,
} from "./lib/terminalConversation";
import { hasRecordedWorktree } from "./lib/sessionWorktree";
import {
  EQUALIZE_PANES_EVENT,
  EXPAND_PANEL_EVENT,
  type ExpandPanelDetail,
  RESET_PANEL_SIZES_EVENT,
  UI_SCALE_CHANGED_EVENT,
  type UiScaleChangedDetail,
} from "./lib/layoutEvents";
import {
  startFocusedSessionNotificationReadWatcher,
  startSessionActivityInboxWatcher,
  startNotificationClickHandler,
  startSessionNotificationWatcher,
} from "./lib/notifications";
import { findFocusedSessionId } from "./lib/focus";
import { isSessionTabId } from "./lib/workspaceTabs";
import { flushAllScrollbacks } from "./lib/scrollback-coordinator";
import { useToasts } from "./lib/toasts";
import { useUpdater } from "./lib/updater-store";
import {
  hasDeniedFolderPermission,
  isMacPlatform,
  type FolderPermissionWarmupResult,
} from "./lib/permissionWarmup";
import {
  normalizeUiScalePercent,
  resolveAiExecutionRequest,
  resolveSessionTitlePrompt,
  UI_SCALE_PERCENT_STEP,
  useSettings,
} from "./lib/settings";
import { planAutoGenerateSessionTitles } from "./lib/sessionTitle";
import { applyBackgroundVars, clearBackgroundVars } from "./lib/background";
import { applyTheme, useThemes } from "./lib/themes";
import { extractTabFromEvent } from "./lib/settings-events";
import { useAcornDragGlobalCleanup } from "./lib/dnd";
import { useNativeFileDropTerminalBridge } from "./lib/nativeFileDrop";
import {
  TERMINAL_PASTE_EVENT,
  type TerminalPasteEventDetail,
} from "./lib/pasteEvents";
import {
  nextSessionStatusPollDelayMs,
  selectDueSessionStatusPollIds,
  selectImmediateSessionStatusPollIds,
} from "./lib/sessionStatusPolling";
import { useAppStore } from "./store";
import type { TranslationKey, Translator } from "./lib/i18n";
import type { SessionStatus } from "./lib/types";
import { useTranslation } from "./lib/useTranslation";

const FOCUSABLE_SELECTOR =
  "textarea, input:not([type='hidden']), button, [tabindex]:not([tabindex='-1']), a[href]";
const SESSION_TITLE_RETRY_MS = 30_000;
const SESSION_TITLE_NOT_READY_RETRY_MS = 1_000;

const SIDEBAR_DEFAULT_SIZE = 18;
const SIDEBAR_MIN_SIZE = 12;
const RIGHT_PANEL_DEFAULT_SIZE = 26;
const RIGHT_PANEL_MIN_SIZE = 16;

type AppTranslationKey = Extract<TranslationKey, `app.${string}`>;

function appText(t: Translator, key: AppTranslationKey): string {
  return t(key);
}

function isEditableTextElement(
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    return false;
  }
  return !element.disabled && !element.readOnly;
}

function dispatchInputEvent(element: Element, text: string) {
  try {
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertFromPaste",
      }),
    );
  } catch {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function insertTextIntoActiveElement(text: string): boolean {
  const active = document.activeElement;
  if (isEditableTextElement(active)) {
    const start = active.selectionStart ?? active.value.length;
    const end = active.selectionEnd ?? active.value.length;
    active.setRangeText(text, start, end, "end");
    dispatchInputEvent(active, text);
    return true;
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    active.focus();
    return document.execCommand("insertText", false, text);
  }
  return false;
}

function activeOrFocusedSessionId(): string | null {
  const focused = findFocusedSessionId();
  if (focused) return focused;
  const state = useAppStore.getState();
  if (state.activeSessionId) return state.activeSessionId;
  if (!state.activeProject) return null;
  const ws = state.workspaces[state.activeProject];
  if (!ws) return null;
  const activeTabId = ws.panes[ws.focusedPaneId]?.activeTabId;
  return activeTabId && isSessionTabId(activeTabId) ? activeTabId : null;
}

function dispatchTerminalPaste(sessionId: string) {
  window.dispatchEvent(
    new CustomEvent<TerminalPasteEventDetail>(TERMINAL_PASTE_EVENT, {
      detail: { sessionId },
    }),
  );
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

function dispatchFocusedTerminalConversationNav(
  direction: ConversationNavigationDirection,
): boolean {
  const sessionId = findFocusedSessionId();
  if (!sessionId) return false;
  const event = new CustomEvent(TERMINAL_CONVERSATION_NAV_EVENT, {
    cancelable: true,
    detail: { direction, sessionId },
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function focusAdjacentPane(direction: "left" | "right" | "up" | "down") {
  useAppStore.getState().focusAdjacentPane(direction);
  requestAnimationFrame(() => {
    focusPaneTerminal(useAppStore.getState().focusedPaneId);
  });
}

function App() {
  const t = useTranslation();
  useAcornDragGlobalCleanup();
  useNativeFileDropTerminalBridge();
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
  const confirmRemoveSession = useSettings(
    (s) => s.settings.sessions.confirmRemove,
  );
  const autoDeleteWorktrees = useSettings(
    (s) => s.settings.sessions.autoDeleteWorktrees,
  );
  const settings = useSettings((s) => s.settings);
  const shortcuts = settings.shortcuts;
  const pendingRemove = sessions.find((s) => s.id === pendingRemoveId) ?? null;
  const pendingProject =
    projects.find((p) => p.repo_path === pendingRemoveProject) ?? null;
  const pendingProjectSessions = pendingProject
    ? sessions.filter((s) => s.repo_path === pendingProject.repo_path)
    : [];
  const pendingRemoveRecordedWorktree =
    pendingRemove !== null && hasRecordedWorktree(pendingRemove);
  const pendingRemoveSkipsDialog =
    pendingRemove !== null &&
    ((pendingRemoveRecordedWorktree && autoDeleteWorktrees) ||
      (!pendingRemoveRecordedWorktree && !confirmRemoveSession));
  const sessionIdsKey = useMemo(
    () => sessions.map((session) => session.id).join("\0"),
    [sessions],
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [controlGuideOpen, setControlGuideOpen] = useState(false);
  const [permissionWarmupOpen, setPermissionWarmupOpen] = useState(false);
  const [permissionWarmupInitialResults, setPermissionWarmupInitialResults] =
    useState<FolderPermissionWarmupResult[] | null>(null);
  const permissionWarmupAuditRef = useRef<{
    key: string;
    promise: Promise<FolderPermissionWarmupResult[]>;
  } | null>(null);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const [resumeCandidates, setResumeCandidates] = useState<
    Map<string, { agent: AgentKind; candidate: ResumeCandidate }>
  >(new Map());
  const titleGenerationInFlightRef = useRef<Set<string>>(new Set());
  const titleGenerationLastAttemptAtRef = useRef<Map<string, number>>(
    new Map(),
  );
  const titleGenerationConfigKeyRef = useRef<string | null>(null);
  const [sessionTitleRetryTick, setSessionTitleRetryTick] = useState(0);
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
  const statusPollLastPolledAtRef = useRef<Map<string, number>>(new Map());
  const themes = useThemes((s) => s.themes);
  const refreshThemes = useThemes((s) => s.refresh);
  const appearance = useSettings((s) => s.settings.appearance);
  const showToast = useToasts((s) => s.show);

  const showStoreOperationToast = useCallback(
    (successKey: TranslationKey | null, failureKey: TranslationKey) => {
      const error = useAppStore.getState().consumeError();
      if (error) {
        showToast(`${t(failureKey)} ${error}`);
      } else if (successKey) {
        showToast(t(successKey));
      }
    },
    [showToast, t],
  );

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
  // Probe each non-busy session for a "이전 대화" candidate exactly once
  // per Acorn launch. Per-session ref dedup so the effect re-firing when
  // zustand pushes a new `sessions` array reference (boot rehydrate,
  // reconcile, refresh, status polling) does NOT re-probe sessions we
  // already checked. Busy sessions are marked as checked without hitting
  // the candidate APIs, because an active claude/codex should never be
  // interrupted by a resume prompt for the transcript it is already using.
  // That dedup is what holds the "cold boot only" UX promise: after
  // the user finishes a claude run and the persister updates
  // `claude.id`, the in-memory map stays stable, so the modal never
  // pops mid-session.
  const resumeModalEnabled = useSettings(
    (s) => s.settings.experiments.resumeModal,
  );
  const primedResumeSessionsRef = useRef<Set<string>>(new Set());
  const [resumePrimeVersion, setResumePrimeVersion] = useState(0);
  const probedSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!resumeModalEnabled) {
      primedResumeSessionsRef.current.clear();
      setResumePrimeVersion((version) => version + 1);
      return;
    }
    const unprimedIds = sessions
      .map((session) => session.id)
      .filter((id) => !primedResumeSessionsRef.current.has(id));
    if (unprimedIds.length === 0) return;
    let cancelled = false;
    void useAppStore
      .getState()
      .pollSessionStatuses()
      .finally(() => {
        if (cancelled) return;
        for (const id of unprimedIds) {
          primedResumeSessionsRef.current.add(id);
        }
        setResumePrimeVersion((version) => version + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [resumeModalEnabled, sessionIdsKey]);

  useEffect(() => {
    if (!resumeModalEnabled) return;
    const latestById = new Map(
      useAppStore.getState().sessions.map((session) => [session.id, session]),
    );
    const effectiveSessions = sessions.map(
      (session) => latestById.get(session.id) ?? session,
    );
    if (
      effectiveSessions.some(
        (session) => !primedResumeSessionsRef.current.has(session.id),
      )
    ) {
      return;
    }
    const activeSessions = effectiveSessions.filter((s) =>
      shouldSkipResumeProbeForStatus(s.status),
    );
    if (activeSessions.length > 0) {
      for (const session of activeSessions) {
        probedSessionsRef.current.add(session.id);
      }
      setResumeCandidates((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const session of activeSessions) {
          changed = next.delete(session.id) || changed;
        }
        return changed ? next : prev;
      });
    }
    const toProbe = effectiveSessions
      .filter(
        (session) =>
          !shouldSkipResumeProbeForStatus(session.status) &&
          !probedSessionsRef.current.has(session.id),
      )
      .map((session) => session.id);
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
        const [claude, codex, antigravity] = await Promise.all([
          api.getClaudeResumeCandidate(sid).catch(() => null),
          api.getCodexResumeCandidate(sid).catch(() => null),
          api.getAntigravityResumeCandidate(sid).catch(() => null),
        ]);
        const pick = pickResumeCandidate(claude, codex, antigravity);
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
  }, [sessions, resumeModalEnabled, resumePrimeVersion]);

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
    const detail: UiScaleChangedDetail = {
      uiScalePercent: appearance.uiScalePercent,
    };
    window.dispatchEvent(new CustomEvent(UI_SCALE_CHANGED_EVENT, { detail }));
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
        if (pane.tabIds.includes(sid)) {
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

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<unknown>("acorn:paste", () => {
      const focusedTerminal = findFocusedSessionId();
      if (focusedTerminal) {
        dispatchTerminalPaste(focusedTerminal);
        return;
      }

      if (isEditableTextElement(document.activeElement)) {
        void api
          .clipboardSnapshot()
          .then((snapshot) => {
            if (snapshot.text) insertTextIntoActiveElement(snapshot.text);
          })
          .catch((err: unknown) => {
            console.debug("[App] clipboard paste failed", err);
          });
        return;
      }

      const sessionId = activeOrFocusedSessionId();
      if (sessionId) dispatchTerminalPaste(sessionId);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[App] failed to attach paste listener", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
    if (typeof navigator === "undefined") return;
    const testWindow = window as typeof window & {
      __ACORN_TEST_MODE__?: boolean;
      __ACORN_ENABLE_PERMISSION_WARMUP__?: boolean;
    };
    if (
      testWindow.__ACORN_TEST_MODE__ &&
      !testWindow.__ACORN_ENABLE_PERMISSION_WARMUP__
    ) {
      return;
    }
    const platform = navigator.platform;
    if (!isMacPlatform(platform)) return;

    const auditKey = platform;
    let audit = permissionWarmupAuditRef.current;
    if (!audit || audit.key !== auditKey) {
      audit = {
        key: auditKey,
        promise: api.warmMacosFolderPermissions(),
      };
      permissionWarmupAuditRef.current = audit;
    }

    let cancelled = false;
    void audit.promise
      .then((results) => {
        if (cancelled || !hasDeniedFolderPermission(results)) return;
        setPermissionWarmupInitialResults(results);
        setPermissionWarmupOpen(true);
      })
      .catch((err) => {
        console.warn("[App] folder permission audit failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return startSessionNotificationWatcher();
  }, []);

  useEffect(() => {
    return startFocusedSessionNotificationReadWatcher();
  }, []);

  useEffect(() => {
    if (!settings.agents.autoGenerateSessionTitles) return;

    let cancelled = false;
    const retryTimers = new Set<ReturnType<typeof window.setTimeout>>();
    const scheduleRetryTick = (delayMs: number, allowAfterCleanup = false) => {
      if (cancelled && !allowAfterCleanup) return;
      const fireAfterCleanup = allowAfterCleanup;
      const timeout = window.setTimeout(() => {
        retryTimers.delete(timeout);
        if (!cancelled || fireAfterCleanup) {
          setSessionTitleRetryTick((tick) => tick + 1);
        }
      }, delayMs);
      retryTimers.add(timeout);
    };

    const now = Date.now();
    const ai = resolveAiExecutionRequest(settings);
    const prompt = resolveSessionTitlePrompt(settings);
    const configKey = JSON.stringify([ai, prompt]);
    const inFlight = titleGenerationInFlightRef.current;
    const lastAttemptAt = titleGenerationLastAttemptAtRef.current;
    const latestTitleConfigMatches = () => {
      const latestSettings = useSettings.getState().settings;
      const latestAi = resolveAiExecutionRequest(latestSettings);
      const latestPrompt = resolveSessionTitlePrompt(latestSettings);
      const latestConfigKey = JSON.stringify([latestAi, latestPrompt]);
      return (
        latestSettings.agents.autoGenerateSessionTitles &&
        latestConfigKey === configKey
      );
    };
    const retryDelayForStatus = (
      sessionId: string,
      status: "not_ready" | "skipped",
    ): number => {
      if (status === "not_ready") {
        lastAttemptAt.delete(sessionId);
        return SESSION_TITLE_NOT_READY_RETRY_MS;
      }
      lastAttemptAt.set(sessionId, Date.now());
      return SESSION_TITLE_RETRY_MS;
    };
    if (titleGenerationConfigKeyRef.current !== configKey) {
      titleGenerationConfigKeyRef.current = configKey;
      lastAttemptAt.clear();
    }
    const plan = planAutoGenerateSessionTitles({
      sessions,
      enabled: settings.agents.autoGenerateSessionTitles,
      inFlightIds: inFlight,
      lastAttemptAt,
      now,
      retryMs: SESSION_TITLE_RETRY_MS,
    });

    for (const sessionId of plan.sessionIds) {
      let retryDelayAfterCompletion: number | null = null;
      inFlight.add(sessionId);
      void api
        .sessionTitleReadiness(sessionId)
        .then(async (readiness) => {
          if (!latestTitleConfigMatches()) return;
          if (readiness.status !== "ready") {
            retryDelayAfterCompletion = retryDelayForStatus(
              sessionId,
              readiness.status,
            );
            return;
          }

          const status = await useAppStore
            .getState()
            .generateSessionTitle(sessionId, ai, prompt);
          if (!latestTitleConfigMatches()) return;
          if (status !== "generated") {
            retryDelayAfterCompletion = retryDelayForStatus(sessionId, status);
          }
        })
        .catch((err) => {
          console.warn("[acorn] session title readiness failed", err);
          if (!latestTitleConfigMatches()) return;
          retryDelayAfterCompletion = retryDelayForStatus(sessionId, "skipped");
        })
        .finally(() => {
          inFlight.delete(sessionId);
          // State changes can clean up this effect while readiness is still
          // in-flight. Schedule after completion so the retry is not erased
          // before the session leaves the in-flight set.
          if (
            retryDelayAfterCompletion !== null &&
            latestTitleConfigMatches()
          ) {
            scheduleRetryTick(retryDelayAfterCompletion, true);
          }
        });
    }

    if (plan.retryDelayMs !== null) {
      scheduleRetryTick(plan.retryDelayMs);
    }

    return () => {
      cancelled = true;
      for (const timeout of retryTimers) {
        window.clearTimeout(timeout);
      }
      retryTimers.clear();
    };
  }, [sessions, settings, sessionTitleRetryTick]);

  useEffect(() => {
    return startSessionActivityInboxWatcher();
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

  // Probe session status adaptively: active tabs stay fresh, volatile sessions
  // get a moderate cadence, and stable sessions fall back to a slow safety
  // sweep. The Rust side accepts an id subset, so each tick sends only ids
  // whose cadence has elapsed.
  useEffect(() => {
    const lastPolledAt = statusPollLastPolledAtRef.current;
    const currentSessions = useAppStore.getState().sessions;
    const currentIds = new Set(currentSessions.map((session) => session.id));
    for (const id of Array.from(lastPolledAt.keys())) {
      if (!currentIds.has(id)) lastPolledAt.delete(id);
    }

    let cancelled = false;
    let inFlight = false;
    let windowFocused =
      typeof document === "undefined" ||
      typeof document.hasFocus !== "function" ||
      document.hasFocus();
    let timer: ReturnType<typeof window.setTimeout> | null = null;
    const pendingImmediateIds = new Set(
      selectImmediateSessionStatusPollIds({
        sessions: currentSessions,
        activeSessionId: useAppStore.getState().activeSessionId,
        lastPolledAt,
      }),
    );

    const isForeground = () =>
      windowFocused &&
      (typeof document === "undefined" || document.visibilityState !== "hidden");

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const scheduleNext = (delay?: number) => {
      clearTimer();
      if (cancelled || !isForeground()) return;
      const state = useAppStore.getState();
      const nextDelay =
        delay ??
        nextSessionStatusPollDelayMs({
          sessions: state.sessions,
          activeSessionId: state.activeSessionId,
          lastPolledAt,
          now: Date.now(),
        });
      if (nextDelay === null) return;
      timer = window.setTimeout(() => {
        void runPoll();
      }, nextDelay);
    };

    const enqueueImmediate = (ids: string[]) => {
      for (const id of ids) pendingImmediateIds.add(id);
      scheduleNext(0);
    };

    const runPoll = async () => {
      clearTimer();
      if (cancelled || !isForeground()) return;
      if (inFlight) return;

      const state = useAppStore.getState();
      const existingIds = new Set(state.sessions.map((session) => session.id));
      const immediateIds = Array.from(pendingImmediateIds).filter((id) =>
        existingIds.has(id),
      );
      pendingImmediateIds.clear();
      const dueIds =
        immediateIds.length > 0
          ? immediateIds
          : selectDueSessionStatusPollIds({
              sessions: state.sessions,
              activeSessionId: state.activeSessionId,
              lastPolledAt,
              now: Date.now(),
            });

      if (dueIds.length === 0) {
        scheduleNext();
        return;
      }

      inFlight = true;
      try {
        await useAppStore.getState().pollSessionStatuses(dueIds);
      } finally {
        const completedAt = Date.now();
        for (const id of dueIds) lastPolledAt.set(id, completedAt);
        inFlight = false;
        scheduleNext(pendingImmediateIds.size > 0 ? 0 : undefined);
      }
    };

    const foregroundImmediateIds = () => {
      const state = useAppStore.getState();
      return selectImmediateSessionStatusPollIds({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        lastPolledAt,
        includeVolatile: true,
      });
    };

    const onFocus = () => {
      windowFocused = true;
      enqueueImmediate(foregroundImmediateIds());
    };
    const onBlur = () => {
      windowFocused = false;
      clearTimer();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearTimer();
      } else {
        enqueueImmediate(foregroundImmediateIds());
      }
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    scheduleNext(0);

    return () => {
      cancelled = true;
      clearTimer();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeSessionId, sessionIdsKey]);

  // Skip the confirmation dialog when Settings gives a deterministic removal
  // choice: plain sessions can skip confirmation, and worktree-backed sessions
  // can opt into always deleting the worktree from disk.
  useEffect(() => {
    if (!pendingRemove) return;
    const recordedWorktree = hasRecordedWorktree(pendingRemove);
    if (recordedWorktree && autoDeleteWorktrees) {
      clearPendingRemove();
      void removeSession(pendingRemove.id, true).then(() =>
        showStoreOperationToast(
          "toasts.session.worktreeRemoved",
          "toasts.session.worktreeRemoveFailed",
        ),
      );
      return;
    }
    if (confirmRemoveSession || recordedWorktree) return;
    clearPendingRemove();
    void removeSession(pendingRemove.id, false).then(() =>
      showStoreOperationToast(
        null,
        "toasts.session.removeFailed",
      ),
    );
  }, [
    pendingRemove,
    autoDeleteWorktrees,
    clearPendingRemove,
    confirmRemoveSession,
    removeSession,
    showStoreOperationToast,
  ]);

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

  // Agent hook callbacks update backend session status immediately. Refresh
  // the session list from backend state so hook status can surface without
  // waiting for the next transcript/process poll.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<string>(AGENT_HOOK_STATUS_EVENT, () => {
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
        console.error("[App] failed to attach agent-hook-status listener", err);
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

  const bindings = useMemo<HotkeyBindings>(() => {
    const uiScaleDownHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      updateUiScalePercent(-UI_SCALE_PERCENT_STEP);
    };
    const uiScaleUpHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      updateUiScalePercent(UI_SCALE_PERCENT_STEP);
    };
    const toggleMultiInputHandler = (e: KeyboardEvent) => {
      e.preventDefault();
      if (
        shortcuts.toggleMultiInput === DEFAULT_HOTKEYS.toggleMultiInput &&
        !shouldUseTinykeysToggleMultiInputFallback()
      ) {
        return;
      }
      toggleMultiInput();
    };

    const next: HotkeyBindings = {
      [shortcuts.openPalette]: (e: KeyboardEvent) => {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      },
      [shortcuts.newSession]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:new-session"));
      },
      [shortcuts.newIsolatedSession]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:new-isolated-session"));
      },
      [shortcuts.newControlSession]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:new-control-session"));
      },
      [shortcuts.addProject]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("acorn:add-project"));
      },
      [shortcuts.focusSidebar]: (e: KeyboardEvent) => {
        e.preventDefault();
        sidebarPanelRef.current?.expand();
        focusPanel("sidebar");
      },
      [shortcuts.focusMain]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusPanel("main");
      },
      [shortcuts.focusRight]: (e: KeyboardEvent) => {
        e.preventDefault();
        rightPanelRef.current?.expand();
        focusPanel("right");
      },
      [shortcuts.toggleSidebar]: (e: KeyboardEvent) => {
        e.preventDefault();
        const panel = sidebarPanelRef.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.expand();
        else panel.collapse();
      },
      [shortcuts.toggleRightPanel]: (e: KeyboardEvent) => {
        e.preventDefault();
        const panel = rightPanelRef.current;
        if (!panel) return;
        if (panel.isCollapsed()) panel.expand();
        else panel.collapse();
      },
      [shortcuts.clearTerminal]: (e: KeyboardEvent) => {
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
                if (pane.activeTabId && isSessionTabId(pane.activeTabId)) {
                  sessionId = pane.activeTabId;
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
      [shortcuts.previousConversation]: (e: KeyboardEvent) => {
        if (dispatchFocusedTerminalConversationNav("previous")) {
          e.preventDefault();
        }
      },
      [shortcuts.nextConversation]: (e: KeyboardEvent) => {
        if (dispatchFocusedTerminalConversationNav("next")) {
          e.preventDefault();
        }
      },
      [shortcuts.toggleTodos]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("todos");
      },
      [shortcuts.toggleCommits]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("commits");
      },
      [shortcuts.toggleStaged]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("staged");
      },
      [shortcuts.togglePrs]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().setRightTab("prs");
      },
      [shortcuts.toggleFiles]: (e: KeyboardEvent) => {
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
      [shortcuts.uiScaleDown]: uiScaleDownHandler,
      [shortcuts.uiScaleUp]: uiScaleUpHandler,
      [shortcuts.uiScaleReset]: (e: KeyboardEvent) => {
        e.preventDefault();
        useSettings.getState().patchAppearance({ uiScalePercent: 100 });
      },
      [shortcuts.toggleMultiInput]: toggleMultiInputHandler,
      [shortcuts.focusPaneLeft]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("left");
      },
      [shortcuts.focusPaneRight]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("right");
      },
      [shortcuts.focusPaneUp]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("up");
      },
      [shortcuts.focusPaneDown]: (e: KeyboardEvent) => {
        e.preventDefault();
        focusAdjacentPane("down");
      },
      [shortcuts.splitVertical]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().splitFocusedPane("horizontal");
      },
      [shortcuts.splitHorizontal]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().splitFocusedPane("vertical");
      },
      [shortcuts.equalizePanes]: (e: KeyboardEvent) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
      },
      [shortcuts.closeTab]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().closeFocusedTab();
      },
      [shortcuts.nextTab]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleTab(1);
      },
      [shortcuts.prevTab]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleTab(-1);
      },
      [shortcuts.nextProject]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleProject(1);
      },
      [shortcuts.prevProject]: (e: KeyboardEvent) => {
        e.preventDefault();
        useAppStore.getState().cycleProject(-1);
      },
      [shortcuts.openSettings]: (e: KeyboardEvent) => {
        e.preventDefault();
        useSettings.getState().setOpen(true);
      },
      [shortcuts.reloadShellEnv]: (e: KeyboardEvent) => {
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
      [shortcuts.closeEmptyPane]: (e: KeyboardEvent) => {
        // Only collapse the focused pane when it's empty, so Escape stays
        // available for inputs, dialogs, and the command palette.
        const { focusedPaneId, panes } = useAppStore.getState();
        const pane = panes[focusedPaneId];
        if (!pane || pane.tabIds.length > 0) return;
        const total = Object.keys(panes).length;
        if (total <= 1) return;
        e.preventDefault();
        useAppStore.getState().closePane(focusedPaneId);
      },
    };

    for (const alias of hotkeyBindingsFor(shortcuts, "uiScaleDown").slice(1)) {
      next[alias] = uiScaleDownHandler;
    }
    for (const alias of hotkeyBindingsFor(shortcuts, "uiScaleUp").slice(1)) {
      next[alias] = uiScaleUpHandler;
    }

    return next;
  }, [shortcuts, t, toggleMultiInput]);

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
          <ResizeHandle thin />
          <Panel id="main" order={2} defaultSize={56} minSize={30}>
            <LayoutRenderer node={layout} />
          </Panel>
          <ResizeHandle thin />
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
      <FolderPermissionWarmupModal
        open={permissionWarmupOpen}
        initialResults={permissionWarmupInitialResults}
        onClose={() => setPermissionWarmupOpen(false)}
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
        session={pendingRemoveSkipsDialog ? null : pendingRemove}
        onClose={(choice) => {
          const target = pendingRemove;
          clearPendingRemove();
          if (!target || choice === "cancel") return;
          void removeSession(target.id, choice === "session_and_worktree").then(
            () =>
              showStoreOperationToast(
                choice === "session_and_worktree"
                  ? "toasts.session.worktreeRemoved"
                  : null,
                choice === "session_and_worktree"
                  ? "toasts.session.worktreeRemoveFailed"
                  : "toasts.session.removeFailed",
              ),
          );
        }}
      />
      <RemoveProjectDialog
        project={pendingProject}
        sessions={pendingProjectSessions}
        onClose={(choice) => {
          const target = pendingProject;
          clearPendingRemoveProject();
          if (!target || choice === "cancel") return;
          void removeProject(
            target.repo_path,
            choice === "project_and_worktrees",
          ).then(() =>
            showStoreOperationToast(
              choice === "project_and_worktrees"
                ? "toasts.project.worktreesRemoved"
                : null,
              choice === "project_and_worktrees"
                ? "toasts.project.worktreesRemoveFailed"
                : "toasts.project.removeFailed",
            ),
          );
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
  antigravity: ResumeCandidate | null,
): { agent: AgentKind; candidate: ResumeCandidate } | null {
  const candidates = [
    claude ? ({ agent: "claude", candidate: claude } as const) : null,
    codex ? ({ agent: "codex", candidate: codex } as const) : null,
    antigravity
      ? ({ agent: "antigravity", candidate: antigravity } as const)
      : null,
  ]
    .filter(
      (entry): entry is { agent: AgentKind; candidate: ResumeCandidate } =>
        entry !== null,
    )
    .sort((a, b) => b.candidate.lastActivityUnix - a.candidate.lastActivityUnix);
  return candidates[0] ?? null;
}

function shouldSkipResumeProbeForStatus(status: SessionStatus): boolean {
  return status === "running" || status === "needs_input";
}

export default App;
