import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatHotkey,
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
  });

  describe("off macOS", () => {
    beforeEach(() => setPlatform("Win32"));

    it("renders the platform-primary modifier as Ctrl", () => {
      expect(formatHotkey("$mod+t")).toBe("Ctrl+T");
    });

    it("keeps `+` separators and modifier order", () => {
      expect(formatHotkey("$mod+Shift+Alt+t")).toBe("Ctrl+Alt+Shift+T");
    });
  });
});
