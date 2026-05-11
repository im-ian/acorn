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
  SessionStartupMode,
  SessionStatus,
  StagedFile,
  TodoItem,
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
    startupMode: SessionStartupMode | null = null,
    kind: SessionKind = "regular",
  ): Promise<Session> {
    return invoke<Session>("create_session", {
      name,
      repoPath,
      isolated,
      startupMode,
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
  claudeSessionExists(cwd: string, sessionId: string): Promise<boolean> {
    return invoke<boolean>("claude_session_exists", { cwd, sessionId });
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
  ): Promise<PullRequestListing> {
    return invoke<PullRequestListing>("list_pull_requests", {
      repoPath,
      state,
      limit,
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
};
