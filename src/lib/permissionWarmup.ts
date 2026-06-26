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

export type MacosPermissionResetStatus = "reset" | "skipped" | "error";

export type MacosPermissionResetId =
  | FolderPermissionWarmupResult["id"]
  | "screen_capture"
  | "accessibility"
  | "automation"
  | "input_monitoring"
  | "camera"
  | "microphone"
  | "developer_tools";

export interface MacosPermissionResetResult {
  id: MacosPermissionResetId;
  service: string;
  status: MacosPermissionResetStatus;
  error: string | null;
}

export function hasDeniedFolderPermission(
  results: FolderPermissionWarmupResult[],
): boolean {
  return results.some((result) => result.status === "denied");
}

export function isMacPlatform(platform: string): boolean {
  return platform.startsWith("Mac");
}
