import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./types";

const mocks = vi.hoisted(() => ({
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  onAction: vi.fn(),
  requestPermission: vi.fn<() => Promise<NotificationPermission>>(),
  sendNotification: vi.fn(),
  show: vi.fn<() => Promise<void>>(),
  unminimize: vi.fn<() => Promise<void>>(),
  setFocus: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  onAction: mocks.onAction,
  requestPermission: mocks.requestPermission,
  sendNotification: mocks.sendNotification,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: mocks.show,
    unminimize: mocks.unminimize,
    setFocus: mocks.setFocus,
  }),
}));

import {
  resetNotificationsForTests,
  startFocusedSessionNotificationReadWatcher,
  startNotificationClickHandler,
  startSessionActivityInboxWatcher,
  startSessionNotificationWatcher,
} from "./notifications";
import { DEFAULT_SETTINGS, useSettings } from "./settings";
import { useAppStore } from "../store";

const originalOpenSessionSurface = useAppStore.getState().openSessionSurface;

const BASE_SESSION: Session = {
  id: "session-1",
  name: "Agent",
  repo_path: "/repo/acorn",
  worktree_path: "/repo/acorn",
  branch: "main",
  isolated: false,
  status: "working",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_message: null,
  title_source: "default",
  kind: "regular",
  owner: { kind: "user" },
  position: null,
  in_worktree: false,
  agent_provider: "codex",
};

function session(patch: Partial<Session> = {}): Session {
  return { ...BASE_SESSION, ...patch };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("notifications", () => {
  beforeEach(() => {
    resetNotificationsForTests();
    vi.clearAllMocks();
    mocks.isPermissionGranted.mockResolvedValue(true);
    mocks.requestPermission.mockResolvedValue("granted");
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    useAppStore.setState({
      sessions: [session()],
      projects: [
        {
          repo_path: "/repo/acorn",
          name: "acorn",
          created_at: "",
          position: 0,
        },
      ],
      activeSessionId: null,
      openSessionSurface: originalOpenSessionSurface,
      sessionNotifications: [],
      silencedSessionIds: {},
      sessionsLoadedCleanly: true,
    });
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      open: false,
      pendingTab: null,
    });
  });

  it("sends a system notification for an unfocused session transition", async () => {
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "acorn — Agent",
        body: "Awaiting your next input.",
        extra: { sessionId: "session-1" },
      }),
    );
    dispose();
  });

  it("opens the destination session surface when a system notification is clicked", async () => {
    const unregister = vi.fn();
    mocks.onAction.mockResolvedValue({ unregister });
    const openSessionSurface = vi.fn(() => true);
    useAppStore.setState({ openSessionSurface });

    const dispose = await startNotificationClickHandler();
    const handleAction = mocks.onAction.mock.calls[0]?.[0] as
      | ((notification: { extra?: Record<string, unknown> }) => void)
      | undefined;
    expect(handleAction).toBeDefined();
    if (!handleAction) throw new Error("notification action handler missing");

    handleAction({ extra: { sessionId: "session-1" } });

    expect(openSessionSurface).toHaveBeenCalledWith("session-1", {
      centerInCanvas: true,
    });
    expect(mocks.show).toHaveBeenCalled();
    expect(mocks.unminimize).toHaveBeenCalled();
    expect(mocks.setFocus).toHaveBeenCalled();

    dispose();
    expect(unregister).toHaveBeenCalled();
  });

  it("marks a focused session transition read instead of sending a system notification", async () => {
    useAppStore.setState({ activeSessionId: "session-1" });
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    dispose();
  });

  it("records in-app activity for an unfocused session transition", async () => {
    const dispose = startSessionActivityInboxWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });

    expect(useAppStore.getState().sessionNotifications).toMatchObject([
      {
        sessionId: "session-1",
        status: "waiting_for_input",
      },
    ]);
    expect(useAppStore.getState().sessionNotifications[0]?.readAt).toBeUndefined();
    dispose();
  });

  it("does not record ready transitions as activity", () => {
    const dispose = startSessionActivityInboxWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "ready",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });

    expect(useAppStore.getState().sessionNotifications).toEqual([]);
    dispose();
  });

  it("suppresses system notifications and activity while a session is silenced", async () => {
    useAppStore.setState({
      silencedSessionIds: { "session-1": true },
    });
    const disposeSystem = startSessionNotificationWatcher();
    const disposeActivity = startSessionActivityInboxWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessionNotifications).toEqual([]);

    useAppStore.getState().setSessionSilenced("session-1", false);
    useAppStore.setState({
      sessions: [
        session({
          status: "working",
          updated_at: "2026-01-01T00:02:00Z",
        }),
      ],
    });
    useAppStore.setState({
      sessions: [
        session({
          status: "errored",
          updated_at: "2026-01-01T00:03:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sessionNotifications).toMatchObject([
      {
        sessionId: "session-1",
        kind: "errored",
      },
    ]);
    disposeSystem();
    disposeActivity();
  });

  it("does not record in-app activity for the focused session transition", () => {
    useAppStore.setState({ activeSessionId: "session-1" });
    const dispose = startSessionActivityInboxWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });

    expect(useAppStore.getState().sessionNotifications).toEqual([]);
    dispose();
  });

  it("records in-app activity for the active session when the app is not focused", () => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    useAppStore.setState({ activeSessionId: "session-1" });
    const dispose = startSessionActivityInboxWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });

    expect(useAppStore.getState().sessionNotifications).toMatchObject([
      {
        sessionId: "session-1",
        status: "waiting_for_input",
      },
    ]);
    dispose();
  });

  it("coalesces repeated needs-input activity for the same session", () => {
    const dispose = startSessionActivityInboxWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    const firstId = useAppStore.getState().sessionNotifications[0]?.id;
    expect(firstId).toBeTruthy();

    useAppStore.getState().markSessionNotificationRead(firstId!);
    useAppStore.setState({
      sessions: [
        session({
          status: "working",
          updated_at: "2026-01-01T00:01:30Z",
        }),
      ],
    });
    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:02:00Z",
        }),
      ],
    });

    const notifications = useAppStore.getState().sessionNotifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.id).not.toBe(firstId);
    expect(notifications[0]?.readAt).toBeUndefined();
    dispose();
  });

  it("marks in-app activity read when its session tab is focused and auto-delete is disabled", async () => {
    useSettings.getState().patchNotifications({ autoDeleteRead: false });
    const disposeActivity = startSessionActivityInboxWatcher();
    const disposeFocusedRead = startFocusedSessionNotificationReadWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    useAppStore.setState({ activeSessionId: "session-1" });

    const [notification] = useAppStore.getState().sessionNotifications;
    expect(notification).toMatchObject({
      sessionId: "session-1",
      status: "waiting_for_input",
    });
    expect(notification?.readAt).toEqual(expect.any(String));
    disposeActivity();
    disposeFocusedRead();
  });

  it("trims in-app activity to the configured maximum", () => {
    useSettings.getState().patchNotifications({ maxHistory: 2 });
    useAppStore.setState({
      sessions: [
        session({ id: "session-1", name: "Agent 1" }),
        session({ id: "session-2", name: "Agent 2" }),
        session({ id: "session-3", name: "Agent 3" }),
      ],
    });
    const dispose = startSessionActivityInboxWatcher();

    for (let i = 1; i <= 3; i += 1) {
      const id = `session-${i}`;
      useAppStore.setState({
        sessions: useAppStore.getState().sessions.map((existing) =>
          existing.id === id
            ? session({
                id,
                name: existing.name,
                status: "waiting_for_input",
                updated_at: `2026-01-01T00:0${i}:00Z`,
              })
            : existing,
        ),
      });
    }

    expect(useAppStore.getState().sessionNotifications).toHaveLength(2);
    dispose();
  });

  it("deletes read in-app activity when auto-delete read notifications is enabled", () => {
    useSettings.getState().patchNotifications({ autoDeleteRead: true });
    const disposeActivity = startSessionActivityInboxWatcher();
    const disposeFocusedRead = startFocusedSessionNotificationReadWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "waiting_for_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    useAppStore.setState({ activeSessionId: "session-1" });

    expect(useAppStore.getState().sessionNotifications).toHaveLength(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    disposeActivity();
    disposeFocusedRead();
  });
});
