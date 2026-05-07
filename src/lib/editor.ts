import { openPath } from "@tauri-apps/plugin-opener";
import { api } from "./api";
import { useSettings } from "./settings";

/**
 * Open `absolutePath` in the user's editor.
 *
 * - When `editor.command` is configured (e.g. `"code"` or `"cursor --wait"`),
 *   spawn that command with the path appended as the last argument.
 * - Otherwise, hand the path to the OS via `tauri-plugin-opener`, which
 *   resolves it through the user's default file association.
 */
export async function openFileInEditor(absolutePath: string): Promise<void> {
  const cmd = useSettings.getState().settings.editor.command.trim();
  if (cmd) {
    const parts = cmd.split(/\s+/);
    const program = parts[0];
    const args = parts.slice(1);
    await api.openInEditor(program, args, absolutePath);
    return;
  }
  await openPath(absolutePath);
}

/** Strict variant of {@link openFileInEditor}: only spawns the configured
 * editor command. Returns false when no editor is configured so the caller
 * can prompt the user (e.g. open settings) instead of silently falling
 * through to the OS default — which for a folder ends up as Finder. */
export async function openInConfiguredEditor(
  absolutePath: string,
): Promise<boolean> {
  const cmd = useSettings.getState().settings.editor.command.trim();
  if (!cmd) return false;
  const parts = cmd.split(/\s+/);
  const program = parts[0];
  const args = parts.slice(1);
  await api.openInEditor(program, args, absolutePath);
  return true;
}

/** True when the user has configured an editor command in settings. */
export function hasConfiguredEditor(): boolean {
  return useSettings.getState().settings.editor.command.trim().length > 0;
}
