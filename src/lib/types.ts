export type SessionStatus =
  | "idle"
  | "running"
  | "needs_input"
  | "failed"
  | "completed";

/**
 * Per-session PTY startup mode persisted on the backend `Session` so the
 * choice survives an app restart and is decoupled from the global
 * `sessionStartup.mode` setting. `null` means no per-session preference is
 * recorded and the Terminal falls back to the global setting.
 */
export type SessionStartupMode = "agent" | "terminal" | "custom";

/**
 * Distinguishes ordinary terminal sessions from "control" sessions. Control
 * sessions are the entry point for the `acorn-ipc` CLI, which lets them
 * dispatch commands to other sessions in the same project. Orthogonal to
 * `SessionStartupMode` — either kind can run any startup flavor. Persisted
 * sessions without this field load as `"regular"` from the backend.
 */
export type SessionKind = "regular" | "control";

export interface Session {
  id: string;
  name: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
  isolated: boolean;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  startup_mode: SessionStartupMode | null;
  kind: SessionKind;
  position: number | null;
}

export interface Project {
  repo_path: string;
  name: string;
  created_at: string;
  position: number;
}

export interface CommitInfo {
  sha: string;
  short_sha: string;
  author: string;
  timestamp: number;
  summary: string;
  pushed: boolean;
}

export interface StagedFile {
  path: string;
  status: string;
}

export interface DiffFile {
  old_path: string | null;
  new_path: string | null;
  patch: string;
  is_image: boolean;
  old_image?: string | null;
  new_image?: string | null;
}

export interface DiffPayload {
  files: DiffFile[];
}

export interface MemoryProcess {
  pid: number;
  parent_pid: number | null;
  name: string;
  /** Space-joined argv. Empty when the kernel hides argv. */
  command_line: string;
  bytes: number;
  depth: number;
}

export interface MemoryUsage {
  bytes: number;
  processes: MemoryProcess[];
}

export interface AcornIpcShim {
  path: string;
  exists: boolean;
}

export interface AcornIpcStatus {
  bundled_path: string;
  bundled_exists: boolean;
  socket_path: string;
  shim_paths: AcornIpcShim[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus | string;
  activeForm?: string | null;
}

export type PrStateFilter = "open" | "closed" | "merged" | "all";

export interface PullRequestChecksSummary {
  passed: number;
  failed: number;
  pending: number;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  author: string;
  head_branch: string;
  base_branch: string;
  url: string;
  updated_at: string;
  is_draft: boolean;
  /** Aggregate of head-sha checks. null when gh returned no rollup entries. */
  checks: PullRequestChecksSummary | null;
}

export interface AccountSummary {
  login: string;
  has_access: boolean;
}

export type PullRequestListing =
  | { kind: "ok"; items: PullRequestInfo[]; account: string }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export interface PullRequestComment {
  author: string;
  body: string;
  created_at: string;
}

export interface PullRequestReview {
  author: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  body: string;
  submitted_at: string;
}

export interface PullRequestCheck {
  name: string;
  /** QUEUED | IN_PROGRESS | COMPLETED | PENDING */
  status: string;
  /** SUCCESS | FAILURE | CANCELLED | NEUTRAL | SKIPPED | TIMED_OUT | ACTION_REQUIRED. null while still running. */
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  url: string | null;
  workflow_name: string | null;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  is_draft: boolean;
  author: string;
  head_branch: string;
  base_branch: string;
  url: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  /** "MERGEABLE" | "CONFLICTING" | "UNKNOWN" — null when gh omits the field. */
  mergeable: string | null;
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  checks: PullRequestCheck[];
  diff: DiffPayload;
}

export type PullRequestDetailListing =
  | { kind: "ok"; account: string; detail: PullRequestDetail }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export type MergeMethod = "squash" | "merge" | "rebase";

export interface GeneratedCommitMessage {
  title: string;
  body: string;
}
