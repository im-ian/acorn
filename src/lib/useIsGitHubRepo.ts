import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Per-repo cache for the git-repo + GitHub origin probe. The result rarely
 * changes during a session (only when the user runs `git init` or edits
 * `origin`), so we resolve once per repoPath and reuse across mounts.
 * Concurrent callers for the same repoPath share one in-flight promise.
 */
const cache = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean>>();

async function probe(repoPath: string): Promise<boolean> {
  const cached = cache.get(repoPath);
  if (cached !== undefined) return cached;
  const existing = inFlight.get(repoPath);
  if (existing) return existing;
  const promise = api
    .isGitRepository(repoPath)
    .then(async (isGitRepo) => {
      if (!isGitRepo) {
        cache.set(repoPath, false);
        return false;
      }
      const slug = await api.githubOriginSlug(repoPath);
      const value = slug !== null;
      cache.set(repoPath, value);
      return value;
    })
    .catch((error) => {
      // Hide GitHub-only UI when the repo probe itself fails. This avoids
      // surfacing PR/Actions controls for paths that may not be git repos.
      console.warn("[useIsGitHubRepo] probe failed", error);
      return false;
    })
    .finally(() => {
      inFlight.delete(repoPath);
    });
  inFlight.set(repoPath, promise);
  return promise;
}

export function prefetchGitHubRepoStatus(repoPath: string): Promise<boolean> {
  return probe(repoPath);
}

/**
 * Returns `true` when `repoPath` is inside a git repo with a GitHub `origin`
 * remote, `false` otherwise, or `null` while the first probe is in flight.
 */
export function useIsGitHubRepo(repoPath: string | null): boolean | null {
  const [state, setState] = useState<boolean | null>(() =>
    repoPath ? (cache.get(repoPath) ?? null) : null,
  );

  useEffect(() => {
    if (!repoPath) {
      setState(null);
      return;
    }
    const cached = cache.get(repoPath);
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    setState(null);
    let cancelled = false;
    void probe(repoPath).then((value) => {
      if (cancelled) return;
      setState(value);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  return state;
}

/** Test-only: clear the module-level cache between cases. */
export function __resetIsGitHubRepoCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
