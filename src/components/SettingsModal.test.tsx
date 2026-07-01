import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  themes: [
    {
      css: "",
      id: "acorn-dark",
      label: "Acorn Dark Green",
      mode: "dark" as const,
      source: "builtin" as const,
    },
    {
      css: "",
      id: "acorn-pink",
      label: "Acorn Dark Pink",
      mode: "dark" as const,
      source: "builtin" as const,
    },
    {
      css: "",
      id: "one-dark-pro",
      label: "One Dark Pro",
      mode: "dark" as const,
      source: "builtin" as const,
    },
    {
      css: "",
      id: "acorn-light",
      label: "Acorn Light Green",
      mode: "light" as const,
      source: "builtin" as const,
    },
    {
      css: "",
      id: "acorn-light-pink",
      label: "Acorn Light Pink",
      mode: "light" as const,
      source: "builtin" as const,
    },
    {
      css: "",
      id: "github-light",
      label: "GitHub Light",
      mode: "light" as const,
      source: "builtin" as const,
    },
    {
      css: "",
      id: "solarized-local",
      label: "Solarized Local",
      mode: "dark" as const,
      source: "user" as const,
    },
  ],
  importBackgroundImage: vi.fn<
    (name: string, bytes: Uint8Array) => Promise<{ relativePath: string; fileName: string }>
  >(),
  removeBackgroundImage: vi.fn<() => Promise<void>>(),
  previewSessionTitle: vi.fn<
    (
      ai: {
        provider: "claude" | "antigravity" | "codex" | "ollama" | "llm" | "custom";
        ollamaModel?: string | null;
        llmModel?: string | null;
      },
      prompt: string,
      firstUserMessage: string,
      repoPath?: string | null,
    ) => Promise<string>
  >(),
  getAcornIpcStatus: vi.fn(),
  daemonStatus: vi.fn(),
  daemonListSessions: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    previewSessionTitle: mocks.previewSessionTitle,
    getAcornIpcStatus: mocks.getAcornIpcStatus,
    daemonStatus: mocks.daemonStatus,
    daemonListSessions: mocks.daemonListSessions,
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
  BUILT_IN_THEMES: mocks.themes.filter((theme) => theme.source === "builtin"),
  revealThemesFolder: vi.fn(),
  useThemes: (selector: (state: unknown) => unknown) =>
    selector({
      refresh: vi.fn(),
      themes: mocks.themes,
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

import { api } from "../lib/api";
import {
  DEFAULT_SETTINGS,
  SESSION_TITLE_PROMPT_PREVIEW_MESSAGE,
  useSettings,
} from "../lib/settings";
import { useAppStore } from "../store";
import { SettingsModal } from "./SettingsModal";

const mockApi = vi.mocked(api);

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

function openAgentsTab() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) =>
      element.textContent === "Agents" || element.textContent === "에이전트",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Agents tab button not found");
  }
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function openSessionTitlePromptDialog() {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element) =>
      element.getAttribute("aria-label") === "Configure title prompt" ||
      element.getAttribute("aria-label") === "제목 프롬프트 설정",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Session title prompt settings button not found");
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
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

function getComboboxByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Combobox not found: ${label}`);
  return button;
}

function clickElement(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function getSelectSearchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("[data-select-search]");
  if (!input) throw new Error("Select search input not found");
  return input;
}

function clickOption(label: string) {
  const optionLabel = Array.from(
    document.querySelectorAll("[data-select-option-label]"),
  ).find((element) => element.textContent?.trim() === label);
  const option = optionLabel?.closest('[role="option"]');
  if (!(option instanceof HTMLElement)) {
    throw new Error(`Select option not found: ${label}`);
  }
  clickElement(option);
}

function pressKey(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
      }),
    );
  });
}

function optionLabels(): string[] {
  return Array.from(
    document.querySelectorAll("[data-select-option-label]"),
  ).map((option) => option.textContent?.trim() ?? "");
}

function separatorLabels(): string[] {
  return Array.from(
    document.querySelectorAll("[data-select-separator]"),
  ).map((separator) => separator.textContent?.trim() ?? "");
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
    mocks.getAcornIpcStatus.mockResolvedValue({
      bundled_path: "/Applications/Acorn.app/Contents/MacOS/acorn-ipc",
      bundled_exists: true,
      shim_paths: [],
    });
    mocks.daemonStatus.mockResolvedValue({
      running: false,
      enabled: true,
      daemon_version: null,
      uptime_seconds: null,
      session_count_total: null,
      session_count_alive: null,
      log_path: null,
      last_error: null,
    });
    mocks.daemonListSessions.mockResolvedValue([]);
    useSettings.setState({
      open: true,
      settings: cloneSettings(),
      patchInterface: vi.fn(),
      patchAppearance: vi.fn(),
      patchTerminal: vi.fn(),
    });
    useAppStore.setState({ activeProject: null });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("shows only supported agents in the requested order", async () => {
    useSettings.setState({
      open: true,
      settings: cloneSettings(),
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAgentsTab();

    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="acorn-agent"]'),
    );
    expect(radios.map((radio) => radio.value)).toEqual([
      "claude",
      "codex",
      "antigravity",
      "custom",
    ]);
    expect(document.body.textContent).toContain("Claude Code");
    expect(document.body.textContent).toContain("Codex");
    expect(document.body.textContent).toContain("Antigravity");
    expect(document.body.textContent).toContain("Custom Command");
    expect(document.body.textContent).not.toContain("Ollama");
    expect(document.body.textContent).not.toContain("llm CLI");
  });

  it("patches the default workspace mode from the Interface tab", async () => {
    const patchInterface = vi.fn();
    useSettings.setState({
      open: true,
      settings: cloneSettings(),
      patchInterface,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openInterfaceTab();

    clickElement(getComboboxByLabel("Default workspace mode"));
    clickOption("Kanban");

    expect(patchInterface).toHaveBeenCalledWith({
      defaultWorkspaceViewMode: "kanban",
    });
  });

  it("patches kanban terminal popover options from the Interface tab", async () => {
    const patchInterface = vi.fn();
    useSettings.setState({
      open: true,
      settings: cloneSettings(),
      patchInterface,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openInterfaceTab();

    const centerInput = document.querySelector<HTMLInputElement>(
      'input[name="kanban-terminal-popover-placement"][value="center"]',
    );
    const fullscreenInput = document.querySelector<HTMLInputElement>(
      'input[name="kanban-terminal-popover-default-size"][value="fullscreen"]',
    );
    if (!centerInput || !fullscreenInput) {
      throw new Error("Kanban terminal popover settings not found");
    }

    act(() => {
      centerInput.click();
    });
    act(() => {
      fullscreenInput.click();
    });

    expect(patchInterface).toHaveBeenNthCalledWith(1, {
      kanbanTerminalPopoverPlacement: "center",
    });
    expect(patchInterface).toHaveBeenNthCalledWith(2, {
      kanbanTerminalPopoverDefaultSize: "fullscreen",
    });
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

  it("patches decimal terminal font size from the Terminal tab", async () => {
    const patchTerminal = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchTerminal,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openTerminalTab();
    await act(async () => {
      await Promise.resolve();
    });

    const label = Array.from(document.querySelectorAll("span")).find(
      (element) => element.textContent === "Font size",
    );
    const field = label?.parentElement;
    const valueInput = field?.querySelector<HTMLInputElement>(
      'input[aria-label="Value"]',
    );

    expect(valueInput?.value).toBe("12");

    setInputValue(valueInput as HTMLInputElement, "13.37");
    blurInput(valueInput as HTMLInputElement);

    expect(patchTerminal).toHaveBeenCalledWith({ fontSize: 13.37 });
  });

  it("patches terminal letter spacing from the Terminal tab", async () => {
    const patchTerminal = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchTerminal,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openTerminalTab();
    await act(async () => {
      await Promise.resolve();
    });

    const label = Array.from(document.querySelectorAll("span")).find(
      (element) => element.textContent === "Letter spacing",
    );
    const field = label?.parentElement;
    const increase = Array.from(field?.querySelectorAll("button") ?? []).find(
      (element) => element.getAttribute("aria-label") === "Increase",
    );

    const valueInput = field?.querySelector<HTMLInputElement>(
      'input[aria-label="Value"]',
    );

    expect(valueInput?.value).toBe("0");
    expect(increase).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      increase?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(patchTerminal).toHaveBeenCalledWith({ letterSpacing: 0.25 });

    patchTerminal.mockClear();
    setInputValue(valueInput as HTMLInputElement, "0.75");
    blurInput(valueInput as HTMLInputElement);

    expect(patchTerminal).toHaveBeenCalledWith({ letterSpacing: 0.75 });
  });

  it("patches terminal anti-aliasing from the Terminal tab", async () => {
    const patchTerminal = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchTerminal,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openTerminalTab();
    await act(async () => {
      await Promise.resolve();
    });

    const select = getComboboxByLabel("Anti-aliasing");
    expect(select.textContent).toContain("Grayscale");

    clickElement(select);
    clickOption("Subpixel");

    expect(patchTerminal).toHaveBeenCalledWith({ fontSmoothing: "subpixel" });
  });

  it("patches terminal right-click selection paste from the Terminal tab", async () => {
    const patchTerminal = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchTerminal,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openTerminalTab();
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) =>
      input
        .closest("label")
        ?.textContent?.includes("Paste selected text on right-click"),
    );

    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(false);

    act(() => {
      toggle?.click();
    });

    expect(patchTerminal).toHaveBeenCalledWith({
      rightClickPasteSelection: true,
    });
  });

  it("patches the resident terminal limit from the Sessions tab", async () => {
    const patchTerminal = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchTerminal,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openSessionsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const label = Array.from(document.querySelectorAll("span")).find(
      (element) => element.textContent === "Resident terminal limit",
    );
    const field = label?.parentElement;
    const increase = Array.from(field?.querySelectorAll("button") ?? []).find(
      (element) => element.getAttribute("aria-label") === "Increase",
    );

    expect(
      field?.querySelector<HTMLInputElement>('input[aria-label="Value"]')
        ?.value,
    ).toBe("8");
    expect(increase).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      increase?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(patchTerminal).toHaveBeenCalledWith({ maxMountedTerminals: 9 });
  });

  it("patches the resident terminal limit toggle from the Sessions tab", async () => {
    const patchTerminal = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchTerminal,
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
        ?.textContent?.includes("Detach off-screen terminals over the limit"),
    );

    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(true);

    act(() => {
      toggle?.click();
    });

    expect(patchTerminal).toHaveBeenCalledWith({
      detachOffscreenTerminals: false,
    });
  });

  it("disables the resident terminal limit stepper when the toggle is off", async () => {
    const settings = cloneSettings();
    settings.terminal.detachOffscreenTerminals = false;
    useSettings.setState({
      settings,
      patchTerminal: vi.fn(),
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openSessionsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const label = Array.from(document.querySelectorAll("span")).find(
      (element) => element.textContent === "Resident terminal limit",
    );
    const field = label?.parentElement;
    const increase = Array.from(field?.querySelectorAll("button") ?? []).find(
      (element) => element.getAttribute("aria-label") === "Increase",
    );
    const valueInput = field?.querySelector<HTMLInputElement>(
      'input[aria-label="Value"]',
    );

    expect(valueInput?.disabled).toBe(true);
    expect(increase).toBeInstanceOf(HTMLButtonElement);
    expect((increase as HTMLButtonElement | undefined)?.disabled).toBe(true);
  });

  it("maps legacy Services deep links to the Sessions tab", async () => {
    useSettings.setState({
      open: false,
      settings: cloneSettings(),
    });
    useSettings.getState().openTab("services");

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Session lifecycle");
    expect(document.body.textContent).toContain("Session runtime");
    expect(document.body.textContent).not.toContain("Language");
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

  it("renders searchable grouped theme options with separators including user themes", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const themeSelect = getComboboxByLabel("Theme");
    expect(themeSelect.textContent).toContain("Acorn Dark Green");
    expect(document.querySelector("[data-select-search]")).toBeNull();

    clickElement(themeSelect);

    expect(
      Array.from(document.querySelectorAll("[data-select-group-label]")).map(
        (element) => element.textContent?.trim(),
      ),
    ).toEqual([
      "Acorn themes",
      "Built-in dark",
      "Built-in light",
      "Custom themes",
    ]);
    expect(separatorLabels()).toEqual([
      "",
      "",
      "",
    ]);
    expect(optionLabels()).toEqual([
      "Acorn Dark Green",
      "Acorn Dark Pink",
      "Acorn Light Green",
      "Acorn Light Pink",
      "One Dark Pro",
      "GitHub Light",
      "Solarized Local (custom)",
    ]);

    const searchInput = getSelectSearchInput();
    expect(searchInput.getAttribute("placeholder")).toBe("Search themes");
    setInputValue(searchInput, "local");

    expect(optionLabels()).toEqual(["Solarized Local (custom)"]);
    expect(separatorLabels()).toEqual([]);

    pressKey(searchInput, "Enter");

    expect(useSettings.getState().patchAppearance).toHaveBeenCalledWith({
      themeId: "solarized-local",
    });
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

    const scaleSelect = getComboboxByLabel("UI scale");

    expect(document.body.textContent).toContain("UI scale");
    expect(
      document.querySelector('input[aria-label="Custom UI scale percentage"]'),
    ).toBeNull();
    expect(scaleSelect.textContent).toContain("100%");

    clickElement(scaleSelect);
    expect(document.querySelector("[data-select-search]")).toBeNull();
    clickOption("125%");

    expect(useSettings.getState().patchAppearance).toHaveBeenCalledWith({
      uiScalePercent: 125,
    });
  });

  it("patches the status bar agent token usage toggle", async () => {
    const patchStatusBar = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchStatusBar,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAppearanceTab();
    await act(async () => {
      await Promise.resolve();
    });

    const input = Array.from(
      document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
    ).find((element) => {
      const label = element.closest("label");
      return label?.textContent?.includes("Agent token usage");
    });

    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.checked).toBe(true);

    act(() => {
      if (!input) throw new Error("Agent token usage checkbox not found");
      input.click();
    });

    expect(patchStatusBar).toHaveBeenCalledWith({ showAgentTokenUsage: false });
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

    const languageSelect = getComboboxByLabel("언어");

    expect(languageSelect).toBeInstanceOf(HTMLButtonElement);
    expect(languageSelect.textContent).toContain("한국어");

    clickElement(languageSelect);
    clickOption("English");

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

  it("renders shortcut hints with editing controls", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openShortcutsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const bodyText = document.body.textContent ?? "";

    expect(bodyText).toContain("Reset all shortcuts");
    expect(bodyText).toContain("Open command palette");
    expect(bodyText).toContain("New control session");
    expect(bodyText).toContain("Right panel");
    expect(bodyText).toContain("Record");
    expect(bodyText).toMatch(/⌘P|Ctrl\+P/);
  });

  it("records and resets a shortcut binding", async () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openShortcutsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const record = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        element.getAttribute("aria-label") ===
        "Record shortcut for Open command palette",
    );
    expect(record).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      record?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Press keys");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "O",
          code: "KeyO",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });

    expect(useSettings.getState().settings.shortcuts.openPalette).toBe(
      "$mod+Shift+o",
    );
    expect(document.body.textContent).toContain("⇧⌘O");

    const reset = Array.from(document.querySelectorAll("button")).find(
      (element) =>
        element.getAttribute("aria-label") ===
        "Reset shortcut for Open command palette",
    );
    expect(reset).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(useSettings.getState().settings.shortcuts.openPalette).toBe(
      "$mod+p",
    );

    Object.defineProperty(navigator, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("patches the isolated worktree cleanup prompt toggle", async () => {
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
        ?.textContent?.includes(
          "Ask before deleting standalone isolated worktrees",
        ),
    );

    expect(document.body.textContent).toContain(
      "Isolated worktree cleanup prompt",
    );
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(true);

    act(() => {
      toggle?.click();
    });

    expect(patchSessions).toHaveBeenCalledWith({
      confirmDeleteIsolatedWorktrees: false,
    });
  });

  it("patches the empty worktree workspace cleanup prompt toggle", async () => {
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
        ?.textContent?.includes(
          "Ask before deleting empty worktree workspace directories",
        ),
    );

    expect(document.body.textContent).toContain(
      "Empty worktree workspace cleanup prompt",
    );
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(true);

    act(() => {
      toggle?.click();
    });

    expect(patchSessions).toHaveBeenCalledWith({
      confirmDeleteEmptyWorktreeWorkspaces: false,
    });
  });

  it("patches the process-exit restart prompt toggle", async () => {
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
        ?.textContent?.includes("Show restart prompt after the process exits"),
    );

    expect(document.body.textContent).toContain("Process-exit restart prompt");
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(true);

    act(() => {
      toggle?.click();
    });

    expect(patchSessions).toHaveBeenCalledWith({
      showRestartPromptOnExit: false,
    });
  });

  it("patches the automatic session title agent toggle", async () => {
    const patchAgents = vi.fn();
    useSettings.setState({
      settings: cloneSettings(),
      patchAgents,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAgentsTab();
    await act(async () => {
      await Promise.resolve();
    });

    const toggle = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) =>
      input
        .closest("label")
        ?.textContent?.includes("Auto-generate session titles"),
    );

    expect(document.body.textContent).toContain("Session titles");
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Session title prompt"]',
      ),
    ).toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).find(
        (button) =>
          button.getAttribute("aria-label") === "Configure title prompt",
      ),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(toggle).toBeInstanceOf(HTMLInputElement);
    expect(toggle?.checked).toBe(true);

    act(() => {
      toggle?.click();
    });

    expect(patchAgents).toHaveBeenCalledWith({
      autoGenerateSessionTitles: false,
    });
  });

  it("patches and resets the session title prompt", async () => {
    const patchAgents = vi.fn();
    useSettings.setState({
      settings: {
        ...cloneSettings(),
        agents: {
          ...cloneSettings().agents,
          sessionTitlePrompt: "Custom naming instructions",
        },
      },
      patchAgents,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAgentsTab();
    await openSessionTitlePromptDialog();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Session title prompt"]',
    );
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea?.value).toBe("Custom naming instructions");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Name the tab in Korean.");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(patchAgents).toHaveBeenCalledWith({
      sessionTitlePrompt: "Name the tab in Korean.",
    });

    const reset = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reset prompt"),
    );
    expect(reset).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      reset?.click();
    });

    expect(patchAgents).toHaveBeenCalledWith({
      sessionTitlePrompt: DEFAULT_SETTINGS.agents.sessionTitlePrompt,
    });
  });

  it("generates a session title prompt preview", async () => {
    mockApi.previewSessionTitle.mockResolvedValueOnce("Preview Tab Titles");
    useAppStore.setState({ activeProject: "/repo/acorn" });
    useSettings.setState({
      settings: cloneSettings(),
      patchAgents: vi.fn(),
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<SettingsModal />);
    });
    openAgentsTab();
    await openSessionTitlePromptDialog();

    const generate = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Generate preview"),
    );
    expect(generate).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      generate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApi.previewSessionTitle).toHaveBeenCalledWith(
      { provider: "claude", ollamaModel: "", llmModel: "" },
      DEFAULT_SETTINGS.agents.sessionTitlePrompt,
      SESSION_TITLE_PROMPT_PREVIEW_MESSAGE,
      "/repo/acorn",
    );
    expect(document.body.textContent).toContain("Preview Tab Titles");
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
