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
  | "app_data"
  | "camera"
  | "microphone"
  | "developer_tools";

export interface MacosPermissionResetResult {
  id: MacosPermissionResetId;
  service: string;
  status: MacosPermissionResetStatus;
  error: string | null;
}

export const FOLDER_PERMISSION_RECHECK_EVENT =
  "acorn:folder-permission-recheck";

const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const MAX_PERMISSION_OUTPUT_TAIL = 512;
const BREW_UNREADABLE_CWD =
  /the current working directory must be readable to [^\r\n]+ to run brew\./i;
const CODEX_PERMISSION_FAILURE =
  /error:\s*operation not permitted \(os error 1\)/i;

export function createFolderPermissionOutputDetector(): {
  push: (bytes: Uint8Array) => boolean;
} {
  const decoder = new TextDecoder();
  let tail = "";
  let detected = false;

  return {
    push(bytes) {
      if (detected || bytes.byteLength === 0) return false;
      const output = (tail + decoder.decode(bytes, { stream: true })).replace(
        ANSI_CSI_SEQUENCE,
        "",
      );
      tail = output.slice(-MAX_PERMISSION_OUTPUT_TAIL);
      detected =
        BREW_UNREADABLE_CWD.test(output) ||
        CODEX_PERMISSION_FAILURE.test(output);
      return detected;
    },
  };
}

export function hasDeniedFolderPermission(
  results: FolderPermissionWarmupResult[],
): boolean {
  return results.some((result) => result.status === "denied");
}

export function isMacPlatform(platform: string): boolean {
  return platform.startsWith("Mac");
}
