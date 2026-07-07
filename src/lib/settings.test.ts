import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_OPTIONS,
  DEFAULT_SETTINGS,
  DEFAULT_SESSION_TITLE_PROMPT,
  MOUNTED_TERMINAL_LIMIT_DEFAULT,
  MOUNTED_TERMINAL_LIMIT_MAX,
  MOUNTED_TERMINAL_LIMIT_MIN,
  NOTIFICATION_HISTORY_LIMIT_MAX,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_STEP,
  TERMINAL_FONT_SMOOTHING_VALUES,
  TERMINAL_LETTER_SPACING_MAX,
  TERMINAL_LETTER_SPACING_MIN,
  TERMINAL_LETTER_SPACING_STEP,
  TERMINAL_LINE_HEIGHT_MAX,
  TERMINAL_LINE_HEIGHT_MIN,
  TERMINAL_LINE_HEIGHT_STEP,
  resolveAiCommitRequest,
  resolveAiExecutionRequest,
  resolveSessionTitlePrompt,
  SESSION_TITLE_PROMPT_MAX_CHARS,
} from "./settings";
import { DEFAULT_HOTKEYS } from "./hotkeys";

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

describe("interface settings", () => {
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

  it("defaults new workspaces to pane mode", () => {
    expect(DEFAULT_SETTINGS.interface.defaultWorkspaceViewMode).toBe("panes");
    expect(DEFAULT_SETTINGS.interface.prioritizeNeedsInputTabs).toBe(false);
    expect(
      DEFAULT_SETTINGS.interface.kanbanTerminalPopoverPlacement,
    ).toBe("card");
    expect(
      DEFAULT_SETTINGS.interface.kanbanTerminalPopoverDefaultSize,
    ).toBe("custom");
    expect(
      DEFAULT_SETTINGS.interface.openKanbanTerminalOnSessionCreate,
    ).toBe(false);
  });

  it("loads a persisted default workspace mode", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        interface: {
          defaultWorkspaceViewMode: "kanban",
          prioritizeNeedsInputTabs: true,
          kanbanTerminalPopoverPlacement: "center",
          kanbanTerminalPopoverDefaultSize: "fullscreen",
          openKanbanTerminalOnSessionCreate: true,
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.interface.defaultWorkspaceViewMode,
    ).toBe("kanban");
    expect(
      useSettings.getState().settings.interface.prioritizeNeedsInputTabs,
    ).toBe(true);
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverPlacement,
    ).toBe("center");
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverDefaultSize,
    ).toBe("fullscreen");
    expect(
      useSettings.getState().settings.interface
        .openKanbanTerminalOnSessionCreate,
    ).toBe(true);
  });

  it("falls back for unsupported interface values", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        interface: {
          defaultWorkspaceViewMode: "grid",
          prioritizeNeedsInputTabs: "yes",
          kanbanTerminalPopoverPlacement: "dock",
          kanbanTerminalPopoverDefaultSize: "huge",
          openKanbanTerminalOnSessionCreate: "yes",
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.interface.defaultWorkspaceViewMode,
    ).toBe("panes");
    expect(
      useSettings.getState().settings.interface.prioritizeNeedsInputTabs,
    ).toBe(false);
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverPlacement,
    ).toBe("card");
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverDefaultSize,
    ).toBe("custom");
    expect(
      useSettings.getState().settings.interface
        .openKanbanTerminalOnSessionCreate,
    ).toBe(false);
  });

  it("patches interface settings and preserves the previous value for invalid patches", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings
      .getState()
      .patchInterface({
        defaultWorkspaceViewMode: "kanban",
        prioritizeNeedsInputTabs: true,
        kanbanTerminalPopoverPlacement: "center",
        kanbanTerminalPopoverDefaultSize: "fullscreen",
        openKanbanTerminalOnSessionCreate: true,
      });
    expect(
      useSettings.getState().settings.interface.defaultWorkspaceViewMode,
    ).toBe("kanban");
    expect(
      useSettings.getState().settings.interface.prioritizeNeedsInputTabs,
    ).toBe(true);
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverPlacement,
    ).toBe("center");
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverDefaultSize,
    ).toBe("fullscreen");
    expect(
      useSettings.getState().settings.interface
        .openKanbanTerminalOnSessionCreate,
    ).toBe(true);

    const invalidMode =
      "grid" as unknown as typeof DEFAULT_SETTINGS.interface.defaultWorkspaceViewMode;
    const invalidPlacement =
      "dock" as unknown as typeof DEFAULT_SETTINGS.interface.kanbanTerminalPopoverPlacement;
    const invalidDefaultSize =
      "huge" as unknown as typeof DEFAULT_SETTINGS.interface.kanbanTerminalPopoverDefaultSize;
    const invalidOpenOnCreate =
      "yes" as unknown as typeof DEFAULT_SETTINGS.interface.openKanbanTerminalOnSessionCreate;
    useSettings
      .getState()
      .patchInterface({
        defaultWorkspaceViewMode: invalidMode,
        kanbanTerminalPopoverPlacement: invalidPlacement,
        kanbanTerminalPopoverDefaultSize: invalidDefaultSize,
        openKanbanTerminalOnSessionCreate: invalidOpenOnCreate,
      });
    expect(
      useSettings.getState().settings.interface.defaultWorkspaceViewMode,
    ).toBe("kanban");
    expect(
      useSettings.getState().settings.interface.prioritizeNeedsInputTabs,
    ).toBe(true);
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverPlacement,
    ).toBe("center");
    expect(
      useSettings.getState().settings.interface
        .kanbanTerminalPopoverDefaultSize,
    ).toBe("fullscreen");
    expect(
      useSettings.getState().settings.interface
        .openKanbanTerminalOnSessionCreate,
    ).toBe(true);
  });
});

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
  });
});

describe("terminal.rightClickPasteSelection settings", () => {
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

  it("defaults right-click selection paste off", () => {
    expect(DEFAULT_SETTINGS.terminal.rightClickPasteSelection).toBe(false);
  });

  it("loads a persisted right-click selection paste toggle", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { rightClickPasteSelection: true } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.terminal.rightClickPasteSelection,
    ).toBe(true);
  });

  it("patches the right-click selection paste toggle", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings.getState().patchTerminal({ rightClickPasteSelection: true });
    expect(
      useSettings.getState().settings.terminal.rightClickPasteSelection,
    ).toBe(true);

    useSettings.getState().patchTerminal({ rightClickPasteSelection: false });
    expect(
      useSettings.getState().settings.terminal.rightClickPasteSelection,
    ).toBe(false);
  });
});

describe("terminal.fontSmoothing settings", () => {
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

  it("defaults to grayscale font smoothing", () => {
    expect(DEFAULT_SETTINGS.terminal.fontSmoothing).toBe("grayscale");
  });

  it("lists the supported terminal font smoothing modes", () => {
    expect(TERMINAL_FONT_SMOOTHING_VALUES).toEqual([
      "grayscale",
      "subpixel",
      "system",
      "none",
    ]);
  });

  it("loads a persisted terminal font smoothing mode", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { fontSmoothing: "subpixel" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.fontSmoothing).toBe(
      "subpixel",
    );
  });

  it("falls back to the default for unsupported stored terminal font smoothing", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { fontSmoothing: "sharp" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.fontSmoothing).toBe(
      "grayscale",
    );
  });

  it("patches terminal font smoothing and preserves the previous value for invalid patches", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings.getState().patchTerminal({ fontSmoothing: "none" });
    expect(useSettings.getState().settings.terminal.fontSmoothing).toBe("none");

    const invalidFontSmoothing =
      "sharp" as unknown as typeof DEFAULT_SETTINGS.terminal.fontSmoothing;
    useSettings.getState().patchTerminal({
      fontSmoothing: invalidFontSmoothing,
    });
    expect(useSettings.getState().settings.terminal.fontSmoothing).toBe("none");
  });
});

describe("terminal.maxMountedTerminals settings", () => {
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

  it("defaults to 8 resident terminal views", () => {
    expect(DEFAULT_SETTINGS.terminal.maxMountedTerminals).toBe(
      MOUNTED_TERMINAL_LIMIT_DEFAULT,
    );
    expect(DEFAULT_SETTINGS.terminal.detachOffscreenTerminals).toBe(true);
  });

  it("loads a persisted resident terminal limit and clamps it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { maxMountedTerminals: 1000 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.maxMountedTerminals).toBe(
      MOUNTED_TERMINAL_LIMIT_MAX,
    );
  });

  it("loads a persisted resident terminal eviction toggle", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { detachOffscreenTerminals: false } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.detachOffscreenTerminals).toBe(
      false,
    );
  });

  it("rounds patched resident terminal limits inside the supported range", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings
      .getState()
      .patchTerminal({ maxMountedTerminals: MOUNTED_TERMINAL_LIMIT_MIN - 0.4 });
    expect(useSettings.getState().settings.terminal.maxMountedTerminals).toBe(
      MOUNTED_TERMINAL_LIMIT_MIN,
    );

    useSettings.getState().patchTerminal({ maxMountedTerminals: 9.6 });
    expect(useSettings.getState().settings.terminal.maxMountedTerminals).toBe(
      10,
    );
  });

  it("patches the resident terminal eviction toggle", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings.getState().patchTerminal({ detachOffscreenTerminals: false });
    expect(useSettings.getState().settings.terminal.detachOffscreenTerminals).toBe(
      false,
    );

    useSettings.getState().patchTerminal({ detachOffscreenTerminals: true });
    expect(useSettings.getState().settings.terminal.detachOffscreenTerminals).toBe(
      true,
    );
  });
});

describe("terminal.fontSize settings", () => {
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

  it("loads persisted decimal font size and clamps it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { fontSize: 13.375 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.fontSize).toBe(13.38);
  });

  it("clamps out-of-range persisted font size", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { fontSize: 99 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.fontSize).toBe(
      TERMINAL_FONT_SIZE_MAX,
    );
  });

  it("preserves patched decimal font size inside the supported range", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings
      .getState()
      .patchTerminal({ fontSize: TERMINAL_FONT_SIZE_MIN - 0.4 });
    expect(useSettings.getState().settings.terminal.fontSize).toBe(
      TERMINAL_FONT_SIZE_MIN,
    );

    useSettings.getState().patchTerminal({ fontSize: 13.375 });
    expect(useSettings.getState().settings.terminal.fontSize).toBe(13.38);
  });

  it("uses a fractional UI step for terminal font size", () => {
    expect(TERMINAL_FONT_SIZE_STEP).toBe(0.25);
  });
});

describe("terminal.letterSpacing settings", () => {
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

  it("defaults to stock xterm letter spacing", () => {
    expect(DEFAULT_SETTINGS.terminal.letterSpacing).toBe(0);
  });

  it("loads persisted letter spacing and clamps it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { letterSpacing: 1.75 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.letterSpacing).toBe(1.75);
  });

  it("clamps out-of-range persisted letter spacing", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { letterSpacing: 99 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.letterSpacing).toBe(
      TERMINAL_LETTER_SPACING_MAX,
    );
  });

  it("preserves patched decimal letter spacing inside the supported range", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings
      .getState()
      .patchTerminal({ letterSpacing: TERMINAL_LETTER_SPACING_MIN - 0.4 });
    expect(useSettings.getState().settings.terminal.letterSpacing).toBe(
      TERMINAL_LETTER_SPACING_MIN,
    );

    useSettings.getState().patchTerminal({ letterSpacing: 2.675 });
    expect(useSettings.getState().settings.terminal.letterSpacing).toBe(2.68);
  });

  it("uses a fractional UI step for terminal letter spacing", () => {
    expect(TERMINAL_LETTER_SPACING_STEP).toBe(0.25);
  });
});

describe("terminal.lineHeight settings", () => {
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

  it("defaults to stock xterm line height", () => {
    expect(DEFAULT_SETTINGS.terminal.lineHeight).toBe(1.0);
  });

  it("loads persisted line height and clamps it", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { lineHeight: 1.35 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.lineHeight).toBe(1.35);
  });

  it("clamps out-of-range persisted line height", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ terminal: { lineHeight: 99 } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.terminal.lineHeight).toBe(
      TERMINAL_LINE_HEIGHT_MAX,
    );
  });

  it("preserves patched decimal line height inside the supported range", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings
      .getState()
      .patchTerminal({ lineHeight: TERMINAL_LINE_HEIGHT_MIN - 0.4 });
    expect(useSettings.getState().settings.terminal.lineHeight).toBe(
      TERMINAL_LINE_HEIGHT_MIN,
    );

    useSettings.getState().patchTerminal({ lineHeight: 1.375 });
    expect(useSettings.getState().settings.terminal.lineHeight).toBe(1.38);
  });

  it("uses a fractional UI step for terminal line height", () => {
    expect(TERMINAL_LINE_HEIGHT_STEP).toBe(0.05);
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

  it("shows removal and cleanup prompts by default", () => {
    expect(DEFAULT_SETTINGS.sessions.warnBeforeClosingRunning).toBe(true);
    expect(DEFAULT_SETTINGS.sessions.confirmDeleteIsolatedWorktrees).toBe(
      true,
    );
    expect(DEFAULT_SETTINGS.sessions.confirmDeleteEmptyWorktreeWorkspaces).toBe(
      true,
    );
    expect(DEFAULT_SETTINGS.sessions.showRestartPromptOnExit).toBe(true);
  });

  it("loads persisted session removal preferences", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: {
          warnBeforeClosingRunning: false,
          confirmDeleteIsolatedWorktrees: false,
          confirmDeleteEmptyWorktreeWorkspaces: false,
          showRestartPromptOnExit: false,
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.sessions.confirmDeleteIsolatedWorktrees,
    ).toBe(false);
    expect(
      useSettings.getState().settings.sessions.warnBeforeClosingRunning,
    ).toBe(false);
    expect(
      useSettings.getState().settings.sessions
        .confirmDeleteEmptyWorktreeWorkspaces,
    ).toBe(false);
    expect(
      useSettings.getState().settings.sessions.showRestartPromptOnExit,
    ).toBe(false);
  });

  it("migrates persisted automatic cleanup preferences", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: {
          warnBeforeClosingRunning: false,
          autoDeleteWorktrees: true,
          autoDeleteEmptyWorktreeWorkspaces: true,
          closeOnExit: true,
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.sessions.confirmDeleteIsolatedWorktrees,
    ).toBe(false);
    expect(
      useSettings.getState().settings.sessions.warnBeforeClosingRunning,
    ).toBe(false);
    expect(
      useSettings.getState().settings.sessions
        .confirmDeleteEmptyWorktreeWorkspaces,
    ).toBe(false);
    expect(
      useSettings.getState().settings.sessions.showRestartPromptOnExit,
    ).toBe(false);
  });

  it("prefers current cleanup prompt preferences over automatic cleanup keys", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: {
          confirmDeleteIsolatedWorktrees: true,
          autoDeleteWorktrees: true,
          confirmDeleteEmptyWorktreeWorkspaces: true,
          autoDeleteEmptyWorktreeWorkspaces: true,
          showRestartPromptOnExit: true,
          closeOnExit: true,
        },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.sessions.confirmDeleteIsolatedWorktrees,
    ).toBe(true);
    expect(
      useSettings.getState().settings.sessions
        .confirmDeleteEmptyWorktreeWorkspaces,
    ).toBe(true);
    expect(
      useSettings.getState().settings.sessions.showRestartPromptOnExit,
    ).toBe(true);
  });
});

describe("power settings", () => {
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

  it("defaults to allowing normal idle sleep", () => {
    expect(DEFAULT_SETTINGS.power.preventSleep).toBe(false);
  });

  it("loads a persisted prevent-sleep preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ power: { preventSleep: true } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.power.preventSleep).toBe(true);
  });

  it("persists patched prevent-sleep changes", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings.getState().patchPower({ preventSleep: true });

    expect(useSettings.getState().settings.power.preventSleep).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").power).toEqual(
      { preventSleep: true },
    );
  });
});

describe("experimental settings", () => {
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

  it("normalizes terminal Unicode spaces by default", () => {
    expect(DEFAULT_SETTINGS.experiments.normalizeTerminalUnicodeSpaces).toBe(
      true,
    );
  });

  it("loads a persisted terminal Unicode space normalization preference", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        experiments: { normalizeTerminalUnicodeSpaces: false },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.experiments
        .normalizeTerminalUnicodeSpaces,
    ).toBe(false);
  });

  it("patches and persists terminal Unicode space normalization", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings
      .getState()
      .patchExperiments({ normalizeTerminalUnicodeSpaces: false });

    expect(
      useSettings.getState().settings.experiments
        .normalizeTerminalUnicodeSpaces,
    ).toBe(false);
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").experiments
        .normalizeTerminalUnicodeSpaces,
    ).toBe(false);
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

  it("defaults notification history to 20 records and auto-deletes read items", () => {
    expect(DEFAULT_SETTINGS.notifications.maxHistory).toBe(20);
    expect(DEFAULT_SETTINGS.notifications.autoDeleteRead).toBe(true);
  });

  it("loads persisted notification history settings and clamps the limit", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        notifications: { maxHistory: 200, autoDeleteRead: false },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.notifications.maxHistory).toBe(
      NOTIFICATION_HISTORY_LIMIT_MAX,
    );
    expect(useSettings.getState().settings.notifications.autoDeleteRead).toBe(
      false,
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

  it("shows agent token usage and hides the working directory by default", () => {
    expect(DEFAULT_SETTINGS.statusBar.showAgentTokenUsage).toBe(true);
    expect(DEFAULT_SETTINGS.statusBar.showWorkingDirectory).toBe(false);
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
      JSON.stringify({ statusBar: { showAgentTokenUsage: false } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.statusBar.showAgentTokenUsage).toBe(
      false,
    );
  });
});

describe("shortcut settings", () => {
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

  it("loads persisted shortcut overrides", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ shortcuts: { openPalette: "$mod+Shift+o" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.shortcuts.openPalette).toBe(
      "$mod+Shift+o",
    );
    expect(useSettings.getState().settings.shortcuts.newSession).toBe(
      DEFAULT_HOTKEYS.newSession,
    );
  });

  it("patches and resets a shortcut", async () => {
    vi.resetModules();
    const { useSettings } = await import("./settings");

    useSettings.getState().patchShortcut("openPalette", "$mod+Shift+o");
    expect(useSettings.getState().settings.shortcuts.openPalette).toBe(
      "$mod+Shift+o",
    );

    useSettings.getState().resetShortcut("openPalette");
    expect(useSettings.getState().settings.shortcuts.openPalette).toBe(
      DEFAULT_HOTKEYS.openPalette,
    );
  });
});

describe("AI commit command resolution", () => {
  it("enables automatic session title generation by default", () => {
    expect(DEFAULT_SETTINGS.agents.autoGenerateSessionTitles).toBe(true);
  });

  it("loads a persisted automatic session title preference", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({ agents: { autoGenerateSessionTitles: false } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(
      useSettings.getState().settings.agents.autoGenerateSessionTitles,
    ).toBe(false);
  });

  it("keeps the default session title prompt in settings", () => {
    expect(DEFAULT_SETTINGS.agents.sessionTitlePrompt).toBe(
      DEFAULT_SESSION_TITLE_PROMPT,
    );
    expect(DEFAULT_SESSION_TITLE_PROMPT).toContain(
      "Separate each word with hyphens.",
    );
    expect(DEFAULT_SESSION_TITLE_PROMPT).toContain("Use lowercase words only.");
    expect(DEFAULT_SESSION_TITLE_PROMPT).toContain(
      "Summarize the overall intent of the full request",
    );
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

  it("migrates the previous default session title prompt to the current default", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({
        agents: {
          sessionTitlePrompt: `You are naming an Acorn terminal tab from the user's first agent prompt.

Return only a concise title for the tab.
Rules:
- 2 to 5 words.
- Separate each word with hyphens.
- Use lowercase words only.
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
      resolveAiCommitRequest({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, selected: "codex" },
      }),
    ).toEqual({ provider: "codex", ollamaModel: "", llmModel: "" });
  });

  it("describes the Codex one-shot invocation in settings", () => {
    expect(AGENT_OPTIONS.find((o) => o.value === "codex")?.oneshotHint).toBe(
      "codex exec --skip-git-repo-check",
    );
  });

  it("describes the Antigravity print prompt argument in settings", () => {
    expect(
      AGENT_OPTIONS.find((o) => o.value === "antigravity")?.oneshotHint,
    ).toBe("agy -p <prompt>");
  });

  it("shows only the supported built-in agents in Settings order", () => {
    expect(AGENT_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["claude", "Claude Code"],
      ["codex", "Codex"],
      ["antigravity", "Antigravity"],
    ]);
  });

  it("falls back from persisted hidden agents to the default agent", async () => {
    localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({ agents: { selected: "ollama" } }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");

    expect(useSettings.getState().settings.agents.selected).toBe("claude");
  });

  it("runs Antigravity through the AGY CLI one-shot mode", () => {
    expect(
      resolveAiExecutionRequest({
        ...DEFAULT_SETTINGS,
        agents: { ...DEFAULT_SETTINGS.agents, selected: "antigravity" },
      }),
    ).toEqual({ provider: "antigravity", ollamaModel: "", llmModel: "" });
  });

  it("uses the Settings Agents model for one-shot providers that take one", () => {
    expect(
      resolveAiExecutionRequest({
        ...DEFAULT_SETTINGS,
        agents: {
          ...DEFAULT_SETTINGS.agents,
          selected: "ollama",
          ollama: { model: "qwen2.5-coder" },
        },
      }),
    ).toEqual({
      provider: "ollama",
      ollamaModel: "qwen2.5-coder",
      llmModel: "",
    });
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
