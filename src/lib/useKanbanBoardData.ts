import { useEffect, useMemo, useRef, useState } from "react";
import { api, type FsGitDiffStatsRequest, type FsGitStatusEntry } from "./api";
import { rightPanelCache } from "./right-panel-cache";
import type { PullRequestInfo, PullRequestListing, Session } from "./types";

/** Per-session board context assembled from PR listings and worktree diffs. */
export interface KanbanSessionBoardData {
  repoPath: string;
  pr: PullRequestInfo | null;
  hasDiff: boolean;
  additions: number;
  deletions: number;
}

export interface DiffSummary {
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

export function diffStatsEntries(
  statuses: Record<string, FsGitStatusEntry>,
): FsGitDiffStatsRequest[] {
  return Object.entries(statuses)
    .filter(([, entry]) => entry.kind !== "clean")
    .map(([path, entry]) => ({ path, kind: entry.kind }));
}

export function summarizeDiffStats(
  entries: readonly FsGitDiffStatsRequest[],
  stats: Record<string, { additions: number; deletions: number }>,
): DiffSummary {
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    const stat = stats[entry.path];
    additions += stat?.additions ?? 0;
    deletions += stat?.deletions ?? 0;
  }
  return entries.length > 0
    ? { hasDiff: true, additions, deletions }
    : CLEAN_DIFF;
}

export function kanbanSessionBoardLookupPath(
  session: Pick<Session, "git_context_path" | "worktree_path" | "repo_path">,
): string {
  return (
    session.git_context_path?.trim() ||
    session.worktree_path ||
    session.repo_path
  );
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
  const prRequestSeqRef = useRef(new Map<string, number>());
  const diffRefreshSeqRef = useRef(0);

  // Key effects off stable string identities so a store-driven sessions array
  // with unchanged membership does not restart the polls. Newline separator:
  // repo and worktree paths may contain spaces, never newlines.
  const repoPaths = useMemo(
    () =>
      [...new Set(sessions.map(kanbanSessionBoardLookupPath))].sort(),
    [sessions],
  );
  const repoKey = repoPaths.join("\n");
  const worktreeEntries = useMemo(
    () =>
      sessions
        .map((session) => ({
          sessionId: session.id,
          repoPath: kanbanSessionBoardLookupPath(session),
        }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    [sessions],
  );
  const worktreeKey = worktreeEntries
    .map((entry) => `${entry.sessionId}:${entry.repoPath}`)
    .join("\n");

  useEffect(() => {
    let cancelled = false;
    const repos = repoKey ? repoKey.split("\n") : [];
    if (repos.length === 0) {
      setPrIndexByRepo(new Map());
      return;
    }
    const repoSet = new Set(repos);
    setPrIndexByRepo((previous) => {
      const next = new Map(previous);
      for (const repo of next.keys()) {
        if (!repoSet.has(repo)) next.delete(repo);
      }
      return next;
    });

    const refresh = (force: boolean) => {
      for (const repo of repos) {
        const requestSeq = (prRequestSeqRef.current.get(repo) ?? 0) + 1;
        prRequestSeqRef.current.set(repo, requestSeq);
        rightPanelCache
          .fetchPullRequests(repo, "all", PR_LIST_LIMIT, { force })
          .then((listing) => {
            if (
              cancelled ||
              prRequestSeqRef.current.get(repo) !== requestSeq
            ) {
              return;
            }
            setPrIndexByRepo((previous) => {
              const next = new Map(previous);
              next.set(repo, indexListingByBranch(listing));
              return next;
            });
          })
          .catch(() => {
            if (
              cancelled ||
              prRequestSeqRef.current.get(repo) !== requestSeq
            ) {
              return;
            }
            // Missing gh, offline, or non-git dirs — clear this repo so stale
            // PR matches do not keep cards in Review after the source failed.
            setPrIndexByRepo((previous) => {
              if (!previous.has(repo)) return previous;
              const next = new Map(previous);
              next.delete(repo);
              return next;
            });
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
      const requestSeq = ++diffRefreshSeqRef.current;
      const entries = worktreeEntriesRef.current;
      const summaries = await Promise.all(
        entries.map(async ({ sessionId, repoPath }) => {
          try {
            const status = await api.fsGitStatus(repoPath);
            const entries = diffStatsEntries(status.statuses);
            const stats =
              entries.length > 0
                ? await api.fsGitDiffStats(repoPath, entries)
                : {};
            return {
              kind: "ok" as const,
              sessionId,
              summary: summarizeDiffStats(entries, stats),
            };
          } catch {
            // Deleted worktree, non-git path, or transient backend failure.
            // Preserve any previous successful summary instead of marking the
            // session clean from missing data.
            return { kind: "error" as const, sessionId };
          }
        }),
      );
      if (cancelled || diffRefreshSeqRef.current !== requestSeq) return;
      setDiffBySession((previous) => {
        const next = new Map<string, DiffSummary>();
        const summaryBySession = new Map(
          summaries.map((summary) => [summary.sessionId, summary]),
        );
        for (const { sessionId } of entries) {
          const result = summaryBySession.get(sessionId);
          if (!result) continue;
          if (result.kind === "ok") {
            next.set(sessionId, result.summary);
          } else if (previous.has(sessionId)) {
            next.set(sessionId, previous.get(sessionId)!);
          }
        }
        return next;
      });
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
      const repoPath = kanbanSessionBoardLookupPath(session);
      const candidates = branch
        ? (prIndexByRepo.get(repoPath)?.get(branch) ?? [])
        : [];
      const diff = diffBySession.get(session.id) ?? CLEAN_DIFF;
      data.set(session.id, {
        repoPath,
        pr: pickPullRequestForBranch(candidates),
        hasDiff: diff.hasDiff,
        additions: diff.additions,
        deletions: diff.deletions,
      });
    }
    return data;
  }, [diffBySession, prIndexByRepo, sessions]);
}
