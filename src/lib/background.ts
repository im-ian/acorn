import { convertFileSrc } from "@tauri-apps/api/core";
import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { readDir, remove } from "@tauri-apps/plugin-fs";
import {
  ensureRealDirectory,
  writeNewPrivateFile,
} from "./safeAppLocalFs";

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
export const MAX_BACKGROUND_IMAGE_BYTES = 25 * 1024 * 1024;
const MANAGED_BACKGROUND_NAME_PATTERN = /^[0-9a-f]{8}\.[a-z0-9]{1,16}$/;

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
  await ensureRealDirectory(dir, "Background image directory");

  return dir;
}

export function isManagedBackgroundRelativePath(
  value: unknown,
): value is string {
  if (typeof value !== "string" || !value.startsWith(`${BG_DIR}/`)) {
    return false;
  }

  const name = value.slice(BG_DIR.length + 1);
  return MANAGED_BACKGROUND_NAME_PATTERN.test(name);
}

function shortHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;

  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

function detectedImageExtension(
  bytes: Uint8Array,
): ".png" | ".jpg" | ".webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return ".png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return ".jpg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}

export async function importBackgroundImage(
  originalName: string,
  bytes: Uint8Array,
): Promise<{ relativePath: string; fileName: string }> {
  if (bytes.byteLength > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error(
      `Background image exceeds the ${MAX_BACKGROUND_IMAGE_BYTES}-byte limit`,
    );
  }
  const extension = detectedImageExtension(bytes);
  if (!extension) {
    throw new Error(
      "Background file is not a supported PNG, JPEG, or WebP image",
    );
  }
  const dir = await ensureBackgroundsDir();

  try {
    const entries = await readDir(dir);
    for (const entry of entries) {
      if (entry.isFile && MANAGED_BACKGROUND_NAME_PATTERN.test(entry.name)) {
        const path = await join(dir, entry.name);
        await remove(path).catch(() => {});
      }
    }
  } catch {
    // Directory may have just been created, so there may be nothing to clean.
  }

  const storedName = `${shortHash(bytes)}${extension}`;
  const absolute = await join(dir, storedName);
  await writeNewPrivateFile(absolute, bytes, "Background image");

  return {
    relativePath: `${BG_DIR}/${storedName}`,
    fileName: originalName,
  };
}

export async function removeBackgroundImage(
  relativePath: string,
): Promise<void> {
  if (!isManagedBackgroundRelativePath(relativePath)) {
    throw new Error("Invalid managed background image path");
  }
  const dir = await ensureBackgroundsDir();
  const absolute = await join(dir, relativePath.slice(BG_DIR.length + 1));
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
  if (!isManagedBackgroundRelativePath(relativePath)) {
    throw new Error("Invalid managed background image path");
  }
  const dir = await ensureBackgroundsDir();
  const absolute = await join(dir, relativePath.slice(BG_DIR.length + 1));
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
