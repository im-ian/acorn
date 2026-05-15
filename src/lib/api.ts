import { invoke } from "@tauri-apps/api/core";
import type {
  AcornIpcStatus,
  CommitInfo,
  DiffPayload,
  GeneratedCommitMessage,
  MemoryUsage,
  MergeMethod,
  Project,
  PrStateFilter,
  PullRequestDetailListing,
  PullRequestListing,
  Session,
  SessionKind,
  SessionStatus,
  StagedFile,
  TodoItem,
  WorkflowRunDetailListing,
  WorkflowRunsListing,
} from "./types";

export interface LoadStatus {
  sessionsClean: boolean;
  projectsClean: boolean;
}

export const api = {
  loadStatus(): Promise<LoadStatus> {
    return invoke<LoadStatus>("load_status");
  },
  listSessions(): Promise<Session[]> {
    return invoke<Session[]>("list_sessions");
  },
  createSession(
    name: string,
    repoPath: string,
    isolated = false,
    kind: SessionKind = "regular",
  ): Promise<Session> {
    return invoke<Session>("create_session", {
      name,
      repoPath,
      isolated,
      kind,
    });
  },
  removeSession(id: string, removeWorktree = false): Promise<void> {
    return invoke<void>("remove_session", { id, removeWorktree });
  },
  setSessionStatus(id: string, status: SessionStatus): Promise<Session> {
    return invoke<Session>("set_session_status", { id, status });
  },
  renameSession(id: string, name: string): Promise<Session> {
    return invoke<Session>("rename_session", { id, name });
  },
  listProjects(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  },
  addProject(repoPath: string): Promise<Project> {
    return invoke<Project>("add_project", { repoPath });
  },
  createNewProject(
    parentPath: string,
    name: string,
    ignoreSafeName = false,
  ): Promise<Project> {
    return invoke<Project>("create_new_project", {
      parentPath,
      name,
      ignoreSafeName,
    });
  },
  removeProject(
    repoPath: string,
    removeSessions = true,
    removeWorktrees = false,
  ): Promise<void> {
    return invoke<void>("remove_project", {
      repoPath,
      removeSessions,
      removeWorktrees,
    });
  },
  reorderProjects(order: string[]): Promise<Project[]> {
    return invoke<Project[]>("reorder_projects", { order });
  },
  reorderSessions(repoPath: string, order: string[]): Promise<Session[]> {
    return invoke<Session[]>("reorder_sessions", { repoPath, order });
  },
  listCommits(repoPath: string, offset = 0, limit = 50): Promise<CommitInfo[]> {
    return invoke<CommitInfo[]>("list_commits", { repoPath, offset, limit });
  },
  listStaged(repoPath: string): Promise<StagedFile[]> {
    return invoke<StagedFile[]>("list_staged", { repoPath });
  },
  commitDiff(repoPath: string, sha: string): Promise<DiffPayload> {
    return invoke<DiffPayload>("commit_diff", { repoPath, sha });
  },
  commitWebUrl(repoPath: string, sha: string): Promise<string | null> {
    return invoke<string | null>("commit_web_url", { repoPath, sha });
  },
  openInEditor(command: string, args: string[], path: string): Promise<void> {
    return invoke<void>("open_in_editor", { command, args, path });
  },
  stagedDiff(repoPath: string): Promise<DiffPayload> {
    return invoke<DiffPayload>("staged_diff", { repoPath });
  },
  listPullRequests(
    repoPath: string,
    state: PrStateFilter = "open",
    limit = 50,
    query: string | null = null,
  ): Promise<PullRequestListing> {
    return invoke<PullRequestListing>("list_pull_requests", {
      repoPath,
      state,
      limit,
      query,
    });
  },
  getPullRequestDetail(
    repoPath: string,
    number: number,
  ): Promise<PullRequestDetailListing> {
    return invoke<PullRequestDetailListing>("get_pull_request_detail", {
      repoPath,
      number,
    });
  },
  getPullRequestCommitDiff(
    repoPath: string,
    sha: string,
  ): Promise<DiffPayload> {
    return invoke<DiffPayload>("get_pull_request_commit_diff", {
      repoPath,
      sha,
    });
  },
  /**
   * Batch-resolve git OIDs → GitHub login (when GitHub knows about them).
   * Missing keys mean we couldn't reach GitHub; `null` values mean the
   * commit exists but its author doesn't map to a GitHub account.
   */
  resolveCommitLogins(
    repoPath: string,
    shas: string[],
  ): Promise<Record<string, string | null>> {
    return invoke<Record<string, string | null>>("resolve_commit_logins", {
      repoPath,
      shas,
    });
  },
  mergePullRequest(
    repoPath: string,
    number: number,
    method: MergeMethod,
    commitTitle: string | null,
    commitBody: string | null,
  ): Promise<void> {
    return invoke<void>("merge_pull_request", {
      repoPath,
      number,
      method,
      commitTitle,
      commitBody,
    });
  },
  closePullRequest(repoPath: string, number: number): Promise<void> {
    return invoke<void>("close_pull_request", { repoPath, number });
  },
  updatePullRequestBody(
    repoPath: string,
    number: number,
    body: string,
  ): Promise<void> {
    return invoke<void>("update_pull_request_body", {
      repoPath,
      number,
      body,
    });
  },
  generatePrCommitMessage(
    repoPath: string,
    number: number,
    method: MergeMethod,
    command: string,
    args: string[],
  ): Promise<GeneratedCommitMessage> {
    return invoke<GeneratedCommitMessage>("generate_pr_commit_message", {
      repoPath,
      number,
      method,
      command,
      args,
    });
  },
  listWorkflowRuns(
    repoPath: string,
    limit = 50,
  ): Promise<WorkflowRunsListing> {
    return invoke<WorkflowRunsListing>("list_workflow_runs", {
      repoPath,
      limit,
    });
  },
  getWorkflowRunDetail(
    repoPath: string,
    runId: number,
  ): Promise<WorkflowRunDetailListing> {
    return invoke<WorkflowRunDetailListing>("get_workflow_run_detail", {
      repoPath,
      runId,
    });
  },
  getMemoryUsage(): Promise<MemoryUsage> {
    return invoke<MemoryUsage>("get_memory_usage");
  },
  /**
   * Inspect the runtime environment for the `acorn-ipc` CLI: bundled binary
   * location and presence, the IPC socket path, and which of the common
   * `$PATH` shim locations already have a copy/symlink installed. Used by
   * the Sessions → Control sessions settings section.
   */
  getAcornIpcStatus(): Promise<AcornIpcStatus> {
    return invoke<AcornIpcStatus>("get_acorn_ipc_status");
  },
  /**
   * Stop the in-process IPC listener and spawn a fresh one. Used when the
   * socket has gone stale (e.g. file removed under the running app) so the
   * user can recover without restarting the whole app. Resolves on success;
   * rejects with the backend's error string if rebind fails.
   */
  ipcRestart(): Promise<void> {
    return invoke<void>("ipc_restart");
  },
  listSystemFonts(): Promise<string[]> {
    return invoke<string[]>("list_system_fonts");
  },
  readSessionTodos(sessionId: string, cwd: string): Promise<TodoItem[]> {
    return invoke<TodoItem[]>("read_session_todos", { sessionId, cwd });
  },
  detectSessionStatuses(
    ids: string[],
  ): Promise<{ id: string; status: SessionStatus; branch: string | null }[]> {
    return invoke<
      { id: string; status: SessionStatus; branch: string | null }[]
    >("detect_session_statuses", { ids });
  },
  /**
   * Inspect on-disk markers to determine which agent CLI (if any) the user has
   * run inside this Acorn session. Drives the Tab > Fork menu item visibility.
   */
  detectSessionAgent(
    sessionId: string,
  ): Promise<{ claude: string | null; codex: string | null }> {
    return invoke<{ claude: string | null; codex: string | null }>(
      "detect_session_agent",
      { sessionId },
    );
  },
  /**
   * Copy a parent claude transcript into the new worktree's project slug
   * so `claude --resume <uuid>` resolves once the fork shell cd's there.
   * Without this, the resume fails because claude looks transcripts up
   * by slug-of-cwd, which differs between parent and worktree.
   */
  prepareClaudeFork(parentUuid: string, newCwd: string): Promise<void> {
    return invoke<void>("prepare_claude_fork", {
      parentUuid,
      newCwd,
    });
  },
  scrollbackOrphanSize(): Promise<number> {
    return invoke<number>("scrollback_orphan_size");
  },
  scrollbackOrphanClear(): Promise<number> {
    return invoke<number>("scrollback_orphan_clear");
  },
  /**
   * Drop the cached snapshot of the user's shell environment. The next PTY
   * spawn re-runs `$SHELL -l -i -c` and re-captures locale / editor / pager
   * vars from the user's dotfiles. Already-running sessions are unaffected
   * because their environment was fixed at fork time — surface that fact to
   * the user when invoking this.
   */
  reloadShellEnv(): Promise<void> {
    return invoke<void>("pty_reload_shell_env");
  },
  /**
   * Resolve the live cwd of a session's PTY tree. Returns `null` when the
   * session has no live PTY (not opened yet, or already exited) — callers
   * should fall back to the session's recorded `worktree_path`. Walks
   * descendants and returns the deepest cwd, so `claude -w` (claude as a
   * grandchild of the shell) is followed in addition to direct `cd`.
   */
  ptyCwd(sessionId: string): Promise<string | null> {
    return invoke<string | null>("pty_cwd", { sessionId });
  },
  /**
   * Like {@link ptyCwd}, but resolves the cwd to its enclosing git repo's
   * working directory. Returns `null` when the PTY has no live cwd or that
   * cwd is outside any git repo (e.g. inside a Cargo registry dir). Callers
   * should fall back to the session's recorded `worktree_path` on `null`.
   */
  ptyRepoRoot(sessionId: string): Promise<string | null> {
    return invoke<string | null>("pty_repo_root", { sessionId });
  },
  /**
   * Batched live "is the session sitting inside a linked git worktree?"
   * probe. Returns a map keyed by session id; missing entries mean
   * "no live PTY, or live cwd is not inside a linked worktree". One
   * backend syscall sweep covers every session — call this on focus /
   * after refresh, not on a tight interval.
   */
  ptyInWorktreeAll(): Promise<Record<string, boolean>> {
    return invoke<Record<string, boolean>>("pty_in_worktree_all");
  },
  /**
   * Classify an arbitrary on-disk path as "inside a linked git worktree".
   * Backs the xterm OSC 7 handler: every shell `cd` emits the new cwd,
   * the handler hands it here, and the boolean feeds the worktree-icon
   * condition. Walks up via `Repository::discover` so subdirectories of
   * a worktree resolve correctly.
   */
  isPathLinkedWorktree(path: string): Promise<boolean> {
    return invoke<boolean>("is_path_linked_worktree", { path });
  },
  /**
   * Resolve an arbitrary path to the root of its enclosing linked git
   * worktree. Returns null when the path is outside git or belongs to the
   * main checkout. Used to remember a session-specific adoption candidate
   * without relying on repo-global worktree diffs alone.
   */
  linkedWorktreeRoot(path: string): Promise<string | null> {
    return invoke<string | null>("linked_worktree_root", { path });
  },
  /**
   * Re-point a session at a different worktree directory. Used after an
   * in-PTY command creates a worktree and exits — adopting it lets the next
   * spawn land inside the new worktree instead of the original cwd.
   */
  updateSessionWorktree(id: string, worktreePath: string): Promise<Session> {
    return invoke<Session>("update_session_worktree", { id, worktreePath });
  },
  /**
   * List absolute paths of every *linked* git worktree of the repo
   * containing `repoPath`. Used to snapshot before a PTY command runs and
   * diff after it exits, so we can detect a freshly-created worktree.
   */
  gitWorktrees(repoPath: string): Promise<string[]> {
    return invoke<string[]>("git_worktrees", { repoPath });
  },
  /**
   * Probe the `acornd` daemon. Backs the StatusBar daemon indicator and
   * the Settings → Background sessions panel. Always resolves — when no
   * daemon is reachable, fields collapse to `null` and `running` is
   * `false`; rejection only on serialization failure (which should never
   * happen for this shape).
   */
  daemonStatus(): Promise<DaemonStatus> {
    return invoke<DaemonStatus>("daemon_status");
  },
  /**
   * Pull the cached boot-time staged-rev reconcile result. `null` when
   * either reconcile has not run, the daemon is disabled, or every
   * alive daemon session was spawned against the same staged dotfile
   * bodies as the current build. Frontend calls this at mount so a
   * listener registered after the matching emit still sees the
   * prompt.
   */
  stagedRevMismatchStatus(): Promise<StagedRevMismatch | null> {
    return invoke<StagedRevMismatch | null>("staged_rev_mismatch_status");
  },
  /**
   * Drop the cached staged-rev mismatch so the prompt does not re-show
   * after the user dismisses it or after the daemon-restart flow that
   * resolves it.
   */
  acknowledgeStagedRevMismatch(): Promise<void> {
    return invoke<void>("acknowledge_staged_rev_mismatch");
  },
  /**
   * Flip the daemon killswitch. Persistence (so the setting survives a
   * restart) is the caller's responsibility — stash to `localStorage`
   * under `acorn:daemon-enabled`.
   */
  daemonSetEnabled(enabled: boolean): Promise<void> {
    return invoke<void>("daemon_set_enabled", { enabled });
  },
  /**
   * Force the bridge to reconnect — drops the cached control connection
   * and re-spawns the daemon if necessary. Used by the Settings
   * "Restart daemon" button after a manual `acornd shutdown`.
   */
  daemonRestart(): Promise<void> {
    return invoke<void>("daemon_restart");
  },
  /**
   * Ask the daemon to shut down (kills every PTY, then exits). Caller
   * must confirm with the user before calling — destructive.
   */
  daemonShutdown(): Promise<void> {
    return invoke<void>("daemon_shutdown");
  },
  /**
   * Enumerate sessions tracked by the daemon (alive + dead). Backs the
   * Settings → Background sessions list view.
   */
  daemonListSessions(): Promise<DaemonSessionSummary[]> {
    return invoke<DaemonSessionSummary[]>("daemon_list_sessions");
  },
  /**
   * Kill a daemon-owned PTY. Equivalent to closing the shell inside the
   * session — the row stays in the daemon registry (with `alive=false`)
   * until `daemonForgetSession` is also called.
   */
  daemonKillSession(targetSessionId: string): Promise<void> {
    return invoke<void>("daemon_kill_session", {
      targetSessionId,
    });
  },
  /**
   * Remove a dead session row from the daemon registry. The daemon
   * rejects this for sessions still alive — caller must kill first.
   */
  daemonForgetSession(targetSessionId: string): Promise<void> {
    return invoke<void>("daemon_forget_session", {
      targetSessionId,
    });
  },
  /**
   * Reconstruct an app-side session row from a daemon-owned PTY the
   * app has lost track of. Pulls name/kind/repo_path/branch from the
   * daemon's session metadata. Idempotent.
   */
  daemonAdoptSession(targetSessionId: string): Promise<void> {
    return invoke<void>("daemon_adopt_session", {
      targetSessionId,
    });
  },
  /**
   * Resolve the "이전 Claude 대화 있음" candidate for a session. The
   * filesystem watcher writes `claude.id` after every fresh bare-flag
   * claude run, and the app surfaces it via this command on session
   * focus. Returns `null` when there is nothing to offer — no claude
   * has run, the user already dismissed the modal for this UUID, or
   * claude is actively running in the PTY tree (in which case the
   * modal would be redundant).
   */
  getClaudeResumeCandidate(
    sessionId: string,
  ): Promise<ResumeCandidate | null> {
    return invoke<ResumeCandidate | null>(
      "get_claude_resume_candidate",
      { sessionId },
    );
  },
  /**
   * Codex equivalent of `getClaudeResumeCandidate`. Returns the codex
   * rollout UUID + preview the user is being offered to resume, or
   * `null` when there's nothing to surface.
   */
  getCodexResumeCandidate(
    sessionId: string,
  ): Promise<ResumeCandidate | null> {
    return invoke<ResumeCandidate | null>(
      "get_codex_resume_candidate",
      { sessionId },
    );
  },
  /**
   * Mark the current `claude.id` as seen. All three modal buttons call
   * this so the modal does not pop again for the same UUID; only a new
   * JSONL appearing under a different UUID reactivates it.
   */
  acknowledgeClaudeResume(sessionId: string): Promise<void> {
    return invoke<void>("acknowledge_claude_resume", { sessionId });
  },
  /** Codex equivalent of `acknowledgeClaudeResume`. */
  acknowledgeCodexResume(sessionId: string): Promise<void> {
    return invoke<void>("acknowledge_codex_resume", { sessionId });
  },
  /**
   * Write raw bytes to a session's PTY master (i.e. as if the user
   * typed them). The backend handles routing — daemon-managed sessions
   * go through the control socket, in-process sessions go through the
   * direct PTY handle. Caller is responsible for terminating commands
   * with `\n` if they want them to execute; otherwise the bytes land
   * on the shell's line buffer untouched.
   */
  ptyWrite(sessionId: string, data: string): Promise<void> {
    const encoded = encodeStringToBase64(data);
    return invoke<void>("pty_write", { sessionId, data: encoded });
  },
  fsListDir(
    path: string,
    showHidden: boolean,
    respectGitignore: boolean,
  ): Promise<FsListResult> {
    return invoke<FsListResult>("fs_list_dir", {
      path,
      showHidden,
      respectGitignore,
    });
  },
  fsRename(from: string, to: string): Promise<void> {
    return invoke<void>("fs_rename", { from, to });
  },
  fsTrash(path: string): Promise<void> {
    return invoke<void>("fs_trash", { path });
  },
  fsReveal(path: string): Promise<void> {
    return invoke<void>("fs_reveal", { path });
  },
  fsOpenDefault(path: string): Promise<void> {
    return invoke<void>("fs_open_default", { path });
  },
  fsShellEditor(): Promise<string> {
    return invoke<string>("fs_shell_editor");
  },
  fsGitStatus(
    repoRoot: string,
  ): Promise<Record<string, FsGitStatusEntry>> {
    return invoke<Record<string, FsGitStatusEntry>>("fs_git_status", {
      repoRoot,
    });
  },
  fsGitBranch(repoRoot: string): Promise<string> {
    return invoke<string>("fs_git_branch", { repoRoot });
  },
  fsReadFile(path: string): Promise<FsReadFileResult> {
    return invoke<FsReadFileResult>("fs_read_file", { path });
  },
  fsGitDiffLines(path: string): Promise<FsLineDiffEntry[]> {
    return invoke<FsLineDiffEntry[]>("fs_git_diff_lines", { path });
  },
  fsWatchSetRoot(path: string | null): Promise<void> {
    return invoke<void>("fs_watch_set_root", { path });
  },
};

/** Mirror of `crate::fs_explorer::FileEntry`. */
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  size: number;
  modified_ms: number;
  gitignored: boolean;
}

/** Mirror of `crate::fs_explorer::ListResult`. */
export interface FsListResult {
  entries: FsEntry[];
  repo_root: string | null;
}

/** Event payload from the backend fs watcher. */
export interface FsChangePayload {
  paths: string[];
}

export const FS_CHANGED_EVENT = "acorn:fs-changed";

/** Per-path git status bucket. Mirrors `crate::fs_explorer::classify_status`. */
export type FsGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "clean";

/** Mirror of `crate::fs_explorer::GitStatusEntry`. */
export interface FsGitStatusEntry {
  kind: FsGitStatus;
  additions: number;
  deletions: number;
}

/** Mirror of `crate::fs_explorer::ReadFileResult`. */
export interface FsReadFileResult {
  content: string;
  size: number;
  truncated: boolean;
  binary: boolean;
}

/** Mirror of `crate::fs_explorer::LineDiffEntry`. */
export interface FsLineDiffEntry {
  line: number;
  kind: "added" | "modified" | "deleted";
}

function encodeStringToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Which user-invoked agent a resume candidate belongs to. */
export type AgentKind = "claude" | "codex";

export interface ResumeCandidate {
  /** JSONL transcript UUID the user is being offered to resume. */
  uuid: string;
  /** Unix seconds of the transcript file's mtime. `0` when unknown. */
  lastActivityUnix: number;
  /** Single-line preview of the last assistant text, truncated. */
  preview: string | null;
}

export interface DaemonStatus {
  running: boolean;
  enabled: boolean;
  daemon_version: string | null;
  uptime_seconds: number | null;
  session_count_total: number | null;
  session_count_alive: number | null;
  log_path: string | null;
  last_error: string | null;
}

export interface DaemonSessionSummary {
  id: string;
  name: string;
  kind: "regular" | "control";
  alive: boolean;
  cwd: string | null;
  repo_path: string | null;
  branch: string | null;
  agent_kind: string | null;
}

/**
 * Mirror of `crate::staged_rev_reconcile::StagedRevMismatch`. Returned
 * when the daemon still owns PTYs spawned against a different
 * staged-dotfile revision than the running build.
 */
export interface StagedRevMismatch {
  current_rev: string;
  stale_session_count: number;
}

export const STAGED_REV_MISMATCH_EVENT = "acorn:staged-rev-mismatch";
