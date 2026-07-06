import { test, expect } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const SESSION = {
  id: "session-1",
  name: "summary-session",
  repo_path: "/tmp/demo",
  worktree_path: "/tmp/demo",
  branch: "main",
  isolated: false,
  project_scoped: true,
  status: "ready",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_message: null,
  title_source: "manual",
  kind: "regular",
  owner: { kind: "user" },
  position: 0,
  in_worktree: true,
  mode: "chat",
};

const CHAT_STATE = {
  schema_version: 1,
  session_id: "session-1",
  session: {
    id: "session-1",
    workspace_path: "/tmp/demo",
    title: "summary-session",
    active_provider: "codex",
    active_model: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z",
  },
  provider: "codex",
  model: null,
  messages: [
    {
      id: "u1",
      session_id: "session-1",
      turn_id: "t1",
      role: "user",
      content: "Summarize this",
      created_at: "2026-01-01T00:00:00Z",
      status: "complete",
      metadata: null,
    },
    {
      id: "a1",
      session_id: "session-1",
      turn_id: "t1",
      role: "assistant",
      content: "Done",
      created_at: "2026-01-01T00:00:01Z",
      status: "complete",
      metadata: {
        provider_response: {
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            total_tokens: 140,
          },
        },
      },
    },
  ],
  turns: [
    {
      id: "t1",
      session_id: "session-1",
      provider: "codex",
      status: "complete",
      user_message_id: "u1",
      assistant_message_id: "a1",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:00:01Z",
    },
  ],
  provider_threads: [],
  context_snapshots: [],
  memory: {
    session_id: "session-1",
    summary: null,
    important_decisions: [],
    facts: [],
    through_message_id: null,
    updated_at: "2026-01-01T00:00:01Z",
  },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:01Z",
};

test.describe("work summary", () => {
  test("opens a changed file from the summary tab", async ({ page, tauri }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);
    await tauri.respond("load_chat_session_state", CHAT_STATE);
    await tauri.respond("fs_git_status", {
      statuses: {
        "/tmp/demo/src/App.tsx": {
          kind: "modified",
          additions: 0,
          deletions: 0,
        },
      },
      huge: false,
      limit: 500,
    });
    await tauri.respond("fs_git_diff_stats", {
      "/tmp/demo/src/App.tsx": { additions: 3, deletions: 1 },
    });
    await tauri.respond("fs_read_file", {
      content: "export const app = 'summary';\n",
      size: 30,
      truncated: false,
      binary: false,
    });

    await page.goto("/");

    await page.locator('[data-tab-drag-handle="session-1"]').click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: "Open Work Summary" }).click();

    await expect(
      page.getByRole("heading", { name: "Work Summary" }),
    ).toBeVisible();
    await expect(page.getByText("2 messages")).toBeVisible();
    await expect(page.getByText("140 tokens").first()).toBeVisible();

    await page.getByRole("button", { name: "Open src/App.tsx" }).dblclick();

    await expect(
      page.getByRole("button", { name: /App\.tsx Close tab/ }),
    ).toBeVisible();
    await expect(page.getByText("export const app = 'summary';")).toBeVisible();
  });
});
