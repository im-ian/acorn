import { afterEach, describe, expect, it } from "vitest";
import { shouldUseTinykeysToggleMultiInputFallback } from "./hotkeys";

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
