export const DEFAULT_GIT_STAT_PATH_CAP = 256;

export function retainRecentGitStatPaths(
  retained: Set<string>,
  paths: Iterable<string>,
  capacity = DEFAULT_GIT_STAT_PATH_CAP,
): void {
  const limit = Number.isFinite(capacity)
    ? Math.max(1, Math.floor(capacity))
    : DEFAULT_GIT_STAT_PATH_CAP;

  for (const path of paths) {
    retained.delete(path);
    retained.add(path);
    while (retained.size > limit) {
      const oldest = retained.values().next().value;
      if (oldest === undefined) break;
      retained.delete(oldest);
    }
  }
}
