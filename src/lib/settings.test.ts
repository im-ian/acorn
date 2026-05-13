import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
  });
});

describe("sessions AI defaults", () => {
  it("auto-renames AI tabs by default while keeping the setting user-toggleable", () => {
    expect(DEFAULT_SETTINGS.sessions.autoRenameAiTabs).toBe(true);
    expect(DEFAULT_SETTINGS.sessions.includeAiPromptInTabName).toBe(true);
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
});
