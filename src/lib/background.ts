import { convertFileSrc } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import {
  exists,
  mkdir,
  readDir,
  remove,
  writeFile,
} from "@tauri-apps/plugin-fs";

export type BackgroundFit = "cover" | "contain" | "tile";

export interface BackgroundState {
  relativePath: string | null;
  fileName: string | null;
  fit: BackgroundFit;
  opacity: number;
  blur: number;
  applyToApp: boolean;
  applyToTerminal: boolean;
}

export const BG_DIR = "backgrounds";

const BG_CSS_VARS = [
  "--bg-image-url",
  "--bg-fit-size",
  "--bg-fit-repeat",
  "--bg-opacity",
  "--bg-blur",
];

async function ensureBackgroundsDir(): Promise<string> {
  const root = await appLocalDataDir();
  const dir = await join(root, BG_DIR);

  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }

  return dir;
}

function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;

  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

function extOf(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export async function importBackgroundImage(
  originalName: string,
  bytes: Uint8Array,
): Promise<{ relativePath: string; fileName: string }> {
  const dir = await ensureBackgroundsDir();

  try {
    const entries = await readDir(dir);
    for (const entry of entries) {
      if (entry.isFile) {
        const path = await join(dir, entry.name);
        await remove(path).catch(() => {});
      }
    }
  } catch {
    // Directory may have just been created, so there may be nothing to clean.
  }

  const storedName = `${shortHash(bytes)}${extOf(originalName)}`;
  const absolute = await join(dir, storedName);
  await writeFile(absolute, bytes);

  return {
    relativePath: `${BG_DIR}/${storedName}`,
    fileName: originalName,
  };
}

export async function removeBackgroundImage(
  relativePath: string,
): Promise<void> {
  const root = await appLocalDataDir();
  const absolute = await join(root, relativePath);
  await remove(absolute).catch(() => {});
}

export function backgroundCssVarsForState(
  state: BackgroundState,
): Record<string, string> {
  return {
    "--bg-image-url": state.relativePath ? 'url("PLACEHOLDER")' : "none",
    "--bg-fit-size": state.fit === "tile" ? "auto" : state.fit,
    "--bg-fit-repeat": state.fit === "tile" ? "repeat" : "no-repeat",
    "--bg-opacity": String(state.opacity),
    "--bg-blur": `${state.blur}px`,
  };
}

async function resolveImageUrl(relativePath: string): Promise<string> {
  const root = await appLocalDataDir();
  const absolute = await join(root, relativePath);
  return convertFileSrc(absolute);
}

export async function applyBackgroundVars(
  state: BackgroundState,
): Promise<void> {
  const vars = backgroundCssVarsForState(state);

  if (state.relativePath) {
    const url = await resolveImageUrl(state.relativePath);
    vars["--bg-image-url"] = `url("${url}")`;
  }

  for (const [name, value] of Object.entries(vars)) {
    document.documentElement.style.setProperty(name, value);
  }

  document.documentElement.setAttribute(
    "data-bg-app",
    state.relativePath && state.applyToApp ? "on" : "off",
  );
  document.documentElement.setAttribute(
    "data-bg-terminal",
    state.relativePath && state.applyToTerminal ? "on" : "off",
  );
}

export function clearBackgroundVars(): void {
  for (const name of BG_CSS_VARS) {
    document.documentElement.style.removeProperty(name);
  }
  document.documentElement.removeAttribute("data-bg-app");
  document.documentElement.removeAttribute("data-bg-terminal");
}
