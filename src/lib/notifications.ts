import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useAppStore } from "../store";
import { useSettings } from "./settings";
import type { Session, SessionStatus } from "./types";

const NOTIFY_LABEL: Record<SessionStatus, string> = {
  idle: "is idle",
  running: "is running",
  needs_input: "needs your input",
  failed: "failed",
  completed: "completed",
};

let permissionPromise: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
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
  })();
  return permissionPromise;
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
      void fire(s);
    }

    // Drop entries for sessions that no longer exist so the map stays bounded.
    const known = new Set(sessions.map((s) => s.id));
    for (const id of lastStatus.keys()) {
      if (!known.has(id)) lastStatus.delete(id);
    }
  });
}

async function fire(session: Session): Promise<void> {
  const ok = await ensurePermission();
  if (!ok) return;
  try {
    sendNotification({
      title: `Acorn — ${session.name}`,
      body: NOTIFY_LABEL[session.status],
    });
  } catch (err) {
    console.error("[notifications] sendNotification failed", err);
  }
}
