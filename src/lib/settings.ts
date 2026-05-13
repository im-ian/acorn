import { create } from "zustand";
import type { BackgroundFit, BackgroundState } from "./background";
import {
  fontStackFromSlots,
  sanitizeFontFamilyName,
  type CuratedMonospaceFont,
} from "./fonts";

const STORAGE_KEY = "acorn:settings:v1";

/**
 * Catalog of AI agents acorn knows how to invoke for one-shot tasks.
 * The user picks ONE `selected` agent under Settings → Agents; that
 * choice powers every AI feature in the app (currently the merge
 * dialog's "Generate with AI" button). Each agent has its own one-shot
 * stdin/stdout invocation convention, captured in `agentOneshotCommand`
 * below.
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
}> = [
  {
    value: "claude",
    label: "Claude Code",
    oneshotHint: "claude -p --output-format text",
  },
  {
    value: "gemini",
    label: "Gemini CLI",
    oneshotHint: "gemini -p",
  },
  {
    value: "ollama",
    label: "Ollama (local)",
    oneshotHint: "ollama run <model>",
  },
  {
    value: "llm",
    label: "llm CLI",
    oneshotHint: "llm [-m <model>]",
  },
  {
    value: "codex",
    label: "OpenAI Codex CLI",
    oneshotHint: "codex (interactive only)",
  },
];

import type { PrStateFilter } from "./types";

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
   * The single AI agent acorn uses everywhere AI features fire (currently
   * the merge dialog's "Generate with AI" button). Per-agent options
   * (Ollama / llm model strings) live alongside so changing them once
   * updates every call site.
   */
  agents: {
    selected: SelectedAgent;
    /**
     * Used when `selected === "custom"`. Whitespace-separated; no shell
     * expansion. Powers the one-shot commit-message invocation; empty
     * falls back to Claude Code.
     */
    customCommand: string;
    ollama: { model: string };
    llm: { model: string };
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
    /**
     * When a terminal session is running a known AI CLI, rename the tab from
     * the agent and the latest prompt observed in terminal input.
     */
    autoRenameAiTabs: boolean;
    /** Include the latest submitted prompt snippet in the generated tab name. */
    includeAiPromptInTabName: boolean;
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
    showSessionCount: boolean;
    showSessionStatus: boolean;
    showGithubAccount: boolean;
    showMemory: boolean;
  };
  pullRequests: {
    /** Tab pre-selected when the PRs panel first mounts for a repo. */
    defaultState: PrStateFilter;
    /** Auto-refresh cadence for the PRs tab in milliseconds. */
    refreshIntervalMs: number;
    /**
     * Show the author's GitHub avatar on each PR row. Trades a thicker
     * row for at-a-glance author recognition, mirroring the PR detail
     * modal which already shows avatars in its header / conversation.
     */
    showAvatars: boolean;
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
  appearance: {
    themeId: string;
    background: BackgroundState;
    fontSlots: [string, string | null, string | null];
  };
  /**
   * Opt-in toggles for unfinished features. Anything under here is
   * unstable on purpose — the contract is "we keep the toggle, the
   * implementation can churn".
   */
  experiments: {
    /**
     * Pins the most recent user-prompt line from the claude TUI to the
     * top of the terminal so the user keeps it in view while reading
     * the assistant's reply. Detection is buffer-driven, so Cmd+K
     * naturally clears the banner along with the rest of the scrollback.
     */
    stickyPrompt: boolean;
  };
}

export const DEFAULT_SETTINGS: AcornSettings = {
  terminal: {
    fontFamily: fontStackFromSlots(
      ["JetBrains Mono", "Fira Code", "Menlo"],
      "monospace",
    ),
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
  sessions: {
    confirmRemove: true,
    closeOnExit: false,
    autoRenameAiTabs: true,
    includeAiPromptInTabName: true,
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
    showSessionCount: true,
    showSessionStatus: true,
    showGithubAccount: true,
    showMemory: true,
  },
  pullRequests: {
    defaultState: "open",
    refreshIntervalMs: 60_000,
    showAvatars: true,
  },
  sessionDisplay: {
    title: "name",
    metadata: {
      branch: true,
      workingDirectory: false,
      status: true,
    },
    icons: {
      statusDot: true,
      sessionKind: true,
    },
    showDetailsOnHover: true,
  },
  appearance: {
    themeId: "acorn-dark",
    background: {
      relativePath: null,
      fileName: null,
      fit: "cover",
      opacity: 0.6,
      blur: 0,
      applyToApp: false,
      applyToTerminal: false,
    },
    fontSlots: ["JetBrains Mono", "Fira Code", "Menlo"],
  },
  experiments: {
    stickyPrompt: false,
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

const VALID_BG_FITS = new Set<BackgroundFit>(["cover", "contain", "tile"]);

function normalizeBgFit(v: unknown, fallback: BackgroundFit): BackgroundFit {
  if (typeof v === "string" && VALID_BG_FITS.has(v as BackgroundFit)) {
    return v as BackgroundFit;
  }
  return fallback;
}

function clamp01(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function clampBlur(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(24, v));
}

function normalizeThemeId(v: unknown, fallback: string): string {
  // Accept any non-empty string so a persisted user-theme id survives a
  // restart. User themes load asynchronously via `useThemes.refresh()` after
  // `loadSettings()` runs, so they are not in the built-in set at this
  // point. `App.tsx` already falls back to `themes[0]` when the requested
  // id isn't in the merged registry at apply time.
  if (typeof v === "string" && v.trim().length > 0) {
    return v;
  }
  return fallback;
}

function normalizeFontSlots(
  v: unknown,
  fallback: AcornSettings["appearance"]["fontSlots"],
): AcornSettings["appearance"]["fontSlots"] {
  if (!Array.isArray(v)) return fallback;

  const cleaned = [0, 1, 2].map((index) => {
    return sanitizeFontFamilyName(v[index]);
  });

  if (!cleaned[0]) return fallback;
  return [cleaned[0], cleaned[1], cleaned[2]];
}

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

    // Prefer the `agents` block; fall back to values stored under the older
    // `commitMessage` shape, then to the Claude default.
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
      agentsRaw.selected ?? legacySelected ?? DEFAULT_SETTINGS.agents.selected,
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

    const appearanceRaw = (parsed.appearance ?? {}) as Partial<
      AcornSettings["appearance"]
    > & {
      background?: Partial<BackgroundState>;
    };
    const appearance: AcornSettings["appearance"] = {
      themeId: normalizeThemeId(
        appearanceRaw.themeId,
        DEFAULT_SETTINGS.appearance.themeId,
      ),
      fontSlots: normalizeFontSlots(
        appearanceRaw.fontSlots,
        DEFAULT_SETTINGS.appearance.fontSlots,
      ),
      background: {
        relativePath:
          typeof appearanceRaw.background?.relativePath === "string"
            ? appearanceRaw.background.relativePath
            : DEFAULT_SETTINGS.appearance.background.relativePath,
        fileName:
          typeof appearanceRaw.background?.fileName === "string"
            ? appearanceRaw.background.fileName
            : DEFAULT_SETTINGS.appearance.background.fileName,
        fit: normalizeBgFit(
          appearanceRaw.background?.fit,
          DEFAULT_SETTINGS.appearance.background.fit,
        ),
        opacity: clamp01(
          appearanceRaw.background?.opacity,
          DEFAULT_SETTINGS.appearance.background.opacity,
        ),
        blur: clampBlur(
          appearanceRaw.background?.blur,
          DEFAULT_SETTINGS.appearance.background.blur,
        ),
        applyToApp:
          typeof appearanceRaw.background?.applyToApp === "boolean"
            ? appearanceRaw.background.applyToApp
            : DEFAULT_SETTINGS.appearance.background.applyToApp,
        applyToTerminal:
          typeof appearanceRaw.background?.applyToTerminal === "boolean"
            ? appearanceRaw.background.applyToTerminal
            : DEFAULT_SETTINGS.appearance.background.applyToTerminal,
      },
    };
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
      sessions: {
        ...DEFAULT_SETTINGS.sessions,
        ...(parsed.sessions ?? {}),
        autoRenameAiTabs:
          typeof parsed.sessions?.autoRenameAiTabs === "boolean"
            ? parsed.sessions.autoRenameAiTabs
            : DEFAULT_SETTINGS.sessions.autoRenameAiTabs,
        includeAiPromptInTabName:
          typeof parsed.sessions?.includeAiPromptInTabName === "boolean"
            ? parsed.sessions.includeAiPromptInTabName
            : DEFAULT_SETTINGS.sessions.includeAiPromptInTabName,
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
        showAvatars:
          typeof parsed.pullRequests?.showAvatars === "boolean"
            ? parsed.pullRequests.showAvatars
            : DEFAULT_SETTINGS.pullRequests.showAvatars,
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
      appearance,
      experiments: {
        ...DEFAULT_SETTINGS.experiments,
        ...(parsed.experiments ?? {}),
        stickyPrompt:
          typeof parsed.experiments?.stickyPrompt === "boolean"
            ? parsed.experiments.stickyPrompt
            : DEFAULT_SETTINGS.experiments.stickyPrompt,
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
  /// Tab the modal should land on the next time it opens. Consumed once
  /// by SettingsModal on mount/open, then reset to null. Lets the
  /// StatusBar daemon button deep-link to the Background sessions tab
  /// without exposing the modal's internal Tab union outside the store.
  pendingTab: string | null;
  setOpen: (v: boolean) => void;
  /// Open settings AND land on a specific tab. The tab id is the same
  /// string the modal uses internally; unknown ids fall back to the
  /// default tab.
  openTab: (tab: string) => void;
  consumePendingTab: () => string | null;
  patchTerminal: (patch: Partial<AcornSettings["terminal"]>) => void;
  patchAgents: (
    patch: Partial<{
      selected: SelectedAgent;
      customCommand: string;
      ollama: Partial<AcornSettings["agents"]["ollama"]>;
      llm: Partial<AcornSettings["agents"]["llm"]>;
    }>,
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
  patchAppearance: (
    patch: Partial<
      Omit<AcornSettings["appearance"], "background" | "fontSlots">
    > & {
      background?: Partial<BackgroundState>;
      fontSlots?: AcornSettings["appearance"]["fontSlots"];
    },
  ) => void;
  patchExperiments: (patch: Partial<AcornSettings["experiments"]>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: loadSettings(),
  open: false,
  pendingTab: null,
  setOpen: (v) => set({ open: v }),
  openTab: (tab) => set({ open: true, pendingTab: tab }),
  consumePendingTab: () => {
    const t = get().pendingTab;
    if (t !== null) {
      set({ pendingTab: null });
    }
    return t;
  },
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
  patchAppearance: (patch) =>
    set((s) => {
      const fontSlots =
        patch.fontSlots !== undefined
          ? patch.fontSlots
          : s.settings.appearance.fontSlots;
      const background = patch.background
        ? { ...s.settings.appearance.background, ...patch.background }
        : s.settings.appearance.background;
      const { background: _background, fontSlots: _fontSlots, ...rest } = patch;
      const appearance: AcornSettings["appearance"] = {
        ...s.settings.appearance,
        ...rest,
        background,
        fontSlots,
      };
      const next: AcornSettings = {
        ...s.settings,
        appearance,
      };
      persist(next);
      return { settings: next };
    }),
  patchExperiments: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        experiments: { ...s.settings.experiments, ...patch },
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
 * dialog tooltip so the user sees which CLI will run before clicking
 * Generate.
 */
export function selectedAgentLabel(s: AcornSettings): string {
  if (s.agents.selected === "custom") return "Custom command";
  return (
    AGENT_OPTIONS.find((o) => o.value === s.agents.selected)?.label ?? "AI"
  );
}

/** Backwards-compat alias for callers that still read this name. */
export const aiCommitProviderLabel = selectedAgentLabel;

export type { CuratedMonospaceFont };
