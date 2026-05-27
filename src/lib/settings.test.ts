import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_OPTIONS,
  DEFAULT_SETTINGS,
  DEFAULT_SESSION_TITLE_PROMPT,
  NOTIFICATION_HISTORY_LIMIT_MAX,
  resolveAiCommitCommand,
  resolveAiOneshotCommand,
  resolveSessionTitlePrompt,
  SESSION_TITLE_PROMPT_MAX_CHARS,
} from "./settings";

describe("language settings", () => {
  const STORAGE_KEY = "acorn:settings:v1";
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return storage.size;
        },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("defaults to English", () => {
    expect(DEFAULT_SETTINGS.language).toBe("en");
  });

  it("loads a persisted Korean language selection", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "ko" }));

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.language).toBe("ko");
  });

  it("falls back to English for an unsupported stored language", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ language: "fr" }));

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.language).toBe("en");
  });
});

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
  });
});

describe("session removal settings", () => {
  const STORAGE_KEY = "acorn:settings:v1";
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return storage.size;
        },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("keeps worktree auto-delete off by default", () => {
    expect(DEFAULT_SETTINGS.sessions.autoDeleteWorktrees).toBe(false);
  });

  it("loads a persisted worktree auto-delete preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessions: { autoDeleteWorktrees: true } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.sessions.autoDeleteWorktrees).toBe(
      true,
    );
  });
});

describe("notification settings", () => {
  const STORAGE_KEY = "acorn:settings:v1";
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return storage.size;
        },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("defaults notification history to 50 records", () => {
    expect(DEFAULT_SETTINGS.notifications.maxHistory).toBe(50);
    expect(DEFAULT_SETTINGS.notifications.autoDeleteRead).toBe(false);
  });

  it("loads persisted notification history settings and clamps the limit", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        notifications: { maxHistory: 200, autoDeleteRead: true },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.notifications.maxHistory).toBe(
      NOTIFICATION_HISTORY_LIMIT_MAX,
    );
    expect(useSettings.getState().settings.notifications.autoDeleteRead).toBe(
      true,
    );
  });
});

describe("status bar settings", () => {
  const STORAGE_KEY = "acorn:settings:v1";
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return storage.size;
        },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("shows the session activity shortcut by default", () => {
    expect(DEFAULT_SETTINGS.statusBar.showSessionActivity).toBe(true);
  });

  it("keeps agent token usage hidden by default", () => {
    expect(DEFAULT_SETTINGS.statusBar.showAgentTokenUsage).toBe(false);
  });

  it("loads a persisted session activity shortcut preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ statusBar: { showSessionActivity: false } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.statusBar.showSessionActivity).toBe(
      false,
    );
  });

  it("loads a persisted agent token usage preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ statusBar: { showAgentTokenUsage: true } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.statusBar.showAgentTokenUsage).toBe(
      true,
    );
  });
});

describe("AI commit command resolution", () => {
  it("keeps automatic session title generation off by default", () => {
    expect(DEFAULT_SETTINGS.agents.autoGenerateSessionTitles).toBe(false);
  });

  it("loads a persisted automatic session title preference", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({ agents: { autoGenerateSessionTitles: true } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.agents.autoGenerateSessionTitles,
    ).toBe(true);
  });

  it("keeps the default session title prompt in settings", () => {
    expect(DEFAULT_SETTINGS.agents.sessionTitlePrompt).toBe(
      DEFAULT_SESSION_TITLE_PROMPT,
    );
    expect(DEFAULT_SESSION_TITLE_PROMPT).toContain(
      "Separate each word with hyphens.",
    );
    expect(DEFAULT_SESSION_TITLE_PROMPT).toContain("Use lowercase words only.");
  });

  it("loads a persisted session title prompt", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({
        agents: { sessionTitlePrompt: "Name the tab in Korean." },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.agents.sessionTitlePrompt).toBe(
      "Name the tab in Korean.",
    );
  });

  it("migrates the old default session title prompt to the current default", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({
        agents: {
          sessionTitlePrompt: `You are naming an Acorn terminal tab from the user's first agent prompt.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Fewer than 30 characters.
- No quotes, Markdown, trailing punctuation, or extra commentary.
- Prefer the concrete task over generic words like "help" or "question".`,
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.agents.sessionTitlePrompt).toBe(
      DEFAULT_SESSION_TITLE_PROMPT,
    );
  });

  it("limits persisted session title prompts", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({
        agents: {
          sessionTitlePrompt: "x".repeat(SESSION_TITLE_PROMPT_MAX_CHARS + 1),
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.agents.sessionTitlePrompt,
    ).toHaveLength(SESSION_TITLE_PROMPT_MAX_CHARS);
  });

  it("falls back to the default session title prompt when blank", () => {
    expect(
      resolveSessionTitlePrompt({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, sessionTitlePrompt: "  \n " },
      }),
    ).toBe(DEFAULT_SESSION_TITLE_PROMPT);
  });

  it("runs Codex through non-interactive exec mode", () => {
    expect(
      resolveAiCommitCommand({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, selected: "codex" },
      }),
    ).toEqual({ command: "codex", args: ["exec"] });
  });

  it("describes the Codex one-shot invocation in settings", () => {
    expect(AGENT_OPTIONS.find((o) => o.value === "codex")?.oneshotHint).toBe(
      "codex exec",
    );
  });

  it("uses the Settings Agents model for one-shot providers that take one", () => {
    expect(
      resolveAiOneshotCommand({
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          selected: "ollama",
          ollama: { model: "qwen2.5-coder" },
        },
      }),
    ).toEqual({ command: "ollama", args: ["run", "qwen2.5-coder"] });
  });
});

describe("github settings", () => {
  const STORAGE_KEY = "acorn:settings:v1";
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return storage.size;
        },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("shows PR row labels by default", () => {
    expect(DEFAULT_SETTINGS.github.showLabels).toBe(true);
  });

  it("shows PR row branches by default", () => {
    expect(DEFAULT_SETTINGS.github.showBranches).toBe(true);
  });

  it("shows PR row CI status by default", () => {
    expect(DEFAULT_SETTINGS.github.showChecks).toBe(true);
  });

  it("loads a persisted PR row labels preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ github: { showLabels: false } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.github.showLabels).toBe(false);
  });

  it("loads persisted PR row branch and CI status preferences", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        github: { showBranches: false, showChecks: false },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.github.showBranches).toBe(false);
    expect(useSettings.getState().settings.github.showChecks).toBe(false);
  });
});

describe("appearance settings migration", () => {
  const STORAGE_KEY = "acorn:settings:v1";
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return storage.size;
        },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        removeItem: (key: string) => {
          storage.delete(key);
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      } satisfies Storage,
    });
  });

  it("fills in default appearance block when missing from stored settings", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { fontSize: 14 } }),
    );

    vi.resetModules();
    const { useSettings, DEFAULT_SETTINGS } = await import("./settings");
    const settings = useSettings.getState().settings;

    expect(settings.appearance.themeId).toBe("acorn-dark");
    expect(settings.appearance.fontSlots).toEqual(
      DEFAULT_SETTINGS.appearance.fontSlots,
    );
    expect(settings.appearance.background.relativePath).toBeNull();
    expect(settings.appearance.uiScalePercent).toBe(100);
    expect(settings.appearance.toastPosition).toBe("top");
  });

  it("keeps terminal.fontFamily as the source of truth on load", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        terminal: {
          fontFamily: '"Berkeley Mono", Menlo, monospace',
        },
        appearance: { fontSlots: ["Menlo", "Monaco", null] },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");
    const settings = useSettings.getState().settings;

    expect(settings.terminal.fontFamily).toBe(
      '"Berkeley Mono", Menlo, monospace',
    );
  });

  it("does not derive terminal.fontFamily from custom appearance fontSlots", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        appearance: { fontSlots: ["CommitMono", "Berkeley Mono", null] },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");
    const settings = useSettings.getState().settings;

    expect(settings.appearance.fontSlots).toEqual([
      "CommitMono",
      "Berkeley Mono",
      null,
    ]);
    expect(settings.terminal.fontFamily).toBe(
      DEFAULT_SETTINGS.terminal.fontFamily,
    );
  });

  it("keeps legacy terminal.fontFamily without migrating it into appearance fontSlots", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        terminal: { fontFamily: "Menlo, Monaco, Consolas, monospace" },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");
    const settings = useSettings.getState().settings;

    expect(settings.appearance.fontSlots).toEqual(
      DEFAULT_SETTINGS.appearance.fontSlots,
    );
    expect(settings.terminal.fontFamily).toBe(
      "Menlo, Monaco, Consolas, monospace",
    );
  });

  it("does not rewrite terminal.fontFamily when patching appearance", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        terminal: {
          ...DEFAULT_SETTINGS.terminal,
          fontFamily: '"Berkeley Mono", Menlo, monospace',
        },
      },
    });

    useSettings.getState().patchAppearance({ background: { opacity: 0.4 } });

    expect(useSettings.getState().settings.terminal.fontFamily).toBe(
      '"Berkeley Mono", Menlo, monospace',
    );
  });

  it("preserves user-theme ids that are not in the built-in set", async () => {
    // User themes load asynchronously after settings load, so the stored id
    // may legitimately not be in `BUILT_IN_THEMES`. Earlier behavior rejected
    // every non-builtin id and silently swapped to the default — clobbering
    // the user's selection on every restart. The applier in `App.tsx`
    // handles missing-id at apply time by falling back to `themes[0]`.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { themeId: "my-custom-theme" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.appearance.themeId).toBe(
      "my-custom-theme",
    );
  });

  it("falls back to default themeId when stored value is empty or not a string", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { themeId: "" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.appearance.themeId).toBe(
      "acorn-dark",
    );
  });

  it("clamps invalid background opacity/blur and rejects bad fit", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        appearance: {
          background: { fit: "garbage", opacity: 9, blur: -3 },
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");
    const background = useSettings.getState().settings.appearance.background;

    expect(background.fit).toBe("cover");
    expect(background.opacity).toBe(1);
    expect(background.blur).toBe(0);
  });

  it("clamps and snaps stored UI scale percentage", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { uiScalePercent: 152 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.appearance.uiScalePercent).toBe(150);
  });

  it("falls back to default UI scale when stored value is invalid", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { uiScalePercent: "large" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.appearance.uiScalePercent).toBe(100);
  });

  it("normalizes stored toast position", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { toastPosition: "bottom" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.appearance.toastPosition).toBe(
      "bottom",
    );
  });

  it("falls back to default toast position when stored value is invalid", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { toastPosition: "left" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.appearance.toastPosition).toBe(
      "top",
    );
  });
});
