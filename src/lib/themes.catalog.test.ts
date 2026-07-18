import { beforeEach, describe, expect, it, vi } from "vitest";
import defaultCapability from "../../src-tauri/capabilities/default.json";

const tauriFsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
  stat: vi.fn(),
  writeTextFile: vi.fn(),
}));

const tauriPathMock = vi.hoisted(() => ({
  appLocalDataDir: vi.fn(),
  join: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => tauriFsMock);
vi.mock("@tauri-apps/api/path", () => tauriPathMock);
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

import {
  THEME_CSS_VARS,
  fetchThemeCatalog,
  installCatalogTheme,
  loadUserThemes,
  parseThemeCatalog,
  uninstallCatalogTheme,
  type ThemeCatalogEntry,
} from "./themes";

const THEME: ThemeCatalogEntry = {
  id: "note",
  label: "Note",
  mode: "light",
  version: 2,
  file: "themes/note.css",
};

const VALID_CSS = `/* @mode light */
:root[data-acorn-theme="note"] {
${THEME_CSS_VARS.map((variable) => `  ${variable}: #fff;`).join("\n")}
}`;

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  tauriPathMock.appLocalDataDir.mockResolvedValue("/app/local");
  tauriPathMock.join.mockImplementation((...parts: string[]) =>
    Promise.resolve(parts.join("/")),
  );
  tauriFsMock.exists.mockResolvedValue(true);
  tauriFsMock.mkdir.mockResolvedValue(undefined);
  tauriFsMock.readDir.mockResolvedValue([]);
  tauriFsMock.readTextFile.mockResolvedValue("");
  tauriFsMock.remove.mockResolvedValue(undefined);
  tauriFsMock.stat.mockResolvedValue({ isFile: true, size: VALID_CSS.length });
  tauriFsMock.writeTextFile.mockResolvedValue(undefined);
});

describe("parseThemeCatalog", () => {
  it("accepts a versioned catalog with strict theme paths", () => {
    expect(
      parseThemeCatalog({ schemaVersion: 1, themes: [THEME] }),
    ).toEqual([THEME]);
  });

  it("rejects duplicate ids and attempts to replace built-in themes", () => {
    expect(() =>
      parseThemeCatalog({ schemaVersion: 1, themes: [THEME, THEME] }),
    ).toThrow(/duplicate id note/);
    expect(() =>
      parseThemeCatalog({
        schemaVersion: 1,
        themes: [
          {
            ...THEME,
            id: "acorn-dark",
            file: "themes/acorn-dark.css",
          },
        ],
      }),
    ).toThrow(/cannot replace built-in theme acorn-dark/);
  });

  it("rejects paths that do not match the theme id", () => {
    expect(() =>
      parseThemeCatalog({
        schemaVersion: 1,
        themes: [{ ...THEME, file: "../note.css" }],
      }),
    ).toThrow(/invalid file path/);
  });

  it("bounds the remote catalog before JSON parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x", {
          status: 200,
          headers: { "Content-Length": "300000" },
        }),
      ),
    );

    await expect(fetchThemeCatalog()).rejects.toThrow(
      /Theme catalog is too large/,
    );
  });
});

describe("theme filesystem capability", () => {
  it("allows the text writes used for downloaded CSS and catalog metadata", () => {
    expect(defaultCapability.permissions).toContain(
      "fs:allow-write-text-file",
    );
    expect(defaultCapability.permissions).toContain("fs:allow-stat");
  });
});

describe("catalog theme persistence", () => {
  it("downloads validated CSS and records the installed catalog version", async () => {
    tauriFsMock.exists.mockImplementation((path: string) =>
      Promise.resolve(!path.endsWith("catalog.json")),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(VALID_CSS, {
          status: 200,
          headers: { "Content-Type": "text/css" },
        }),
      ),
    );

    await installCatalogTheme(THEME);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(
      "https://raw.githubusercontent.com/im-ian/acorn-themes/main/themes/note.css",
    );
    expect(init).toMatchObject({ cache: "no-store" });
    expect(tauriFsMock.writeTextFile).toHaveBeenNthCalledWith(
      1,
      "/app/local/themes/note.css",
      VALID_CSS,
    );
    const metadata = JSON.parse(
      tauriFsMock.writeTextFile.mock.calls[1][1] as string,
    );
    expect(metadata.installed.note).toEqual({
      label: "Note",
      mode: "light",
      version: 2,
      file: "note.css",
    });
  });

  it("rejects downloaded CSS that targets a different theme id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          VALID_CSS.replace(
            'data-acorn-theme="note"',
            'data-acorn-theme="other"',
          ),
          { status: 200 },
        ),
      ),
    );

    await expect(installCatalogTheme(THEME)).rejects.toThrow(
      /does not target its catalog id/,
    );
    expect(tauriFsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("rejects network-capable CSS including escaped spellings", async () => {
    const unsafeCss = [
      `${VALID_CSS}\n:root { background: url(https://example.invalid/pixel); }`,
      `${VALID_CSS}\n@import "https://example.invalid/theme.css";`,
      String.raw`${VALID_CSS}
:root { cursor: u\72 l(https://example.invalid/cursor); }`,
      String.raw`${VALID_CSS}
@\69 mport "https://example.invalid/theme.css";`,
      `${VALID_CSS}\n:root { background: u/**/rl(https://example.invalid/pixel); }`,
      `${VALID_CSS}\n@im/**/port "https://example.invalid/theme.css";`,
      `${VALID_CSS}\n:root { background: image-set("https://example.invalid/pixel" 1x); }`,
      `${VALID_CSS}\n@font-face { src: src("https://example.invalid/font"); }`,
      `${VALID_CSS}\n:root { --open: "/*"; background: url("https://example.invalid/pixel"); --close: "*/"; }`,
      `${VALID_CSS}\n:root { background: u\\72\r\nl("https://example.invalid/pixel"); }`,
      `${VALID_CSS}\n@\\69\r\nmport "https://example.invalid/theme.css";`,
    ];

    for (const css of unsafeCss) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(css, { status: 200 })),
      );

      await expect(installCatalogTheme(THEME)).rejects.toThrow(
        /cannot load external CSS resources/,
      );
    }

    expect(tauriFsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("bounds downloaded CSS while reading the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x".repeat(1_000_001), { status: 200 }),
      ),
    );

    await expect(installCatalogTheme(THEME)).rejects.toThrow(
      /Theme note is too large/,
    );
    expect(tauriFsMock.writeTextFile).not.toHaveBeenCalled();
  });

  it("loads catalog metadata separately from custom CSS files", async () => {
    tauriFsMock.readDir.mockResolvedValue([
      { isFile: true, name: "note.css" },
      { isFile: true, name: "personal.css" },
    ]);
    tauriFsMock.readTextFile.mockImplementation((path: string) => {
      if (path.endsWith("catalog.json")) {
        return Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            installed: {
              note: {
                label: "Note",
                mode: "light",
                version: 2,
                file: "note.css",
              },
            },
          }),
        );
      }
      return Promise.resolve(
        path.endsWith("note.css")
          ? VALID_CSS
          : VALID_CSS.split("note").join("personal"),
      );
    });

    const themes = await loadUserThemes();

    expect(themes).toEqual([
      expect.objectContaining({
        id: "note",
        label: "Note",
        source: "catalog",
        catalogVersion: 2,
      }),
      expect.objectContaining({
        id: "personal",
        label: "Personal",
        source: "user",
      }),
    ]);
  });

  it("revalidates persisted catalog CSS without restricting user themes", async () => {
    tauriFsMock.readDir.mockResolvedValue([
      { isFile: true, name: "note.css" },
      { isFile: true, name: "personal.css" },
    ]);
    tauriFsMock.readTextFile.mockImplementation((path: string) => {
      if (path.endsWith("catalog.json")) {
        return Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            installed: {
              note: {
                label: "Note",
                mode: "light",
                version: 2,
                file: "note.css",
              },
            },
          }),
        );
      }
      const base = path.endsWith("note.css")
        ? VALID_CSS
        : VALID_CSS.split("note").join("personal");
      return Promise.resolve(
        `${base}\n:root { background: url(https://example.invalid/pixel); }`,
      );
    });

    const themes = await loadUserThemes();

    expect(themes).toEqual([
      expect.objectContaining({
        id: "personal",
        source: "user",
      }),
    ]);
  });

  it("skips oversized persisted catalog CSS before reading it", async () => {
    tauriFsMock.readDir.mockResolvedValue([
      { isFile: true, name: "note.css" },
    ]);
    tauriFsMock.readTextFile.mockImplementation((path: string) => {
      if (path.endsWith("catalog.json")) {
        return Promise.resolve(
          JSON.stringify({
            schemaVersion: 1,
            installed: {
              note: {
                label: "Note",
                mode: "light",
                version: 2,
                file: "note.css",
              },
            },
          }),
        );
      }
      return Promise.reject(new Error("oversized CSS must not be read"));
    });
    tauriFsMock.stat.mockImplementation((path: string) =>
      Promise.resolve({
        isFile: true,
        size: path.endsWith("note.css") ? 1_000_001 : VALID_CSS.length,
      }),
    );

    await expect(loadUserThemes()).resolves.toEqual([]);
    expect(tauriFsMock.readTextFile).toHaveBeenCalledTimes(1);
  });

  it("fails closed before reading oversized installed metadata", async () => {
    tauriFsMock.readDir.mockResolvedValue([
      { isFile: true, name: "personal.css" },
    ]);
    tauriFsMock.stat.mockResolvedValue({ isFile: true, size: 300_000 });
    tauriFsMock.readTextFile.mockRejectedValue(
      new Error("oversized metadata must not be read"),
    );

    await expect(loadUserThemes()).resolves.toEqual([]);
    expect(tauriFsMock.readTextFile).not.toHaveBeenCalled();
  });

  it("fails closed when installed metadata provenance is corrupt", async () => {
    tauriFsMock.readDir.mockResolvedValue([
      { isFile: true, name: "note.css" },
    ]);
    tauriFsMock.readTextFile.mockImplementation((path: string) => {
      if (path.endsWith("catalog.json")) {
        return Promise.resolve('{"schemaVersion":1,"installed":"invalid"}');
      }
      return Promise.reject(new Error("unclassified CSS must not be read"));
    });

    await expect(loadUserThemes()).resolves.toEqual([]);
    expect(tauriFsMock.readTextFile).toHaveBeenCalledTimes(1);
  });

  it("removes only files recorded as catalog-managed", async () => {
    tauriFsMock.readTextFile.mockResolvedValue(
      JSON.stringify({
        schemaVersion: 1,
        installed: {
          note: {
            label: "Note",
            mode: "light",
            version: 2,
            file: "note.css",
          },
        },
      }),
    );

    await uninstallCatalogTheme("note");

    expect(tauriFsMock.remove).toHaveBeenCalledWith(
      "/app/local/themes/note.css",
    );
    const metadata = JSON.parse(
      tauriFsMock.writeTextFile.mock.calls[0][1] as string,
    );
    expect(metadata.installed).toEqual({});

    await expect(uninstallCatalogTheme("personal")).rejects.toThrow(
      /not managed by the catalog/,
    );
  });
});
