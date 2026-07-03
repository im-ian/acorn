import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { rightPanelCache } from "./right-panel-cache";
import type { PullRequestInfo, PullRequestListing, Session } from "./types";

/** Per-session board context assembled from PR listings and worktree diffs. */
export interface KanbanSessionBoardData {
  pr: PullRequestInfo | null;
  hasDiff: boolean;
  additions: number;
  deletions: number;
}

interface DiffSummary {
  hasDiff: boolean;
  additions: number;
  deletions: number;
}

const CLEAN_DIFF: DiffSummary = { hasDiff: false, additions: 0, deletions: 0 };

const PR_POLL_INTERVAL_MS = 60_000;
const DIFF_POLL_INTERVAL_MS = 20_000;
const PR_LIST_LIMIT = 50;

/**
 * Pick the PR that best represents a branch when several share a head branch:
 * an open PR outranks merged/closed ones, then the most recently updated wins.
 */
export function pickPullRequestForBranch(
  prs: readonly PullRequestInfo[],
): PullRequestInfo | null {
  let best: PullRequestInfo | null = null;
  for (const pr of prs) {
    if (!best) {
      best = pr;
      continue;
    }
    const bestOpen = best.state.toUpperCase() === "OPEN";
    const prOpen = pr.state.toUpperCase() === "OPEN";
    if (prOpen !== bestOpen) {
      if (prOpen) best = pr;
      continue;
    }
    if (Date.parse(pr.updated_at) > Date.parse(best.updated_at)) best = pr;
  }
  return best;
}

function indexListingByBranch(
  listing: PullRequestListing,
): Map<string, PullRequestInfo[]> {
  const byBranch = new Map<string, PullRequestInfo[]>();
  if (listing.kind !== "ok") return byBranch;
  for (const pr of listing.items) {
    const list = byBranch.get(pr.head_branch);
    if (list) list.push(pr);
    else byBranch.set(pr.head_branch, [pr]);
  }
  return byBranch;
}

function summarizeGitStatuses(
  statuses: Record<string, { additions: number; deletions: number }>,
): DiffSummary {
  let additions = 0;
  let deletions = 0;
  let entries = 0;
  for (const entry of Object.values(statuses)) {
    entries += 1;
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return entries > 0 ? { hasDiff: true, additions, deletions } : CLEAN_DIFF;
}

/**
 * Poll PR listings (per distinct repo) and worktree diff summaries (per
 * session) for the workspace kanban. Both polls pause while the document is
 * hidden and refresh immediately when it becomes visible again. `refreshKey`
 * forces an immediate PR re-fetch (bump it after a PR mutation).
 */
export function useKanbanBoardData(
  sessions: readonly Session[],
  refreshKey = 0,
): Map<string, KanbanSessionBoardData> {
  const [prIndexByRepo, setPrIndexByRepo] = useState<
    ReadonlyMap<string, Map<string, PullRequestInfo[]>>
  >(new Map());
  const [diffBySession, setDiffBySession] = useState<
    ReadonlyMap<string, DiffSummary>
  >(new Map());

  // Key effects off stable string identities so a store-driven sessions array
  // with unchanged membership does not restart the polls. Newline separator:
  // repo and worktree paths may contain spaces, never newlines.
  const repoPaths = useMemo(
    () =>
      [...new Set(sessions.map((session) => session.repo_path))].sort(),
    [sessions],
  );
  const repoKey = repoPaths.join("\n");
  const worktreeEntries = useMemo(
    () =>
      sessions
        .map((session) => ({
          sessionId: session.id,
          worktreePath: session.worktree_path,
        }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [sessions],
  );
  const worktreeKey = worktreeEntries
    .map((entry) => `${entry.sessionId}:${entry.worktreePath}`)
    .join("\n");

  useEffect(() => {
    let cancelled = false;
    const repos = repoKey ? repoKey.split("\n") : [];
    if (repos.length === 0) {
      setPrIndexByRepo(new Map());
      return;
    }

    const refresh = (force: boolean) => {
      for (const repo of repos) {
        rightPanelCache
          .fetchPullRequests(repo, "all", PR_LIST_LIMIT, { force })
          .then((listing) => {
            if (cancelled) return;
            setPrIndexByRepo((previous) => {
              const next = new Map(previous);
              next.set(repo, indexListingByBranch(listing));
              return next;
            });
          })
          .catch(() => {
            // Missing gh, offline, or non-git dirs — the board just renders
            // without PR context for this repo.
          });
      }
    };

    refresh(refreshKey > 0);
    const handle = window.setInterval(() => {
      if (!document.hidden) refresh(true);
    }, PR_POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) refresh(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [repoKey, refreshKey]);

  const worktreeEntriesRef = useRef(worktreeEntries);
  worktreeEntriesRef.current = worktreeEntries;

  useEffect(() => {
    let cancelled = false;
    if (!worktreeKey) {
      setDiffBySession(new Map());
      return;
    }

    const refresh = async () => {
      const entries = worktreeEntriesRef.current;
      const summaries = await Promise.all(
        entries.map(async ({ sessionId, worktreePath }) => {
          try {
            const result = await api.fsGitStatus(worktreePath);
            return [sessionId, summarizeGitStatuses(result.statuses)] as const;
          } catch {
            // Deleted worktree or non-git path: treat as clean rather than
            // wedging the whole board refresh.
            return [sessionId, CLEAN_DIFF] as const;
          }
        }),
      );
      if (!cancelled) setDiffBySession(new Map(summaries));
    };

    void refresh();
    const handle = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, DIFF_POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [worktreeKey]);

  return useMemo(() => {
    const data = new Map<string, KanbanSessionBoardData>();
    for (const session of sessions) {
      const branch = session.branch?.trim();
      const candidates = branch
        ? (prIndexByRepo.get(session.repo_path)?.get(branch) ?? [])
        : [];
      const diff = diffBySession.get(session.id) ?? CLEAN_DIFF;
      data.set(session.id, {
        pr: pickPullRequestForBranch(candidates),
        hasDiff: diff.hasDiff,
        additions: diff.additions,
        deletions: diff.deletions,
      });
    }
    return data;
  }, [diffBySession, prIndexByRepo, sessions]);
}
