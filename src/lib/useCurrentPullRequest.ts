import { useEffect, useState } from "react";
import { api } from "./api";
import {
  currentPullRequestSearchQuery,
  findCurrentPullRequestForBranch,
} from "./sessionContext";
import type { Session, SessionPullRequestSummary } from "./types";

const CURRENT_PR_CACHE_TTL_MS = 60_000;
const CURRENT_PR_EMPTY_RETRY_MS = 15_000;

type CurrentPullRequestCacheEntry = {
  value: SessionPullRequestSummary | null;
  expiresAt: number;
  promise?: Promise<SessionPullRequestSummary | null>;
};

const currentPullRequestCache = new Map<string, CurrentPullRequestCacheEntry>();

function currentPullRequestCacheKey(repoPath: string, branch: string): string {
  return `${repoPath}\u0000${branch}`;
}

function currentPullRequestRepoPath(session: Session): string {
  return (
    session.git_context_path?.trim() ||
    session.worktree_path ||
    session.repo_path
  );
}

function loadCurrentPullRequest(
  repoPath: string,
  branch: string,
): Promise<SessionPullRequestSummary | null> {
  const key = currentPullRequestCacheKey(repoPath, branch);
  const now = Date.now();
  const cached = currentPullRequestCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.promise ?? Promise.resolve(cached.value);
  }

  const query = currentPullRequestSearchQuery(branch);
  if (!query) return Promise.resolve(null);

  const promise = api
    .listPullRequests(repoPath, "open", 10, query)
    .then((listing) => findCurrentPullRequestForBranch(listing, branch))
    .catch(() => null);

  currentPullRequestCache.set(key, {
    value: cached?.value ?? null,
    expiresAt: now + CURRENT_PR_CACHE_TTL_MS,
    promise,
  });

  return promise.then((value) => {
    currentPullRequestCache.set(key, {
      value,
      expiresAt:
        Date.now() +
        (value ? CURRENT_PR_CACHE_TTL_MS : CURRENT_PR_EMPTY_RETRY_MS),
    });
    return value;
  });
}

export function useCurrentPullRequest(
  session: Session,
): SessionPullRequestSummary | null {
  const branch = session.branch.trim();
  const repoPath = currentPullRequestRepoPath(session);
  const cacheKey = branch ? currentPullRequestCacheKey(repoPath, branch) : null;
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [currentPullRequest, setCurrentPullRequest] =
    useState<SessionPullRequestSummary | null>(() =>
      cacheKey ? (currentPullRequestCache.get(cacheKey)?.value ?? null) : null,
    );

  useEffect(() => {
    const query = currentPullRequestSearchQuery(branch);
    if (!branch || !cacheKey || !query) {
      setCurrentPullRequest(null);
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const scheduleEmptyRetry = (value: SessionPullRequestSummary | null) => {
      if (value || cancelled) return;
      retryTimer = window.setTimeout(() => {
        if (!cancelled) setLookupAttempt((attempt) => attempt + 1);
      }, CURRENT_PR_EMPTY_RETRY_MS);
    };
    const cached = currentPullRequestCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setCurrentPullRequest(cached.value);
      if (!cached.promise) {
        scheduleEmptyRetry(cached.value);
        return () => {
          cancelled = true;
          if (retryTimer !== null) window.clearTimeout(retryTimer);
        };
      }
    } else {
      setCurrentPullRequest(cached?.value ?? null);
    }

    loadCurrentPullRequest(repoPath, branch).then((value) => {
      if (!cancelled) {
        setCurrentPullRequest(value);
        scheduleEmptyRetry(value);
      }
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [branch, cacheKey, lookupAttempt, repoPath]);

  return currentPullRequest;
}
