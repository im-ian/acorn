import { writeText as writeNativeText } from "@tauri-apps/plugin-clipboard-manager";

type TauriRuntimeWindow = Window & { __TAURI_INTERNALS__?: unknown };

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as TauriRuntimeWindow)
  );
}

/**
 * Write plain text through the native clipboard in the desktop app. Browser
 * development keeps the standard API fallback because no Tauri runtime is
 * present there.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriRuntime()) {
    await writeNativeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
