import { create } from "zustand";

const STORAGE_KEY = "acorn:settings:v1";

export type SessionStartupMode = "claude" | "terminal" | "custom";

export interface AcornSettings {
  terminal: {
    fontFamily: string;
    fontSize: number;
  };
  sessionStartup: {
    mode: SessionStartupMode;
    /** Used when `mode === "custom"`. Empty string falls back to claude. */
    customCommand: string;
  };
  sessions: {
    /**
     * Show the confirmation dialog before removing a non-isolated session.
     * Isolated worktrees always prompt because the worktree-deletion choice
     * matters. Set false to skip the prompt for plain sessions.
     */
    confirmRemove: boolean;
  };
  editor: {
    /**
     * External command used by the "Open in editor" action.
     * Whitespace-separated args supported (e.g. `"code --wait"`). Empty
     * string falls back to the OS default association via Tauri opener.
     */
    command: string;
  };
  notifications: {
    enabled: boolean;
    events: {
      needsInput: boolean;
      failed: boolean;
      completed: boolean;
    };
  };
}

export const DEFAULT_SETTINGS: AcornSettings = {
  terminal: {
    fontFamily:
      '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
  },
  sessionStartup: {
    mode: "claude",
    customCommand: "",
  },
  sessions: {
    confirmRemove: true,
  },
  editor: {
    command: "",
  },
  notifications: {
    enabled: true,
    events: {
      needsInput: true,
      failed: true,
      completed: false,
    },
  },
};

function loadSettings(): AcornSettings {
  if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AcornSettings> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
      terminal: {
        ...DEFAULT_SETTINGS.terminal,
        ...(parsed.terminal ?? {}),
      },
      sessionStartup: {
        ...DEFAULT_SETTINGS.sessionStartup,
        ...(parsed.sessionStartup ?? {}),
      },
      sessions: {
        ...DEFAULT_SETTINGS.sessions,
        ...(parsed.sessions ?? {}),
      },
      editor: {
        ...DEFAULT_SETTINGS.editor,
        ...(parsed.editor ?? {}),
      },
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        ...(parsed.notifications ?? {}),
        events: {
          ...DEFAULT_SETTINGS.notifications.events,
          ...(parsed.notifications?.events ?? {}),
        },
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(value: AcornSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore (storage quota / private mode)
  }
}

interface SettingsState {
  settings: AcornSettings;
  open: boolean;
  setOpen: (v: boolean) => void;
  patchTerminal: (patch: Partial<AcornSettings["terminal"]>) => void;
  patchSessionStartup: (
    patch: Partial<AcornSettings["sessionStartup"]>,
  ) => void;
  patchSessions: (patch: Partial<AcornSettings["sessions"]>) => void;
  patchEditor: (patch: Partial<AcornSettings["editor"]>) => void;
  patchNotifications: (
    patch: Partial<Omit<AcornSettings["notifications"], "events">> & {
      events?: Partial<AcornSettings["notifications"]["events"]>;
    },
  ) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: loadSettings(),
  open: false,
  setOpen: (v) => set({ open: v }),
  patchTerminal: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        terminal: { ...s.settings.terminal, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchSessionStartup: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        sessionStartup: { ...s.settings.sessionStartup, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchSessions: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        sessions: { ...s.settings.sessions, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchEditor: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        editor: { ...s.settings.editor, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchNotifications: (patch) =>
    set((s) => {
      const events = patch.events
        ? { ...s.settings.notifications.events, ...patch.events }
        : s.settings.notifications.events;
      const { events: _ignored, ...rest } = patch;
      const next: AcornSettings = {
        ...s.settings,
        notifications: {
          ...s.settings.notifications,
          ...rest,
          events,
        },
      };
      persist(next);
      return { settings: next };
    }),
  reset: () => {
    persist(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
  },
}));

/**
 * Resolve the command (and args) used to spawn a session's PTY based on the
 * current `sessionStartup` setting.
 *
 * - `claude` → `claude` binary
 * - `terminal` → empty string; the Rust pty_spawn falls back to `$SHELL`
 * - `custom` → user-provided command, falls back to claude when blank
 */
export function resolveStartupCommand(s: AcornSettings): {
  command: string;
  args: string[];
} {
  if (s.sessionStartup.mode === "terminal") return { command: "", args: [] };
  if (s.sessionStartup.mode === "custom") {
    const trimmed = s.sessionStartup.customCommand.trim();
    if (!trimmed) return { command: "claude", args: [] };
    // Light tokenisation: split on whitespace, no shell interpretation.
    const parts = trimmed.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  return { command: "claude", args: [] };
}
