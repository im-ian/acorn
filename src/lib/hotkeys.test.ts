import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOTKEYS,
  formatHotkey,
  recordHotkeyFromEvent,
  resolveHotkeys,
  shouldUseTinykeysToggleMultiInputFallback,
} from "./hotkeys";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function clearTauriInternals() {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

describe("shouldUseTinykeysToggleMultiInputFallback", () => {
  afterEach(() => {
    clearTauriInternals();
  });

  it("keeps the tinykeys fallback active outside Tauri", () => {
    clearTauriInternals();

    expect(shouldUseTinykeysToggleMultiInputFallback()).toBe(true);
  });

  it("defers to the native menu accelerator inside Tauri", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });

    expect(shouldUseTinykeysToggleMultiInputFallback()).toBe(false);
  });
});

describe("formatHotkey", () => {
  const originalPlatform = navigator.platform;

  function setPlatform(value: string) {
    Object.defineProperty(navigator, "platform", {
      value,
      configurable: true,
    });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe("on macOS", () => {
    beforeEach(() => setPlatform("MacIntel"));

    it("renders the platform-primary modifier as ⌘", () => {
      expect(formatHotkey("$mod+t")).toBe("⌘T");
    });

    it("orders modifiers Ctrl-Alt-Shift-Cmd", () => {
      expect(formatHotkey("$mod+Shift+Alt+t")).toBe("⌥⇧⌘T");
    });

    it("translates named keys into mac glyphs", () => {
      expect(formatHotkey("Escape")).toBe("⎋");
      expect(formatHotkey("Control+Tab")).toBe("⌃⇥");
      expect(formatHotkey("$mod+Alt+ArrowLeft")).toBe("⌥⌘←");
    });

    it("renders `event.code` tokens as the bare letter/digit", () => {
      expect(formatHotkey("$mod+Alt+KeyT")).toBe("⌥⌘T");
      expect(formatHotkey("$mod+Alt+Shift+KeyT")).toBe("⌥⇧⌘T");
      expect(formatHotkey("$mod+Digit3")).toBe("⌘3");
    });
  });

  describe("off macOS", () => {
    beforeEach(() => setPlatform("Win32"));

    it("renders the platform-primary modifier as Ctrl", () => {
      expect(formatHotkey("$mod+t")).toBe("Ctrl+T");
    });

    it("keeps `+` separators and modifier order", () => {
      expect(formatHotkey("$mod+Shift+Alt+t")).toBe("Ctrl+Alt+Shift+T");
    });

    it("renders `event.code` tokens as the bare letter/digit", () => {
      expect(formatHotkey("$mod+Alt+KeyT")).toBe("Ctrl+Alt+T");
      expect(formatHotkey("$mod+Digit3")).toBe("Ctrl+3");
    });
  });
});

describe("recordHotkeyFromEvent", () => {
  const originalPlatform = navigator.platform;

  function setPlatform(value: string) {
    Object.defineProperty(navigator, "platform", {
      value,
      configurable: true,
    });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("records the platform primary modifier as $mod", () => {
    setPlatform("MacIntel");

    const binding = recordHotkeyFromEvent(
      new KeyboardEvent("keydown", {
        key: "p",
        code: "KeyP",
        metaKey: true,
      }),
    );

    expect(binding).toBe("$mod+p");
  });

  it("uses code tokens for Alt-modified letters", () => {
    setPlatform("MacIntel");

    const binding = recordHotkeyFromEvent(
      new KeyboardEvent("keydown", {
        key: "†",
        code: "KeyT",
        metaKey: true,
        altKey: true,
      }),
    );

    expect(binding).toBe("$mod+Alt+KeyT");
  });

  it("ignores modifier-only events", () => {
    setPlatform("Win32");

    expect(
      recordHotkeyFromEvent(
        new KeyboardEvent("keydown", {
          key: "Shift",
          code: "ShiftLeft",
          shiftKey: true,
        }),
      ),
    ).toBeNull();
  });
});

describe("resolveHotkeys", () => {
  it("merges custom bindings with defaults", () => {
    expect(resolveHotkeys({ openPalette: "$mod+Shift+o" })).toMatchObject({
      ...DEFAULT_HOTKEYS,
      openPalette: "$mod+Shift+o",
    });
  });

  it("falls back when a persisted binding is invalid", () => {
    expect(resolveHotkeys({ openPalette: "Shift" }).openPalette).toBe(
      DEFAULT_HOTKEYS.openPalette,
    );
  });

  it("drops persisted bindings that collide with another command", () => {
    const hotkeys = resolveHotkeys({
      openPalette: DEFAULT_HOTKEYS.newSession,
    });

    expect(hotkeys.openPalette).toBe(DEFAULT_HOTKEYS.openPalette);
    expect(hotkeys.newSession).toBe(DEFAULT_HOTKEYS.newSession);
  });

  it("allows a default binding after its owning command is customized", () => {
    const hotkeys = resolveHotkeys({
      openPalette: DEFAULT_HOTKEYS.newSession,
      newSession: "$mod+Alt+KeyU",
    });

    expect(hotkeys.openPalette).toBe(DEFAULT_HOTKEYS.newSession);
    expect(hotkeys.newSession).toBe("$mod+Alt+KeyU");
  });

  it("drops duplicate custom bindings from persisted settings", () => {
    const hotkeys = resolveHotkeys({
      openPalette: "$mod+Alt+KeyU",
      newSession: "$mod+Alt+KeyU",
    });

    expect(hotkeys.openPalette).toBe(DEFAULT_HOTKEYS.openPalette);
    expect(hotkeys.newSession).toBe(DEFAULT_HOTKEYS.newSession);
  });
});
