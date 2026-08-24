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
// Permission failures are short ASCII lines. TUI frames are kilobytes of CSI;
// inspecting only the tail keeps the detector off the redraw hot path.
const MAX_PERMISSION_INSPECT_BYTES = 1024;
const BREW_UNREADABLE_CWD =
  /the current working directory must be readable to [^\r\n]+ to run brew\./i;
const CODEX_PERMISSION_FAILURE =
  /error:\s*operation not permitted \(os error 1\)/i;

export function createFolderPermissionOutputDetector(): {
  push: (bytes: Uint8Array) => boolean;
} {
  const decoder = new TextDecoder();
  let tail = "";

  return {
    push(bytes) {
      if (bytes.byteLength === 0) return false;
      const slice =
        bytes.byteLength > MAX_PERMISSION_INSPECT_BYTES
          ? bytes.subarray(bytes.byteLength - MAX_PERMISSION_INSPECT_BYTES)
          : bytes;
      const output = (tail + decoder.decode(slice, { stream: true })).replace(
        ANSI_CSI_SEQUENCE,
        "",
      );
      tail = output.slice(-MAX_PERMISSION_OUTPUT_TAIL);
      const detected =
        BREW_UNREADABLE_CWD.test(output) ||
        CODEX_PERMISSION_FAILURE.test(output);
      if (detected) tail = "";
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
