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
}> = [
  {
    value: "claude",
    label: "Claude Code",
    oneshotHint: "claude -p --output-format text",
  },
  {
    value: "codex",
    label: "Codex",
    oneshotHint: "codex exec --skip-git-repo-check",
  },
  {
    value: "antigravity",
    label: "Antigravity",
    oneshotHint: "agy -p <prompt>",
  },
];

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
export const NOTIFICATION_HISTORY_LIMIT_DEFAULT = 50;
export const NOTIFICATION_HISTORY_LIMIT_MAX = 100;
export const MOUNTED_TERMINAL_LIMIT_MIN = 1;
export const MOUNTED_TERMINAL_LIMIT_DEFAULT = 8;
export const MOUNTED_TERMINAL_LIMIT_MAX = 64;
export const TERMINAL_LETTER_SPACING_MIN = -2;
export const TERMINAL_LETTER_SPACING_MAX = 6;
export const TERMINAL_LETTER_SPACING_STEP = 0.25;

export type ToastPosition = "top" | "bottom";

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
     * Warn before closing a session that Acorn currently marks as running.
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
     * Inline icon toggles. Status dot is the colored bullet at row start;
     * agentProvider lets live Claude/Codex/Antigravity sessions replace that dot with
     * their provider mark; sessionKind covers the isolated-worktree
     * (GitBranch) and control (Bot) glyphs trailing the title.
     */
    icons: {
      statusDot: boolean;
      agentProvider: boolean;
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
    uiScalePercent: number;
    toastPosition: ToastPosition;
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
     * Cold-boot "Resume previous conversation" modal for claude / codex.
     * On Acorn launch, probes every persisted session for an unfinished
     * agent transcript and pops a one-shot modal when the user focuses
     * one. Disable to suppress the modal entirely (the underlying
     * `claude.id` / `codex.id` files still get written by the persister
     * for future debugging).
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
    maxMountedTerminals: MOUNTED_TERMINAL_LIMIT_DEFAULT,
    detachOffscreenTerminals: true,
  },
  agents: {
    selected: "claude",
    autoGenerateSessionTitles: false,
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
    autoDeleteRead: false,
    events: {
      needsInput: true,
      failed: true,
      completed: false,
    },
  },
  statusBar: {
    showSessionActivity: true,
    showSessionCount: true,
    showSessionStatus: true,
    showGithubAccount: true,
    showWorkingDirectory: true,
    showAgentTokenUsage: false,
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
    icons: {
      statusDot: true,
      agentProvider: true,
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
    uiScalePercent: 100,
    toastPosition: "top",
  },
  shortcuts: { ...DEFAULT_HOTKEYS },
  experiments: {
    stickyPrompt: false,
    cjkCellWidthHeuristic: false,
    resumeModal: true,
    normalizeTerminalUnicodeSpaces: true,
  },
};

const VALID_WEIGHTS = new Set<TerminalFontWeight>([
  100, 200, 300, 400, 500, 600, 700, 800, 900,
]);

const VALID_AGENTS = new Set<AgentProvider>([
  "claude",
  "antigravity",
  "codex",
]);

const VALID_PR_INTERVALS = new Set<number>(
  PR_REFRESH_INTERVAL_OPTIONS.map((o) => o.value),
);

const VALID_BG_FITS = new Set<BackgroundFit>(["cover", "contain", "tile"]);
const VALID_TOAST_POSITIONS = new Set<ToastPosition>(["top", "bottom"]);

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
  return Math.max(1.0, Math.min(2.0, v));
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

function normalizeSelectedAgent(
  v: unknown,
  fallback: SelectedAgent,
): SelectedAgent {
  if (v === "gemini") return "antigravity";
  if (
    typeof v === "string" &&
    (VALID_AGENTS.has(v as AgentProvider) || v === "custom")
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
    const terminalRaw: Partial<AcornSettings["terminal"]> = parsed.terminal ?? {};
    const sessionsRaw = (parsed.sessions ?? {}) as PersistedSessionSettings;

    // Prefer the `agents` block; fall back to values stored under the older
    // `commitMessage` shape, then to the Claude default.
    const agentsRaw = (parsed.agents ?? {}) as {
      selected?: string;
      autoGenerateSessionTitles?: boolean;
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
          ...DEFAULT_SETTINGS.notifications.events,
          ...(parsed.notifications?.events ?? {}),
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
  patchTerminal: (patch: Partial<AcornSettings["terminal"]>) => void;
  patchAgents: (
    patch: Partial<{
      selected: SelectedAgent;
      autoGenerateSessionTitles: boolean;
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
