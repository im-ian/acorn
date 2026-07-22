import { create } from "zustand";
import type { AiExecutionRequest } from "./api";
import type { BackgroundFit, BackgroundState } from "./background";
import {
  fontStackFromSlots,
  sanitizeFontFamilyName,
  type CuratedMonospaceFont,
} from "./fonts";
import {
  DEFAULT_HOTKEYS,
  resolveHotkeys,
  type HotkeyConfig,
  type HotkeyId,
} from "./hotkeys";
import { isLanguage, type Language } from "./i18n";
import {
  AGENT_PROVIDER_ORDER,
  getAgentProviderDefinition,
  isSessionAgentProvider,
} from "./agentProviderRegistry";

const STORAGE_KEY = "acorn:settings:v1";

/**
 * Catalog of AI agents acorn knows how to invoke for one-shot tasks.
 * The user picks ONE `selected` agent under Settings → Agents; that
 * choice powers every AI feature in the app (currently the merge
 * dialog's "Generate with AI" button). Each agent has its own one-shot
 * stdin/stdout invocation convention, captured in `agentOneshotCommand`
 * below.
 */
export type AgentProvider =
  | "claude"
  | "antigravity"
  | "ollama"
  | "llm"
  | "codex";

/** Agent selection accepts every catalogued agent plus the persisted legacy
 *  custom option. Native execution rejects custom commands at the backend
 *  boundary; keep the option readable so existing settings migrate cleanly. */
export type SelectedAgent = AgentProvider | "custom";

export const AGENT_OPTIONS: ReadonlyArray<{
  value: AgentProvider;
  label: string;
  /** One-shot invocation hint shown in Settings. */
  oneshotHint: string;
}> = AGENT_PROVIDER_ORDER.map((value) => {
  const definition = getAgentProviderDefinition(value);
  return {
    value,
    label: definition.agentOptionLabel,
    oneshotHint: definition.oneshotHint,
  };
});

const LEGACY_DEFAULT_SESSION_TITLE_PROMPT = `You are naming an Acorn terminal tab from the user's first agent prompt.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Fewer than 30 characters.
- No quotes, Markdown, trailing punctuation, or extra commentary.
- Prefer the concrete task over generic words like "help" or "question".`;

const PREVIOUS_DEFAULT_SESSION_TITLE_PROMPT = `You are naming an Acorn terminal tab from the user's first agent prompt.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Separate each word with hyphens.
- Use lowercase words only.
- Fewer than 30 characters.
- No quotes, Markdown, trailing punctuation, or extra commentary.
- Prefer the concrete task over generic words like "help" or "question".`;

export const DEFAULT_SESSION_TITLE_PROMPT = `You are naming an Acorn terminal tab from the conversation transcript.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Separate each word with hyphens.
- Use lowercase words only.
- Fewer than 30 characters.
- No quotes, Markdown, trailing punctuation, or extra commentary.
- Summarize the overall intent of the full request, not just the first line or first task.
- Prefer the main user goal over setup steps and generic words like "help" or "question".`;

export const SESSION_TITLE_PROMPT_MAX_CHARS = 1_000;

export const SESSION_TITLE_PROMPT_PREVIEW_MESSAGE =
  "Add a Settings button that previews generated tab titles without creating a session.";

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

export const UI_SCALE_PERCENT_MIN = 75;
export const UI_SCALE_PERCENT_MAX = 150;
export const UI_SCALE_PERCENT_STEP = 5;
export const NOTIFICATION_HISTORY_LIMIT_MIN = 1;
export const NOTIFICATION_HISTORY_LIMIT_DEFAULT = 20;
export const NOTIFICATION_HISTORY_LIMIT_MAX = 100;
export const MOUNTED_TERMINAL_LIMIT_MIN = 1;
export const MOUNTED_TERMINAL_LIMIT_DEFAULT = 8;
export const MOUNTED_TERMINAL_LIMIT_MAX = 64;
export const CANVAS_INACTIVE_TERMINAL_RENDER_INTERVAL_OPTIONS = [
  16, 40, 80, 120,
] as const;
export type CanvasInactiveTerminalRenderIntervalMs =
  (typeof CANVAS_INACTIVE_TERMINAL_RENDER_INTERVAL_OPTIONS)[number];
export const CANVAS_INACTIVE_TERMINAL_RENDER_INTERVAL_DEFAULT: CanvasInactiveTerminalRenderIntervalMs =
  40;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_STEP = 0.25;
export const TERMINAL_LETTER_SPACING_MIN = -2;
export const TERMINAL_LETTER_SPACING_MAX = 6;
export const TERMINAL_LETTER_SPACING_STEP = 0.25;
export const TERMINAL_LINE_HEIGHT_MIN = 1.0;
export const TERMINAL_LINE_HEIGHT_MAX = 2.0;
export const TERMINAL_LINE_HEIGHT_STEP = 0.05;

export type ToastPosition = "top" | "bottom";
export type DefaultWorkspaceViewMode = "panes" | "kanban" | "canvas";
export type KanbanTerminalPopoverPlacement = "card" | "center";
export type KanbanTerminalPopoverDefaultSize = "custom" | "fullscreen";

export const TOAST_POSITION_OPTIONS: ReadonlyArray<{
  value: ToastPosition;
  label: string;
}> = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
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
export type TerminalFontSmoothing =
  | "grayscale"
  | "subpixel"
  | "system"
  | "none";
export const TERMINAL_FONT_SMOOTHING_VALUES: ReadonlyArray<TerminalFontSmoothing> =
  ["grayscale", "subpixel", "system", "none"];

export const TERMINAL_FONT_PRESET_FIELDS = [
  "fontFamily",
  "fontSize",
  "letterSpacing",
  "fontSmoothing",
  "fontWeight",
  "fontWeightBold",
  "lineHeight",
] as const;

export const TERMINAL_FONT_PRESET_EXPERIMENT_FIELDS = [
  "cjkCellWidthHeuristic",
] as const;

type TerminalFontPresetField = (typeof TERMINAL_FONT_PRESET_FIELDS)[number];
type TerminalFontPresetExperimentField =
  (typeof TERMINAL_FONT_PRESET_EXPERIMENT_FIELDS)[number];

export type TerminalFontPresetSettings = Pick<
  AcornSettings["terminal"],
  TerminalFontPresetField
>;
export type TerminalFontPresetExperimentSettings = Pick<
  AcornSettings["experiments"],
  TerminalFontPresetExperimentField
>;

export interface TerminalFontPreset {
  id: string;
  name: string;
  settings: TerminalFontPresetSettings;
  experiments: TerminalFontPresetExperimentSettings;
}

export const TERMINAL_FONT_PRESET_LIMIT = 50;
export const TERMINAL_FONT_PRESET_NAME_MAX_CHARS = 80;

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
  language: Language;
  interface: {
    /**
     * Initial workspace view mode for newly-created project workspaces.
     * Existing project workspaces keep their own stored mode.
     */
    defaultWorkspaceViewMode: DefaultWorkspaceViewMode;
    /**
     * Move project sidebar tabs that need attention ahead of ready work.
     * The saved manual order is preserved and restored when this is off.
     */
    prioritizeNeedsInputTabs: boolean;
    /**
     * Initial placement for terminal popovers opened from kanban cards.
     * Users can still drag the popover after it opens.
     */
    kanbanTerminalPopoverPlacement: KanbanTerminalPopoverPlacement;
    /**
     * Initial size mode for terminal popovers opened from kanban cards.
     * `custom` uses the remembered user-resized popover size.
     */
    kanbanTerminalPopoverDefaultSize: KanbanTerminalPopoverDefaultSize;
    /**
     * Open the terminal popover as soon as a terminal session is created while
     * the active workspace is in kanban mode.
     */
    openKanbanTerminalOnSessionCreate: boolean;
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
    /**
     * xterm.js horizontal cell spacing in CSS pixels. Negative values tighten
     * cramped fonts; positive values give dense terminal output more
     * horizontal room.
     */
    letterSpacing: number;
    /**
     * CSS font-smoothing mode applied to terminal text only. xterm.js does
     * not expose this as a terminal option, so Acorn applies it on the
     * terminal DOM renderer container.
     */
    fontSmoothing: TerminalFontSmoothing;
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
    /**
     * When enabled, right-clicking selected terminal text writes that
     * selection back to the PTY. Default off because it is an input gesture.
     */
    rightClickPasteSelection: boolean;
    /**
     * Output batching interval for visible, unselected canvas terminals.
     * The selected terminal continues to render on animation frames.
     */
    canvasInactiveTerminalRenderIntervalMs: CanvasInactiveTerminalRenderIntervalMs;
    /**
     * Upper bound on simultaneously-mounted terminal sessions. Visible
     * terminals are always exempt, so this only evicts off-screen daemon
     * sessions that can be re-attached with scrollback replay.
     */
    maxMountedTerminals: number;
    /**
     * Detach off-screen daemon-backed terminals when the resident terminal
     * limit is exceeded. Disable to keep every opened terminal view mounted.
     */
    detachOffscreenTerminals: boolean;
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
     * When enabled, new user-owned agent sessions can have their default tab
     * name replaced by an AI-generated title from transcript context.
     * Default off: this can send prompt text to the configured AI CLI.
     */
    autoGenerateSessionTitles: boolean;
    /**
     * Mirror Acorn's manual and generated terminal tab titles into matching
     * Codex and Claude conversations. Default off because this changes
     * provider-owned conversation metadata and transcript files.
     */
    syncAgentSessionTitles: boolean;
    /**
     * Instructions prepended to transcript context when Acorn asks the
     * selected AI CLI to name a new session tab.
     */
    sessionTitlePrompt: string;
    /**
     * Legacy value from earlier builds. The backend no longer executes
     * renderer-supplied custom commands.
     */
    customCommand: string;
    ollama: { model: string };
    llm: { model: string };
  };
  sessions: {
    /**
     * Show the confirmation dialog before removing a non-isolated session.
     * Set false to skip the prompt for plain sessions. Worktree-backed
     * sessions still ask unless their cleanup prompt is disabled below.
     */
    confirmRemove: boolean;
    /**
     * Warn before closing a session that Acorn currently marks as working.
     * This sits ahead of the normal removal confirmation so users get an
     * explicit chance to avoid killing active shell or agent work.
     */
    warnBeforeClosingRunning: boolean;
    /**
     * Ask before deleting a standalone isolated worktree directory when its
     * session is removed. Shared worktree workspaces and linked worktree
     * sessions are preserved unless the user explicitly deletes them.
     */
    confirmDeleteIsolatedWorktrees: boolean;
    /**
     * Ask before deleting the linked worktree directory when removing an
     * empty worktree workspace. Worktree workspaces that still contain
     * sessions always show the workspace removal confirmation.
     */
    confirmDeleteEmptyWorktreeWorkspaces: boolean;
    /**
     * Show the "[process exited — press Enter to restart]" prompt when the
     * session's PTY process exits. When false, Acorn closes the session tab
     * automatically; worktree-backed sessions still pass through the normal
     * worktree cleanup policy.
     */
    showRestartPromptOnExit: boolean;
  };
  power: {
    /**
     * Hold a macOS PreventUserIdleSystemSleep assertion while Acorn is
     * running. The display may still sleep; this only keeps idle system
     * sleep from suspending long-running sessions.
     */
    preventSleep: boolean;
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
    maxHistory: number;
    autoDeleteRead: boolean;
    events: {
      waitingForInput: boolean;
      errored: boolean;
    };
  };
  /**
   * Toggles for the bottom status bar items. Disabling `showMemory`
   * also short-circuits the memory polling loop in the StatusBar, so it
   * actually reduces the work acorn does — not just hides the readout.
   */
  statusBar: {
    showSessionActivity: boolean;
    showSessionCount: boolean;
    showSessionStatus: boolean;
    showGithubAccount: boolean;
    showWorkingDirectory: boolean;
    showAgentTokenUsage: boolean;
    showMemory: boolean;
  };
  github: {
    /** Auto-refresh cadence for the PRs, Issues, and Actions tabs in milliseconds. */
    refreshIntervalMs: number;
    /**
     * Show the author's GitHub avatar on PR and issue rows. Trades a thicker
     * row for at-a-glance author recognition.
     */
    showAvatars: boolean;
    /** Show GitHub labels next to each PR or issue row title. */
    showLabels: boolean;
    /** Show source and target branches on each PR row. */
    showBranches: boolean;
    /** Show CI/check status on each PR row. */
    showChecks: boolean;
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
    uiScalePercent: number;
    toastPosition: ToastPosition;
  };
  fontPresets: {
    terminal: TerminalFontPreset[];
  };
  shortcuts: HotkeyConfig;
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
    /**
     * Heuristic CJK terminal cell-width correction. Compares rendered
     * widths of `W` and `가`; if equal, treats the font as a CJK
     * monospaced face and halves the cell width so Hangul/Han glyphs
     * align to the cell grid. Off by default — the heuristic does not
     * cover system-fallback CJK rendering (ASCII-only font + OS
     * fallback for `가`), and aggressive cell-width edits can break
     * unrelated terminal layouts.
     */
    cjkCellWidthHeuristic: boolean;
    /**
     * Cold-boot "Resume previous conversation" modal for session agents.
     * On Acorn launch, probes every persisted session for an unfinished
     * agent transcript and pops a one-shot modal when the user focuses
     * one. Disable to suppress the modal entirely; marker files still get
     * written by the persister for future debugging.
     */
    resumeModal: boolean;
    /**
     * Convert Unicode space separators that reach interactive terminal input
     * boundaries into ASCII space so shells keep parsing commands as separate
     * words. Disable to preserve literal NBSP-like characters in TUIs or REPLs.
     */
    normalizeTerminalUnicodeSpaces: boolean;
  };
}

export const DEFAULT_SETTINGS: AcornSettings = {
  language: "en",
  interface: {
    defaultWorkspaceViewMode: "panes",
    prioritizeNeedsInputTabs: false,
    kanbanTerminalPopoverPlacement: "card",
    kanbanTerminalPopoverDefaultSize: "custom",
    openKanbanTerminalOnSessionCreate: false,
  },
  terminal: {
    fontFamily: fontStackFromSlots(
      ["JetBrains Mono", "Fira Code", "Menlo"],
      "monospace",
    ),
    fontSize: 12,
    letterSpacing: 0,
    fontSmoothing: "grayscale",
    fontWeight: 400,
    fontWeightBold: 700,
    lineHeight: 1.0,
    linkActivation: "click",
    rightClickPasteSelection: false,
    canvasInactiveTerminalRenderIntervalMs:
      CANVAS_INACTIVE_TERMINAL_RENDER_INTERVAL_DEFAULT,
    maxMountedTerminals: MOUNTED_TERMINAL_LIMIT_DEFAULT,
    detachOffscreenTerminals: true,
  },
  agents: {
    selected: "claude",
    autoGenerateSessionTitles: true,
    syncAgentSessionTitles: false,
    sessionTitlePrompt: DEFAULT_SESSION_TITLE_PROMPT,
    customCommand: "",
    ollama: { model: "" },
    llm: { model: "" },
  },
  sessions: {
    confirmRemove: true,
    warnBeforeClosingRunning: true,
    confirmDeleteIsolatedWorktrees: true,
    confirmDeleteEmptyWorktreeWorkspaces: true,
    showRestartPromptOnExit: true,
  },
  power: {
    preventSleep: false,
  },
  editor: {
    command: "",
  },
  notifications: {
    enabled: true,
    maxHistory: NOTIFICATION_HISTORY_LIMIT_DEFAULT,
    autoDeleteRead: true,
    events: {
      waitingForInput: true,
      errored: true,
    },
  },
  statusBar: {
    showSessionActivity: true,
    showSessionCount: true,
    showSessionStatus: true,
    showGithubAccount: true,
    showWorkingDirectory: false,
    showAgentTokenUsage: true,
    showMemory: true,
  },
  github: {
    refreshIntervalMs: 60_000,
    showAvatars: true,
    showLabels: true,
    showBranches: true,
    showChecks: true,
  },
  sessionDisplay: {
    title: "name",
    metadata: {
      branch: true,
      workingDirectory: false,
      status: true,
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
    uiScalePercent: 100,
    toastPosition: "top",
  },
  fontPresets: {
    terminal: [],
  },
  shortcuts: { ...DEFAULT_HOTKEYS },
  experiments: {
    stickyPrompt: false,
    cjkCellWidthHeuristic: false,
    resumeModal: true,
    normalizeTerminalUnicodeSpaces: true,
  },
};

export function terminalFontPresetById(
  presets: ReadonlyArray<TerminalFontPreset>,
  id: string,
): TerminalFontPreset | null {
  return presets.find((preset) => preset.id === id) ?? null;
}

export function terminalFontPresetSettings(
  settings: Pick<AcornSettings, "terminal">,
): TerminalFontPresetSettings {
  return {
    fontFamily: settings.terminal.fontFamily,
    fontSize: settings.terminal.fontSize,
    letterSpacing: settings.terminal.letterSpacing,
    fontSmoothing: settings.terminal.fontSmoothing,
    fontWeight: settings.terminal.fontWeight,
    fontWeightBold: settings.terminal.fontWeightBold,
    lineHeight: settings.terminal.lineHeight,
  };
}

export function terminalFontPresetExperiments(
  settings: Pick<AcornSettings, "experiments">,
): TerminalFontPresetExperimentSettings {
  return {
    cjkCellWidthHeuristic: settings.experiments.cjkCellWidthHeuristic,
  };
}

export function terminalFontPresetMatches(
  settings: Pick<AcornSettings, "terminal" | "experiments">,
  preset: TerminalFontPreset,
): boolean {
  return (
    TERMINAL_FONT_PRESET_FIELDS.every((field) =>
      Object.is(settings.terminal[field], preset.settings[field]),
    ) &&
    TERMINAL_FONT_PRESET_EXPERIMENT_FIELDS.every((field) =>
      Object.is(settings.experiments[field], preset.experiments[field]),
    )
  );
}

export function matchingTerminalFontPresetId(
  settings: Pick<AcornSettings, "terminal" | "experiments">,
  presets: ReadonlyArray<TerminalFontPreset>,
): string | null {
  return (
    presets.find((preset) =>
      terminalFontPresetMatches(settings, preset),
    )?.id ?? null
  );
}

const VALID_WEIGHTS = new Set<TerminalFontWeight>([
  100, 200, 300, 400, 500, 600, 700, 800, 900,
]);

const VALID_PR_INTERVALS = new Set<number>(
  PR_REFRESH_INTERVAL_OPTIONS.map((o) => o.value),
);
const VALID_CANVAS_INACTIVE_TERMINAL_RENDER_INTERVALS =
  new Set<CanvasInactiveTerminalRenderIntervalMs>(
    CANVAS_INACTIVE_TERMINAL_RENDER_INTERVAL_OPTIONS,
  );

const VALID_BG_FITS = new Set<BackgroundFit>(["cover", "contain", "tile"]);
const VALID_TOAST_POSITIONS = new Set<ToastPosition>(["top", "bottom"]);
const VALID_WORKSPACE_VIEW_MODES = new Set<DefaultWorkspaceViewMode>([
  "panes",
  "kanban",
  "canvas",
]);
const VALID_KANBAN_TERMINAL_POPOVER_PLACEMENTS =
  new Set<KanbanTerminalPopoverPlacement>(["card", "center"]);
const VALID_KANBAN_TERMINAL_POPOVER_DEFAULT_SIZES =
  new Set<KanbanTerminalPopoverDefaultSize>(["custom", "fullscreen"]);

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

export function normalizeUiScalePercent(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const clamped = Math.max(
    UI_SCALE_PERCENT_MIN,
    Math.min(UI_SCALE_PERCENT_MAX, v),
  );
  return Math.round(clamped / UI_SCALE_PERCENT_STEP) * UI_SCALE_PERCENT_STEP;
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

function normalizeToastPosition(
  v: unknown,
  fallback: ToastPosition,
): ToastPosition {
  if (
    typeof v === "string" &&
    VALID_TOAST_POSITIONS.has(v as ToastPosition)
  ) {
    return v as ToastPosition;
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

function normalizeTerminalFontSmoothing(
  v: unknown,
  fallback: TerminalFontSmoothing,
): TerminalFontSmoothing {
  return typeof v === "string" &&
    TERMINAL_FONT_SMOOTHING_VALUES.includes(v as TerminalFontSmoothing)
    ? (v as TerminalFontSmoothing)
    : fallback;
}

function normalizeLineHeight(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  // Clamp to the same range the Stepper enforces in the UI so a hand-
  // edited localStorage value can't make the terminal unusable.
  const clamped = Math.max(
    TERMINAL_LINE_HEIGHT_MIN,
    Math.min(TERMINAL_LINE_HEIGHT_MAX, v),
  );
  return Math.round(clamped * 100) / 100;
}

export function normalizeTerminalFontSize(
  v: unknown,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const clamped = Math.max(
    TERMINAL_FONT_SIZE_MIN,
    Math.min(TERMINAL_FONT_SIZE_MAX, v),
  );
  return Math.round(clamped * 100) / 100;
}

export function normalizeTerminalLetterSpacing(
  v: unknown,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const clamped = Math.max(
    TERMINAL_LETTER_SPACING_MIN,
    Math.min(TERMINAL_LETTER_SPACING_MAX, v),
  );
  return Math.round(clamped * 100) / 100;
}

export function normalizeMountedTerminalLimit(
  v: unknown,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(
    MOUNTED_TERMINAL_LIMIT_MIN,
    Math.min(MOUNTED_TERMINAL_LIMIT_MAX, Math.round(v)),
  );
}

function normalizeCanvasInactiveTerminalRenderInterval(
  v: unknown,
  fallback: CanvasInactiveTerminalRenderIntervalMs,
): CanvasInactiveTerminalRenderIntervalMs {
  if (
    typeof v === "number" &&
    VALID_CANVAS_INACTIVE_TERMINAL_RENDER_INTERVALS.has(
      v as CanvasInactiveTerminalRenderIntervalMs,
    )
  ) {
    return v as CanvasInactiveTerminalRenderIntervalMs;
  }
  return fallback;
}

function normalizePrInterval(v: unknown, fallback: number): number {
  if (typeof v === "number" && VALID_PR_INTERVALS.has(v)) return v;
  return fallback;
}

export function normalizeNotificationHistoryLimit(
  v: unknown,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(
    NOTIFICATION_HISTORY_LIMIT_MIN,
    Math.min(NOTIFICATION_HISTORY_LIMIT_MAX, Math.round(v)),
  );
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

function normalizeTerminalFontPresetName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim().replace(/\s+/g, " ");
  if (!name) return null;
  return Array.from(name)
    .slice(0, TERMINAL_FONT_PRESET_NAME_MAX_CHARS)
    .join("");
}

function terminalFontPresetIdBase(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `font-${slug}` : "font-preset";
}

function uniqueTerminalFontPresetId(
  name: string,
  presets: ReadonlyArray<TerminalFontPreset>,
): string {
  const existing = new Set(presets.map((preset) => preset.id));
  const base = terminalFontPresetIdBase(name);
  if (!existing.has(base)) return base;

  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base}-${Date.now()}`;
}

function normalizeTerminalFontPresetId(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const id = v.trim();
  return id ? id.slice(0, 120) : fallback;
}

function normalizeTerminalFontPresetSettings(
  v: unknown,
): TerminalFontPresetSettings | null {
  if (!v || typeof v !== "object") return null;
  const raw = v as Partial<TerminalFontPresetSettings>;
  return {
    fontFamily:
      typeof raw.fontFamily === "string" && raw.fontFamily.trim()
        ? raw.fontFamily
        : DEFAULT_SETTINGS.terminal.fontFamily,
    fontSize: normalizeTerminalFontSize(
      raw.fontSize,
      DEFAULT_SETTINGS.terminal.fontSize,
    ),
    letterSpacing: normalizeTerminalLetterSpacing(
      raw.letterSpacing,
      DEFAULT_SETTINGS.terminal.letterSpacing,
    ),
    fontSmoothing: normalizeTerminalFontSmoothing(
      raw.fontSmoothing,
      DEFAULT_SETTINGS.terminal.fontSmoothing,
    ),
    fontWeight: normalizeWeight(
      raw.fontWeight,
      DEFAULT_SETTINGS.terminal.fontWeight,
    ),
    fontWeightBold: normalizeWeight(
      raw.fontWeightBold,
      DEFAULT_SETTINGS.terminal.fontWeightBold,
    ),
    lineHeight: normalizeLineHeight(
      raw.lineHeight,
      DEFAULT_SETTINGS.terminal.lineHeight,
    ),
  };
}

function normalizeTerminalFontPresetExperiments(
  v: unknown,
): TerminalFontPresetExperimentSettings {
  const raw =
    v && typeof v === "object"
      ? (v as Partial<TerminalFontPresetExperimentSettings>)
      : {};
  return {
    cjkCellWidthHeuristic:
      typeof raw.cjkCellWidthHeuristic === "boolean"
        ? raw.cjkCellWidthHeuristic
        : DEFAULT_SETTINGS.experiments.cjkCellWidthHeuristic,
  };
}

function normalizeTerminalFontPresets(
  v: unknown,
): TerminalFontPreset[] {
  if (!Array.isArray(v)) return DEFAULT_SETTINGS.fontPresets.terminal;

  const presets: TerminalFontPreset[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const raw = item as {
      id?: unknown;
      name?: unknown;
      settings?: unknown;
      experiments?: unknown;
    };
    const name = normalizeTerminalFontPresetName(raw.name);
    const settings = normalizeTerminalFontPresetSettings(raw.settings);
    if (!name || !settings) continue;

    const nameKey = name.toLocaleLowerCase();
    if (seenNames.has(nameKey)) continue;

    const fallbackId = uniqueTerminalFontPresetId(name, presets);
    const id = normalizeTerminalFontPresetId(raw.id, fallbackId);
    const uniqueId = seenIds.has(id)
      ? uniqueTerminalFontPresetId(name, presets)
      : id;

    presets.push({
      id: uniqueId,
      name,
      settings,
      experiments: normalizeTerminalFontPresetExperiments(raw.experiments),
    });
    seenIds.add(uniqueId);
    seenNames.add(nameKey);

    if (presets.length >= TERMINAL_FONT_PRESET_LIMIT) break;
  }

  return presets;
}

function normalizeSelectedAgent(
  v: unknown,
  fallback: SelectedAgent,
): SelectedAgent {
  if (v === "gemini") return "antigravity";
  if (
    typeof v === "string" &&
    (isSessionAgentProvider(v) || v === "custom")
  ) {
    return v as SelectedAgent;
  }
  return fallback;
}

function normalizeSessionTitlePrompt(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  if (
    [
      LEGACY_DEFAULT_SESSION_TITLE_PROMPT,
      PREVIOUS_DEFAULT_SESSION_TITLE_PROMPT,
    ].includes(v.trim())
  ) {
    return DEFAULT_SESSION_TITLE_PROMPT;
  }
  return Array.from(v).slice(0, SESSION_TITLE_PROMPT_MAX_CHARS).join("");
}

function normalizeLanguage(v: unknown, fallback: Language): Language {
  return isLanguage(v) ? v : fallback;
}

function normalizeDefaultWorkspaceViewMode(
  v: unknown,
  fallback: DefaultWorkspaceViewMode,
): DefaultWorkspaceViewMode {
  if (
    typeof v === "string" &&
    VALID_WORKSPACE_VIEW_MODES.has(v as DefaultWorkspaceViewMode)
  ) {
    return v as DefaultWorkspaceViewMode;
  }
  return fallback;
}

function normalizeKanbanTerminalPopoverPlacement(
  v: unknown,
  fallback: KanbanTerminalPopoverPlacement,
): KanbanTerminalPopoverPlacement {
  if (
    typeof v === "string" &&
    VALID_KANBAN_TERMINAL_POPOVER_PLACEMENTS.has(
      v as KanbanTerminalPopoverPlacement,
    )
  ) {
    return v as KanbanTerminalPopoverPlacement;
  }
  return fallback;
}

function normalizeKanbanTerminalPopoverDefaultSize(
  v: unknown,
  fallback: KanbanTerminalPopoverDefaultSize,
): KanbanTerminalPopoverDefaultSize {
  if (
    typeof v === "string" &&
    VALID_KANBAN_TERMINAL_POPOVER_DEFAULT_SIZES.has(
      v as KanbanTerminalPopoverDefaultSize,
    )
  ) {
    return v as KanbanTerminalPopoverDefaultSize;
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

interface LegacyPullRequests {
  refreshIntervalMs?: number;
  showAvatars?: boolean;
  showLabels?: boolean;
  showBranches?: boolean;
  showChecks?: boolean;
}

interface PersistedSessionSettings
  extends Partial<AcornSettings["sessions"]> {
  autoDeleteWorktrees?: boolean;
  autoDeleteEmptyWorktreeWorkspaces?: boolean;
  closeOnExit?: boolean;
}

function loadSettings(): AcornSettings {
  if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as
      | (Partial<AcornSettings> & {
          commitMessage?: LegacyCommitMessage;
          pullRequests?: LegacyPullRequests;
        })
      | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    const interfaceRaw = (parsed.interface ?? {}) as Partial<
      AcornSettings["interface"]
    >;
    const terminalRaw: Partial<AcornSettings["terminal"]> = parsed.terminal ?? {};
    const fontPresetsRaw = (parsed.fontPresets ?? {}) as {
      terminal?: unknown;
    };
    const sessionsRaw = (parsed.sessions ?? {}) as PersistedSessionSettings;
    const notificationEventsRaw = (parsed.notifications?.events ?? {}) as {
      waitingForInput?: unknown;
      needsInput?: unknown;
      errored?: unknown;
      failed?: unknown;
    };

    // Prefer the `agents` block; fall back to values stored under the older
    // `commitMessage` shape, then to the Claude default.
    const agentsRaw = (parsed.agents ?? {}) as {
      selected?: string;
      autoGenerateSessionTitles?: boolean;
      syncAgentSessionTitles?: boolean;
      sessionTitlePrompt?: unknown;
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
      uiScalePercent: normalizeUiScalePercent(
        appearanceRaw.uiScalePercent,
        DEFAULT_SETTINGS.appearance.uiScalePercent,
      ),
      toastPosition: normalizeToastPosition(
        appearanceRaw.toastPosition,
        DEFAULT_SETTINGS.appearance.toastPosition,
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
      language: normalizeLanguage(parsed.language, DEFAULT_SETTINGS.language),
      interface: {
        defaultWorkspaceViewMode: normalizeDefaultWorkspaceViewMode(
          interfaceRaw.defaultWorkspaceViewMode,
          DEFAULT_SETTINGS.interface.defaultWorkspaceViewMode,
        ),
        prioritizeNeedsInputTabs:
          typeof interfaceRaw.prioritizeNeedsInputTabs === "boolean"
            ? interfaceRaw.prioritizeNeedsInputTabs
            : DEFAULT_SETTINGS.interface.prioritizeNeedsInputTabs,
        kanbanTerminalPopoverPlacement:
          normalizeKanbanTerminalPopoverPlacement(
            interfaceRaw.kanbanTerminalPopoverPlacement,
            DEFAULT_SETTINGS.interface.kanbanTerminalPopoverPlacement,
          ),
        kanbanTerminalPopoverDefaultSize:
          normalizeKanbanTerminalPopoverDefaultSize(
            interfaceRaw.kanbanTerminalPopoverDefaultSize,
            DEFAULT_SETTINGS.interface.kanbanTerminalPopoverDefaultSize,
          ),
        openKanbanTerminalOnSessionCreate:
          typeof interfaceRaw.openKanbanTerminalOnSessionCreate === "boolean"
            ? interfaceRaw.openKanbanTerminalOnSessionCreate
            : DEFAULT_SETTINGS.interface.openKanbanTerminalOnSessionCreate,
      },
      terminal: {
        ...DEFAULT_SETTINGS.terminal,
        ...terminalRaw,
        fontSize: normalizeTerminalFontSize(
          (terminalRaw as { fontSize?: unknown }).fontSize,
          DEFAULT_SETTINGS.terminal.fontSize,
        ),
        fontWeight: normalizeWeight(
          terminalRaw.fontWeight,
          DEFAULT_SETTINGS.terminal.fontWeight,
        ),
        fontWeightBold: normalizeWeight(
          terminalRaw.fontWeightBold,
          DEFAULT_SETTINGS.terminal.fontWeightBold,
        ),
        letterSpacing: normalizeTerminalLetterSpacing(
          (terminalRaw as { letterSpacing?: unknown }).letterSpacing,
          DEFAULT_SETTINGS.terminal.letterSpacing,
        ),
        fontSmoothing: normalizeTerminalFontSmoothing(
          (terminalRaw as { fontSmoothing?: unknown }).fontSmoothing,
          DEFAULT_SETTINGS.terminal.fontSmoothing,
        ),
        lineHeight: normalizeLineHeight(
          (terminalRaw as { lineHeight?: unknown }).lineHeight,
          DEFAULT_SETTINGS.terminal.lineHeight,
        ),
        linkActivation: normalizeLinkActivation(
          (terminalRaw as { linkActivation?: unknown }).linkActivation,
          DEFAULT_SETTINGS.terminal.linkActivation,
        ),
        rightClickPasteSelection:
          typeof (terminalRaw as { rightClickPasteSelection?: unknown })
            .rightClickPasteSelection === "boolean"
            ? (terminalRaw as { rightClickPasteSelection: boolean })
                .rightClickPasteSelection
            : DEFAULT_SETTINGS.terminal.rightClickPasteSelection,
        canvasInactiveTerminalRenderIntervalMs:
          normalizeCanvasInactiveTerminalRenderInterval(
            (
              terminalRaw as {
                canvasInactiveTerminalRenderIntervalMs?: unknown;
              }
            ).canvasInactiveTerminalRenderIntervalMs,
            DEFAULT_SETTINGS.terminal.canvasInactiveTerminalRenderIntervalMs,
          ),
        maxMountedTerminals: normalizeMountedTerminalLimit(
          (terminalRaw as { maxMountedTerminals?: unknown })
            .maxMountedTerminals,
          DEFAULT_SETTINGS.terminal.maxMountedTerminals,
        ),
        detachOffscreenTerminals:
          typeof (terminalRaw as { detachOffscreenTerminals?: unknown })
            .detachOffscreenTerminals === "boolean"
            ? (terminalRaw as { detachOffscreenTerminals: boolean })
                .detachOffscreenTerminals
            : DEFAULT_SETTINGS.terminal.detachOffscreenTerminals,
      },
      agents: {
        selected,
        autoGenerateSessionTitles:
          typeof agentsRaw.autoGenerateSessionTitles === "boolean"
            ? agentsRaw.autoGenerateSessionTitles
            : DEFAULT_SETTINGS.agents.autoGenerateSessionTitles,
        syncAgentSessionTitles:
          typeof agentsRaw.syncAgentSessionTitles === "boolean"
            ? agentsRaw.syncAgentSessionTitles
            : DEFAULT_SETTINGS.agents.syncAgentSessionTitles,
        sessionTitlePrompt: normalizeSessionTitlePrompt(
          agentsRaw.sessionTitlePrompt,
          DEFAULT_SETTINGS.agents.sessionTitlePrompt,
        ),
        customCommand,
        ollama: { model: ollamaModel },
        llm: { model: llmModel },
      },
      sessions: {
        confirmRemove:
          typeof sessionsRaw.confirmRemove === "boolean"
            ? sessionsRaw.confirmRemove
            : DEFAULT_SETTINGS.sessions.confirmRemove,
        warnBeforeClosingRunning:
          typeof sessionsRaw.warnBeforeClosingRunning === "boolean"
            ? sessionsRaw.warnBeforeClosingRunning
            : DEFAULT_SETTINGS.sessions.warnBeforeClosingRunning,
        confirmDeleteIsolatedWorktrees:
          typeof sessionsRaw.confirmDeleteIsolatedWorktrees === "boolean"
            ? sessionsRaw.confirmDeleteIsolatedWorktrees
            : typeof sessionsRaw.autoDeleteWorktrees === "boolean"
              ? !sessionsRaw.autoDeleteWorktrees
              : DEFAULT_SETTINGS.sessions.confirmDeleteIsolatedWorktrees,
        confirmDeleteEmptyWorktreeWorkspaces:
          typeof sessionsRaw.confirmDeleteEmptyWorktreeWorkspaces === "boolean"
            ? sessionsRaw.confirmDeleteEmptyWorktreeWorkspaces
            : typeof sessionsRaw.autoDeleteEmptyWorktreeWorkspaces ===
                "boolean"
              ? !sessionsRaw.autoDeleteEmptyWorktreeWorkspaces
              : DEFAULT_SETTINGS.sessions.confirmDeleteEmptyWorktreeWorkspaces,
        showRestartPromptOnExit:
          typeof sessionsRaw.showRestartPromptOnExit === "boolean"
            ? sessionsRaw.showRestartPromptOnExit
            : typeof sessionsRaw.closeOnExit === "boolean"
              ? !sessionsRaw.closeOnExit
              : DEFAULT_SETTINGS.sessions.showRestartPromptOnExit,
      },
      power: {
        preventSleep:
          typeof parsed.power?.preventSleep === "boolean"
            ? parsed.power.preventSleep
            : DEFAULT_SETTINGS.power.preventSleep,
      },
      editor: {
        ...DEFAULT_SETTINGS.editor,
        ...(parsed.editor ?? {}),
      },
      notifications: {
        ...DEFAULT_SETTINGS.notifications,
        ...(parsed.notifications ?? {}),
        maxHistory: normalizeNotificationHistoryLimit(
          parsed.notifications?.maxHistory,
          DEFAULT_SETTINGS.notifications.maxHistory,
        ),
        autoDeleteRead:
          typeof parsed.notifications?.autoDeleteRead === "boolean"
            ? parsed.notifications.autoDeleteRead
            : DEFAULT_SETTINGS.notifications.autoDeleteRead,
        events: {
          waitingForInput:
            typeof notificationEventsRaw.waitingForInput === "boolean"
              ? notificationEventsRaw.waitingForInput
              : typeof notificationEventsRaw.needsInput === "boolean"
                ? notificationEventsRaw.needsInput
                : DEFAULT_SETTINGS.notifications.events.waitingForInput,
          errored:
            typeof notificationEventsRaw.errored === "boolean"
              ? notificationEventsRaw.errored
              : typeof notificationEventsRaw.failed === "boolean"
                ? notificationEventsRaw.failed
                : DEFAULT_SETTINGS.notifications.events.errored,
        },
      },
      statusBar: {
        ...DEFAULT_SETTINGS.statusBar,
        ...(parsed.statusBar ?? {}),
      },
      github: {
        // Backwards compat: legacy persisted settings store these fields
        // under `pullRequests`. Fall through to that key when the new
        // `github` slot is missing so existing users don't lose their
        // refresh interval / avatar toggle on first launch after rename.
        refreshIntervalMs: normalizePrInterval(
          parsed.github?.refreshIntervalMs ??
            parsed.pullRequests?.refreshIntervalMs,
          DEFAULT_SETTINGS.github.refreshIntervalMs,
        ),
        showAvatars:
          typeof parsed.github?.showAvatars === "boolean"
            ? parsed.github.showAvatars
            : typeof parsed.pullRequests?.showAvatars === "boolean"
              ? parsed.pullRequests.showAvatars
              : DEFAULT_SETTINGS.github.showAvatars,
        showLabels:
          typeof parsed.github?.showLabels === "boolean"
            ? parsed.github.showLabels
            : typeof parsed.pullRequests?.showLabels === "boolean"
              ? parsed.pullRequests.showLabels
              : DEFAULT_SETTINGS.github.showLabels,
        showBranches:
          typeof parsed.github?.showBranches === "boolean"
            ? parsed.github.showBranches
            : typeof parsed.pullRequests?.showBranches === "boolean"
              ? parsed.pullRequests.showBranches
              : DEFAULT_SETTINGS.github.showBranches,
        showChecks:
          typeof parsed.github?.showChecks === "boolean"
            ? parsed.github.showChecks
            : typeof parsed.pullRequests?.showChecks === "boolean"
              ? parsed.pullRequests.showChecks
              : DEFAULT_SETTINGS.github.showChecks,
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
        showDetailsOnHover:
          typeof parsed.sessionDisplay?.showDetailsOnHover === "boolean"
            ? parsed.sessionDisplay.showDetailsOnHover
            : DEFAULT_SETTINGS.sessionDisplay.showDetailsOnHover,
      },
      appearance,
      fontPresets: {
        terminal: normalizeTerminalFontPresets(fontPresetsRaw.terminal),
      },
      shortcuts: resolveHotkeys(
        (parsed.shortcuts ?? {}) as Partial<Record<HotkeyId, unknown>>,
      ),
      experiments: {
        ...DEFAULT_SETTINGS.experiments,
        ...(parsed.experiments ?? {}),
        stickyPrompt:
          typeof parsed.experiments?.stickyPrompt === "boolean"
            ? parsed.experiments.stickyPrompt
            : DEFAULT_SETTINGS.experiments.stickyPrompt,
        cjkCellWidthHeuristic:
          typeof parsed.experiments?.cjkCellWidthHeuristic === "boolean"
            ? parsed.experiments.cjkCellWidthHeuristic
            : DEFAULT_SETTINGS.experiments.cjkCellWidthHeuristic,
        resumeModal:
          typeof parsed.experiments?.resumeModal === "boolean"
            ? parsed.experiments.resumeModal
            : DEFAULT_SETTINGS.experiments.resumeModal,
        normalizeTerminalUnicodeSpaces:
          typeof parsed.experiments?.normalizeTerminalUnicodeSpaces === "boolean"
            ? parsed.experiments.normalizeTerminalUnicodeSpaces
            : DEFAULT_SETTINGS.experiments.normalizeTerminalUnicodeSpaces,
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
  patchInterface: (patch: Partial<AcornSettings["interface"]>) => void;
  patchTerminal: (patch: Partial<AcornSettings["terminal"]>) => void;
  patchAgents: (
    patch: Partial<{
      selected: SelectedAgent;
      autoGenerateSessionTitles: boolean;
      syncAgentSessionTitles: boolean;
      sessionTitlePrompt: string;
      customCommand: string;
      ollama: Partial<AcornSettings["agents"]["ollama"]>;
      llm: Partial<AcornSettings["agents"]["llm"]>;
    }>,
  ) => void;
  patchSessions: (patch: Partial<AcornSettings["sessions"]>) => void;
  patchPower: (patch: Partial<AcornSettings["power"]>) => void;
  patchEditor: (patch: Partial<AcornSettings["editor"]>) => void;
  patchNotifications: (
    patch: Partial<Omit<AcornSettings["notifications"], "events">> & {
      events?: Partial<AcornSettings["notifications"]["events"]>;
    },
  ) => void;
  patchStatusBar: (patch: Partial<AcornSettings["statusBar"]>) => void;
  patchGithub: (patch: Partial<AcornSettings["github"]>) => void;
  patchSessionDisplay: (
    patch: Partial<Omit<AcornSettings["sessionDisplay"], "metadata">> & {
      metadata?: Partial<AcornSettings["sessionDisplay"]["metadata"]>;
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
  applyTerminalFontPreset: (id: string) => void;
  saveTerminalFontPreset: (name: string) => string | null;
  deleteTerminalFontPreset: (id: string) => void;
  patchShortcut: (id: HotkeyId, binding: string) => void;
  resetShortcut: (id: HotkeyId) => void;
  resetShortcuts: () => void;
  patchExperiments: (patch: Partial<AcornSettings["experiments"]>) => void;
  patchLanguage: (language: Language) => void;
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
  patchInterface: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        interface: {
          ...s.settings.interface,
          defaultWorkspaceViewMode:
            patch.defaultWorkspaceViewMode === undefined
              ? s.settings.interface.defaultWorkspaceViewMode
              : normalizeDefaultWorkspaceViewMode(
                  patch.defaultWorkspaceViewMode,
                  s.settings.interface.defaultWorkspaceViewMode,
                ),
          prioritizeNeedsInputTabs:
            patch.prioritizeNeedsInputTabs === undefined
              ? s.settings.interface.prioritizeNeedsInputTabs
              : patch.prioritizeNeedsInputTabs,
          kanbanTerminalPopoverPlacement:
            patch.kanbanTerminalPopoverPlacement === undefined
              ? s.settings.interface.kanbanTerminalPopoverPlacement
              : normalizeKanbanTerminalPopoverPlacement(
                  patch.kanbanTerminalPopoverPlacement,
                  s.settings.interface.kanbanTerminalPopoverPlacement,
                ),
          kanbanTerminalPopoverDefaultSize:
            patch.kanbanTerminalPopoverDefaultSize === undefined
              ? s.settings.interface.kanbanTerminalPopoverDefaultSize
              : normalizeKanbanTerminalPopoverDefaultSize(
                  patch.kanbanTerminalPopoverDefaultSize,
                  s.settings.interface.kanbanTerminalPopoverDefaultSize,
                ),
          openKanbanTerminalOnSessionCreate:
            patch.openKanbanTerminalOnSessionCreate === undefined
              ? s.settings.interface.openKanbanTerminalOnSessionCreate
              : typeof patch.openKanbanTerminalOnSessionCreate === "boolean"
                ? patch.openKanbanTerminalOnSessionCreate
                : s.settings.interface.openKanbanTerminalOnSessionCreate,
        },
      };
      persist(next);
      return { settings: next };
    }),
  patchTerminal: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        terminal: {
          ...s.settings.terminal,
          ...patch,
          maxMountedTerminals:
            patch.maxMountedTerminals === undefined
              ? s.settings.terminal.maxMountedTerminals
              : normalizeMountedTerminalLimit(
                  patch.maxMountedTerminals,
                  s.settings.terminal.maxMountedTerminals,
                ),
          fontSize:
            patch.fontSize === undefined
              ? s.settings.terminal.fontSize
              : normalizeTerminalFontSize(
                  patch.fontSize,
                  s.settings.terminal.fontSize,
                ),
          letterSpacing:
            patch.letterSpacing === undefined
              ? s.settings.terminal.letterSpacing
              : normalizeTerminalLetterSpacing(
                  patch.letterSpacing,
                  s.settings.terminal.letterSpacing,
                ),
          fontSmoothing:
            patch.fontSmoothing === undefined
              ? s.settings.terminal.fontSmoothing
              : normalizeTerminalFontSmoothing(
                  patch.fontSmoothing,
                  s.settings.terminal.fontSmoothing,
                ),
          lineHeight:
            patch.lineHeight === undefined
              ? s.settings.terminal.lineHeight
              : normalizeLineHeight(
                  patch.lineHeight,
                  s.settings.terminal.lineHeight,
                ),
          rightClickPasteSelection:
            patch.rightClickPasteSelection === undefined
              ? s.settings.terminal.rightClickPasteSelection
              : typeof patch.rightClickPasteSelection === "boolean"
                ? patch.rightClickPasteSelection
                : s.settings.terminal.rightClickPasteSelection,
          canvasInactiveTerminalRenderIntervalMs:
            patch.canvasInactiveTerminalRenderIntervalMs === undefined
              ? s.settings.terminal.canvasInactiveTerminalRenderIntervalMs
              : normalizeCanvasInactiveTerminalRenderInterval(
                  patch.canvasInactiveTerminalRenderIntervalMs,
                  s.settings.terminal.canvasInactiveTerminalRenderIntervalMs,
                ),
          detachOffscreenTerminals:
            patch.detachOffscreenTerminals === undefined
              ? s.settings.terminal.detachOffscreenTerminals
              : typeof patch.detachOffscreenTerminals === "boolean"
                ? patch.detachOffscreenTerminals
                : s.settings.terminal.detachOffscreenTerminals,
        },
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
          ...(patch.autoGenerateSessionTitles !== undefined
            ? { autoGenerateSessionTitles: patch.autoGenerateSessionTitles }
            : {}),
          ...(patch.syncAgentSessionTitles !== undefined
            ? { syncAgentSessionTitles: patch.syncAgentSessionTitles }
            : {}),
          ...(patch.sessionTitlePrompt !== undefined
            ? {
                sessionTitlePrompt: normalizeSessionTitlePrompt(
                  patch.sessionTitlePrompt,
                  DEFAULT_SETTINGS.agents.sessionTitlePrompt,
                ),
              }
            : {}),
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
  patchPower: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        power: { ...s.settings.power, ...patch },
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
          maxHistory:
            rest.maxHistory === undefined
              ? s.settings.notifications.maxHistory
              : normalizeNotificationHistoryLimit(
                  rest.maxHistory,
                  s.settings.notifications.maxHistory,
                ),
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
  patchGithub: (patch) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        github: { ...s.settings.github, ...patch },
      };
      persist(next);
      return { settings: next };
    }),
  patchSessionDisplay: (patch) =>
    set((s) => {
      const metadata = patch.metadata
        ? { ...s.settings.sessionDisplay.metadata, ...patch.metadata }
        : s.settings.sessionDisplay.metadata;
      const { metadata: _m, ...rest } = patch;
      const next: AcornSettings = {
        ...s.settings,
        sessionDisplay: {
          ...s.settings.sessionDisplay,
          ...rest,
          metadata,
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
  applyTerminalFontPreset: (id) =>
    set((s) => {
      const preset = terminalFontPresetById(
        s.settings.fontPresets.terminal,
        id,
      );
      if (!preset) return s;
      const next: AcornSettings = {
        ...s.settings,
        terminal: {
          ...s.settings.terminal,
          ...preset.settings,
        },
        experiments: {
          ...s.settings.experiments,
          ...preset.experiments,
        },
      };
      persist(next);
      return { settings: next };
    }),
  saveTerminalFontPreset: (name) => {
    let savedId: string | null = null;
    set((s) => {
      const normalizedName = normalizeTerminalFontPresetName(name);
      if (!normalizedName) return s;

      const presets = s.settings.fontPresets.terminal;
      const existingIndex = presets.findIndex(
        (preset) =>
          preset.name.toLocaleLowerCase() ===
          normalizedName.toLocaleLowerCase(),
      );
      const preset: TerminalFontPreset = {
        id:
          existingIndex >= 0
            ? presets[existingIndex].id
            : uniqueTerminalFontPresetId(normalizedName, presets),
        name: normalizedName,
        settings: terminalFontPresetSettings(s.settings),
        experiments: terminalFontPresetExperiments(s.settings),
      };
      savedId = preset.id;

      const terminal =
        existingIndex >= 0
          ? presets.map((item, index) =>
              index === existingIndex ? preset : item,
            )
          : [preset, ...presets].slice(0, TERMINAL_FONT_PRESET_LIMIT);
      const next: AcornSettings = {
        ...s.settings,
        fontPresets: {
          ...s.settings.fontPresets,
          terminal,
        },
      };
      persist(next);
      return { settings: next };
    });
    return savedId;
  },
  deleteTerminalFontPreset: (id) =>
    set((s) => {
      const terminal = s.settings.fontPresets.terminal.filter(
        (preset) => preset.id !== id,
      );
      if (terminal.length === s.settings.fontPresets.terminal.length) {
        return s;
      }
      const next: AcornSettings = {
        ...s.settings,
        fontPresets: {
          ...s.settings.fontPresets,
          terminal,
        },
      };
      persist(next);
      return { settings: next };
    }),
  patchShortcut: (id, binding) =>
    set((s) => {
      const shortcuts = resolveHotkeys({
        ...s.settings.shortcuts,
        [id]: binding,
      });
      const next: AcornSettings = {
        ...s.settings,
        shortcuts,
      };
      persist(next);
      return { settings: next };
    }),
  resetShortcut: (id) =>
    set((s) => {
      const shortcuts = resolveHotkeys({
        ...s.settings.shortcuts,
        [id]: DEFAULT_HOTKEYS[id],
      });
      const next: AcornSettings = {
        ...s.settings,
        shortcuts,
      };
      persist(next);
      return { settings: next };
    }),
  resetShortcuts: () =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        shortcuts: { ...DEFAULT_HOTKEYS },
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
  patchLanguage: (language) =>
    set((s) => {
      const next: AcornSettings = {
        ...s.settings,
        language,
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
 * Resolve the AI CLI invocation selected under Settings → Agents. The
 * renderer sends only this provider intent; the Rust backend owns the actual
 * executable/arg allowlist.
 */
export function resolveAiExecutionRequest(
  s: AcornSettings,
): AiExecutionRequest {
  return {
    provider: s.agents.selected,
    ollamaModel: s.agents.ollama.model,
    llmModel: s.agents.llm.model,
  };
}

export function resolveSessionTitlePrompt(s: AcornSettings): string {
  return s.agents.sessionTitlePrompt.trim()
    ? s.agents.sessionTitlePrompt
    : DEFAULT_SESSION_TITLE_PROMPT;
}

/** Backwards-compat alias for callers that still read this name. */
export const resolveAiCommitRequest = resolveAiExecutionRequest;

/**
 * Human-friendly label for the global agent selection. Used by the merge
 * dialog tooltip so the user sees which CLI will run before clicking
 * Generate.
 */
export function selectedAgentLabel(s: AcornSettings): string {
  if (s.agents.selected === "custom") return "Custom Command";
  return (
    AGENT_OPTIONS.find((o) => o.value === s.agents.selected)?.label ?? "AI"
  );
}

/** Backwards-compat alias for callers that still read this name. */
export const aiCommitProviderLabel = selectedAgentLabel;

export type { CuratedMonospaceFont };
