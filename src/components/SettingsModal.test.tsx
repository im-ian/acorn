import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  importBackgroundImage: vi.fn<
    (name: string, bytes: Uint8Array) => Promise<{ relativePath: string; fileName: string }>
  >(),
  removeBackgroundImage: vi.fn<() => Promise<void>>(),
}));

vi.mock("../lib/api", () => ({
  api: {},
}));

vi.mock("../lib/background", () => ({
  importBackgroundImage: mocks.importBackgroundImage,
  removeBackgroundImage: mocks.removeBackgroundImage,
}));

vi.mock("../lib/notifications", () => ({
  sendTestNotification: vi.fn(),
}));

vi.mock("../lib/releases", () => ({
  fetchLatestReleaseNotes: vi.fn(),
  fetchReleaseNotes: vi.fn(),
}));

vi.mock("../lib/themes", () => ({
  BUILT_IN_THEMES: [
    {
      css: "",
      id: "acorn-dark",
      label: "Acorn Dark",
      mode: "dark",
      source: "builtin",
    },
  ],
  revealThemesFolder: vi.fn(),
  useThemes: (selector: (state: unknown) => unknown) =>
    selector({
      refresh: vi.fn(),
      themes: [
        {
          css: "",
          id: "acorn-dark",
          label: "Acorn Dark",
          mode: "dark",
          source: "builtin",
        },
      ],
    }),
}));

vi.mock("../lib/updater-store", () => ({
  useUpdater: () => ({
    available: null,
    busy: false,
    check: vi.fn(),
    clearError: vi.fn(),
    currentVersion: "1.0.0",
    dismiss: vi.fn(),
    error: null,
    init: vi.fn(),
    install: vi.fn(),
  }),
}));

import { DEFAULT_SETTINGS, useSettings } from "../lib/settings";
import { SettingsModal } from "./SettingsModal";

function cloneSettings() {
  return structuredClone(DEFAULT_SETTINGS);
}

function openAppearanceTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent === "Appearance",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Appearance tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("Input value setter not found");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SettingsModal font controls", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    mocks.importBackgroundImage.mockResolvedValue({
      fileName: "wallpaper.png",
      relativePath: "backgrounds/wallpaper.png",
    });
    mocks.removeBackgroundImage.mockResolvedValue(undefined);
    useSettings.setState({
      open: true,
      settings: cloneSettings(),
      patchAppearance: vi.fn(),
      patchTerminal: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("edits terminal fontFamily as a comma-separated stack", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });

    const fontFamily = document.querySelector<HTMLInputElement>("input");
    const patchTerminal = useSettings.getState().patchTerminal;

    expect(document.body.textContent).toContain("Font family");
    expect(document.body.textContent).toContain(
      "Comma-separated stack. First family that resolves wins.",
    );
    expect(fontFamily?.value).toBe(DEFAULT_SETTINGS.terminal.fontFamily);

    setInputValue(
      fontFamily as HTMLInputElement,
      '"Berkeley Mono", Menlo, monospace',
    );

    expect(patchTerminal).toHaveBeenCalledWith({
      fontFamily: '"Berkeley Mono", Menlo, monospace',
    });
  });

  it("does not render the Appearance font dropdown controls", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain("Terminal font");
    expect(document.body.textContent).not.toContain("Refresh fonts");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("edits Appearance UI scale as a percentage", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const scaleInput = document.querySelector<HTMLInputElement>(
      'input[aria-label="Custom UI scale percentage"]',
    );

    expect(document.body.textContent).toContain("UI scale");
    expect(scaleInput?.value).toBe("100");

    setInputValue(scaleInput as HTMLInputElement, "126");

    expect(useSettings.getState().patchAppearance).not.toHaveBeenCalledWith({
      uiScalePercent: 125,
    });
    expect(scaleInput?.value).toBe("126");

    act(() => {
      scaleInput?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(useSettings.getState().patchAppearance).toHaveBeenCalledWith({
      uiScalePercent: 125,
    });
  });
});

describe("SettingsModal background controls", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    mocks.importBackgroundImage.mockResolvedValue({
      fileName: "wallpaper.png",
      relativePath: "backgrounds/wallpaper.png",
    });
    mocks.removeBackgroundImage.mockResolvedValue(undefined);
    useSettings.setState({
      open: true,
      settings: cloneSettings(),
      patchAppearance: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("applies a picked image to both app and terminal by default", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const fileInput = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    const file = new File([new Uint8Array([1, 2, 3])], "wallpaper.png", {
      type: "image/png",
    });
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(useSettings.getState().patchAppearance).toHaveBeenCalledWith({
      background: {
        relativePath: "backgrounds/wallpaper.png",
        fileName: "wallpaper.png",
        applyToApp: true,
        applyToTerminal: true,
      },
    });
  });
});
