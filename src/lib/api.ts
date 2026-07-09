import { invoke } from "@tauri-apps/api/core";
import type {
  AcornIpcStatus,
  AgentTokenUsageSnapshot,
  AgentHistoryItem,
  AgentTranscriptSummary,
  CommitInfo,
  ChatMessage,
  ChatMessagePatch,
  ChatSessionState,
  DiffPayload,
  GenerateSessionTitleResult,
  GeneratedCommitMessage,
  IssueDetailListing,
  IssueListing,
  IssueStateFilter,
  MemoryUsage,
  MergeMethod,
  Project,
  ProjectSettings,
  ProjectSettingsRecord,
  ProjectWorktree,
  PrStateFilter,
  PullRequestDetailListing,
  PullRequestDiffListing,
  PullRequestListing,
  Session,
  SessionAgentDetection,
  SessionAgentProvider,
  SessionKind,
  SessionMode,
  SessionProcessSummary,
  SessionStatus,
  SessionStatusReason,
  SessionTitleReadinessResult,
  StagedFile,
  TodoItem,
  WorkflowRunDetailListing,
  WorkflowRunsListing,
} from "./types";
import type {
  FolderPermissionWarmupResult,
  MacosPermissionResetResult,
} from "./permissionWarmup";
import type { IpcListWorkspacesResponsePayload } from "./ipcWorkspaces";

export type {
  ChatMessage,
  ChatMessagePatch,
  ChatMessageStatus,
  ChatRole,
  ChatSession,
  ChatSessionState,
  ChatTurn,
  ChatTurnStatus,
  ContextSnapshot,
  ContextSnapshotMode,
  ProviderThread,
  SessionMemory,
} from "./types";

export interface LoadStatus {
  sessionsClean: boolean;
  projectsClean: boolean;
}

export interface PreventSleepStatus {
  supported: boolean;
  enabled: boolean;
}

export interface AiExecutionRequest {
  provider: "claude" | "antigravity" | "codex" | "ollama" | "llm" | "custom";
  ollamaModel?: string | null;
  llmModel?: string | null;
}

export interface ClipboardSnapshot {
  supported: boolean;
  changeCount: number | null;
  types: string[];
  text: string | null;
  hasImage: boolean;
  mimeType: string | null;
  extension: string | null;
  dataB64: string | null;
}

export interface WorktreeRemoval {
  token: string;
  repoPath: string;
  worktreePath: string;
  gitCommonDir: string;
}

export interface ChatSessionStateChangedPayload {
  session_id: string;
  state: ChatSessionState;
}

export const CHAT_SESSION_STATE_CHANGED_EVENT =
  "acorn:chat-session-state-changed";

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
    agentProvider?: SessionAgentProvider | null,
    projectScoped?: boolean,
    mode: SessionMode = "terminal",
    cwdPath?: string,
  ): Promise<Session> {
    const args: {
      name: string;
      repoPath: string;
      isolated: boolean;
      kind: SessionKind;
      agentProvider?: SessionAgentProvider | null;
      projectScoped?: boolean;
      mode: SessionMode;
      cwdPath?: string;
    } = {
      name,
      repoPath,
      isolated,
      kind,
      agentProvider,
      mode,
    };
    if (projectScoped !== undefined) args.projectScoped = projectScoped;
    if (cwdPath !== undefined) args.cwdPath = cwdPath;
    return invoke<Session>("create_session", args);
  },
  createSessionFromDialog(
    name: string,
    isolated = false,
    kind: SessionKind = "regular",
    agentProvider?: SessionAgentProvider | null,
    projectScoped = true,
    title?: string,
    mode: SessionMode = "terminal",
  ): Promise<Session | null> {
    return invoke<Session | null>("create_session_from_dialog", {
      name,
      isolated,
      kind,
      agentProvider,
      projectScoped,
      title,
      mode,
    });
  },
  removeSession(
    id: string,
    removeWorktree = false,
  ): Promise<WorktreeRemoval | null> {
    return invoke<WorktreeRemoval | null>("remove_session", { id, removeWorktree });
  },
  setSessionStatus(id: string, status: SessionStatus): Promise<Session> {
    return invoke<Session>("set_session_status", { id, status });
  },
  renameSession(id: string, name: string): Promise<Session> {
    return invoke<Session>("rename_session", { id, name });
  },
  sessionTitleReadiness(id: string): Promise<SessionTitleReadinessResult> {
    return invoke<SessionTitleReadinessResult>("session_title_readiness", {
      id,
    });
  },
  generateSessionTitle(
    id: string,
    ai: AiExecutionRequest,
    prompt: string,
    force = false,
  ): Promise<GenerateSessionTitleResult> {
    return invoke<GenerateSessionTitleResult>("generate_session_title", {
      id,
      ai,
      prompt,
      force,
    });
  },
  previewSessionTitle(
    ai: AiExecutionRequest,
    prompt: string,
    firstUserMessage: string,
    repoPath?: string | null,
  ): Promise<string> {
    return invoke<string>("preview_session_title", {
      ai,
      prompt,
      firstUserMessage,
      repoPath,
    });
  },
  loadChatSessionState(sessionId: string): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("load_chat_session_state", {
      sessionId,
    });
  },
  saveChatSessionState(state: ChatSessionState): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("save_chat_session_state", {
      chatState: state,
    });
  },
  appendChatMessage(
    sessionId: string,
    message: ChatMessage,
  ): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("append_chat_message", {
      sessionId,
      message,
    });
  },
  updateChatMessage(
    sessionId: string,
    messageId: string,
    patch: ChatMessagePatch,
  ): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("update_chat_message", {
      sessionId,
      messageId,
      patch,
    });
  },
  sendChatMessage(
    sessionId: string,
    ai: AiExecutionRequest,
    content: string,
  ): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("send_chat_message", {
      sessionId,
      ai,
      content,
    });
  },
  retryChatMessage(
    sessionId: string,
    ai: AiExecutionRequest,
    messageId: string,
    content?: string,
  ): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("retry_chat_message", {
      sessionId,
      ai,
      messageId,
      content,
    });
  },
  deleteChatMessage(
    sessionId: string,
    messageId: string,
  ): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("delete_chat_message", {
      sessionId,
      messageId,
    });
  },
  cancelChatMessage(sessionId: string): Promise<ChatSessionState> {
    return invoke<ChatSessionState>("cancel_chat_message", {
      sessionId,
    });
  },
  listProjects(): Promise<Project[]> {
    return invoke<Project[]>("list_projects");
  },
  addProject(title?: string): Promise<Project | null> {
    return invoke<Project | null>("add_project", { title });
  },
  selectProjectParentFolder(title?: string): Promise<string | null> {
    return invoke<string | null>("select_project_parent_folder", { title });
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
    removeSettings = false,
  ): Promise<WorktreeRemoval[]> {
    return invoke<WorktreeRemoval[]>("remove_project", {
      repoPath,
      removeSessions,
      removeWorktrees,
      removeSettings,
    });
  },
  getProjectSettings(repoPath: string): Promise<ProjectSettingsRecord> {
    return invoke<ProjectSettingsRecord>("get_project_settings", { repoPath });
  },
  updateProjectSettings(
    repoPath: string,
    settings: ProjectSettings,
  ): Promise<ProjectSettingsRecord> {
    return invoke<ProjectSettingsRecord>("update_project_settings", {
      repoPath,
      settings,
    });
  },
  listProjectWorktrees(repoPath: string): Promise<ProjectWorktree[]> {
    return invoke<ProjectWorktree[]>("list_project_worktrees", { repoPath });
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
  /** Resolve the repo's GitHub `owner/repo` slug, or null when the origin
   *  remote isn't a GitHub host. Used to conditionally hide GitHub-only UI. */
  githubOriginSlug(repoPath: string): Promise<string | null> {
    return invoke<string | null>("github_origin_slug", { repoPath });
  },
  /** True when the path is inside a git repository. */
  isGitRepository(repoPath: string): Promise<boolean> {
    return invoke<boolean>("is_git_repository", { repoPath });
  },
  openInEditor(command: string, args: string[], path: string): Promise<void> {
    return invoke<void>("open_in_editor", { command, args, path });
  },
  stagedDiff(repoPath: string): Promise<DiffPayload> {
    return invoke<DiffPayload>("staged_diff", { repoPath });
  },
  stagedFileDiff(repoPath: string, path: string): Promise<DiffPayload> {
    return invoke<DiffPayload>("staged_file_diff", { repoPath, path });
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
  listIssues(
    repoPath: string,
    state: IssueStateFilter = "open",
    limit = 50,
    query: string | null = null,
  ): Promise<IssueListing> {
    return invoke<IssueListing>("list_issues", {
      repoPath,
      state,
      limit,
      query,
    });
  },
  getIssueDetail(
    repoPath: string,
    number: number,
  ): Promise<IssueDetailListing> {
    return invoke<IssueDetailListing>("get_issue_detail", {
      repoPath,
      number,
    });
  },
  addIssueComment(
    repoPath: string,
    number: number,
    body: string,
  ): Promise<void> {
    return invoke<void>("add_issue_comment", {
      repoPath,
      number,
      body,
    });
  },
  updateGithubComment(
    repoPath: string,
    accountLogin: string,
    commentId: number,
    body: string,
  ): Promise<void> {
    return invoke<void>("update_github_comment", {
      repoPath,
      accountLogin,
      commentId,
      body,
    });
  },
  deleteGithubComment(
    repoPath: string,
    accountLogin: string,
    commentId: number,
  ): Promise<void> {
    return invoke<void>("delete_github_comment", {
      repoPath,
      accountLogin,
      commentId,
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
  getPullRequestDiff(
    repoPath: string,
    number: number,
  ): Promise<PullRequestDiffListing> {
    return invoke<PullRequestDiffListing>("get_pull_request_diff", {
      repoPath,
      number,
    });
  },
  addPullRequestComment(
    repoPath: string,
    number: number,
    body: string,
  ): Promise<void> {
    return invoke<void>("add_pull_request_comment", {
      repoPath,
      number,
      body,
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
    admin: boolean = false,
  ): Promise<void> {
    return invoke<void>("merge_pull_request", {
      repoPath,
      number,
      method,
      commitTitle,
      commitBody,
      admin,
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
    ai: AiExecutionRequest,
    prompt: string,
  ): Promise<GeneratedCommitMessage> {
    return invoke<GeneratedCommitMessage>("generate_pr_commit_message", {
      repoPath,
      number,
      method,
      ai,
      prompt,
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
  getAgentTokenUsage(): Promise<AgentTokenUsageSnapshot> {
    return invoke<AgentTokenUsageSnapshot>("get_agent_token_usage");
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
  clipboardSnapshot(): Promise<ClipboardSnapshot> {
    return invoke<ClipboardSnapshot>("clipboard_snapshot");
  },
  warmMacosFolderPermissions(): Promise<FolderPermissionWarmupResult[]> {
    return invoke<FolderPermissionWarmupResult[]>(
      "warm_macos_folder_permissions",
    );
  },
  resetMacosFolderPermissions(): Promise<void> {
    return invoke<void>("reset_macos_folder_permissions");
  },
  resetMacosDeveloperPermissions(): Promise<MacosPermissionResetResult[]> {
    return invoke<MacosPermissionResetResult[]>(
      "reset_macos_developer_permissions",
    );
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
  ipcListWorkspacesResponse(
    response: IpcListWorkspacesResponsePayload,
  ): Promise<void> {
    return invoke<void>("ipc_list_workspaces_response", { response });
  },
  listSystemFonts(): Promise<string[]> {
    return invoke<string[]>("list_system_fonts");
  },
  listAgentHistory(repoPath: string, limit = 100): Promise<AgentHistoryItem[]> {
    return invoke<AgentHistoryItem[]>("list_agent_history", {
      repoPath,
      limit,
    });
  },
  agentTranscriptSummary(
    repoPath: string,
    transcriptId: string,
  ): Promise<AgentTranscriptSummary | null> {
    return invoke<AgentTranscriptSummary | null>("agent_transcript_summary", {
      repoPath,
      transcriptId,
    });
  },
  agentTranscriptSummaryAtPath(
    repoPath: string,
    provider: SessionAgentProvider,
    id: string,
    transcriptPath: string,
  ): Promise<AgentTranscriptSummary | null> {
    return invoke<AgentTranscriptSummary | null>(
      "agent_transcript_summary_at_path",
      {
        repoPath,
        provider,
        id,
        transcriptPath,
      },
    );
  },
  listUnscopedAgentHistory(limit = 100): Promise<AgentHistoryItem[]> {
    return invoke<AgentHistoryItem[]>("list_unscoped_agent_history", {
      limit,
    });
  },
  trashAgentHistoryTranscript(item: AgentHistoryItem): Promise<void> {
    return invoke<void>("trash_agent_history_transcript", {
      provider: item.provider,
      id: item.id,
      transcriptPath: item.transcript_path,
    });
  },
  readSessionTodos(sessionId: string, cwd: string): Promise<TodoItem[]> {
    return invoke<TodoItem[]>("read_session_todos", { sessionId, cwd });
  },
  detectSessionStatuses(
    ids: string[],
  ): Promise<
    {
      id: string;
      status: SessionStatus;
      status_reason?: SessionStatusReason | null;
      status_started_at?: string | null;
      last_message?: string | null;
      last_user_message?: string | null;
      last_agent_message?: string | null;
      agent_provider?: SessionAgentProvider | null;
      agent_transcript_id?: string | null;
      agent_transcript_path?: string | null;
      active_processes?: SessionProcessSummary[];
      git_context_path?: string | null;
      branch: string | null;
      auto_title_enabled?: boolean | null;
    }[]
  > {
    return invoke<
      {
        id: string;
        status: SessionStatus;
        status_reason?: SessionStatusReason | null;
        status_started_at?: string | null;
        last_message?: string | null;
        last_user_message?: string | null;
        last_agent_message?: string | null;
        agent_provider?: SessionAgentProvider | null;
        agent_transcript_id?: string | null;
        agent_transcript_path?: string | null;
        active_processes?: SessionProcessSummary[];
        git_context_path?: string | null;
        branch: string | null;
        auto_title_enabled?: boolean | null;
      }[]
    >("detect_session_statuses", { ids });
  },
  /**
   * Inspect on-disk markers to determine which agent CLI (if any) the user has
   * run inside this Acorn session. Drives the Tab > Fork menu item visibility.
   */
  detectSessionAgent(
    sessionId: string,
  ): Promise<SessionAgentDetection> {
    return invoke<SessionAgentDetection>("detect_session_agent", { sessionId });
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
   * Create a fresh linked worktree for an existing native chat session and
   * adopt it as the session working directory before the first chat turn.
   */
  prepareChatSessionWorktree(sessionId: string): Promise<Session> {
    return invoke<Session>("prepare_chat_session_worktree", { sessionId });
  },
  /**
   * List absolute paths of every *linked* git worktree of the repo
   * containing `repoPath`. Used to snapshot before a PTY command runs and
   * diff after it exits, so we can detect a freshly-created worktree.
   */
  gitWorktrees(repoPath: string): Promise<string[]> {
    return invoke<string[]>("git_worktrees", { repoPath });
  },
  removeWorktree(
    repoPath: string,
    worktreePath: string,
    removeSessions = false,
  ): Promise<WorktreeRemoval | null> {
    return invoke<WorktreeRemoval | null>(
      "remove_worktree",
      removeSessions
        ? { repoPath, worktreePath, removeSessions }
        : { repoPath, worktreePath },
    );
  },
  restoreRemovedWorktree(removal: WorktreeRemoval): Promise<void> {
    return invoke<void>("restore_removed_worktree", { ...removal });
  },
  discardRemovedWorktree(removal: WorktreeRemoval): Promise<void> {
    return invoke<void>("discard_removed_worktree", { ...removal });
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
  preventSleepStatus(): Promise<PreventSleepStatus> {
    return invoke<PreventSleepStatus>("prevent_sleep_status");
  },
  setPreventSleep(enabled: boolean): Promise<PreventSleepStatus> {
    return invoke<PreventSleepStatus>("set_prevent_sleep", { enabled });
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
   * Enumerate live sessions tracked by the daemon. Backs the Settings →
   * Background sessions list view; inactive daemon metadata is handled by
   * `daemonForgetInactiveSessions`.
   */
  daemonListSessions(): Promise<DaemonSessionSummary[]> {
    return invoke<DaemonSessionSummary[]>("daemon_list_sessions");
  },
  /**
   * Kill a daemon-owned PTY. Equivalent to closing the shell inside the
   * session; the daemon detaches the row once the PTY child exits.
   */
  daemonKillSession(targetSessionId: string): Promise<void> {
    return invoke<void>("daemon_kill_session", {
      targetSessionId,
    });
  },
  /**
   * Remove an inactive session row from the daemon registry. The daemon
   * rejects this for sessions still alive — caller must kill first.
   */
  daemonForgetSession(targetSessionId: string): Promise<void> {
    return invoke<void>("daemon_forget_session", {
      targetSessionId,
    });
  },
  /**
   * Remove every inactive session row from the daemon registry. Live PTYs
   * are left untouched. Returns the number of rows forgotten.
   */
  daemonForgetInactiveSessions(): Promise<number> {
    return invoke<number>("daemon_forget_inactive_sessions");
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
   * Resolve a previous-agent-conversation candidate for a session. The
   * filesystem watcher writes provider id markers after fresh agent runs,
   * and the app surfaces them on session focus. Returns `null` when there
   * is nothing to offer, the user already dismissed the modal for this
   * UUID, or the provider is actively running in the PTY tree.
   */
  getAgentResumeCandidate(
    provider: SessionAgentProvider,
    sessionId: string,
  ): Promise<ResumeCandidate | null> {
    return invoke<ResumeCandidate | null>(
      "get_agent_resume_candidate",
      { kind: provider, sessionId },
    );
  },
  /**
   * Mark the provider's current id as seen so the modal does not pop
   * again for the same UUID; only a new transcript under a different UUID
   * reactivates it.
   */
  acknowledgeAgentResume(
    provider: SessionAgentProvider,
    sessionId: string,
  ): Promise<void> {
    return invoke<void>("acknowledge_agent_resume", {
      kind: provider,
      sessionId,
    });
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
    statusLimit?: number,
  ): Promise<FsGitStatusResult> {
    return invoke<FsGitStatusResult>("fs_git_status", {
      repoRoot,
      statusLimit,
    });
  },
  fsGitDiffStats(
    repoRoot: string,
    entries: FsGitDiffStatsRequest[],
  ): Promise<Record<string, FsGitDiffStatsEntry>> {
    return invoke<Record<string, FsGitDiffStatsEntry>>("fs_git_diff_stats", {
      repoRoot,
      entries,
    });
  },
  fsGitBranch(repoRoot: string): Promise<string> {
    return invoke<string>("fs_git_branch", { repoRoot });
  },
  fsFileExists(path: string): Promise<boolean> {
    return invoke<boolean>("fs_file_exists", { path });
  },
  fsGrantExternalFile(path: string): Promise<void> {
    return invoke<void>("fs_grant_external_file", { path });
  },
  fsReadFile(path: string): Promise<FsReadFileResult> {
    return invoke<FsReadFileResult>("fs_read_file", { path });
  },
  fsPrepareAsset(path: string): Promise<FsPrepareAssetResult> {
    return invoke<FsPrepareAssetResult>("fs_prepare_asset", { path });
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
export interface FsRefreshHint {
  kind: "root" | "subtree";
  path: string;
}

export interface FsChangePayload {
  paths: string[];
  root?: string;
  overflow?: boolean;
  cap?: number;
  refresh?: FsRefreshHint | null;
  dotgit_changed: boolean;
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

/** Mirror of `crate::fs_explorer::GitStatusResult`. */
export interface FsGitStatusResult {
  statuses: Record<string, FsGitStatusEntry>;
  huge: boolean;
  limit: number;
}

export interface FsGitDiffStatsRequest {
  path: string;
  kind: FsGitStatus;
}

export interface FsGitDiffStatsEntry {
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

/** Mirror of `crate::fs_explorer::PrepareAssetResult`. */
export interface FsPrepareAssetResult {
  size: number;
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
export type AgentKind = SessionAgentProvider;

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
export const AGENT_HOOK_STATUS_EVENT = "acorn:agent-hook-status";
