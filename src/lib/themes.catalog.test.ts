import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriFsMock = vi.hoisted(() => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  remove: vi.fn(),
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
