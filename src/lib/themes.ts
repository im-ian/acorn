import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import {
  exists,
  lstat,
  open,
  readDir,
  remove,
  writeTextFile,
  type DirEntry,
} from "@tauri-apps/plugin-fs";
import { create } from "zustand";
import { ensureRealDirectory } from "./safeAppLocalFs";
import { openExternalUrlWithFeedback } from "./externalOpener";

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
const MAX_THEME_CATALOG_BYTES = 256 * 1024;
const MAX_INSTALLED_THEME_METADATA_BYTES = 256 * 1024;
const MAX_THEME_CSS_BYTES = 1_000_000;
const THEME_REQUEST_TIMEOUT_MS = 15_000;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sameFileIdentity(
  before: Awaited<ReturnType<typeof lstat>>,
  opened: Awaited<ReturnType<typeof lstat>>,
): boolean {
  if (
    typeof before.dev === "number" &&
    typeof before.ino === "number" &&
    typeof opened.dev === "number" &&
    typeof opened.ino === "number"
  ) {
    return before.dev === opened.dev && before.ino === opened.ino;
  }
  return before.size === opened.size;
}

async function readBoundedRegularTextFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const before = await lstat(path);
  if (
    !before.isFile ||
    before.isSymlink ||
    before.size > maxBytes ||
    before.size < 0
  ) {
    throw new Error(`${label} is too large or not a regular file`);
  }

  const file = await open(path, { read: true });
  try {
    const opened = await file.stat();
    if (
      !opened.isFile ||
      opened.isSymlink ||
      opened.size > maxBytes ||
      opened.size < 0 ||
      !sameFileIdentity(before, opened)
    ) {
      throw new Error(`${label} changed or exceeded its limit while opening`);
    }

    const bytes = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = await file.read(bytes.subarray(offset));
      if (count === null) break;
      if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) {
        throw new Error(`${label} returned an invalid read length`);
      }
      offset += count;
    }
    if (offset > maxBytes) {
      throw new Error(`${label} grew beyond its ${maxBytes}-byte limit`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    await file.close();
  }
}

function normalizeCssSecurityTokens(css: string): string {
  // Match CSS Syntax preprocessing before scanning. In particular, CRLF is
  // one newline, which can be consumed as the optional terminator of a hex
  // escape (for example `u\\72\r\nl` becomes `url`).
  const input = css
    .replace(/\r\n?|\f/g, "\n")
    .replace(/\0/g, "\ufffd");
  let normalized = "";
  let index = 0;

  const consumeEscape = (): string => {
    index += 1; // Backslash.
    if (index >= input.length) return "";

    if (index < input.length && /[0-9a-f]/i.test(input[index])) {
      const start = index;
      while (index < input.length && index - start < 6) {
        if (!/[0-9a-f]/i.test(input[index])) break;
        index += 1;
      }
      const codePoint = Number.parseInt(input.slice(start, index), 16);
      if (/[\t\n ]/.test(input[index] ?? "")) index += 1;
      return codePoint === 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? "\ufffd"
        : String.fromCodePoint(codePoint);
    }

    const escaped = input[index];
    index += 1;
    // A newline is not a valid escape outside a string. Separating adjacent
    // identifiers is conservative and avoids manufacturing a false token.
    return escaped === "\n" ? " " : escaped;
  };

  const consumeString = (quote: string): void => {
    index += 1;
    while (index < input.length) {
      const current = input[index];
      if (current === quote) {
        index += 1;
        return;
      }
      // An unescaped newline ends a CSS string as a bad-string token. Leave it
      // for the outer scanner so following declarations are still inspected.
      if (current === "\n") return;
      if (current === "\\") {
        if (input[index + 1] === "\n") {
          index += 2;
        } else {
          consumeEscape();
        }
        continue;
      }
      index += 1;
    }
  };

  while (index < input.length) {
    const current = input[index];
    if (current === '"' || current === "'") {
      // String contents cannot create a request by themselves. Keep a token
      // boundary, while still detecting an enclosing @import outside it.
      normalized += " ";
      consumeString(current);
      continue;
    }
    if (current === "/" && input[index + 1] === "*") {
      index += 2;
      const end = input.indexOf("*/", index);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    if (current === "\\") {
      normalized += consumeEscape();
      continue;
    }
    normalized += current;
    index += 1;
  }

  return normalized;
}

function containsCatalogNetworkPrimitive(css: string): boolean {
  const normalized = normalizeCssSecurityTokens(css);
  return (
    /(?:^|[^\w-])(?:url|src|image|(?:-webkit-)?image-set)\s*\(/i.test(
      normalized,
    ) || /@\s*import\b/i.test(normalized)
  );
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
      throw new Error(`${label} is too large`);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`${label} is too large`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function withThemeResponse<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    THEME_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    window.clearTimeout(timeout);
  }
}

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
  return withThemeResponse(
    THEME_CATALOG_URL,
    {
      cache: "no-store",
      headers: { Accept: "application/json" },
    },
    async (response) => {
      if (!response.ok) {
        throw new Error(`Theme catalog request failed: ${response.status}`);
      }
      const body = await readBoundedResponseText(
        response,
        MAX_THEME_CATALOG_BYTES,
        "Theme catalog",
      );
      return parseThemeCatalog(JSON.parse(body));
    },
  );
}

async function ensureThemesDir(): Promise<string> {
  const root = await appLocalDataDir();
  const dir = await join(root, USER_THEMES_DIR);
  await ensureRealDirectory(dir, "User themes directory");

  return dir;
}

async function assertRegularFileOrMissing(
  path: string,
  label: string,
): Promise<boolean> {
  if (!(await exists(path))) return false;

  const info = await lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`${label} is not a regular file`);
  }
  return true;
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
    throw new Error("Invalid installed theme metadata");
  }

  const installed: Record<string, InstalledCatalogTheme> = {};
  for (const [id, entry] of Object.entries(value.installed)) {
    if (
      !THEME_ID_PATTERN.test(id) ||
      !isRecord(entry) ||
      typeof entry.label !== "string" ||
      entry.label.trim().length === 0 ||
      !isThemeMode(entry.mode) ||
      !Number.isSafeInteger(entry.version) ||
      (entry.version as number) < 1 ||
      entry.file !== `${id}.css`
    ) {
      throw new Error(`Invalid installed theme metadata for ${id}`);
    }
    installed[id] = {
      label: entry.label.trim(),
      mode: entry.mode,
      version: entry.version as number,
      file: entry.file,
    };
  }
  return { schemaVersion: 1, installed };
}

async function readInstalledMetadata(
  dir: string,
  entries?: DirEntry[],
): Promise<InstalledThemeMetadata> {
  const path = await join(dir, INSTALLED_METADATA_FILE);
  if (!(await exists(path))) {
    // `exists()` delegates to `Path::exists()`, which reports a metadata
    // access failure as `false`. Taking that at face value would report an
    // unreadable catalog as empty, and the next write would overwrite the real
    // installed-theme records. Confirm against the directory listing, which
    // fails loudly instead of guessing.
    const directoryEntries = entries ?? (await readDir(dir));
    if (
      !directoryEntries.some((entry) => entry.name === INSTALLED_METADATA_FILE)
    ) {
      return emptyInstalledMetadata();
    }
  }
  const contents = await readBoundedRegularTextFile(
    path,
    MAX_INSTALLED_THEME_METADATA_BYTES,
    "Installed theme metadata",
  );
  return installedMetadataFromUnknown(JSON.parse(contents));
}

async function writeInstalledMetadata(
  dir: string,
  metadata: InstalledThemeMetadata,
): Promise<void> {
  const path = await join(dir, INSTALLED_METADATA_FILE);
  const contents = `${JSON.stringify(metadata, null, 2)}\n`;
  if (
    new TextEncoder().encode(contents).byteLength >
    MAX_INSTALLED_THEME_METADATA_BYTES
  ) {
    throw new Error("Installed theme metadata is too large");
  }
  await assertRegularFileOrMissing(path, "Installed theme metadata");
  await writeTextFile(path, contents);
}

export async function loadUserThemes(): Promise<AcornTheme[]> {
  try {
    const dir = await ensureThemesDir();
    const entries = await readDir(dir);
    const metadata = await readInstalledMetadata(dir, entries);
    const themes: AcornTheme[] = [];

    for (const entry of entries) {
      if (!entry.isFile || !entry.name?.endsWith(".css")) {
        continue;
      }

      const id = entry.name.replace(/\.css$/, "");
      const path = await join(dir, entry.name);
      const installed = metadata.installed[id];
      let css: string;
      try {
        css = await readBoundedRegularTextFile(
          path,
          MAX_THEME_CSS_BYTES,
          `Theme ${entry.name}`,
        );
      } catch (error) {
        console.warn("[acorn] skipping theme %s:", entry.name, error);
        continue;
      }

      if (installed?.file === entry.name) {
        try {
          assertCatalogThemeCss(id, css);
        } catch (error) {
          console.warn(
            "[acorn] skipping catalog theme %s:",
            entry.name,
            error,
          );
          continue;
        }
      }

      const result = validateThemeCss(css);

      if (!result.ok) {
        console.warn(
          "[acorn] skipping theme %s: missing %s",
          entry.name,
          result.missing.join(", "),
        );
        continue;
      }

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
  if (containsCatalogNetworkPrimitive(css)) {
    throw new Error(`Theme ${id} cannot load external CSS resources`);
  }
  const validation = validateThemeCss(css);
  if (!validation.ok) {
    throw new Error(
      `Theme ${id} is missing required variables: ${validation.missing.join(", ")}`,
    );
  }
  if (!catalogThemeTargetsId(css, id)) {
    throw new Error(`Theme ${id} does not target its catalog id`);
  }
}

function catalogThemeTargetsId(css: string, id: string): boolean {
  const attribute = "data-acorn-theme";
  let searchFrom = 0;
  while (searchFrom < css.length) {
    const attributeIndex = css.indexOf(attribute, searchFrom);
    if (attributeIndex === -1) return false;
    let cursor = attributeIndex + attribute.length;
    while (cursor < css.length && isCssWhitespace(css[cursor])) cursor += 1;
    if (css[cursor] !== "=") {
      searchFrom = cursor;
      continue;
    }
    cursor += 1;
    while (cursor < css.length && isCssWhitespace(css[cursor])) cursor += 1;
    const quote = css[cursor];
    if (quote !== '"' && quote !== "'") {
      searchFrom = cursor + 1;
      continue;
    }
    const valueStart = cursor + 1;
    const valueEnd = css.indexOf(quote, valueStart);
    if (valueEnd === -1) return false;
    if (css.slice(valueStart, valueEnd) === id) return true;
    searchFrom = valueEnd + 1;
  }
  return false;
}

function isCssWhitespace(value: string | undefined): boolean {
  return value !== undefined && " \t\n\f\r".includes(value);
}

export async function installCatalogTheme(
  theme: ThemeCatalogEntry,
): Promise<void> {
  const catalogTheme = catalogEntryFromUnknown(theme);
  const css = await withThemeResponse(
    new URL(catalogTheme.file, THEME_CATALOG_URL),
    {
      cache: "no-store",
      headers: { Accept: "text/css" },
    },
    async (response) => {
      if (!response.ok) {
        throw new Error(`Theme download failed: ${response.status}`);
      }
      return readBoundedResponseText(
        response,
        MAX_THEME_CSS_BYTES,
        `Theme ${catalogTheme.id}`,
      );
    },
  );
  assertCatalogThemeCss(catalogTheme.id, css);

  const dir = await ensureThemesDir();
  const file = `${catalogTheme.id}.css`;
  const path = await join(dir, file);
  const metadata = await readInstalledMetadata(dir);

  await assertRegularFileOrMissing(path, `Theme ${catalogTheme.id}`);
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
  if (await assertRegularFileOrMissing(path, `Theme ${id}`)) {
    await remove(path);
  }
  delete metadata.installed[id];
  await writeInstalledMetadata(dir, metadata);
}

export async function revealThemesFolder(): Promise<void> {
  await invoke("reveal_themes_folder");
}

export async function openThemePreview(): Promise<void> {
  await openExternalUrlWithFeedback(THEME_PREVIEW_URL);
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
