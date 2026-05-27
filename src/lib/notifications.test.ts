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
  listNotificationHistory,
  resetNotificationsForTests,
  startSessionNotificationWatcher,
} from "./notifications";
import { DEFAULT_SETTINGS, useSettings } from "./settings";
import { useAppStore } from "../store";

const BASE_SESSION: Session = {
  id: "session-1",
  name: "Agent",
  repo_path: "/repo/acorn",
  worktree_path: "/repo/acorn",
  branch: "main",
  isolated: false,
  status: "running",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_message: null,
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
      projects: [{ repo_path: "/repo/acorn", name: "acorn", created_at: "", position: 0 }],
      activeSessionId: null,
    });
    useSettings.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      open: false,
      pendingTab: null,
    });
  });

  it("sends a status notification for an unfocused session transition", async () => {
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
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
    expect(listNotificationHistory()).toMatchObject([
      {
        sessionId: "session-1",
        status: "needs_input",
        readAt: null,
      },
    ]);
    dispose();
  });

  it("marks a focused session transition read instead of sending a notification", async () => {
    useAppStore.setState({ activeSessionId: "session-1" });
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(listNotificationHistory()).toMatchObject([
      {
        sessionId: "session-1",
        status: "needs_input",
      },
    ]);
    expect(listNotificationHistory()[0]?.readAt).toEqual(expect.any(String));
    dispose();
  });

  it("allows a later unread transition after the session leaves the read status", async () => {
    useAppStore.setState({ activeSessionId: "session-1" });
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    useAppStore.setState({
      activeSessionId: null,
      sessions: [
        session({
          status: "running",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Awaiting your next input.",
        extra: { sessionId: "session-1" },
      }),
    );
    dispose();
  });

  it("trims notification history to the configured maximum", async () => {
    useSettings.getState().patchNotifications({ maxHistory: 2 });
    const dispose = startSessionNotificationWatcher();

    for (let i = 1; i <= 3; i += 1) {
      useAppStore.setState({
        sessions: [
          session({
            status: "needs_input",
            updated_at: `2026-01-01T00:0${i}:00Z`,
          }),
        ],
      });
      useAppStore.setState({
        sessions: [
          session({
            status: "running",
            updated_at: `2026-01-01T00:0${i}:30Z`,
          }),
        ],
      });
    }
    await flushPromises();

    expect(listNotificationHistory()).toHaveLength(2);
    dispose();
  });

  it("deletes read history entries when auto-delete read notifications is enabled", async () => {
    useSettings
      .getState()
      .patchNotifications({ autoDeleteRead: true });
    useAppStore.setState({ activeSessionId: "session-1" });
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    expect(listNotificationHistory()).toHaveLength(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    dispose();
  });

  it("drops history for sessions that disappear after a clean session load", async () => {
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();
    expect(listNotificationHistory()).toHaveLength(1);

    useAppStore.setState({
      sessions: [],
      sessionsLoadedCleanly: true,
    });

    expect(listNotificationHistory()).toHaveLength(0);
    dispose();
  });

  it("keeps history when the session list is not known to be clean", async () => {
    const dispose = startSessionNotificationWatcher();

    useAppStore.setState({
      sessions: [
        session({
          status: "needs_input",
          updated_at: "2026-01-01T00:01:00Z",
        }),
      ],
    });
    await flushPromises();

    useAppStore.setState({
      sessions: [],
      sessionsLoadedCleanly: false,
    });

    expect(listNotificationHistory()).toHaveLength(1);
    dispose();
  });
});
