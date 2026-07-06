import type {
  PullRequestListing,
  SessionProcessSummary,
  SessionPullRequestSummary,
} from "./types";

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
    is_draft: pr.is_draft,
  };
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
