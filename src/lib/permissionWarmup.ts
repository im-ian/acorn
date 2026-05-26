const STORAGE_KEY = "acorn:folder-permission-warmup:v1";

export type FolderPermissionWarmupStatus =
  | "ok"
  | "missing"
  | "denied"
  | "error";

export interface FolderPermissionWarmupResult {
  id: "desktop" | "documents" | "downloads" | "icloud";
  path: string;
  status: FolderPermissionWarmupStatus;
  error: string | null;
}

export function isMacPlatform(platform: string): boolean {
  return platform.startsWith("Mac");
}

export function shouldShowPermissionWarmup(
  currentVersion: string | null,
  platform: string,
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  if (!currentVersion) return false;
  if (!isMacPlatform(platform)) return false;
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) !== currentVersion;
  } catch {
    return false;
  }
}

export function markPermissionWarmupHandled(
  version: string,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, version);
  } catch {
    // localStorage can be unavailable in private / restricted contexts.
  }
}

function browserStorage(): Storage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export const PERMISSION_WARMUP_STORAGE_KEY = STORAGE_KEY;
