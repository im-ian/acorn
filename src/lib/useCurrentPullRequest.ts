import { useEffect, useState } from "react";
import { api } from "./api";
import {
  currentPullRequestSearchQuery,
  findCurrentPullRequestForBranch,
} from "./sessionContext";
import {
  onPullRequestMutation,
  pullRequestMutationAffectsOpenContext,
  type PullRequestMutationEvent,
} from "./pullRequestEvents";
import type {
  PullRequestListing,
  Session,
  SessionPullRequestSummary,
} from "./types";

const CURRENT_PR_CACHE_TTL_MS = 60_000;
const CURRENT_PR_EMPTY_RETRY_MS = 15_000;

type CurrentPullRequestCacheEntry = {
  value: SessionPullRequestSummary | null;
  expiresAt: number;
  promise?: Promise<SessionPullRequestSummary | null>;
};

type CurrentPullRequestSubscriber = {
  projectRepoPath: string;
  lookupRepoPath: string;
  branch: string;
  onPrime: (value: SessionPullRequestSummary) => void;
  onInvalidate: () => void;
};

const currentPullRequestCache = new Map<string, CurrentPullRequestCacheEntry>();
const currentPullRequestProjectCache = new Map<
  string,
  CurrentPullRequestCacheEntry
>();
const currentPullRequestSubscribers = new Set<CurrentPullRequestSubscriber>();

function normalizeRepoPath(repoPath: string): string {
  return repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

function currentPullRequestCacheKey(repoPath: string, branch: string): string {
  return `${normalizeRepoPath(repoPath)}\u0000${branch}`;
}

function currentPullRequestProjectCacheKey(
  repoPath: string,
  branch: string,
): string {
  return `${normalizeRepoPath(repoPath)}\u0000${branch}`;
}

function setCurrentPullRequestCache(
  repoPath: string,
  branch: string,
  value: SessionPullRequestSummary | null,
  ttlMs: number,
): void {
  currentPullRequestCache.set(currentPullRequestCacheKey(repoPath, branch), {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function readPrimedCurrentPullRequest(
  projectRepoPath: string,
  branch: string,
): SessionPullRequestSummary | null {
  const key = currentPullRequestProjectCacheKey(projectRepoPath, branch);
  const cached = currentPullRequestProjectCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    currentPullRequestProjectCache.delete(key);
    return null;
  }
  return cached.value;
}

function currentPullRequestRepoPath(session: Session): string {
  return (
    session.git_context_path?.trim() ||
    session.worktree_path ||
    session.repo_path
  );
}

function mutationMatchesSubscriber(
  event: PullRequestMutationEvent,
  subscriber: CurrentPullRequestSubscriber,
): boolean {
  const repoPath = normalizeRepoPath(event.repoPath);
  if (
    repoPath !== subscriber.projectRepoPath &&
    repoPath !== subscriber.lookupRepoPath
  ) {
    return false;
  }
  return !event.headBranch || event.headBranch === subscriber.branch;
}

function invalidateCurrentPullRequestCaches(
  event: PullRequestMutationEvent,
): void {
  if (!pullRequestMutationAffectsOpenContext(event.kind)) return;
  for (const subscriber of currentPullRequestSubscribers) {
    if (!mutationMatchesSubscriber(event, subscriber)) continue;
    currentPullRequestProjectCache.delete(
      currentPullRequestProjectCacheKey(
        subscriber.projectRepoPath,
        subscriber.branch,
      ),
    );
    currentPullRequestCache.delete(
      currentPullRequestCacheKey(subscriber.lookupRepoPath, subscriber.branch),
    );
    subscriber.onInvalidate();
  }
}

onPullRequestMutation(invalidateCurrentPullRequestCaches);

export function resetCurrentPullRequestCacheForTests(): void {
  currentPullRequestCache.clear();
  currentPullRequestProjectCache.clear();
  currentPullRequestSubscribers.clear();
}

export function primeCurrentPullRequestCacheFromListing(
  projectRepoPath: string,
  listing: PullRequestListing,
): void {
  if (listing.kind !== "ok") return;

  const expiresAt = Date.now() + CURRENT_PR_CACHE_TTL_MS;
  const summariesByBranch = new Map<string, SessionPullRequestSummary>();
  for (const item of listing.items) {
    const summary = findCurrentPullRequestForBranch(
      { kind: "ok", account: listing.account, items: [item] },
      item.head_branch,
    );
    if (!summary) continue;
    summariesByBranch.set(summary.head_branch, summary);
    currentPullRequestProjectCache.set(
      currentPullRequestProjectCacheKey(projectRepoPath, summary.head_branch),
      {
        value: summary,
        expiresAt,
      },
    );
  }

  if (summariesByBranch.size === 0) return;
  const normalizedProjectRepoPath = normalizeRepoPath(projectRepoPath);
  for (const subscriber of currentPullRequestSubscribers) {
    if (subscriber.projectRepoPath !== normalizedProjectRepoPath) continue;
    const summary = summariesByBranch.get(subscriber.branch);
    if (!summary) continue;
    setCurrentPullRequestCache(
      subscriber.lookupRepoPath,
      subscriber.branch,
      summary,
      CURRENT_PR_CACHE_TTL_MS,
    );
    subscriber.onPrime(summary);
  }
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
    const latest = currentPullRequestCache.get(key);
    if (
      latest &&
      latest.promise !== promise &&
      latest.expiresAt > Date.now()
    ) {
      return latest.value;
    }
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
  const projectRepoPath = normalizeRepoPath(session.repo_path);
  const cacheKey = branch ? currentPullRequestCacheKey(repoPath, branch) : null;
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [currentPullRequest, setCurrentPullRequest] =
    useState<SessionPullRequestSummary | null>(() => {
      if (!cacheKey) return null;
      return (
        readPrimedCurrentPullRequest(projectRepoPath, branch) ??
        currentPullRequestCache.get(cacheKey)?.value ??
        null
      );
    });

  useEffect(() => {
    if (!branch) return;
    const subscriber: CurrentPullRequestSubscriber = {
      projectRepoPath,
      lookupRepoPath: normalizeRepoPath(repoPath),
      branch,
      onPrime: (value) => {
        setCurrentPullRequest(value);
        setLookupAttempt((attempt) => attempt + 1);
      },
      onInvalidate: () => {
        setCurrentPullRequest(null);
        setLookupAttempt((attempt) => attempt + 1);
      },
    };
    currentPullRequestSubscribers.add(subscriber);
    return () => {
      currentPullRequestSubscribers.delete(subscriber);
    };
  }, [branch, projectRepoPath, repoPath]);

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
    const primed = readPrimedCurrentPullRequest(projectRepoPath, branch);
    if (primed) {
      setCurrentPullRequestCache(
        repoPath,
        branch,
        primed,
        CURRENT_PR_CACHE_TTL_MS,
      );
      setCurrentPullRequest(primed);
      return () => {
        cancelled = true;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
      };
    }
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
  }, [branch, cacheKey, lookupAttempt, projectRepoPath, repoPath]);

  return currentPullRequest;
}
