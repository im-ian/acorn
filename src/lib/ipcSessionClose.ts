import type { RemovalIssue, SessionRemoval } from "./api";
import type { ProjectFoldersByRepo } from "./projectFolders";
import {
  controlOwnedSessionCount,
  shouldAutoDeleteSessionWorktree,
} from "./sessionWorktree";
import type { Session } from "./types";

export const IPC_SESSION_CLOSE_REQUEST_EVENT =
  "acorn:ipc-session-close-request";

export interface IpcSessionCloseRequestPayload {
  request_id: string;
  session_id: string;
}

export interface IpcSessionCloseResponsePayload {
  request_id: string;
  remove_worktree: boolean;
}

export interface IpcSessionCloseRemovalNotice {
  removal: SessionRemoval | null;
  issues: RemovalIssue[];
  retryToken: string | null;
}

const REMOVAL_ISSUE_KINDS = [
  "worktree",
  "scrollback",
  "settings",
  "persistence",
] as const;

export function parseIpcSessionCloseRequest(
  value: unknown,
): IpcSessionCloseRequestPayload | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.request_id !== "string" || typeof raw.session_id !== "string") {
    return null;
  }
  if (raw.request_id.length === 0 || raw.session_id.length === 0) return null;
  return { request_id: raw.request_id, session_id: raw.session_id };
}

/**
 * Same gate as the sidebar's silent isolated-worktree delete. IPC cannot
 * show the confirm dialog, so a session that would ask keeps its worktree.
 */
export function ipcCloseRemovesWorktree(
  session: Session | null | undefined,
  foldersByRepo: ProjectFoldersByRepo,
  sessions: readonly Session[],
  confirmDeleteIsolatedWorktrees: boolean,
): boolean {
  if (!session || confirmDeleteIsolatedWorktrees) return false;
  if (controlOwnedSessionCount(sessions, session) > 0) return false;
  return shouldAutoDeleteSessionWorktree(session, foldersByRepo, sessions);
}

export function parseIpcSessionCloseRemovalNotice(
  value: unknown,
): IpcSessionCloseRemovalNotice {
  const empty: IpcSessionCloseRemovalNotice = {
    removal: null,
    issues: [],
    retryToken: null,
  };
  if (!value || typeof value !== "object") return empty;
  const raw = value as Record<string, unknown>;
  return {
    removal: parseSessionRemoval(raw.removal),
    issues: parseRemovalIssues(raw.issues),
    retryToken: typeof raw.retry_token === "string" ? raw.retry_token : null,
  };
}

function parseSessionRemoval(value: unknown): SessionRemoval | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.token !== "string" ||
    typeof raw.repo_path !== "string" ||
    typeof raw.worktree_path !== "string" ||
    typeof raw.git_common_dir !== "string"
  ) {
    return null;
  }
  const sessionIds = Array.isArray(raw.session_ids)
    ? raw.session_ids.filter((id): id is string => typeof id === "string")
    : [];
  return {
    token: raw.token,
    repoPath: raw.repo_path,
    worktreePath: raw.worktree_path,
    gitCommonDir: raw.git_common_dir,
    sessionIds,
  };
}

function parseRemovalIssues(value: unknown): RemovalIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: RemovalIssue[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.kind !== "string" ||
      typeof raw.target !== "string" ||
      typeof raw.message !== "string" ||
      !REMOVAL_ISSUE_KINDS.includes(raw.kind as (typeof REMOVAL_ISSUE_KINDS)[number])
    ) {
      continue;
    }
    issues.push({
      kind: raw.kind as RemovalIssue["kind"],
      target: raw.target,
      message: raw.message,
      retryable: raw.retryable === true,
    });
  }
  return issues;
}
