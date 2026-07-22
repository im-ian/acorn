import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativeWriteText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.nativeWriteText,
}));

import { writeClipboardText } from "./clipboardText";

const originalTauriInternals = Object.getOwnPropertyDescriptor(
  window,
  "__TAURI_INTERNALS__",
);
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

afterEach(() => {
  mocks.nativeWriteText.mockReset();
  if (originalTauriInternals) {
    Object.defineProperty(
      window,
      "__TAURI_INTERNALS__",
      originalTauriInternals,
    );
  } else {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  }
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("writeClipboardText", () => {
  it("uses the native clipboard in the Tauri runtime", async () => {
    const browserWriteText = vi.fn<(text: string) => Promise<void>>();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });
    mocks.nativeWriteText.mockResolvedValue();

    await writeClipboardText("#708");

    expect(mocks.nativeWriteText).toHaveBeenCalledWith("#708");
    expect(browserWriteText).not.toHaveBeenCalled();
  });

  it("keeps browser-only development on the Clipboard API", async () => {
    const browserWriteText = vi.fn<(text: string) => Promise<void>>();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: browserWriteText },
    });
    browserWriteText.mockResolvedValue();

    await writeClipboardText("browser text");

    expect(browserWriteText).toHaveBeenCalledWith("browser text");
    expect(mocks.nativeWriteText).not.toHaveBeenCalled();
  });
});
