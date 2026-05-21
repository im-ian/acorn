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
    (element) =>
      element.textContent === "Appearance" || element.textContent === "모양",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Appearance tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openInterfaceTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) =>
      element.textContent === "Interface" ||
      element.textContent === "인터페이스",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Interface tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openTerminalTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) =>
      element.textContent === "Terminal" || element.textContent === "터미널",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Terminal tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openSessionsTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) =>
      element.textContent === "Sessions" || element.textContent === "세션",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Sessions tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openGithubTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent === "GitHub",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("GitHub tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openShortcutsTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) =>
      element.textContent === "Shortcuts" || element.textContent === "단축키",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Shortcuts tab button not found");
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

function blurInput(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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

  it("buffers terminal fontFamily edits until the field loses focus", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openTerminalTab();
    await act(async () => {
      await Promise.resolve();
    });

    const fontFamily = document.querySelector<HTMLInputElement>("input");
    const patchTerminal = useSettings.getState().patchTerminal;
    const bodyText = document.body.textContent ?? "";

    expect(bodyText).toMatch(
      /Font family|settings\.terminal\.fontFamily\.label/,
    );
    expect(bodyText).toMatch(
      /Comma-separated stack\. First family that resolves wins\.|settings\.terminal\.fontFamily\.hint/,
    );
    expect(fontFamily?.value).toBe(DEFAULT_SETTINGS.terminal.fontFamily);

    setInputValue(
      fontFamily as HTMLInputElement,
      '"Berkeley Mono", Menlo, monospace',
    );

    expect(patchTerminal).not.toHaveBeenCalled();

    blurInput(fontFamily as HTMLInputElement);

    expect(patchTerminal).toHaveBeenCalledWith({
      fontFamily: '"Berkeley Mono", Menlo, monospace',
    });
  });

  it("patches terminal cursor style from presets", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openTerminalTab();
    await act(async () => {
      await Promise.resolve();
    });

    const patchTerminal = useSettings.getState().patchTerminal;
    const cursorStyle = Array.from(
      document.querySelectorAll<HTMLSelectElement>("select"),
    ).find((element) => element.value === DEFAULT_SETTINGS.terminal.cursorStyle);

    expect(document.body.textContent).toContain("Cursor style");
    expect(cursorStyle?.textContent).toContain("Block");
    expect(cursorStyle?.textContent).toContain("Bar");
    expect(cursorStyle?.textContent).toContain("Underline");
    expect(cursorStyle?.textContent).toContain("Outline");
    expect(cursorStyle?.textContent).toContain("Pill");
    expect(cursorStyle).toBeInstanceOf(HTMLSelectElement);

    act(() => {
      if (!cursorStyle) throw new Error("Cursor style select not found");
      cursorStyle.value = "pill";
      cursorStyle.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(patchTerminal).toHaveBeenCalledWith({ cursorStyle: "pill" });
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

  it("edits Interface UI scale with presets only", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openInterfaceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const scaleSelect = Array.from(
      document.querySelectorAll<HTMLSelectElement>("select"),
    ).find((element) => element.value === "100");

    expect(document.body.textContent).toContain("UI scale");
    expect(
      document.querySelector('input[aria-label="Custom UI scale percentage"]'),
    ).toBeNull();
    expect(scaleSelect?.value).toBe("100");

    act(() => {
      if (!scaleSelect) throw new Error("UI scale select not found");
      scaleSelect.value = "125";
      scaleSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(useSettings.getState().patchAppearance).toHaveBeenCalledWith({
      uiScalePercent: 125,
    });
  });

  it("renders the Interface language selector in Korean and patches changes", async () => {
    const patchLanguage = vi.fn();
    useSettings.setState({
      settings: {
        ...cloneSettings(),
        language: "ko",
      },
      patchLanguage,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openInterfaceTab();
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("설정");
    expect(document.body.textContent).toContain("인터페이스");
    expect(document.body.textContent).toContain("언어");

    const languageSelect = Array.from(
      document.querySelectorAll<HTMLSelectElement>("select"),
    ).find((element) => element.value === "ko");

    expect(languageSelect).toBeInstanceOf(HTMLSelectElement);
    expect(languageSelect?.textContent).toContain("한국어");

    act(() => {
      if (!languageSelect) throw new Error("Language select not found");
      languageSelect.value = "en";
      languageSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(patchLanguage).toHaveBeenCalledWith("en");
  });

  it("renders Korean Settings chrome and the active panel controls", async () => {
    useSettings.setState({
      settings: {
        ...cloneSettings(),
        language: "ko",
      },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });

    for (const label of [
      "인터페이스",
      "모양",
      "터미널",
      "에이전트",
      "세션",
      "서비스",
      "GitHub",
      "편집기",
      "알림",
      "단축키",
      "저장 공간",
      "실험 기능",
      "정보",
    ]) {
      const button = Array.from(document.querySelectorAll("button")).find(
        (element) => element.textContent === label,
      );
      expect(button, `${label} tab button`).toBeInstanceOf(HTMLButtonElement);
    }

    expect(document.body.textContent).toContain("설정");
    expect(document.body.textContent).toContain("기본값으로 재설정");
    expect(document.body.textContent).toContain("언어");
  });

  it("renders shortcut hints with the edit-coming-soon notice", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openShortcutsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const bodyText = document.body.textContent ?? "";

    expect(bodyText).toContain("Shortcut editing is coming soon.");
    expect(bodyText).toContain("Open command palette");
    expect(bodyText).toContain("New control session");
    expect(bodyText).toContain("Right panel");
    expect(bodyText).toMatch(/⌘P|Ctrl\+P/);
  });

  it("patches the worktree auto-delete session toggle", async () => {
    const patchSessions = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchSessions,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openSessionsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) =>
      input
        .closest("label")
        ?.textContent?.includes("Always delete worktree-backed sessions"),
    );

    expect(document.body.textContent).toContain(
      "Delete worktrees without asking",
    );
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(false);

    act(() => {
      toggle?.click();
    });

    expect(patchSessions).toHaveBeenCalledWith({
      autoDeleteWorktrees: true,
    });
  });

  it("patches the GitHub PR row display toggles", async () => {
    const patchGithub = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchGithub,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openGithubTab();

    const findToggle = (label: string) =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ).find((input) => input.closest("label")?.textContent?.includes(label));

    const labelsToggle = findToggle("Show labels");
    const branchesToggle = findToggle("Show branches");
    const checksToggle = findToggle("Show CI status");

    expect(document.body.textContent).toContain("Show labels");
    expect(document.body.textContent).toContain("Show branches");
    expect(document.body.textContent).toContain("Show CI status");
    expect(labelsToggle).toBeInstanceOf(HTMLInputElement);
    expect(branchesToggle).toBeInstanceOf(HTMLInputElement);
    expect(checksToggle).toBeInstanceOf(HTMLInputElement);
    expect(labelsToggle?.checked).toBe(true);
    expect(branchesToggle?.checked).toBe(true);
    expect(checksToggle?.checked).toBe(true);

    act(() => {
      labelsToggle?.click();
      branchesToggle?.click();
      checksToggle?.click();
    });

    expect(patchGithub).toHaveBeenCalledWith({ showLabels: false });
    expect(patchGithub).toHaveBeenCalledWith({ showBranches: false });
    expect(patchGithub).toHaveBeenCalledWith({ showChecks: false });
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
