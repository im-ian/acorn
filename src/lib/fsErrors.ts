/**
 * True when a filesystem command failed because the path is gone. Viewers
 * keep the last loaded snapshot in that case instead of replacing it with
 * a path-not-found error.
 */
export function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no such file or directory/i.test(message) ||
    /cannot find the (?:file|path) specified/i.test(message) ||
    /\bos error 2\b/i.test(message)
  );
}
