import { test, expect } from "./support";

const CHAT_SESSION = {
  id: "chat-actions",
  name: "Chat actions",
  repo_path: "/tmp/demo",
  worktree_path: "/tmp/demo",
  branch: "main",
  isolated: false,
  project_scoped: true,
  status: "needs_input",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_message: null,
  title_source: "manual",
  kind: "regular",
  mode: "chat",
  owner: { kind: "user" },
  position: null,
  in_worktree: false,
  agent_provider: "claude",
};

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

test.describe("chat message actions", () => {
  test("can stop a running native chat response", async ({ page, tauri }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [CHAT_SESSION]);
    await page.addInitScript(() => {
      const now = "2026-01-01T00:00:00Z";
      const emptyState = {
        schema_version: 1,
        session_id: "chat-actions",
        session: {
          id: "chat-actions",
          workspace_path: "/tmp/demo",
          title: "Chat actions",
          active_provider: "claude",
          active_model: null,
          created_at: now,
          updated_at: now,
        },
        provider: "claude",
        model: null,
        messages: [],
        turns: [],
        provider_threads: [],
        context_snapshots: [],
        memory: {
          session_id: "chat-actions",
          summary: null,
          important_decisions: [],
          facts: [],
          through_message_id: null,
          updated_at: now,
        },
        created_at: now,
        updated_at: now,
      };
      const w = window as unknown as {
        __chatState: typeof emptyState;
        __sendCalls?: unknown[];
        __cancelCalls?: unknown[];
      };
      w.__chatState = emptyState;
    });
    await tauri.handle("load_chat_session_state", () => {
      return (window as unknown as { __chatState: unknown }).__chatState;
    });
    await tauri.handle("send_chat_message", (args) => {
      const now = "2026-01-01T00:00:01Z";
      const w = window as unknown as {
        __chatState: Record<string, unknown>;
        __sendCalls?: unknown[];
      };
      w.__sendCalls = w.__sendCalls ?? [];
      w.__sendCalls.push(args);
      w.__chatState = {
        ...w.__chatState,
        messages: [
          {
            id: "u1",
            session_id: "chat-actions",
            turn_id: "t1",
            role: "user",
            content: args?.content,
            created_at: now,
            status: "complete",
            metadata: null,
          },
          {
            id: "a1",
            session_id: "chat-actions",
            turn_id: "t1",
            role: "assistant",
            content: "",
            created_at: now,
            status: "pending",
            metadata: { provider: args?.ai?.provider ?? "claude" },
          },
        ],
        updated_at: now,
      };
      return w.__chatState;
    });
    await tauri.handle("cancel_chat_message", (args) => {
      const now = "2026-01-01T00:00:02Z";
      const w = window as unknown as {
        __chatState: { messages?: Array<Record<string, unknown>> };
        __cancelCalls?: unknown[];
      };
      w.__cancelCalls = w.__cancelCalls ?? [];
      w.__cancelCalls.push(args);
      const messages = w.__chatState.messages ?? [];
      w.__chatState = {
        ...w.__chatState,
        messages: [
          messages[0],
          {
            ...messages[1],
            content: "Cancelled",
            created_at: now,
            status: "cancelled",
          },
        ],
        updated_at: now,
      };
      return w.__chatState;
    });

    await page.goto("/");
    await page.getByLabel("Chat message").fill("do a long task");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText("do a long task")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();

    await page.getByRole("button", { name: "Stop response" }).click();

    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    const calls = await page.evaluate(() => ({
      send: (window as unknown as { __sendCalls?: unknown[] }).__sendCalls,
      cancel: (window as unknown as { __cancelCalls?: unknown[] }).__cancelCalls,
    }));
    expect(calls.send).toHaveLength(1);
    expect(calls.cancel).toHaveLength(1);
  });

  test("can regenerate, edit, and delete a chat branch", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [CHAT_SESSION]);
    await page.addInitScript(() => {
      const now = "2026-01-01T00:00:00Z";
      const state = {
        schema_version: 1,
        session_id: "chat-actions",
        session: {
          id: "chat-actions",
          workspace_path: "/tmp/demo",
          title: "Chat actions",
          active_provider: "claude",
          active_model: null,
          created_at: now,
          updated_at: now,
        },
        provider: "claude",
        model: null,
        messages: [
          {
            id: "u1",
            session_id: "chat-actions",
            turn_id: "t1",
            role: "user",
            content: "original prompt",
            created_at: now,
            status: "complete",
            metadata: { provider: "claude" },
          },
          {
            id: "a1",
            session_id: "chat-actions",
            turn_id: "t1",
            role: "assistant",
            content: "original answer",
            created_at: "2026-01-01T00:00:01Z",
            status: "complete",
            metadata: { provider: "claude" },
          },
        ],
        turns: [],
        provider_threads: [],
        context_snapshots: [],
        memory: {
          session_id: "chat-actions",
          summary: null,
          important_decisions: [],
          facts: [],
          through_message_id: null,
          updated_at: now,
        },
        created_at: now,
        updated_at: now,
      };
      const w = window as unknown as {
        __chatState: typeof state;
        __retryCalls?: unknown[];
        __deleteCalls?: unknown[];
      };
      w.__chatState = state;
    });
    await tauri.handle("load_chat_session_state", () => {
      return (window as unknown as { __chatState: unknown }).__chatState;
    });
    await tauri.handle("retry_chat_message", (args) => {
      const w = window as unknown as {
        __chatState: { messages: Array<Record<string, unknown>> };
        __retryCalls?: unknown[];
      };
      w.__retryCalls = w.__retryCalls ?? [];
      w.__retryCalls.push(args);
      const messageId = args?.messageId ?? args?.message_id;
      const content =
        typeof args?.content === "string" ? args.content : undefined;
      const prompt =
        messageId === "u1" && content !== undefined
          ? content
          : "original prompt";
      const now =
        messageId === "u1"
          ? "2026-01-01T00:00:04Z"
          : "2026-01-01T00:00:02Z";
      const answer =
        messageId === "u1" ? "edited answer" : "regenerated answer";
      const assistantMessage = w.__chatState.messages[1] ?? {
        id: "a1",
        session_id: "chat-actions",
        turn_id: "t1",
        role: "assistant",
        status: "complete",
        metadata: { provider: args?.ai?.provider ?? "claude" },
      };
      w.__chatState = {
        ...w.__chatState,
        messages: [
          {
            ...w.__chatState.messages[0],
            content: prompt,
            created_at: now,
          },
          {
            ...assistantMessage,
            content: answer,
            created_at: now,
          },
        ],
        updated_at: now,
      };
      return w.__chatState;
    });
    await tauri.handle("delete_chat_message", (args) => {
      const w = window as unknown as {
        __chatState: { messages: Array<Record<string, unknown>> };
        __deleteCalls?: unknown[];
      };
      w.__deleteCalls = w.__deleteCalls ?? [];
      w.__deleteCalls.push(args);
      w.__chatState = {
        ...w.__chatState,
        messages: [w.__chatState.messages[0]],
        updated_at:
          w.__deleteCalls.length > 1
            ? "2026-01-01T00:00:05Z"
            : "2026-01-01T00:00:03Z",
      };
      return w.__chatState;
    });

    await page.goto("/");
    await expect(page.getByText("original answer")).toBeVisible();

    await page.getByRole("button", { name: "Regenerate Claude message" }).click();
    await expect(page.getByText("regenerated answer")).toBeVisible();

    await page.getByRole("button", { name: "Delete Claude message" }).click();
    await expect(page.getByText("regenerated answer")).toHaveCount(0);

    await page.getByRole("button", { name: "Edit user message" }).click();
    await page.getByLabel("Edit user message content").fill("edited prompt");
    await page.getByRole("button", { name: "Save edited user message" }).click();
    await expect(page.getByText("edited prompt")).toBeVisible();
    await expect(page.getByText("edited answer")).toBeVisible();

    await page.getByRole("button", { name: "Delete Claude message" }).click();
    await expect(page.getByText("edited answer")).toHaveCount(0);

    const calls = await page.evaluate(() => ({
      retry: (window as unknown as { __retryCalls?: unknown[] }).__retryCalls,
      remove: (window as unknown as { __deleteCalls?: unknown[] }).__deleteCalls,
    }));
    expect(calls.retry).toHaveLength(2);
    expect(calls.remove).toHaveLength(2);
  });
});
