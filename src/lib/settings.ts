import { create } from "zustand";

const STORAGE_KEY = "acorn:settings:v1";

/**
 * Catalog of AI agents acorn knows how to spawn. The user picks ONE
 * `selected` agent under Settings → Agents; that choice powers every AI
 * feature in the app (Sessions startup's Agent mode, the merge dialog's
 * "Generate with AI" button, …). Each agent has its own invocation
 * conventions for interactive PTY use and one-shot stdin/stdout use,
 * captured in `agentInteractiveCommand` / `agentOneshotCommand` below.
 */
export type AgentProvider = "claude" | "gemini" | "ollama" | "llm" | "codex";

/** Agent selection accepts every catalogued agent plus an arbitrary custom
 *  command for tools that don't fit the catalog. */
export type SelectedAgent = AgentProvider | "custom";

export const AGENT_OPTIONS: ReadonlyArray<{
  value: AgentProvider;
  label: string;
  /** One-shot invocation hint shown in Settings. */
  oneshotHint: string;
  /** Interactive PTY invocation hint shown in Settings. */
  interactiveHint: string;
}> = [
  {
    value: "claude",
    label: "Claude Code",
    oneshotHint: "claude -p --output-format text",
    interactiveHint: "claude",
  },
  {
    value: "gemini",
    label: "Gemini CLI",
    oneshotHint: "gemini -p",
    interactiveHint: "gemini",
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    oneshotHint: "ollama run <model>",
    interactiveHint: "ollama run <model>",
  },
  {
    value: "llm",
    label: "llm CLI",
    oneshotHint: "llm [-m <model>]",
    interactiveHint: "llm chat [-m <model>]",
  },
  {
    value: "codex",
    label: "OpenAI Codex CLI",
    oneshotHint: "codex (interactive only)",
    interactiveHint: "codex",
  },
];

export type { SessionStartupMode } from "./types";
import type { SessionStartupMode } from "./types";

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
  /**
   * The single AI agent acorn uses everywhere: Sessions startup (when
   * mode === "agent"), the merge dialog's "Generate with AI" button, and
   * any future AI-powered features. Per-agent options (Ollama / llm
   * model strings) live alongside so changing them once updates every
   * call site.
   */
  agents: {
    selected: SelectedAgent;
    /**
     * Used when `selected === "custom"`. Whitespace-separated; no shell
     * expansion. The same string powers both interactive (Sessions) and
     * one-shot (commit message) invocations — empty falls back to
     * Claude Code in both cases.
     */
    customCommand: string;
    ollama: { model: string };
    llm: { model: string };
  };
  sessionStartup: {
    mode: SessionStartupMode;
    /**
     * Used when `mode === "custom"`. Independent from
     * `agents.customCommand` because session startup launches a long-
     * lived PTY (your shell of choice), which has different needs from
     * the AI one-shot command.
     */
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
    fontWeight: 400,
    fontWeightBold: 700,
  },
  agents: {
    selected: "claude",
    customCommand: "",
    ollama: { model: "" },
    llm: { model: "" },
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
};

const VALID_WEIGHTS = new Set<TerminalFontWeight>([
  100, 200, 300, 400, 500, 600, 700, 800, 900,
]);

const VALID_AGENTS = new Set<AgentProvider>([
  "claude",
  "gemini",
  "ollama",
  "llm",
  "codex",
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

function normalizeSelectedAgent(
  v: unknown,
  fallback: SelectedAgent,
): SelectedAgent {
  if (
    typeof v === "string" &&
    (VALID_AGENTS.has(v as AgentProvider) || v === "custom")
  ) {
    return v as SelectedAgent;
  }
  return fallback;
}

/**
 * v1 commitMessage block from the multi-provider commit-message PR. The
 * loader below lifts every field up into the new `agents.*` block so a
 * single agent selection drives every AI feature.
 */
interface LegacyCommitMessage {
  agent?: string;
  provider?: string;
  customCommand?: string;
  ollamaModel?: string;
  llmModel?: string;
}

function loadSettings(): AcornSettings {
  if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as
      | (Partial<AcornSettings> & { commitMessage?: LegacyCommitMessage })
      | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    const terminalRaw: Partial<AcornSettings["terminal"]> = parsed.terminal ?? {};

    // Sessions startup migration: legacy `mode === "claude"` collapses
    // into the new agent-mode + global selected agent.
    const startupRaw = (parsed.sessionStartup ?? {}) as {
      mode?: string;
      customCommand?: string;
    };
    const legacyClaudeMode = startupRaw.mode === "claude";
    const startupMode: SessionStartupMode = legacyClaudeMode
      ? "agent"
      : startupRaw.mode === "agent" ||
          startupRaw.mode === "terminal" ||
          startupRaw.mode === "custom"
        ? startupRaw.mode
        : DEFAULT_SETTINGS.sessionStartup.mode;

    // Agents migration: prefer existing `agents` block, otherwise lift
    // values from the v1 `commitMessage` block, otherwise fall back to
    // a Claude default. Legacy `mode === "claude"` also seeds
    // `selected` if nothing else has set it.
    const agentsRaw = (parsed.agents ?? {}) as {
      selected?: string;
      customCommand?: string;
      ollama?: { model?: string };
      llm?: { model?: string };
    };
    const commitRaw: LegacyCommitMessage = parsed.commitMessage ?? {};
    const legacySelected =
      commitRaw.agent ?? commitRaw.provider ?? undefined;
    const selected = normalizeSelectedAgent(
      agentsRaw.selected ??
        legacySelected ??
        (legacyClaudeMode ? "claude" : DEFAULT_SETTINGS.agents.selected),
      DEFAULT_SETTINGS.agents.selected,
    );
    const customCommand =
      agentsRaw.customCommand ??
      commitRaw.customCommand ??
      DEFAULT_SETTINGS.agents.customCommand;
    const ollamaModel =
      agentsRaw.ollama?.model ??
      commitRaw.ollamaModel ??
      DEFAULT_SETTINGS.agents.ollama.model;
    const llmModel =
      agentsRaw.llm?.model ??
      commitRaw.llmModel ??
      DEFAULT_SETTINGS.agents.llm.model;

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
      agents: {
        selected,
        customCommand,
        ollama: { model: ollamaModel },
        llm: { model: llmModel },
      },
      sessionStartup: {
        mode: startupMode,
        customCommand:
          startupRaw.customCommand ??
          DEFAULT_SETTINGS.sessionStartup.customCommand,
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
  patchAgents: (
    patch: Partial<{
      selected: SelectedAgent;
      customCommand: string;
      ollama: Partial<AcornSettings["agents"]["ollama"]>;
      llm: Partial<AcornSettings["agents"]["llm"]>;
    }>,
  ) => void;
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
  patchAgents: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        agents: {
          ...s.settings.agents,
          ...(patch.selected !== undefined ? { selected: patch.selected } : {}),
          ...(patch.customCommand !== undefined
            ? { customCommand: patch.customCommand }
            : {}),
          ollama: { ...s.settings.agents.ollama, ...(patch.ollama ?? {}) },
          llm: { ...s.settings.agents.llm, ...(patch.llm ?? {}) },
        },
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

interface ResolvedCommand {
  command: string;
  args: string[];
}

/**
 * Interactive PTY invocation for an agent. Used by Sessions startup when
 * mode === "agent". Each provider's CLI launches into a chat/REPL loop.
 */
function agentInteractiveCommand(
  agent: AgentProvider,
  agents: AcornSettings["agents"],
): ResolvedCommand {
  switch (agent) {
    case "claude":
      return { command: "claude", args: [] };
    case "gemini":
      return { command: "gemini", args: [] };
    case "codex":
      return { command: "codex", args: [] };
    case "ollama": {
      const model = agents.ollama.model.trim() || "llama3";
      return { command: "ollama", args: ["run", model] };
    }
    case "llm": {
      const model = agents.llm.model.trim();
      return model
        ? { command: "llm", args: ["chat", "-m", model] }
        : { command: "llm", args: ["chat"] };
    }
  }
}

/**
 * One-shot stdin → stdout invocation for an agent. Used by the merge
 * dialog's "Generate with AI" action. Codex has no documented headless
 * mode here, so users who need codex specifically should select Custom
 * and supply their own one-shot incantation.
 */
function agentOneshotCommand(
  agent: AgentProvider,
  agents: AcornSettings["agents"],
): ResolvedCommand {
  switch (agent) {
    case "claude":
      return { command: "claude", args: ["-p", "--output-format", "text"] };
    case "gemini":
      return { command: "gemini", args: ["-p"] };
    case "codex":
      return { command: "codex", args: [] };
    case "ollama": {
      const model = agents.ollama.model.trim() || "llama3";
      return { command: "ollama", args: ["run", model] };
    }
    case "llm": {
      const model = agents.llm.model.trim();
      return model
        ? { command: "llm", args: ["-m", model] }
        : { command: "llm", args: [] };
    }
  }
}

function tokenizeCustom(raw: string): ResolvedCommand | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

/**
 * Resolve the command (and args) used to spawn a session's PTY based on
 * the current `sessionStartup` setting.
 *
 * - `terminal` → empty command; the Rust pty_spawn falls back to `$SHELL`
 * - `agent`    → globally selected agent's interactive invocation, or
 *                the agent custom command when selected === "custom"
 * - `custom`   → sessionStartup.customCommand (separate from the agent
 *                custom command), falls back to terminal when blank
 *
 * `modeOverride` lets a per-session preference (persisted on `Session`)
 * win over the global setting so changing `sessionStartup.mode` does not
 * retroactively swap the startup of existing sessions on respawn. `null`
 * or `undefined` means "no per-session preference" → use the global.
 */
export function resolveStartupCommand(
  s: AcornSettings,
  modeOverride?: SessionStartupMode | null,
): ResolvedCommand {
  const mode = modeOverride ?? s.sessionStartup.mode;
  if (mode === "agent") {
    if (s.agents.selected === "custom") {
      return (
        tokenizeCustom(s.agents.customCommand) ??
        agentInteractiveCommand("claude", s.agents)
      );
    }
    return agentInteractiveCommand(s.agents.selected, s.agents);
  }
  if (mode === "custom") {
    return tokenizeCustom(s.sessionStartup.customCommand) ?? {
      command: "",
      args: [],
    };
  }
  return { command: "", args: [] };
}

/**
 * Resolve the AI CLI invocation for the merge dialog's "Generate with AI"
 * action. The resolved value is sent to the Rust backend as
 * `(command, args)` so the backend stays provider-agnostic.
 */
export function resolveAiCommitCommand(s: AcornSettings): ResolvedCommand {
  if (s.agents.selected === "custom") {
    return (
      tokenizeCustom(s.agents.customCommand) ??
      agentOneshotCommand("claude", s.agents)
    );
  }
  return agentOneshotCommand(s.agents.selected, s.agents);
}

/**
 * Human-friendly label for the global agent selection. Used by the merge
 * dialog tooltip and the Sessions tab description so the user sees at a
 * glance which CLI will run before clicking Generate or starting a
 * session.
 */
export function selectedAgentLabel(s: AcornSettings): string {
  if (s.agents.selected === "custom") return "Custom command";
  return (
    AGENT_OPTIONS.find((o) => o.value === s.agents.selected)?.label ?? "AI"
  );
}

/** Backwards-compat alias for callers that still read this name. */
export const aiCommitProviderLabel = selectedAgentLabel;
