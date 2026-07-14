import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { useSettings } from "./settings";
import type {
  Session,
  SessionNotification,
  SessionNotificationKind,
  SessionStatus,
} from "./types";

// Notification body copy keyed by the status the session transitioned *into*.
// The watcher only fires on transitions to `waiting_for_input` / `errored`;
// `ready` / `working` entries are placeholders so the record
// stays exhaustive against `SessionStatus`.
const STATUS_SENTENCE: Record<SessionStatus, string> = {
  ready: "Session is ready.",
  working: "Session is working.",
  waiting_for_input: "Awaiting your next input.",
  errored: "Session hit an error.",
};

// Cached OS permission result for the steady-state notification path. Reused
// across session-status transitions so we don't pay the IPC round-trip on
// every fire. `null` means "never checked"; subsequent transitions skip the
// check once it has resolved. The test-notification path deliberately bypasses
// this and refreshes the cache so a stale value (e.g. user toggled permission
// in System Settings since boot) gets corrected the moment the user asks
// "does this actually work?".
let cachedPermission: boolean | null = null;
let inboxNotificationCounter = 0;

async function checkPermission(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === "granted";
    }
    return granted;
  } catch (err) {
    console.error("[notifications] permission check failed", err);
    return false;
  }
}

async function ensurePermission(): Promise<boolean> {
  if (cachedPermission !== null) return cachedPermission;
  cachedPermission = await checkPermission();
  return cachedPermission;
}

async function refreshPermission(): Promise<boolean> {
  cachedPermission = await checkPermission();
  return cachedPermission;
}

function shouldNotifyTransition(prev: SessionStatus, next: SessionStatus): {
  notify: boolean;
  key: "waitingForInput" | "errored" | null;
} {
  if (prev === next) return { notify: false, key: null };
  if (next === "waiting_for_input") {
    return { notify: true, key: "waitingForInput" };
  }
  if (next === "errored") return { notify: true, key: "errored" };
  return { notify: false, key: null };
}

function notificationKindForTransition(
  prev: SessionStatus,
  next: SessionStatus,
): SessionNotificationKind | null {
  if (prev === next) return null;
  if (next === "waiting_for_input") return "waiting_for_input";
  if (next === "errored") return "errored";
  return null;
}

function isSessionFocused(sessionId: string, activeSessionId: string | null): boolean {
  return (
    activeSessionId === sessionId &&
    (typeof document === "undefined" || document.hasFocus())
  );
}

/**
 * Treat the currently visible session tab as having consumed its outstanding
 * in-app notifications. This intentionally does not clear delivered OS
 * notifications.
 */
export function markSessionNotificationsRead(sessionId: string | null): void {
  if (!sessionId) return;
  useAppStore.getState().markSessionNotificationsReadForSession(sessionId);
}

export function resetNotificationsForTests(): void {
  cachedPermission = null;
  inboxNotificationCounter = 0;
}

export function startFocusedSessionNotificationReadWatcher(): () => void {
  const markFocused = () => {
    if (typeof document !== "undefined" && !document.hasFocus()) return;
    markSessionNotificationsRead(useAppStore.getState().activeSessionId);
  };

  const unsubscribeStore = useAppStore.subscribe((state, previous) => {
    if (state.activeSessionId !== previous.activeSessionId) {
      markFocused();
    }
  });
  const unsubscribeSettings = useSettings.subscribe((state, previous) => {
    if (
      state.settings.notifications.maxHistory ===
        previous.settings.notifications.maxHistory &&
      state.settings.notifications.autoDeleteRead ===
        previous.settings.notifications.autoDeleteRead
    ) {
      return;
    }
    const { maxHistory, autoDeleteRead } = state.settings.notifications;
    useAppStore.setState((store) => {
      const filtered = autoDeleteRead
        ? store.sessionNotifications.filter((notification) => !notification.readAt)
        : store.sessionNotifications;
      return { sessionNotifications: filtered.slice(0, maxHistory) };
    });
  });
  window.addEventListener("focus", markFocused);
  markFocused();

  return () => {
    unsubscribeStore();
    unsubscribeSettings();
    window.removeEventListener("focus", markFocused);
  };
}

/**
 * Watches the session list for status transitions and fires a system
 * notification when one matches the user's enabled events. Returns an
 * unsubscribe function. Designed to run once at app boot.
 */
export function startSessionNotificationWatcher(): () => void {
  const lastStatus = new Map<string, SessionStatus>();
  for (const s of useAppStore.getState().sessions) {
    lastStatus.set(s.id, s.status);
  }

  return useAppStore.subscribe((state) => {
    const settings = useSettings.getState().settings.notifications;
    const sessions: Session[] = state.sessions;

    if (!settings.enabled) {
      // Keep the snapshot in sync so re-enabling doesn't fire stale events.
      lastStatus.clear();
      for (const s of sessions) lastStatus.set(s.id, s.status);
      return;
    }

    for (const s of sessions) {
      const prev = lastStatus.get(s.id);
      lastStatus.set(s.id, s.status);
      if (prev === undefined) continue;
      if (state.silencedSessionIds[s.id]) continue;
      const { notify, key } = shouldNotifyTransition(prev, s.status);
      if (!notify || !key || !settings.events[key]) continue;
      if (isSessionFocused(s.id, state.activeSessionId)) {
        markSessionNotificationsRead(s.id);
        continue;
      }
      void fire(s, s.status);
    }

    // Drop entries for sessions that no longer exist so the map stays bounded.
    const known = new Set(sessions.map((s) => s.id));
    for (const id of lastStatus.keys()) {
      if (!known.has(id)) lastStatus.delete(id);
    }
  });
}

/**
 * Watches session status transitions and records an in-app activity item for
 * changes that need review. This is intentionally independent from the
 * system-notification setting: the inbox is Acorn's local status history.
 */
export function startSessionActivityInboxWatcher(): () => void {
  const lastStatus = new Map<string, SessionStatus>();
  for (const s of useAppStore.getState().sessions) {
    lastStatus.set(s.id, s.status);
  }

  return useAppStore.subscribe((state) => {
    const sessions: Session[] = state.sessions;
    const store = useAppStore.getState();

    for (const s of sessions) {
      const prev = lastStatus.get(s.id);
      lastStatus.set(s.id, s.status);
      if (prev === undefined) continue;
      if (state.silencedSessionIds[s.id]) continue;

      const kind = notificationKindForTransition(prev, s.status);
      if (!kind) continue;
      if (isSessionFocused(s.id, state.activeSessionId)) {
        markSessionNotificationsRead(s.id);
        continue;
      }
      store.addSessionNotification(buildInboxNotification(s, prev, kind));
    }

    const known = new Set(sessions.map((s) => s.id));
    for (const id of lastStatus.keys()) {
      if (!known.has(id)) lastStatus.delete(id);
    }
  });
}

function projectNameFor(session: Session): string {
  const projects = useAppStore.getState().projects;
  const match = projects.find((p) => p.repo_path === session.repo_path);
  if (match) return match.name;
  return session.repo_path.split("/").pop() || session.repo_path;
}

function buildInboxNotification(
  session: Session,
  previousStatus: SessionStatus,
  kind: SessionNotificationKind,
): SessionNotification {
  const createdAt = new Date().toISOString();
  inboxNotificationCounter += 1;
  return {
    id: `${createdAt}:${inboxNotificationCounter}:${session.id}:${kind}`,
    sessionId: session.id,
    kind,
    status: session.status,
    previousStatus,
    sessionName: session.name,
    projectName: projectNameFor(session),
    repoPath: session.repo_path,
    createdAt,
  };
}

async function fire(
  session: Session,
  next: SessionStatus,
): Promise<void> {
  if (useAppStore.getState().silencedSessionIds[session.id]) return;
  const ok = await ensurePermission();
  if (!ok || useAppStore.getState().silencedSessionIds[session.id]) return;
  try {
    sendNotification({
      title: `${projectNameFor(session)} — ${session.name}`,
      body: STATUS_SENTENCE[next],
      extra: { sessionId: session.id },
    });
  } catch (err) {
    console.error("[notifications] sendNotification failed", err);
  }
}

/**
 * Registers a listener that fires when the user clicks a session-status
 * notification we sent. Each notification carries the originating session id
 * in its `extra` payload so the handler can route focus directly to that
 * session — bringing the app window forward, switching workspaces if the
 * session lives in a different project, and selecting the tab.
 *
 * Returns a cleanup function. Designed to run once at app boot. The Tauri
 * plugin only delivers click events while a listener is attached, so the
 * caller must keep this registration alive for the lifetime of the app.
 */
export async function startNotificationClickHandler(): Promise<() => void> {
  let disposed = false;
  const listener = await onAction((notification) => {
    if (disposed) return;
    const sessionId =
      typeof notification.extra?.sessionId === "string"
        ? notification.extra.sessionId
        : null;
    if (!sessionId) return;
    const win = getCurrentWindow();
    void win.show();
    void win.unminimize();
    void win.setFocus();
    useAppStore.getState().openSessionSurface(sessionId);
    markSessionNotificationsRead(sessionId);
  });
  return () => {
    disposed = true;
    listener.unregister();
  };
}

/**
 * Send a one-off "this is a test" system notification, surfaced from the
 * Notifications settings tab so the user can confirm the OS-level
 * permission and sound/visibility plumbing works without waiting for a
 * real session-status transition. Returns the resolved status:
 *
 * - `"sent"`  — fire-and-forget succeeded
 * - `"denied"` — the OS rejected (or the user dismissed) the permission prompt
 * - `"error"` — `sendNotification` threw; details are logged to the console
 */
export async function sendTestNotification(): Promise<"sent" | "denied" | "error"> {
  const ok = await refreshPermission();
  if (!ok) return "denied";
  try {
    sendNotification({
      title: "Acorn — test notification",
      body: "If you can see this, system notifications are working.",
    });
    return "sent";
  } catch (err) {
    console.error("[notifications] test sendNotification failed", err);
    return "error";
  }
}
