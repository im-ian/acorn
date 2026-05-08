import { create } from "zustand";

const STORAGE_KEY = "acorn:settings:v1";

export type SessionStartupMode = "claude" | "terminal" | "custom";

/**
 * AI CLI used by "Generate with AI" in the merge dialog. The actual command
 * + argv is resolved via `resolveAiCommitCommand` so each provider's
 * invocation conventions live in one place. All providers must follow the
 * `stdin = prompt, stdout = response` convention.
 */
export type AiCommitProvider =
  | "claude"
  | "gemini"
  | "ollama"
  | "llm"
  | "custom";

export const AI_COMMIT_PROVIDER_OPTIONS: ReadonlyArray<{
  value: AiCommitProvider;
  label: string;
  hint: string;
}> = [
  {
    value: "claude",
    label: "Claude Code",
    hint: "claude -p --output-format text",
  },
  { value: "gemini", label: "Gemini CLI", hint: "gemini -p" },
  {
    value: "ollama",
    label: "Ollama (local)",
    hint: "ollama run <model>",
  },
  {
    value: "llm",
    label: "Simon Willison's llm",
    hint: "llm [-m <model>]",
  },
  {
    value: "custom",
    label: "Custom command",
    hint: "Whitespace-separated, no shell expansion",
  },
];

export type TerminalFontWeight =
  | 100
  | 200
  | 300
  | 400
  | 500
  | 600
  | 700
  | 800
  | 900;

export const TERMINAL_FONT_WEIGHTS: ReadonlyArray<{
  value: TerminalFontWeight;
  label: string;
}> = [
  { value: 100, label: "100 — Thin" },
  { value: 200, label: "200 — Extra Light" },
  { value: 300, label: "300 — Light" },
  { value: 400, label: "400 — Normal" },
  { value: 500, label: "500 — Medium" },
  { value: 600, label: "600 — Semi Bold" },
  { value: 700, label: "700 — Bold" },
  { value: 800, label: "800 — Extra Bold" },
  { value: 900, label: "900 — Black" },
];

export interface AcornSettings {
  terminal: {
    fontFamily: string;
    fontSize: number;
    fontWeight: TerminalFontWeight;
    fontWeightBold: TerminalFontWeight;
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
  commitMessage: {
    /** Which AI CLI handles "Generate with AI" in the merge dialog. */
    provider: AiCommitProvider;
    /** Model name for `ollama run <model>`. Falls back to `llama3` when blank. */
    ollamaModel: string;
    /** Optional `-m <model>` arg for the `llm` CLI. Empty = use llm default. */
    llmModel: string;
    /**
     * Used when `provider === "custom"`. Whitespace-separated; no shell
     * expansion. Empty = fall back to claude.
     */
    customCommand: string;
  };
}

export const DEFAULT_SETTINGS: AcornSettings = {
  terminal: {
    fontFamily:
      '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    fontWeight: 400,
    fontWeightBold: 700,
  },
  sessionStartup: {
    mode: "terminal",
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
  commitMessage: {
    provider: "claude",
    ollamaModel: "",
    llmModel: "",
    customCommand: "",
  },
};

const VALID_WEIGHTS = new Set<TerminalFontWeight>([
  100, 200, 300, 400, 500, 600, 700, 800, 900,
]);

function normalizeWeight(
  v: unknown,
  fallback: TerminalFontWeight,
): TerminalFontWeight {
  if (typeof v === "number" && VALID_WEIGHTS.has(v as TerminalFontWeight)) {
    return v as TerminalFontWeight;
  }
  return fallback;
}

function loadSettings(): AcornSettings {
  if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AcornSettings> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    const terminalRaw: Partial<AcornSettings["terminal"]> = parsed.terminal ?? {};
    return {
      terminal: {
        ...DEFAULT_SETTINGS.terminal,
        ...terminalRaw,
        fontWeight: normalizeWeight(
          terminalRaw.fontWeight,
          DEFAULT_SETTINGS.terminal.fontWeight,
        ),
        fontWeightBold: normalizeWeight(
          terminalRaw.fontWeightBold,
          DEFAULT_SETTINGS.terminal.fontWeightBold,
        ),
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
      commitMessage: {
        ...DEFAULT_SETTINGS.commitMessage,
        ...(parsed.commitMessage ?? {}),
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
  patchCommitMessage: (
    patch: Partial<AcornSettings["commitMessage"]>,
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
  patchCommitMessage: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        commitMessage: { ...s.settings.commitMessage, ...patch },
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
 * - `terminal` → empty string; the Rust pty_spawn falls back to `$SHELL`
 * - `claude`   → `claude` binary
 * - `custom`   → user-provided command, falls back to terminal when blank
 */
export function resolveStartupCommand(s: AcornSettings): {
  command: string;
  args: string[];
} {
  if (s.sessionStartup.mode === "claude") {
    return { command: "claude", args: [] };
  }
  if (s.sessionStartup.mode === "custom") {
    const trimmed = s.sessionStartup.customCommand.trim();
    if (!trimmed) return { command: "", args: [] };
    // Light tokenisation: split on whitespace, no shell interpretation.
    const parts = trimmed.split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  }
  return { command: "", args: [] };
}

/**
 * Resolve the AI CLI invocation for the merge dialog's "Generate with AI"
 * action. Each provider has its own argv convention; `custom` lets the user
 * plug in anything that follows the standard `stdin = prompt, stdout =
 * response` shape. The resolved value is sent to the Rust backend as
 * `(command, args)` so the backend stays provider-agnostic.
 */
export function resolveAiCommitCommand(s: AcornSettings): {
  command: string;
  args: string[];
} {
  const c = s.commitMessage;
  switch (c.provider) {
    case "claude":
      return { command: "claude", args: ["-p", "--output-format", "text"] };
    case "gemini":
      return { command: "gemini", args: ["-p"] };
    case "ollama": {
      const model = c.ollamaModel.trim() || "llama3";
      return { command: "ollama", args: ["run", model] };
    }
    case "llm": {
      const model = c.llmModel.trim();
      return model
        ? { command: "llm", args: ["-m", model] }
        : { command: "llm", args: [] };
    }
    case "custom": {
      const trimmed = c.customCommand.trim();
      if (!trimmed) {
        // Empty custom falls back to claude so the button still does
        // something predictable rather than failing with "No AI command".
        return { command: "claude", args: ["-p", "--output-format", "text"] };
      }
      const parts = trimmed.split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    }
  }
}

/**
 * Human-friendly label for the currently configured AI provider — used in
 * the merge dialog's tooltip ("Generate via Claude Code", "Generate via
 * Ollama", etc.) so the user can see at a glance which CLI will run.
 */
export function aiCommitProviderLabel(s: AcornSettings): string {
  const opt = AI_COMMIT_PROVIDER_OPTIONS.find(
    (o) => o.value === s.commitMessage.provider,
  );
  return opt?.label ?? "AI";
}
