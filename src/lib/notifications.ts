import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../store";
import { useSettings } from "./settings";
import type { Session, SessionStatus } from "./types";

// Notification body copy keyed by the status the session transitioned *into*.
// The watcher only fires on transitions to `needs_input` / `failed` /
// `completed`; `idle` / `running` entries are placeholders so the record
// stays exhaustive against `SessionStatus`.
const STATUS_SENTENCE: Record<SessionStatus, string> = {
  idle: "Session is idle.",
  running: "Session is running.",
  needs_input: "Awaiting your next input.",
  failed: "Session failed.",
  completed: "Session complete.",
};

// Cached OS permission result for the steady-state notification path. Reused
// across session-status transitions so we don't pay the IPC round-trip on
// every fire. `null` means "never checked"; subsequent transitions skip the
// check once it has resolved. The test-notification path deliberately bypasses
// this and refreshes the cache so a stale value (e.g. user toggled permission
// in System Settings since boot) gets corrected the moment the user asks
// "does this actually work?".
let cachedPermission: boolean | null = null;

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
  key: "needsInput" | "failed" | "completed" | null;
} {
  if (prev === next) return { notify: false, key: null };
  if (next === "needs_input") return { notify: true, key: "needsInput" };
  if (next === "failed") return { notify: true, key: "failed" };
  if (next === "completed") return { notify: true, key: "completed" };
  return { notify: false, key: null };
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
      const { notify, key } = shouldNotifyTransition(prev, s.status);
      if (!notify || !key || !settings.events[key]) continue;
      void fire(s, s.status);
    }

    // Drop entries for sessions that no longer exist so the map stays bounded.
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

async function fire(
  session: Session,
  next: SessionStatus,
): Promise<void> {
  const ok = await ensurePermission();
  if (!ok) return;
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
    useAppStore.getState().selectSession(sessionId);
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
