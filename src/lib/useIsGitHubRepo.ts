import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Per-repo cache for the GitHub origin probe. The result rarely changes
 * during a session (only when the user edits `origin`), so we resolve once
 * per repoPath and reuse across mounts. Concurrent callers for the same
 * repoPath share one in-flight promise.
 */
const cache = new Map<string, boolean>();
const inFlight = new Map<string, Promise<boolean>>();

async function probe(repoPath: string): Promise<boolean> {
  const cached = cache.get(repoPath);
  if (cached !== undefined) return cached;
  const existing = inFlight.get(repoPath);
  if (existing) return existing;
  const promise = api
    .githubOriginSlug(repoPath)
    .then((slug) => {
      const value = slug !== null;
      cache.set(repoPath, value);
      return value;
    })
    .catch((error) => {
      // Treat probe failures as "unknown" → assume GitHub so the user still
      // sees the GitHub tabs and their built-in error states (rather than
      // silently hiding navigation). Don't poison the cache.
      console.warn("[useIsGitHubRepo] probe failed", error);
      return true;
    })
    .finally(() => {
      inFlight.delete(repoPath);
    });
  inFlight.set(repoPath, promise);
  return promise;
}

/**
 * Returns `true` when `repoPath` has a GitHub `origin` remote, `false`
 * otherwise, or `null` while the first probe is in flight (so callers can
 * avoid flicker between "show GitHub" and "hide GitHub" on first paint).
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
