import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";

import acornDarkCss from "../assets/themes/acorn-dark.css?raw";
import acornLightCss from "../assets/themes/acorn-light.css?raw";
import catppuccinLatteCss from "../assets/themes/catppuccin-latte.css?raw";
import githubLightCss from "../assets/themes/github-light.css?raw";
import oneDarkProCss from "../assets/themes/one-dark-pro.css?raw";
import solarizedLightCss from "../assets/themes/solarized-light.css?raw";
import tokyoNightCss from "../assets/themes/tokyo-night.css?raw";

export type ThemeMode = "dark" | "light";

export interface AcornTheme {
  id: string;
  label: string;
  mode: ThemeMode;
  css: string;
  source: "builtin" | "user";
}

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
    label: "Acorn Dark",
    mode: "dark",
    css: acornDarkCss,
    source: "builtin",
  },
  {
    id: "one-dark-pro",
    label: "One Dark Pro",
    mode: "dark",
    css: oneDarkProCss,
    source: "builtin",
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    css: tokyoNightCss,
    source: "builtin",
  },
  {
    id: "acorn-light",
    label: "Acorn Light",
    mode: "light",
    css: acornLightCss,
    source: "builtin",
  },
  {
    id: "github-light",
    label: "GitHub Light",
    mode: "light",
    css: githubLightCss,
    source: "builtin",
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    css: solarizedLightCss,
    source: "builtin",
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    css: catppuccinLatteCss,
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

async function ensureThemesDir(): Promise<string> {
  const root = await appLocalDataDir();
  const dir = await join(root, USER_THEMES_DIR);

  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }

  return dir;
}

export async function loadUserThemes(): Promise<AcornTheme[]> {
  try {
    const dir = await ensureThemesDir();
    const entries = await readDir(dir);
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

      themes.push({
        id,
        label: humanize(id),
        mode: css.includes("/* @mode light */") ? "light" : "dark",
        css,
        source: "user",
      });
    }

    return themes;
  } catch (err) {
    console.warn("[acorn] failed to load user themes", err);
    return [];
  }
}

export async function revealThemesFolder(): Promise<void> {
  const dir = await ensureThemesDir();
  await openPath(dir);
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
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}
