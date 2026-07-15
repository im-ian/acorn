const SESSION_PR_BRANCH_LINKS_STORAGE_KEY =
  "acorn:workspace-kanban:pr-branch-links:v1";

export interface SessionPullRequestBranchLink {
  repoPath: string;
  headBranch: string;
}

export type SessionPullRequestBranchLinks = Record<
  string,
  SessionPullRequestBranchLink
>;

function isSessionPullRequestBranchLink(
  value: unknown,
): value is SessionPullRequestBranchLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Partial<SessionPullRequestBranchLink>;
  return (
    typeof link.repoPath === "string" &&
    link.repoPath.trim().length > 0 &&
    typeof link.headBranch === "string" &&
    link.headBranch.trim().length > 0
  );
}

export function readSessionPullRequestBranchLinks(): SessionPullRequestBranchLinks {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(
      SESSION_PR_BRANCH_LINKS_STORAGE_KEY,
    );
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, SessionPullRequestBranchLink] =>
          isSessionPullRequestBranchLink(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

export function writeSessionPullRequestBranchLinks(
  links: SessionPullRequestBranchLinks,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SESSION_PR_BRANCH_LINKS_STORAGE_KEY,
      JSON.stringify(links),
    );
  } catch {
    // Current-branch PR matching still works when storage is unavailable.
  }
}
