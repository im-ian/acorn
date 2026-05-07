export type SessionStatus =
  | "idle"
  | "running"
  | "needs_input"
  | "failed"
  | "completed";

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

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus | string;
  activeForm?: string | null;
}

export type PrStateFilter = "open" | "closed" | "merged" | "all";

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
}

export interface AccountSummary {
  login: string;
  has_access: boolean;
}

export type PullRequestListing =
  | { kind: "ok"; items: PullRequestInfo[]; account: string }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };
