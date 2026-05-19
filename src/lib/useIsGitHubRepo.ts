import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Per-repo caches for the git-repo + GitHub origin probes. The results rarely
 * change during a session (only when the user runs `git init` or edits git
 * metadata), so we resolve once per repoPath and reuse across mounts.
 * Concurrent callers for the same repoPath share one in-flight promise.
 */
const gitRepoCache = new Map<string, boolean>();
const gitRepoInFlight = new Map<string, Promise<boolean>>();
const githubRepoCache = new Map<string, boolean>();
const githubRepoInFlight = new Map<string, Promise<boolean>>();
const generations = new Map<string, number>();

function generationOf(repoPath: string): number {
  return generations.get(repoPath) ?? 0;
}

async function probeGitRepository(repoPath: string): Promise<boolean> {
  const cached = gitRepoCache.get(repoPath);
  if (cached !== undefined) return cached;
  const existing = gitRepoInFlight.get(repoPath);
  if (existing) return existing;
  const generation = generationOf(repoPath);
  const promise = api
    .isGitRepository(repoPath)
    .then((isGitRepo) => {
      if (generationOf(repoPath) === generation) {
        gitRepoCache.set(repoPath, isGitRepo);
      }
      if (generationOf(repoPath) !== generation) return false;
      return isGitRepo;
    })
    .catch((error) => {
      // Treat probe failures as "not a git repo" so git-backed UI does not
      // surface actions for paths whose repository state cannot be verified.
      console.warn("[useIsGitHubRepo] git repository probe failed", error);
      return false;
    })
    .finally(() => {
      if (gitRepoInFlight.get(repoPath) === promise) {
        gitRepoInFlight.delete(repoPath);
      }
    });
  gitRepoInFlight.set(repoPath, promise);
  return promise;
}

async function probeGitHubRepo(repoPath: string): Promise<boolean> {
  const cached = githubRepoCache.get(repoPath);
  if (cached !== undefined) return cached;
  const existing = githubRepoInFlight.get(repoPath);
  if (existing) return existing;
  const generation = generationOf(repoPath);
  const promise = probeGitRepository(repoPath)
    .then(async (isGitRepo) => {
      if (!isGitRepo) {
        if (generationOf(repoPath) === generation) {
          githubRepoCache.set(repoPath, false);
        }
        return false;
      }
      const slug = await api.githubOriginSlug(repoPath);
      const value = slug !== null;
      if (generationOf(repoPath) === generation) {
        githubRepoCache.set(repoPath, value);
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
      if (githubRepoInFlight.get(repoPath) === promise) {
        githubRepoInFlight.delete(repoPath);
      }
    });
  githubRepoInFlight.set(repoPath, promise);
  return promise;
}

export function prefetchGitRepositoryStatus(repoPath: string): Promise<boolean> {
  return probeGitRepository(repoPath);
}

export function prefetchGitHubRepoStatus(repoPath: string): Promise<boolean> {
  return probeGitHubRepo(repoPath);
}

export function invalidateGitRepositoryStatus(repoPath: string): void {
  gitRepoCache.delete(repoPath);
  gitRepoInFlight.delete(repoPath);
  githubRepoCache.delete(repoPath);
  githubRepoInFlight.delete(repoPath);
  generations.set(repoPath, generationOf(repoPath) + 1);
}

export function invalidateGitHubRepoStatus(repoPath: string): void {
  invalidateGitRepositoryStatus(repoPath);
}

/**
 * Returns `true` when `repoPath` is inside a git repo, `false` otherwise, or
 * `null` while the first probe is in flight.
 */
export function useIsGitRepository(
  repoPath: string | null,
  refreshKey = 0,
): boolean | null {
  const [state, setState] = useState<boolean | null>(() =>
    repoPath ? (gitRepoCache.get(repoPath) ?? null) : null,
  );

  useEffect(() => {
    if (!repoPath) {
      setState(null);
      return;
    }
    const cached = gitRepoCache.get(repoPath);
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    setState(null);
    let cancelled = false;
    void probeGitRepository(repoPath).then((value) => {
      if (cancelled) return;
      setState(value);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, repoPath]);

  return state;
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
    repoPath ? (githubRepoCache.get(repoPath) ?? null) : null,
  );

  useEffect(() => {
    if (!repoPath) {
      setState(null);
      return;
    }
    const cached = githubRepoCache.get(repoPath);
    if (cached !== undefined) {
      setState(cached);
      return;
    }
    setState(null);
    let cancelled = false;
    void probeGitHubRepo(repoPath).then((value) => {
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
  gitRepoCache.clear();
  gitRepoInFlight.clear();
  githubRepoCache.clear();
  githubRepoInFlight.clear();
  generations.clear();
}
