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
