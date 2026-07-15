import type {
  PullRequestListing,
  Session,
  SessionProcessSummary,
  SessionPullRequestSummary,
} from "./types";
import type { SessionPullRequestBranchLinks } from "./sessionPullRequestLinks";

const PROCESS_SUMMARY_VISIBLE = 2;

function sessionProcessNames(
  processes: readonly SessionProcessSummary[] | null | undefined,
): string[] {
  if (!processes || processes.length === 0) return [];
  return processes
    .map((process) => process.name.trim())
    .filter((name) => name.length > 0);
}

export function currentPullRequestSearchQuery(branch: string): string | null {
  const trimmed = branch.trim();
  if (!trimmed) return null;
  if (trimmed === "main" || trimmed === "master") return null;
  return `head:${trimmed}`;
}

export function findCurrentPullRequestForBranch(
  listing: PullRequestListing,
  branch: string,
): SessionPullRequestSummary | null {
  const trimmed = branch.trim();
  if (!trimmed || listing.kind !== "ok") return null;
  const pr = listing.items.find(
    (item) => item.state === "OPEN" && item.head_branch === trimmed,
  );
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    head_branch: pr.head_branch,
    base_branch: pr.base_branch,
    state: pr.state,
    is_draft: pr.is_draft,
  };
}

function comparableRepoPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

function sessionTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function findSessionsForPullRequest(
  sessions: readonly Session[],
  repoPath: string,
  headBranch: string,
  branchLinks: SessionPullRequestBranchLinks = {},
): Session[] {
  const targetRepo = comparableRepoPath(repoPath.trim());
  const targetBranch = headBranch.trim();
  if (!targetBranch) return [];

  return sessions
    .filter((session) => {
      if (session.project_scoped === false) return false;
      if (comparableRepoPath(session.repo_path.trim()) !== targetRepo) {
        return false;
      }
      if (session.branch.trim() === targetBranch) return true;
      const link = branchLinks[session.id];
      return (
        link?.headBranch.trim() === targetBranch &&
        comparableRepoPath(link.repoPath.trim()) === targetRepo
      );
    })
    .sort((a, b) => {
      const aCurrent = a.branch.trim() === targetBranch;
      const bCurrent = b.branch.trim() === targetBranch;
      if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      return (
        sessionTimestamp(b.updated_at) - sessionTimestamp(a.updated_at) ||
        sessionTimestamp(b.created_at) - sessionTimestamp(a.created_at) ||
        a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }) ||
        a.id.localeCompare(b.id)
      );
    });
}

export function summarizeSessionProcesses(
  processes: readonly SessionProcessSummary[] | null | undefined,
): string | null {
  const names = sessionProcessNames(processes);
  if (names.length === 0) return null;
  const visible = names.slice(0, PROCESS_SUMMARY_VISIBLE).join(", ");
  const hidden = names.length - PROCESS_SUMMARY_VISIBLE;
  return hidden > 0 ? `${visible} +${hidden}` : visible;
}

export function summarizeAllSessionProcesses(
  processes: readonly SessionProcessSummary[] | null | undefined,
): string | null {
  const names = sessionProcessNames(processes);
  return names.length > 0 ? names.join(", ") : null;
}
