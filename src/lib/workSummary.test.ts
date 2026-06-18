import { describe, expect, it } from "vitest";
import type { ChatSessionState } from "./types";
import {
  buildWorkSummary,
  summarizeTokenUsage,
  summarizeChatSession,
  tokenUsageDelta,
  type WorkSummaryDiffStatsByPath,
} from "./workSummary";

describe("work summary git aggregation", () => {
  it("builds changed file rows and aggregate counts from git status and diff stats", () => {
    const diffStats: WorkSummaryDiffStatsByPath = {
      "/repo/src/App.tsx": { additions: 12, deletions: 3 },
      "/repo/README.md": { additions: 4, deletions: 0 },
    };

    const summary = buildWorkSummary("/repo", {
      statuses: {
        "/repo/src/App.tsx": {
          kind: "modified",
          additions: 0,
          deletions: 0,
        },
        "/repo/README.md": {
          kind: "added",
          additions: 0,
          deletions: 0,
        },
      },
      huge: false,
      limit: 500,
    }, diffStats);

    expect(summary.totalFiles).toBe(2);
    expect(summary.totalAdditions).toBe(16);
    expect(summary.totalDeletions).toBe(3);
    expect(summary.byKind).toEqual({
      added: 1,
      clean: 0,
      conflicted: 0,
      deleted: 0,
      modified: 1,
      renamed: 0,
    });
    expect(summary.files.map((file) => file.relativePath)).toEqual([
      "README.md",
      "src/App.tsx",
    ]);
  });

  it("uses status-provided counts when diff stats are not available", () => {
    const summary = buildWorkSummary("/repo", {
      statuses: {
        "/repo/package.json": {
          kind: "modified",
          additions: 2,
          deletions: 1,
        },
      },
      huge: true,
      limit: 1,
    }, {});

    expect(summary.totalFiles).toBe(1);
    expect(summary.totalAdditions).toBe(2);
    expect(summary.totalDeletions).toBe(1);
    expect(summary.huge).toBe(true);
  });
});

describe("work summary chat aggregation", () => {
  it("counts chat messages and turns by role and status", () => {
    const chat = {
      messages: [
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
      ],
      turns: [
        { id: "t1", status: "complete" },
        { id: "t2", status: "running" },
      ],
    } as ChatSessionState;

    expect(summarizeChatSession(chat)).toEqual({
      assistantMessages: 1,
      completeTurns: 1,
      messageCount: 3,
      runningTurns: 1,
      turnCount: 2,
      userMessages: 2,
    });
  });

  it("extracts token usage from provider response metadata", () => {
    const chat = {
      messages: [
        {
          id: "a1",
          role: "assistant",
          metadata: {
            provider_response: {
              usage: {
                input_tokens: 1200,
                output_tokens: 300,
                cache_read_input_tokens: 500,
              },
            },
          },
        },
        {
          id: "a2",
          role: "assistant",
          metadata: {
            provider_response: {
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  output_tokens: 50,
                  reasoning_output_tokens: 25,
                  total_tokens: 175,
                },
              },
            },
          },
        },
      ],
      turns: [],
    } as unknown as ChatSessionState;

    expect(summarizeTokenUsage(chat)).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 500,
      inputTokens: 1300,
      messagesWithUsage: 2,
      outputTokens: 350,
      reasoningTokens: 25,
      totalTokens: 2175,
    });
  });

  it("computes token usage since a captured baseline", () => {
    expect(
      tokenUsageDelta(
        {
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: 10,
          cacheCreationTokens: 0,
          reasoningTokens: 5,
          totalTokens: 170,
          messagesWithUsage: 2,
        },
        {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 15,
          cacheCreationTokens: 0,
          reasoningTokens: 1,
          totalTokens: 130,
          messagesWithUsage: 1,
        },
      ),
    ).toEqual({
      inputTokens: 20,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 4,
      totalTokens: 40,
      messagesWithUsage: 1,
    });
  });

});
