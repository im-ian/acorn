import type {
  FsGitDiffStatsEntry,
  FsGitStatus,
  FsGitStatusResult,
} from "./api";
import { relativePath } from "./pathUtils";
import type { ChatSessionState } from "./types";

export type WorkSummaryDiffStatsByPath = Record<string, FsGitDiffStatsEntry>;

export interface WorkSummaryChangedFile {
  path: string;
  relativePath: string;
  kind: FsGitStatus;
  additions: number;
  deletions: number;
}

export type WorkSummaryKindCounts = Record<FsGitStatus, number>;

export interface WorkSummary {
  files: WorkSummaryChangedFile[];
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  byKind: WorkSummaryKindCounts;
  huge: boolean;
  limit: number;
}

export interface WorkSummaryChatMetrics {
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  turnCount: number;
  completeTurns: number;
  runningTurns: number;
}

export interface WorkSummaryTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  messagesWithUsage: number;
}

export interface WorkSummaryTokenBaseline extends WorkSummaryTokenUsage {
  capturedAt: string;
}

export function emptyKindCounts(): WorkSummaryKindCounts {
  return {
    added: 0,
    clean: 0,
    conflicted: 0,
    deleted: 0,
    modified: 0,
    renamed: 0,
  };
}

export function buildWorkSummary(
  rootPath: string,
  status: FsGitStatusResult,
  diffStats: WorkSummaryDiffStatsByPath,
): WorkSummary {
  const byKind = emptyKindCounts();
  const files = Object.entries(status.statuses)
    .map(([path, entry]): WorkSummaryChangedFile => {
      const stats = diffStats[path] ?? entry;
      return {
        path,
        relativePath: relativePath(rootPath, path),
        kind: entry.kind,
        additions: stats.additions,
        deletions: stats.deletions,
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of files) {
    byKind[file.kind] += 1;
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }

  return {
    files,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    byKind,
    huge: status.huge,
    limit: status.limit,
  };
}

export function summarizeChatSession(
  state: ChatSessionState,
): WorkSummaryChatMetrics {
  let userMessages = 0;
  let assistantMessages = 0;
  for (const message of state.messages) {
    if (message.role === "user") userMessages += 1;
    if (message.role === "assistant") assistantMessages += 1;
  }

  let completeTurns = 0;
  let runningTurns = 0;
  for (const turn of state.turns) {
    if (turn.status === "complete") completeTurns += 1;
    if (turn.status === "running" || turn.status === "pending") {
      runningTurns += 1;
    }
  }

  return {
    messageCount: state.messages.length,
    userMessages,
    assistantMessages,
    turnCount: state.turns.length,
    completeTurns,
    runningTurns,
  };
}

export function summarizeTokenUsage(
  state: ChatSessionState,
): WorkSummaryTokenUsage {
  const total = emptyTokenUsage();

  for (const message of state.messages) {
    if (message.role !== "assistant") continue;
    const usage = extractTokenUsage(message.metadata);
    if (!usage) continue;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheCreationTokens += usage.cacheCreationTokens;
    total.reasoningTokens += usage.reasoningTokens;
    total.totalTokens += usage.totalTokens;
    total.messagesWithUsage += 1;
  }

  return total;
}

export function emptyTokenUsage(): WorkSummaryTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    messagesWithUsage: 0,
  };
}

export function tokenUsageDelta(
  current: WorkSummaryTokenUsage,
  baseline: WorkSummaryTokenUsage | null | undefined,
): WorkSummaryTokenUsage {
  if (!baseline) return current;
  return {
    inputTokens: positiveDelta(current.inputTokens, baseline.inputTokens),
    outputTokens: positiveDelta(current.outputTokens, baseline.outputTokens),
    cacheReadTokens: positiveDelta(
      current.cacheReadTokens,
      baseline.cacheReadTokens,
    ),
    cacheCreationTokens: positiveDelta(
      current.cacheCreationTokens,
      baseline.cacheCreationTokens,
    ),
    reasoningTokens: positiveDelta(
      current.reasoningTokens,
      baseline.reasoningTokens,
    ),
    totalTokens: positiveDelta(current.totalTokens, baseline.totalTokens),
    messagesWithUsage: positiveDelta(
      current.messagesWithUsage,
      baseline.messagesWithUsage,
    ),
  };
}

export function extractTokenUsage(
  metadata: unknown,
): WorkSummaryTokenUsage | null {
  const candidates = collectUsageCandidates(metadata);
  for (const candidate of candidates) {
    const inputTokens = firstNumber(candidate, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
    ]);
    const outputTokens = firstNumber(candidate, [
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "completionTokens",
    ]);
    const cacheReadTokens = firstNumber(candidate, [
      "cache_read_input_tokens",
      "cacheReadInputTokens",
      "cached_input_tokens",
      "cachedInputTokens",
      "cached_tokens",
      "cachedTokens",
    ]);
    const cacheCreationTokens = firstNumber(candidate, [
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ]);
    const reasoningTokens = firstNumber(candidate, [
      "reasoning_output_tokens",
      "reasoningOutputTokens",
      "reasoning_tokens",
      "reasoningTokens",
    ]);
    const explicitTotal = firstNumber(candidate, [
      "total_tokens",
      "totalTokens",
      "total_token_count",
      "totalTokenCount",
    ]);
    const totalTokens =
      explicitTotal ||
      inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
    if (
      inputTokens ||
      outputTokens ||
      cacheReadTokens ||
      cacheCreationTokens ||
      reasoningTokens ||
      totalTokens
    ) {
      return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens,
        totalTokens,
        messagesWithUsage: 1,
      };
    }
  }
  return null;
}

function collectUsageCandidates(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const candidates: Record<string, unknown>[] = [];
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);

    if (looksLikeUsageObject(current)) candidates.push(current);
    for (const key of [
      "provider_response",
      "providerResponse",
      "usage",
      "token_usage",
      "tokenUsage",
      "total_token_usage",
      "totalTokenUsage",
      "info",
      "message",
      "response",
      "payload",
      "metadata",
    ]) {
      if (key in current) stack.push(current[key]);
    }
  }

  return candidates;
}

function looksLikeUsageObject(value: Record<string, unknown>): boolean {
  return [
    "input_tokens",
    "output_tokens",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_input_tokens",
    "reasoning_output_tokens",
    "cache_creation_input_tokens",
  ].some((key) => typeof value[key] === "number");
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.round(raw);
    }
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveDelta(current: number, baseline: number): number {
  return Math.max(0, current - baseline);
}
