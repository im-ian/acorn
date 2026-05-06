/**
 * Join a base directory with a repo-relative path. Used to resolve diff/staged
 * file paths against a session's worktree before opening them in the editor.
 *
 * The result is a forward-slash absolute path. macOS and Linux use `/`
 * natively; Tauri's opener accepts forward slashes on Windows too.
 */
export function joinPath(base: string, rel: string): string {
  const trimmed = rel.replace(/^\/+/, "");
  if (base.endsWith("/")) return `${base}${trimmed}`;
  return `${base}/${trimmed}`;
}
