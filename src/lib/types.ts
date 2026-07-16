export type SessionStatus =
  | "ready"
  | "working"
  | "waiting_for_input"
  | "errored";

export type SessionStatusReason = "turn_complete" | "shell_prompt";

export type AgentStatusSource =
  | "hook"
  | "transcript_fallback"
  | "process_fallback";

export type SessionNotificationKind = "waiting_for_input" | "errored";

export interface SessionNotification {
  id: string;
  sessionId: string;
  kind: SessionNotificationKind;
  status: SessionStatus;
  previousStatus: SessionStatus;
  sessionName: string;
  projectName: string;
  repoPath: string;
  createdAt: string;
  readAt?: string;
}

/**
 * Distinguishes ordinary terminal sessions from "control" sessions. Control
 * sessions are the entry point for the `acorn-ipc` CLI, which lets them
 * dispatch commands to other sessions in the same project. Persisted
 * sessions without this field load as `"regular"` from the backend.
 */
export type SessionKind = "regular" | "control";

export type SessionMode = "terminal" | "chat";

export type SessionOwner =
  | { kind: "user" }
  | { kind: "control"; session_id: string };

export type SessionTitleSource = "default" | "generated" | "manual";

export type SessionAgentProvider = "claude" | "codex" | "antigravity";

export type SessionAgentDetection = Record<SessionAgentProvider, string | null>;

export type SessionTitleGenerationStatus =
  | "generated"
  | "not_ready"
  | "skipped";

export type SessionTitleReadinessStatus = "ready" | "not_ready" | "skipped";

export interface GenerateSessionTitleResult {
  status: SessionTitleGenerationStatus;
  session: Session;
}

export interface SessionTitleReadinessResult {
  status: SessionTitleReadinessStatus;
  session: Session;
}

export type AgentProviderCapability =
  | "history"
  | "resume"
  | "fork"
  | "status"
  | "hooks"
  | "tokenUsage";

export type AgentProviderIconMetadata =
  | {
      kind: "mask";
      url: string;
      alt: string;
    }
  | {
      kind: "glyph";
      text: string;
      alt: string;
    };

export interface AgentProviderHookMetadata {
  supportsHooks: boolean;
  providerEnvValue?: SessionAgentProvider;
}

export interface AgentProviderSessionMetadata {
  markerFile?: string;
  acknowledgedMarkerFile?: string;
  resumeCommandPrefix?: string;
  forkCommandPrefix?: string;
  forkCommandSuffix?: string;
  supportsSessionResume: boolean;
  requiresForkTranscriptPrep?: boolean;
}

export interface AgentProviderDefinition<
  TProvider extends SessionAgentProvider = SessionAgentProvider,
> {
  id: TProvider;
  label: string;
  agentOptionLabel: string;
  oneshotHint: string;
  icon: AgentProviderIconMetadata;
  capabilities: readonly AgentProviderCapability[];
  hooks: AgentProviderHookMetadata;
  session: AgentProviderSessionMetadata;
  imagePasteFallback: boolean;
  mentionPrefix: string;
  supportsWorktreeAdoption: boolean;
  brandToneClassName: string;
  inferNamePattern: RegExp;
}

export interface Session {
  id: string;
  name: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
  isolated: boolean;
  project_scoped?: boolean;
  status: SessionStatus;
  /** Ephemeral status-poll detail. Not persisted in backend sessions. */
  status_reason?: SessionStatusReason | null;
  /** Ephemeral status control path reported by status polling. */
  agent_status_source?: AgentStatusSource | null;
  /** Ephemeral time when the current status started. */
  status_started_at?: string | null;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  /** Ephemeral transcript/chat preview for the latest user turn. */
  last_user_message?: string | null;
  /** Ephemeral source timestamp for the latest real user turn. */
  last_user_message_at?: string | null;
  /** Ephemeral transcript/chat preview for the latest agent turn. */
  last_agent_message?: string | null;
  title_source: SessionTitleSource;
  auto_title_enabled?: boolean | null;
  generated_title_transcript_id?: string | null;
  kind: SessionKind;
  mode?: SessionMode;
  owner: SessionOwner;
  position: number | null;
  /** Derived backend-side from `worktree_path`'s `.git` being a file (linked
   * worktree marker). Surfaces the worktree icon regardless of whether Acorn,
   * `claude -w`, or the user originally created the worktree. */
  in_worktree: boolean;
  /** Current live agent provider, if a known agent process is under the PTY. */
  agent_provider?: SessionAgentProvider | null;
  /** Provider for the paired transcript path/id, independent from live process state. */
  agent_transcript_provider?: SessionAgentProvider | null;
  /** Most recently paired agent transcript id, if Acorn has paired this tab to one. */
  agent_transcript_id?: string | null;
  /** Ephemeral path to the transcript currently used for status/preview reads. */
  agent_transcript_path?: string | null;
  /** Ephemeral mtime of the transcript/chat state backing the latest agent work. */
  agent_activity_at?: string | null;
  /** Ephemeral live process names observed under the session PTY. */
  active_processes?: SessionProcessSummary[];
  /** Ephemeral git workdir that produced the current live branch. */
  git_context_path?: string | null;
}

export interface SessionProcessSummary {
  pid: number;
  name: string;
  depth: number;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "error"
  | "cancelled";

export interface ChatMessage {
  id: string;
  session_id?: string | null;
  turn_id?: string | null;
  role: ChatRole;
  content: string;
  created_at: string;
  status?: ChatMessageStatus | null;
  metadata?: unknown;
}

export interface ChatSession {
  id: string;
  workspace_path?: string | null;
  title?: string | null;
  active_provider?: string | null;
  active_model?: string | null;
  created_at: string;
  updated_at: string;
}

export type ChatTurnStatus =
  | "pending"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

export interface ChatTurn {
  id: string;
  session_id: string;
  provider: string;
  model?: string | null;
  status: ChatTurnStatus;
  user_message_id: string;
  assistant_message_id?: string | null;
  started_at: string;
  completed_at?: string | null;
  error?: string | null;
}

export interface ProviderThread {
  session_id: string;
  provider: string;
  model?: string | null;
  native_thread_id?: string | null;
  resume_token?: string | null;
  last_response_id?: string | null;
  updated_at: string;
}

export type ContextSnapshotMode = "native_thread" | "compiled_context";

export interface ContextSnapshot {
  turn_id: string;
  session_id: string;
  provider: string;
  mode: ContextSnapshotMode;
  included_message_ids: string[];
  summary_id?: string | null;
  prompt_or_payload: string;
  created_at: string;
}

export interface SessionMemory {
  session_id: string;
  summary?: string | null;
  important_decisions: string[];
  facts: string[];
  through_message_id?: string | null;
  updated_at: string;
}

export interface ChatSessionState {
  schema_version: number;
  session_id: string;
  session: ChatSession;
  provider?: string | null;
  model?: string | null;
  messages: ChatMessage[];
  turns: ChatTurn[];
  provider_threads: ProviderThread[];
  context_snapshots: ContextSnapshot[];
  memory: SessionMemory;
  created_at: string;
  updated_at: string;
}

export interface ChatMessagePatch {
  content?: string;
  status?: ChatMessageStatus;
  metadata?: unknown;
}

export interface Project {
  repo_path: string;
  name: string;
  created_at: string;
  position: number;
}

export interface ProjectWorktree {
  name: string;
  path: string;
  modified_ms: number | null;
}

export interface ProjectPullRequestSettings {
  generation_prompt: string | null;
}

export interface ProjectSettings {
  remember_after_close: boolean;
  pull_requests: ProjectPullRequestSettings;
}

export interface ProjectSettingsRecord {
  key: string;
  settings: ProjectSettings;
}

export type AgentHistoryProvider = SessionAgentProvider;

export interface AgentHistoryWorktree {
  name: string;
  path: string;
  exists: boolean;
}

export interface AgentHistoryItem {
  provider: AgentHistoryProvider;
  id: string;
  title: string;
  preview: string | null;
  queued_message_count: number;
  subagent_transcript_count: number;
  cwd: string | null;
  worktree: AgentHistoryWorktree | null;
  transcript_path: string;
  updated_at: number;
  resume_command: string | null;
}

export interface AgentTranscriptTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  messages_with_usage: number;
}

export interface AgentTranscriptSummary {
  provider: AgentHistoryProvider;
  id: string;
  transcript_path: string;
  updated_at: number;
  message_count: number;
  user_messages: number;
  assistant_messages: number;
  turn_count: number;
  complete_turns: number;
  running_turns: number;
  recent_messages: AgentTranscriptMessagePreview[];
  token_usage: AgentTranscriptTokenUsage;
}

export interface AgentTranscriptMessagePreview {
  role: "user" | "assistant";
  text: string;
}

export interface CommitInfo {
  sha: string;
  short_sha: string;
  author: string;
  author_email: string;
  timestamp: number;
  summary: string;
  body: string;
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

export type AgentTokenProvider = "codex" | "claude";
export type AgentTokenWindow = "five_hour" | "weekly";

export interface AgentTokenUsageMetric {
  provider: AgentTokenProvider;
  window: AgentTokenWindow;
  used_percent: number | null;
  remaining_percent: number | null;
  reset_at: number | null;
  source: string;
  error: string | null;
}

export interface AgentTokenUsageSnapshot {
  metrics: AgentTokenUsageMetric[];
  updated_at: number;
}

export interface AcornIpcShim {
  path: string;
  exists: boolean;
}

export interface AcornIpcStatus {
  bundled_path: string;
  bundled_exists: boolean;
  socket_path: string;
  server_running: boolean;
  shim_paths: AcornIpcShim[];
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus | string;
  activeForm?: string | null;
}

export type PrStateFilter = "open" | "closed" | "merged" | "all";
export type IssueStateFilter = "open" | "closed" | "all";

export interface PullRequestLabel {
  name: string;
  /** Hex color without the leading `#`, as returned by gh. */
  color: string;
}

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
  closed_at: string | null;
  merged_at: string | null;
  is_draft: boolean;
  /** Aggregate of head-sha checks. null when gh returned no rollup entries. */
  checks: PullRequestChecksSummary | null;
  labels: PullRequestLabel[];
}

export interface AccountSummary {
  login: string;
  has_access: boolean;
}

export type PullRequestListing =
  | { kind: "ok"; items: PullRequestInfo[]; account: string }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export interface SessionPullRequestSummary {
  number: number;
  title: string;
  url: string;
  head_branch: string;
  base_branch: string;
  state: string;
  is_draft: boolean;
}

export interface IssueInfo {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  state_reason: string | null;
  comments: number;
  labels: PullRequestLabel[];
}

export type IssueListing =
  | { kind: "ok"; items: IssueInfo[]; account: string }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export interface IssueComment {
  id: number | null;
  author: string;
  author_avatar_url: string | null;
  body: string;
  created_at: string;
  url: string | null;
}

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  state_reason: string | null;
  labels: PullRequestLabel[];
  comments: IssueComment[];
  assignees: string[];
  milestone: string | null;
}

export type IssueDetailListing =
  | { kind: "ok"; account: string; detail: IssueDetail }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export interface PullRequestComment {
  id: number | null;
  author: string;
  author_avatar_url: string | null;
  body: string;
  created_at: string;
  url: string | null;
}

export interface PullRequestReview {
  author: string;
  author_avatar_url: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  body: string;
  submitted_at: string;
}

export interface PullRequestCommitAuthor {
  name: string;
  email: string;
  /** GitHub login when resolvable, otherwise null. */
  login: string | null;
}

export interface PullRequestCommit {
  /** Full SHA — UI shortens for display but full id is needed for the GitHub link. */
  oid: string;
  message_headline: string;
  message_body: string;
  committed_date: string;
  authors: PullRequestCommitAuthor[];
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
  labels: PullRequestLabel[];
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
  checks: PullRequestCheck[];
  commits: PullRequestCommit[];
}

export type PullRequestDetailListing =
  | { kind: "ok"; account: string; detail: PullRequestDetail }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export type PullRequestDiffListing =
  | { kind: "ok"; account: string; diff: DiffPayload }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export interface WorkflowRun {
  id: number;
  /** Commit subject (or dispatch title) gh shows for the run. */
  display_title: string;
  /** Human-readable workflow name (e.g. "CI", "Release"). */
  workflow_name: string;
  /** queued | in_progress | completed | requested | waiting | pending */
  status: string;
  /** success | failure | cancelled | skipped | neutral | timed_out | action_required | startup_failure. null while still running. */
  conclusion: string | null;
  /** push | pull_request | workflow_dispatch | schedule | ... */
  event: string;
  head_branch: string | null;
  head_sha: string;
  url: string;
  created_at: string;
  updated_at: string;
  /** When GitHub reports the run actually began. Null while still queued. */
  started_at: string | null;
  attempt: number;
}

export type WorkflowRunsListing =
  | { kind: "ok"; items: WorkflowRun[]; account: string }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export interface WorkflowJobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  url: string;
  steps: WorkflowJobStep[];
}

export interface WorkflowRunDetail {
  id: number;
  display_title: string;
  workflow_name: string;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  url: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  attempt: number;
  jobs: WorkflowJob[];
}

export type WorkflowRunDetailListing =
  | { kind: "ok"; account: string; detail: WorkflowRunDetail }
  | { kind: "not_github" }
  | { kind: "no_access"; slug: string; accounts: AccountSummary[] };

export type MergeMethod = "squash" | "merge" | "rebase";

export interface GeneratedCommitMessage {
  title: string;
  body: string;
}
