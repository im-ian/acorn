import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  remove: vi.fn(),
  readDir: vi.fn(),
}));

const tauriPathMock = vi.hoisted(() => ({
  appLocalDataDir: vi.fn(),
  join: vi.fn(),
}));

const tauriCoreMock = vi.hoisted(() => ({
  convertFileSrc: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => tauriFsMock);
vi.mock("@tauri-apps/api/path", () => tauriPathMock);
vi.mock("@tauri-apps/api/core", () => tauriCoreMock);

import {
  applyBackgroundVars,
  backgroundCssVarsForState,
  clearBackgroundVars,
  importBackgroundImage,
} from "./background";
import appCss from "../App.css?raw";
import terminalSource from "../components/Terminal.tsx?raw";
import tauriConfigRaw from "../../src-tauri/tauri.conf.json?raw";

beforeEach(() => {
  tauriPathMock.appLocalDataDir.mockResolvedValue("/app/local");
  tauriPathMock.join.mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/")),
  );
  tauriFsMock.exists.mockResolvedValue(true);
  tauriFsMock.writeFile.mockResolvedValue(undefined);
  tauriFsMock.remove.mockResolvedValue(undefined);
  tauriFsMock.readDir.mockResolvedValue([]);
  tauriCoreMock.convertFileSrc.mockImplementation(
    (path: string) => `asset://localhost/${path}`,
  );
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
  vi.clearAllMocks();
});

describe("importBackgroundImage", () => {
  it("copies the picked file into $APPLOCALDATA/backgrounds with a hashed name", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const result = await importBackgroundImage("my photo.PNG", bytes);

    expect(tauriFsMock.writeFile).toHaveBeenCalledOnce();
    const [path] = tauriFsMock.writeFile.mock.calls[0];
    expect(path).toMatch(/\/app\/local\/backgrounds\/[0-9a-f]{8}\.png$/);
    expect(result.fileName).toBe("my photo.PNG");
    expect(result.relativePath).toMatch(/^backgrounds\/[0-9a-f]{8}\.png$/);
  });

  it("removes any previous file in backgrounds before writing the new one", async () => {
    tauriFsMock.readDir.mockResolvedValueOnce([
      { name: "old.png", isFile: true },
      { name: "scratch", isFile: false },
    ]);

    await importBackgroundImage("new.png", new Uint8Array([5]));

    expect(tauriFsMock.remove).toHaveBeenCalledWith(
      "/app/local/backgrounds/old.png",
    );
    expect(
      tauriFsMock.remove.mock.calls.every(
        ([path]) => !String(path).endsWith("scratch"),
      ),
    ).toBe(true);
  });
});

describe("backgroundCssVarsForState", () => {
  it("returns empty vars when no image", () => {
    expect(
      backgroundCssVarsForState({
        relativePath: null,
        fileName: null,
        fit: "cover",
        opacity: 0.5,
        blur: 0,
        applyToApp: true,
        applyToTerminal: false,
      }),
    ).toEqual({
      "--bg-image-url": "none",
      "--bg-fit-size": "cover",
      "--bg-fit-repeat": "no-repeat",
      "--bg-opacity": "0.5",
      "--bg-blur": "0px",
    });
  });
});

describe("applyBackgroundVars", () => {
  it("maps tile to size=auto + repeat=repeat and resolves to asset url", async () => {
    await applyBackgroundVars({
      relativePath: "backgrounds/abc.png",
      fileName: "x.png",
      fit: "tile",
      opacity: 1,
      blur: 4,
      applyToApp: true,
      applyToTerminal: true,
    });

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--bg-fit-size")).toBe("auto");
    expect(root.style.getPropertyValue("--bg-fit-repeat")).toBe("repeat");
    expect(root.style.getPropertyValue("--bg-image-url")).toMatch(
      /^url\("asset:\/\/localhost\//,
    );
    expect(root.style.getPropertyValue("--bg-blur")).toBe("4px");
    expect(root.getAttribute("data-bg-app")).toBe("on");
    expect(root.getAttribute("data-bg-terminal")).toBe("on");
  });
});

describe("clearBackgroundVars", () => {
  it("clears vars written by applyBackgroundVars", async () => {
    await applyBackgroundVars({
      relativePath: "backgrounds/abc.png",
      fileName: "x.png",
      fit: "cover",
      opacity: 0.5,
      blur: 0,
      applyToApp: true,
      applyToTerminal: false,
    });

    expect(document.documentElement.style.getPropertyValue("--bg-opacity")).toBe(
      "0.5",
    );
    clearBackgroundVars();
    expect(document.documentElement.style.getPropertyValue("--bg-opacity")).toBe(
      "",
    );
  });
});

describe("background overlay CSS", () => {
  it("makes app and terminal surfaces translucent when a background is active", () => {
    expect(appCss).toContain(':root[data-bg-app="on"] .acorn-app-shell .bg-bg');
    expect(appCss).toContain(
      ':root[data-bg-app="on"] .acorn-app-shell .bg-bg-sidebar',
    );
    expect(appCss).toContain(".acorn-terminal-shell");
    expect(appCss).toContain(
      ':root[data-bg-terminal="on"] .acorn-terminal-shell',
    );
  });

  it("keeps foreground surfaces translucent enough for the image to be visible", () => {
    expect(appCss).toContain("var(--color-bg) 64%");
    expect(appCss).toContain("var(--color-bg-sidebar) 62%");
    expect(appCss).toContain("var(--color-bg-elevated) 66%");
    expect(appCss).toContain("var(--color-terminal-bg, #1f2326) 62%");
  });

  it("lets the xterm renderer show the terminal background image", () => {
    expect(terminalSource).toContain("allowTransparency: true");
    expect(terminalSource).toContain(
      'background: useTransparentBackground ? "rgba(0, 0, 0, 0)"',
    );
    expect(terminalSource).toContain("nextBackground.applyToTerminal");
  });

  it("does not paint a second terminal image when the app background is active", () => {
    expect(appCss).toMatch(
      /:root\[data-bg-app="on"\] \.acorn-bg-terminal\s*\{\s*display: none;\s*\}/,
    );
  });
});

describe("Tauri background asset access", () => {
  it("allows the asset protocol to load persisted background images", () => {
    const config = JSON.parse(tauriConfigRaw) as {
      app?: {
        security?: {
          assetProtocol?: {
            enable?: boolean;
            scope?: string[];
          };
        };
      };
    };

    expect(config.app?.security?.assetProtocol?.enable).toBe(true);
    expect(config.app?.security?.assetProtocol?.scope).toContain(
      "$APPLOCALDATA/backgrounds/**/*",
    );
  });
});
