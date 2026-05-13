import { beforeEach, describe, expect, it, vi } from "vitest";
import { fontStackFromSlots } from "./fonts";
import { DEFAULT_SETTINGS } from "./settings";

describe("terminal.linkActivation default", () => {
  it("defaults to plain click so xterm's stock behaviour is preserved", () => {
    expect(DEFAULT_SETTINGS.terminal.linkActivation).toBe("click");
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

  it("derives terminal.fontFamily from appearance.fontSlots on load", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        appearance: { fontSlots: ["Menlo", "Monaco", null] },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");
    const settings = useSettings.getState().settings;

    expect(settings.terminal.fontFamily).toBe(
      fontStackFromSlots(["Menlo", "Monaco", null], "monospace"),
    );
  });

  it("migrates legacy terminal.fontFamily into appearance.fontSlots when slots are missing", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        terminal: { fontFamily: "Menlo, Monaco, Consolas, monospace" },
      }),
    );

    vi.resetModules();
    const { useSettings } = await import("./settings");
    const settings = useSettings.getState().settings;

    expect(settings.appearance.fontSlots).toEqual([
      "Menlo",
      "Monaco",
      "Consolas",
    ]);
    expect(settings.terminal.fontFamily).toBe(
      fontStackFromSlots(["Menlo", "Monaco", "Consolas"], "monospace"),
    );
  });

  it("rejects unknown themeId and falls back to default", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ appearance: { themeId: "not-real" } }),
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
