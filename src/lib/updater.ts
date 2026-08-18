import { getVersion } from "@tauri-apps/api/app";
import { fetchLatestReleaseNotes } from "./releases";
import { openSafeUrl } from "./safeOpenUrl";

const UPDATE_OWNER = "im-ian";
const UPDATE_REPO = "acorn";
const MAX_UPDATE_NOTES_BYTES = 2 * 1024 * 1024;
const STABLE_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export interface AvailableUpdate {
  version: string;
  body: string;
  htmlUrl: string;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseStableVersion(value: string): [number, number, number] {
  const match = STABLE_VERSION_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid stable Acorn version: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== currentParts[index]) {
      return candidateParts[index] > currentParts[index];
    }
  }
  return false;
}

/**
 * Update data is notification-only: it can open the canonical GitHub release
 * page, but it never authorizes an executable download or install. Keep the
 * link exact so compromised API content cannot redirect the privileged OS
 * opener to another host or even another repository path.
 */
export function validateAvailableUpdate(update: AvailableUpdate): void {
  parseStableVersion(update.version);
  if (utf8Length(update.body) > MAX_UPDATE_NOTES_BYTES) {
    throw new Error("Update release notes are too large");
  }
  const expected = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/v${update.version}`;
  if (update.htmlUrl !== expected) {
    throw new Error("Update release URL is not the canonical Acorn release");
  }
}

/**
 * Check the bounded GitHub Releases endpoint and return notification metadata
 * only when its stable version is newer than the running app. Runtime update
 * installation is intentionally disabled until Acorn has OS-trusted signing
 * identities; the Tauri updater buffers manifests/artifacts in memory and an
 * unsigned installation cannot establish publisher identity with the OS.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const [currentVersion, release] = await Promise.all([
    getVersion(),
    fetchLatestReleaseNotes(),
  ]);
  const update: AvailableUpdate = {
    version: release.version,
    body: release.body,
    htmlUrl: release.htmlUrl,
  };
  validateAvailableUpdate(update);
  return isNewerVersion(update.version, currentVersion) ? update : null;
}

export async function getCurrentVersion(): Promise<string> {
  return getVersion();
}

/** Open the exact public release page so the user can choose an OS download. */
export async function openUpdateDownload(update: AvailableUpdate): Promise<void> {
  validateAvailableUpdate(update);
  if (!(await openSafeUrl(update.htmlUrl))) {
    throw new Error("Could not open the canonical Acorn release page");
  }
}
