import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  importBackgroundImage: vi.fn<
    (name: string, bytes: Uint8Array) => Promise<{ relativePath: string; fileName: string }>
  >(),
  listSystemFonts: vi.fn<() => Promise<string[]>>(),
  removeBackgroundImage: vi.fn<() => Promise<void>>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    listSystemFonts: mocks.listSystemFonts,
  },
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

function fontInputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[placeholder="Search or type a font"], input[placeholder="Optional fallback"]',
    ),
  );
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

function focusInput(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
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
    mocks.listSystemFonts.mockResolvedValue([]);
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

  it("keeps font typing local until blur so primary can be cleared and replaced", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const [primary] = fontInputs();
    const patchAppearance = useSettings.getState().patchAppearance;

    setInputValue(primary, "");
    expect(primary.value).toBe("");
    expect(patchAppearance).not.toHaveBeenCalled();

    setInputValue(primary, "Berkeley Mono");
    expect(primary.value).toBe("Berkeley Mono");
    expect(patchAppearance).not.toHaveBeenCalled();

    act(() => {
      primary.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(patchAppearance).toHaveBeenCalledWith({
      fontSlots: ["Berkeley Mono", "Fira Code", "Menlo"],
    });
  });

  it("caps system font suggestions instead of rendering every installed font", async () => {
    mocks.listSystemFonts.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => `System Font ${index}`),
    );

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const [primary] = fontInputs();
    focusInput(primary);
    setInputValue(primary, "");

    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox?.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(
      40,
    );
  });

  it("shows clickable font autocomplete suggestions while typing", async () => {
    mocks.listSystemFonts.mockResolvedValue([
      "Berkeley Mono",
      "CommitMono",
      "Recursive Mono",
    ]);

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const [primary] = fontInputs();
    const patchAppearance = useSettings.getState().patchAppearance;

    focusInput(primary);
    setInputValue(primary, "berk");

    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((element) => element.textContent === "Berkeley Mono");
    expect(option).toBeTruthy();

    act(() => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(primary.value).toBe("Berkeley Mono");
    expect(patchAppearance).toHaveBeenCalledWith({
      fontSlots: ["Berkeley Mono", "Fira Code", "Menlo"],
    });
  });

  it("defaults to mono suggestions and can toggle all fonts", async () => {
    mocks.listSystemFonts.mockResolvedValue([
      "Alpha Mono Regular",
      "Alpha Mono Bold",
      "Alpha Sans",
      "Alpha Serif Italic",
    ]);

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const [primary] = fontInputs();
    focusInput(primary);
    setInputValue(primary, "Alpha");

    const monoOptions = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((element) => element.textContent);
    expect(monoOptions).toContain("Alpha Mono");
    expect(monoOptions).not.toContain("Alpha Mono Bold");
    expect(monoOptions).not.toContain("Alpha Sans");

    const scopeSwitch = document.querySelector<HTMLElement>('[role="switch"]');
    expect(scopeSwitch).toBeTruthy();
    act(() => {
      scopeSwitch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const allOptions = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((element) => element.textContent);
    expect(allOptions).toContain("Alpha Mono");
    expect(allOptions).toContain("Alpha Sans");
    expect(allOptions).toContain("Alpha Serif");
    expect(allOptions).not.toContain("Alpha Serif Italic");
  });

  it("renders optional font clear as an icon button inside the input", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const [, secondary] = fontInputs();
    const patchAppearance = useSettings.getState().patchAppearance;
    const secondaryClear = document.querySelector<HTMLButtonElement>(
      '[aria-label="Clear Secondary font"]',
    );

    expect(document.body.textContent).not.toContain("Clear");
    expect(secondaryClear).toBeTruthy();
    expect(secondaryClear?.parentElement?.contains(secondary)).toBe(true);

    act(() => {
      secondaryClear?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(patchAppearance).toHaveBeenCalledWith({
      fontSlots: ["JetBrains Mono", null, "Menlo"],
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
    mocks.listSystemFonts.mockResolvedValue([]);
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
