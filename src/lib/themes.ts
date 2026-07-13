import { appLocalDataDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";

import acornDarkCss from "../assets/themes/acorn-dark.css?raw";
import acornLightCss from "../assets/themes/acorn-light.css?raw";
import acornLightPinkCss from "../assets/themes/acorn-light-pink.css?raw";
import acornPinkCss from "../assets/themes/acorn-pink.css?raw";

export type ThemeMode = "dark" | "light";
export type ThemeSource = "builtin" | "catalog" | "user";

export interface AcornTheme {
  id: string;
  label: string;
  mode: ThemeMode;
  css: string;
  source: ThemeSource;
  catalogVersion?: number;
}

export interface ThemeCatalogEntry {
  id: string;
  label: string;
  mode: ThemeMode;
  version: number;
  file: string;
}

interface InstalledCatalogTheme {
  label: string;
  mode: ThemeMode;
  version: number;
  file: string;
}

interface InstalledThemeMetadata {
  schemaVersion: 1;
  installed: Record<string, InstalledCatalogTheme>;
}

export const THEME_CATALOG_URL =
  "https://raw.githubusercontent.com/im-ian/acorn-themes/main/manifest.json";
export const THEME_PREVIEW_URL = "https://im-ian.github.io/acorn-themes/";

export const THEME_CSS_VARS = [
  "--color-bg",
  "--color-bg-elevated",
  "--color-bg-sidebar",
  "--color-fg",
  "--color-fg-muted",
  "--color-border",
  "--color-accent",
  "--color-accent-hover",
  "--color-danger",
  "--color-warning",
  "--color-terminal-bg",
  "--color-terminal-fg",
] as const;

export const BUILT_IN_THEMES: ReadonlyArray<AcornTheme> = [
  {
    id: "acorn-dark",
    label: "Acorn Dark Green",
    mode: "dark",
    css: acornDarkCss,
    source: "builtin",
  },
  {
    id: "acorn-pink",
    label: "Acorn Dark Pink",
    mode: "dark",
    css: acornPinkCss,
    source: "builtin",
  },
  {
    id: "acorn-light",
    label: "Acorn Light Green",
    mode: "light",
    css: acornLightCss,
    source: "builtin",
  },
  {
    id: "acorn-light-pink",
    label: "Acorn Light Pink",
    mode: "light",
    css: acornLightPinkCss,
    source: "builtin",
  },
];

export type ValidateResult =
  | { ok: true }
  | { ok: false; missing: string[] };

export function validateThemeCss(css: string): ValidateResult {
  const missing: string[] = [];

  for (const variable of THEME_CSS_VARS) {
    const re = new RegExp(`${variable}\\s*:\\s*[^;\\n]+`);
    if (!re.test(css)) {
      missing.push(variable);
    }
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

const STYLE_ELEMENT_ID = "acorn-theme";
const USER_THEMES_DIR = "themes";
const INSTALLED_METADATA_FILE = "catalog.json";
const MAX_THEME_CSS_BYTES = 1_000_000;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function applyTheme(id: string, css: string): void {
  let styleEl = document.getElementById(STYLE_ELEMENT_ID) as
    | HTMLStyleElement
    | null;

  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ELEMENT_ID;
    document.head.appendChild(styleEl);
  }

  styleEl.textContent = css;
  document.documentElement.setAttribute("data-acorn-theme", id);
}

export function resolveThemeMode(
  themeId: string | null | undefined,
  themes: ReadonlyArray<AcornTheme>,
): ThemeMode {
  return (
    (themes.find((theme) => theme.id === themeId) ?? themes[0])?.mode ?? "dark"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

function catalogEntryFromUnknown(value: unknown): ThemeCatalogEntry {
  if (!isRecord(value)) {
    throw new Error("Theme catalog entry must be an object");
  }

  const { id, label, mode, version, file } = value;
  if (typeof id !== "string" || !THEME_ID_PATTERN.test(id)) {
    throw new Error("Theme catalog contains an invalid id");
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error(`Theme ${id} has an invalid label`);
  }
  if (!isThemeMode(mode)) {
    throw new Error(`Theme ${id} has an invalid mode`);
  }
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error(`Theme ${id} has an invalid version`);
  }
  if (file !== `themes/${id}.css`) {
    throw new Error(`Theme ${id} has an invalid file path`);
  }
  if (BUILT_IN_THEMES.some((theme) => theme.id === id)) {
    throw new Error(`Theme catalog cannot replace built-in theme ${id}`);
  }

  return { id, label: label.trim(), mode, version: version as number, file };
}

export function parseThemeCatalog(value: unknown): ThemeCatalogEntry[] {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported theme catalog schema");
  }
  if (!Array.isArray(value.themes)) {
    throw new Error("Theme catalog is missing its themes list");
  }

  const themes = value.themes.map(catalogEntryFromUnknown);
  const ids = new Set<string>();
  for (const theme of themes) {
    if (ids.has(theme.id)) {
      throw new Error(`Theme catalog contains duplicate id ${theme.id}`);
    }
    ids.add(theme.id);
  }
  return themes;
}

export async function fetchThemeCatalog(): Promise<ThemeCatalogEntry[]> {
  const response = await fetch(THEME_CATALOG_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Theme catalog request failed: ${response.status}`);
  }
  return parseThemeCatalog(await response.json());
}

async function ensureThemesDir(): Promise<string> {
  const root = await appLocalDataDir();
  const dir = await join(root, USER_THEMES_DIR);

  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }

  return dir;
}

function emptyInstalledMetadata(): InstalledThemeMetadata {
  return { schemaVersion: 1, installed: {} };
}

function installedMetadataFromUnknown(value: unknown): InstalledThemeMetadata {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRecord(value.installed)
  ) {
    return emptyInstalledMetadata();
  }

  const installed: Record<string, InstalledCatalogTheme> = {};
  for (const [id, entry] of Object.entries(value.installed)) {
    if (!THEME_ID_PATTERN.test(id) || !isRecord(entry)) continue;
    if (
      typeof entry.label !== "string" ||
      !isThemeMode(entry.mode) ||
      !Number.isSafeInteger(entry.version) ||
      (entry.version as number) < 1 ||
      entry.file !== `${id}.css`
    ) {
      continue;
    }
    installed[id] = {
      label: entry.label,
      mode: entry.mode,
      version: entry.version as number,
      file: entry.file,
    };
  }
  return { schemaVersion: 1, installed };
}

async function readInstalledMetadata(
  dir: string,
): Promise<InstalledThemeMetadata> {
  try {
    const path = await join(dir, INSTALLED_METADATA_FILE);
    if (!(await exists(path))) return emptyInstalledMetadata();
    return installedMetadataFromUnknown(JSON.parse(await readTextFile(path)));
  } catch (error) {
    console.warn("[acorn] failed to read installed theme metadata", error);
    return emptyInstalledMetadata();
  }
}

async function writeInstalledMetadata(
  dir: string,
  metadata: InstalledThemeMetadata,
): Promise<void> {
  const path = await join(dir, INSTALLED_METADATA_FILE);
  await writeTextFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function loadUserThemes(): Promise<AcornTheme[]> {
  try {
    const dir = await ensureThemesDir();
    const [entries, metadata] = await Promise.all([
      readDir(dir),
      readInstalledMetadata(dir),
    ]);
    const themes: AcornTheme[] = [];

    for (const entry of entries) {
      if (!entry.isFile || !entry.name?.endsWith(".css")) {
        continue;
      }

      const id = entry.name.replace(/\.css$/, "");
      const path = await join(dir, entry.name);
      const css = await readTextFile(path);
      const result = validateThemeCss(css);

      if (!result.ok) {
        console.warn(
          `[acorn] skipping theme ${entry.name}: missing ${result.missing.join(
            ", ",
          )}`,
        );
        continue;
      }

      const installed = metadata.installed[id];
      themes.push({
        id,
        label: installed?.label ?? humanize(id),
        mode:
          installed?.mode ??
          (css.includes("/* @mode light */") ? "light" : "dark"),
        css,
        source: installed?.file === entry.name ? "catalog" : "user",
        catalogVersion:
          installed?.file === entry.name ? installed.version : undefined,
      });
    }

    return themes.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    console.warn("[acorn] failed to load user themes", error);
    return [];
  }
}

function assertCatalogThemeCss(id: string, css: string): void {
  if (new TextEncoder().encode(css).byteLength > MAX_THEME_CSS_BYTES) {
    throw new Error(`Theme ${id} is too large`);
  }
  const validation = validateThemeCss(css);
  if (!validation.ok) {
    throw new Error(
      `Theme ${id} is missing required variables: ${validation.missing.join(", ")}`,
    );
  }
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selector = new RegExp(
    `data-acorn-theme\\s*=\\s*["']${escapedId}["']`,
  );
  if (!selector.test(css)) {
    throw new Error(`Theme ${id} does not target its catalog id`);
  }
}

export async function installCatalogTheme(
  theme: ThemeCatalogEntry,
): Promise<void> {
  const catalogTheme = catalogEntryFromUnknown(theme);
  const response = await fetch(new URL(catalogTheme.file, THEME_CATALOG_URL), {
    cache: "no-store",
    headers: { Accept: "text/css" },
  });
  if (!response.ok) {
    throw new Error(`Theme download failed: ${response.status}`);
  }

  const css = await response.text();
  assertCatalogThemeCss(catalogTheme.id, css);

  const dir = await ensureThemesDir();
  const file = `${catalogTheme.id}.css`;
  const path = await join(dir, file);
  const metadata = await readInstalledMetadata(dir);

  await writeTextFile(path, css);
  metadata.installed[catalogTheme.id] = {
    label: catalogTheme.label,
    mode: catalogTheme.mode,
    version: catalogTheme.version,
    file,
  };
  await writeInstalledMetadata(dir, metadata);
}

export async function uninstallCatalogTheme(id: string): Promise<void> {
  if (!THEME_ID_PATTERN.test(id)) {
    throw new Error("Invalid theme id");
  }

  const dir = await ensureThemesDir();
  const metadata = await readInstalledMetadata(dir);
  const installed = metadata.installed[id];
  if (!installed) {
    throw new Error(`Theme ${id} is not managed by the catalog`);
  }

  const path = await join(dir, installed.file);
  if (await exists(path)) {
    await remove(path);
  }
  delete metadata.installed[id];
  await writeInstalledMetadata(dir, metadata);
}

export async function revealThemesFolder(): Promise<void> {
  const dir = await ensureThemesDir();
  await openPath(dir);
}

export async function openThemePreview(): Promise<void> {
  await openUrl(THEME_PREVIEW_URL);
}

export function mergeThemes(
  builtin: ReadonlyArray<AcornTheme>,
  user: ReadonlyArray<AcornTheme>,
): AcornTheme[] {
  const userById = new Map(user.map((theme) => [theme.id, theme]));
  const merged = builtin.map((theme) => userById.get(theme.id) ?? theme);
  const extras = user
    .filter((theme) => !builtin.some((builtIn) => builtIn.id === theme.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  return [...merged, ...extras];
}

function humanize(id: string): string {
  return id
    .split("-")
    .map((word) =>
      word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

export type ThemeCatalogStatus = "idle" | "loading" | "ready" | "error";
export type ThemeOperation = "installing" | "removing";

interface ThemesStore {
  themes: AcornTheme[];
  catalog: ThemeCatalogEntry[];
  catalogStatus: ThemeCatalogStatus;
  catalogError: string | null;
  operations: Record<string, ThemeOperation>;
  setThemes: (next: AcornTheme[]) => void;
  refresh: () => Promise<void>;
  loadCatalog: () => Promise<void>;
  install: (theme: ThemeCatalogEntry) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useThemes = create<ThemesStore>((set, get) => ({
  themes: [...BUILT_IN_THEMES],
  catalog: [],
  catalogStatus: "idle",
  catalogError: null,
  operations: {},
  setThemes: (themes) => set({ themes }),
  refresh: async () => {
    const userThemes = await loadUserThemes();
    set({ themes: mergeThemes(BUILT_IN_THEMES, userThemes) });
  },
  loadCatalog: async () => {
    if (get().catalogStatus === "loading") return;
    set({ catalogStatus: "loading", catalogError: null });
    try {
      const catalog = await fetchThemeCatalog();
      set({ catalog, catalogStatus: "ready" });
    } catch (error) {
      set({ catalogError: errorMessage(error), catalogStatus: "error" });
    }
  },
  install: async (theme) => {
    set((state) => ({
      operations: { ...state.operations, [theme.id]: "installing" },
    }));
    try {
      await installCatalogTheme(theme);
      await get().refresh();
    } finally {
      set((state) => {
        const operations = { ...state.operations };
        delete operations[theme.id];
        return { operations };
      });
    }
  },
  uninstall: async (id) => {
    set((state) => ({
      operations: { ...state.operations, [id]: "removing" },
    }));
    try {
      await uninstallCatalogTheme(id);
      await get().refresh();
    } finally {
      set((state) => {
        const operations = { ...state.operations };
        delete operations[id];
        return { operations };
      });
    }
  },
}));
