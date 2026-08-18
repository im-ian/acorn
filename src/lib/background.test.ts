import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
  readDir: vi.fn(),
}));

const fileHandleMock = vi.hoisted(() => ({
  write: vi.fn(),
  stat: vi.fn(),
  close: vi.fn(),
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
  isManagedBackgroundRelativePath,
  MAX_BACKGROUND_IMAGE_BYTES,
  removeBackgroundImage,
} from "./background";
import { buildXtermTheme } from "./terminalTheme";
import appCss from "../App.css?raw";
import terminalSource from "../components/Terminal.tsx?raw";
import tauriConfigRaw from "../../src-tauri/tauri.conf.json?raw";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

beforeEach(() => {
  tauriPathMock.appLocalDataDir.mockResolvedValue("/app/local");
  tauriPathMock.join.mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/")),
  );
  tauriFsMock.exists.mockResolvedValue(true);
  tauriFsMock.lstat.mockResolvedValue({
    isDirectory: true,
    isSymlink: false,
  });
  let writtenSize = 0;
  fileHandleMock.write.mockImplementation(async (bytes: Uint8Array) => {
    writtenSize = bytes.byteLength;
    return writtenSize;
  });
  fileHandleMock.stat.mockImplementation(async () => ({
    isFile: true,
    isSymlink: false,
    size: writtenSize,
  }));
  fileHandleMock.close.mockResolvedValue(undefined);
  tauriFsMock.open.mockResolvedValue(fileHandleMock);
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
    const bytes = PNG_BYTES;

    const result = await importBackgroundImage("my photo.PNG", bytes);

    expect(tauriFsMock.open).toHaveBeenCalledOnce();
    const [path, options] = tauriFsMock.open.mock.calls[0];
    expect(path).toMatch(/\/app\/local\/backgrounds\/[0-9a-f]{8}\.png$/);
    expect(options).toMatchObject({ write: true, createNew: true, mode: 0o600 });
    expect(fileHandleMock.write).toHaveBeenCalledWith(bytes);
    expect(result.fileName).toBe("my photo.PNG");
    expect(result.relativePath).toMatch(/^backgrounds\/[0-9a-f]{8}\.png$/);
  });

  it("removes only Acorn-managed background files before writing the new one", async () => {
    tauriFsMock.readDir.mockResolvedValueOnce([
      { name: "deadbeef.png", isFile: true },
      { name: "notes.txt", isFile: true },
      { name: "scratch", isFile: false },
    ]);

    await importBackgroundImage("new.png", PNG_BYTES);

    expect(tauriFsMock.remove).toHaveBeenCalledWith(
      "/app/local/backgrounds/deadbeef.png",
    );
    expect(
      tauriFsMock.remove.mock.calls.every(
        ([path]) =>
          !String(path).endsWith("scratch") &&
          !String(path).endsWith("notes.txt"),
      ),
    ).toBe(true);
  });

  it("rejects a symlinked backgrounds directory before reading or writing it", async () => {
    tauriFsMock.lstat.mockResolvedValueOnce({
      isDirectory: false,
      isSymlink: true,
    });

    await expect(importBackgroundImage("new.png", PNG_BYTES)).rejects.toThrow(
      /not a real directory/,
    );
    expect(tauriFsMock.readDir).not.toHaveBeenCalled();
    expect(tauriFsMock.open).not.toHaveBeenCalled();
  });

  it("rejects files whose bytes are not a supported image", async () => {
    await expect(
      importBackgroundImage("disguised.png", new TextEncoder().encode("<html>")),
    ).rejects.toThrow(/not a supported PNG, JPEG, or WebP/);
    expect(tauriFsMock.open).not.toHaveBeenCalled();
  });

  it("rejects image payloads above the persisted size limit", async () => {
    const bytes = new Uint8Array(MAX_BACKGROUND_IMAGE_BYTES + 1);
    bytes.set(PNG_BYTES);

    await expect(importBackgroundImage("huge.png", bytes)).rejects.toThrow(
      /exceeds.*byte limit/,
    );
    expect(tauriFsMock.open).not.toHaveBeenCalled();
  });

  it("rejects persisted paths outside Acorn's managed background namespace", async () => {
    expect(isManagedBackgroundRelativePath("backgrounds/deadbeef.png")).toBe(
      true,
    );
    expect(isManagedBackgroundRelativePath("backgrounds/deadbeef.jpeg")).toBe(
      true,
    );
    expect(isManagedBackgroundRelativePath("../Documents/report.txt")).toBe(
      false,
    );
    expect(isManagedBackgroundRelativePath("backgrounds/../../report.txt")).toBe(
      false,
    );

    await expect(
      removeBackgroundImage("../Documents/report.txt"),
    ).rejects.toThrow(/Invalid managed background image path/);
    expect(tauriFsMock.remove).not.toHaveBeenCalled();
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
      relativePath: "backgrounds/1234abcd.png",
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
      relativePath: "backgrounds/1234abcd.png",
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
    expect(terminalSource).toContain("nextBackground.applyToTerminal");

    const transparentTheme = buildXtermTheme({
      mode: "dark",
      readVar: () => null,
      useTransparentBackground: true,
    });
    expect(transparentTheme.background).toBe("rgba(0, 0, 0, 0)");

    const opaqueTheme = buildXtermTheme({
      mode: "dark",
      readVar: () => null,
      useTransparentBackground: false,
    });
    expect(opaqueTheme.background).not.toBe("rgba(0, 0, 0, 0)");
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
