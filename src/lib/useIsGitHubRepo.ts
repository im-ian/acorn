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
const generations = new Map<string, number>();

function generationOf(repoPath: string): number {
  return generations.get(repoPath) ?? 0;
}

async function probe(repoPath: string): Promise<boolean> {
  const cached = cache.get(repoPath);
  if (cached !== undefined) return cached;
  const existing = inFlight.get(repoPath);
  if (existing) return existing;
  const generation = generationOf(repoPath);
  const promise = api
    .isGitRepository(repoPath)
    .then(async (isGitRepo) => {
      if (!isGitRepo) {
        if (generationOf(repoPath) === generation) {
          cache.set(repoPath, false);
        }
        return false;
      }
      const slug = await api.githubOriginSlug(repoPath);
      const value = slug !== null;
      if (generationOf(repoPath) === generation) {
        cache.set(repoPath, value);
      }
      if (generationOf(repoPath) !== generation) return false;
      return value;
    })
    .catch((error) => {
      // Hide GitHub-only UI when the repo probe itself fails. This avoids
      // surfacing PR/Actions controls for paths that may not be git repos.
      console.warn("[useIsGitHubRepo] probe failed", error);
      return false;
    })
    .finally(() => {
      if (inFlight.get(repoPath) === promise) {
        inFlight.delete(repoPath);
      }
    });
  inFlight.set(repoPath, promise);
  return promise;
}

export function prefetchGitHubRepoStatus(repoPath: string): Promise<boolean> {
  return probe(repoPath);
}

export function invalidateGitHubRepoStatus(repoPath: string): void {
  cache.delete(repoPath);
  inFlight.delete(repoPath);
  generations.set(repoPath, generationOf(repoPath) + 1);
}

/**
 * Returns `true` when `repoPath` is inside a git repo with a GitHub `origin`
 * remote, `false` otherwise, or `null` while the first probe is in flight.
 */
export function useIsGitHubRepo(
  repoPath: string | null,
  refreshKey = 0,
): boolean | null {
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
  }, [refreshKey, repoPath]);

  return state;
}

/** Test-only: clear the module-level cache between cases. */
export function __resetIsGitHubRepoCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  generations.clear();
}
