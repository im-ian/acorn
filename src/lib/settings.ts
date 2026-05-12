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
import type { PrStateFilter, SessionStartupMode } from "./types";

/**
 * Allowed PRs-tab refresh intervals shown in the Settings UI. Picked to
 * cover the common cases ("snappy", "default", "background-quiet") without
 * exposing a free-form numeric field where users could accidentally hammer
 * `gh` with sub-second polling.
 */
export const PR_REFRESH_INTERVAL_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 15_000, label: "15 seconds" },
  { value: 30_000, label: "30 seconds" },
  { value: 60_000, label: "1 minute (default)" },
  { value: 120_000, label: "2 minutes" },
  { value: 300_000, label: "5 minutes" },
  { value: 600_000, label: "10 minutes" },
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

/**
 * How the terminal activates links. `click` opens on a plain mouse click;
 * `modifier-click` requires the platform-primary modifier (Cmd on macOS,
 * Ctrl elsewhere) so a stray click on a URL in shell output does not yank
 * focus to the browser.
 */
export type TerminalLinkActivation = "click" | "modifier-click";

/**
 * Which field acorn shows as the primary line of a sidebar session row.
 * Mirrors Warp's "Pane title as" picker — `name` is the editable session
 * name (default), the other two surface git/repo metadata directly.
 */
export type SessionTitleSource = "name" | "workingDirectory" | "branch";

export const SESSION_TITLE_OPTIONS: ReadonlyArray<{
  value: SessionTitleSource;
  label: string;
  description: string;
}> = [
  {
    value: "name",
    label: "Session name",
    description: "The editable name you give each session (default).",
  },
  {
    value: "workingDirectory",
    label: "Working directory",
    description: "Worktree directory basename.",
  },
  {
    value: "branch",
    label: "Branch",
    description: "Active git branch.",
  },
];

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
    /**
     * xterm.js cell-height multiplier. 1.0 packs rows flush; 1.2–1.4 adds
     * vertical breathing room for fonts whose intrinsic metrics feel
     * cramped. Range 1.0–2.0 keeps the cursor / link hit boxes sensible.
     */
    lineHeight: number;
    /**
     * Gesture required to follow a URL in terminal output. Plain click is
     * the xterm default; modifier-click matches iTerm2 / Terminal.app so a
     * stray click on output containing a URL doesn't steal focus.
     */
    linkActivation: TerminalLinkActivation;
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
    /**
     * When the session's PTY process exits (e.g. user typed `exit`), close
     * the session tab automatically instead of showing the
     * "[process exited — press Enter to restart]" prompt. The worktree is
     * preserved either way; only the in-app tab is affected.
     */
    closeOnExit: boolean;
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
  /**
   * Toggles for the bottom status bar items. Disabling `showMemory`
   * also short-circuits the memory polling loop in the StatusBar, so it
   * actually reduces the work acorn does — not just hides the readout.
   */
  statusBar: {
    showGithubAccount: boolean;
    showMemory: boolean;
  };
  pullRequests: {
    /** Tab pre-selected when the PRs panel first mounts for a repo. */
    defaultState: PrStateFilter;
    /** Auto-refresh cadence for the PRs tab in milliseconds. */
    refreshIntervalMs: number;
  };
  /**
   * Sidebar session-row presentation. Mirrors Warp's "View as / Pane
   * title as / Additional metadata / Show details on hover" panel so
   * users can pick what each session shows at a glance.
   */
  sessionDisplay: {
    /** Which field becomes the bold first line of the row. */
    title: SessionTitleSource;
    /**
     * Secondary metadata shown beneath the title. Each toggle is
     * independent; status falls back to "Idle" so the row never goes
     * blank when everything is off.
     */
    metadata: {
      branch: boolean;
      workingDirectory: boolean;
      status: boolean;
      /** Relative timestamp (e.g. "2 min ago") derived from updated_at. */
      lastActivity: boolean;
      /** First line of the session's last_message snapshot, truncated. */
      lastMessage: boolean;
    };
    /**
     * Inline icon toggles. Status dot is the colored bullet at row start;
     * sessionKind covers the isolated-worktree (GitBranch) and control
     * (Bot) glyphs trailing the title.
     */
    icons: {
      statusDot: boolean;
      sessionKind: boolean;
    };
    /**
     * When true, hovering a row pops a tooltip with every available
     * field (name, working directory, branch, status) regardless of
     * which ones the row itself shows.
     */
    showDetailsOnHover: boolean;
  };
}

export const DEFAULT_SETTINGS: AcornSettings = {
  terminal: {
    fontFamily:
      '"JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    fontWeight: 400,
    fontWeightBold: 700,
    lineHeight: 1.0,
    linkActivation: "click",
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
    closeOnExit: false,
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
  statusBar: {
    showGithubAccount: true,
    showMemory: true,
  },
  pullRequests: {
    defaultState: "open",
    refreshIntervalMs: 60_000,
  },
  sessionDisplay: {
    title: "name",
    metadata: {
      branch: true,
      workingDirectory: false,
      status: true,
      lastActivity: false,
      lastMessage: false,
    },
    icons: {
      statusDot: true,
      sessionKind: true,
    },
    showDetailsOnHover: true,
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

const VALID_PR_STATES = new Set<PrStateFilter>([
  "open",
  "closed",
  "merged",
  "all",
]);

const VALID_PR_INTERVALS = new Set<number>(
  PR_REFRESH_INTERVAL_OPTIONS.map((o) => o.value),
);

function normalizeLinkActivation(
  v: unknown,
  fallback: TerminalLinkActivation,
): TerminalLinkActivation {
  if (v === "click" || v === "modifier-click") return v;
  return fallback;
}

function normalizeLineHeight(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  // Clamp to the same range the Stepper enforces in the UI so a hand-
  // edited localStorage value can't make the terminal unusable.
  return Math.max(1.0, Math.min(2.0, v));
}

function normalizePrState(v: unknown, fallback: PrStateFilter): PrStateFilter {
  if (typeof v === "string" && VALID_PR_STATES.has(v as PrStateFilter)) {
    return v as PrStateFilter;
  }
  return fallback;
}

function normalizePrInterval(v: unknown, fallback: number): number {
  if (typeof v === "number" && VALID_PR_INTERVALS.has(v)) return v;
  return fallback;
}

const VALID_SESSION_TITLE_SOURCES = new Set<SessionTitleSource>([
  "name",
  "workingDirectory",
  "branch",
]);

function normalizeSessionTitle(
  v: unknown,
  fallback: SessionTitleSource,
): SessionTitleSource {
  if (
    typeof v === "string" &&
    VALID_SESSION_TITLE_SOURCES.has(v as SessionTitleSource)
  ) {
    return v as SessionTitleSource;
  }
  return fallback;
}

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

    // `mode === "claude"` from older storage maps to agent mode with the
    // global selected agent.
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

    // Prefer the `agents` block; fall back to values stored under the older
    // `commitMessage` shape, then to the Claude default. `mode === "claude"`
    // from older storage seeds `selected` when nothing else has set it.
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
        lineHeight: normalizeLineHeight(
          (terminalRaw as { lineHeight?: unknown }).lineHeight,
          DEFAULT_SETTINGS.terminal.lineHeight,
        ),
        linkActivation: normalizeLinkActivation(
          (terminalRaw as { linkActivation?: unknown }).linkActivation,
          DEFAULT_SETTINGS.terminal.linkActivation,
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
      statusBar: {
        ...DEFAULT_SETTINGS.statusBar,
        ...(parsed.statusBar ?? {}),
      },
      pullRequests: {
        defaultState: normalizePrState(
          parsed.pullRequests?.defaultState,
          DEFAULT_SETTINGS.pullRequests.defaultState,
        ),
        refreshIntervalMs: normalizePrInterval(
          parsed.pullRequests?.refreshIntervalMs,
          DEFAULT_SETTINGS.pullRequests.refreshIntervalMs,
        ),
      },
      sessionDisplay: {
        title: normalizeSessionTitle(
          parsed.sessionDisplay?.title,
          DEFAULT_SETTINGS.sessionDisplay.title,
        ),
        metadata: {
          ...DEFAULT_SETTINGS.sessionDisplay.metadata,
          ...(parsed.sessionDisplay?.metadata ?? {}),
        },
        icons: {
          ...DEFAULT_SETTINGS.sessionDisplay.icons,
          ...(parsed.sessionDisplay?.icons ?? {}),
        },
        showDetailsOnHover:
          typeof parsed.sessionDisplay?.showDetailsOnHover === "boolean"
            ? parsed.sessionDisplay.showDetailsOnHover
            : DEFAULT_SETTINGS.sessionDisplay.showDetailsOnHover,
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
  patchStatusBar: (patch: Partial<AcornSettings["statusBar"]>) => void;
  patchPullRequests: (patch: Partial<AcornSettings["pullRequests"]>) => void;
  patchSessionDisplay: (
    patch: Partial<
      Omit<AcornSettings["sessionDisplay"], "metadata" | "icons">
    > & {
      metadata?: Partial<AcornSettings["sessionDisplay"]["metadata"]>;
      icons?: Partial<AcornSettings["sessionDisplay"]["icons"]>;
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
  patchStatusBar: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        statusBar: { ...s.settings.statusBar, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchPullRequests: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        pullRequests: { ...s.settings.pullRequests, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchSessionDisplay: (patch) =>
    set((s) => {
      const metadata = patch.metadata
        ? { ...s.settings.sessionDisplay.metadata, ...patch.metadata }
        : s.settings.sessionDisplay.metadata;
      const icons = patch.icons
        ? { ...s.settings.sessionDisplay.icons, ...patch.icons }
        : s.settings.sessionDisplay.icons;
      const { metadata: _m, icons: _i, ...rest } = patch;
      const next: AcornSettings = {
        ...s.settings,
        sessionDisplay: {
          ...s.settings.sessionDisplay,
          ...rest,
          metadata,
          icons,
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
