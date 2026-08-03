import { expect, test } from "./support";

const CHAT_SESSION = {
  id: "graph-chat",
  name: "Graph chat",
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

function emptyChatState() {
  const now = "2026-01-01T00:00:00Z";
  return {
    schema_version: 1,
    session_id: "graph-chat",
    session: {
      id: "graph-chat",
      workspace_path: "/tmp/demo",
      title: "Graph chat",
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
      session_id: "graph-chat",
      summary: null,
      important_decisions: [],
      facts: [],
      through_message_id: null,
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  };
}

test("builds a valid manual graph before sending raw chat content", async ({
  page,
  tauri,
}) => {
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.respond("list_sessions", [CHAT_SESSION]);
  await tauri.respond("load_chat_session_state", emptyChatState());
  await tauri.handle("send_chat_message", (args) => {
    const now = "2026-01-01T00:00:02Z";
    const state = window as unknown as {
      __graphSendCalls?: unknown[];
      __graphMessages?: unknown[];
    };
    state.__graphSendCalls = state.__graphSendCalls ?? [];
    state.__graphSendCalls.push(args);
    const callIndex = state.__graphSendCalls.length;
    const messages = [
      ...(state.__graphMessages ?? []),
      {
        id: `user-${callIndex}`,
        session_id: "graph-chat",
        turn_id: `turn-${callIndex}`,
        role: "user",
        content: args?.content,
        graph_prompt_plan: args?.graphPromptPlan,
        created_at: now,
        status: "complete",
        metadata: null,
      },
      {
        id: `assistant-${callIndex}`,
        session_id: "graph-chat",
        turn_id: `turn-${callIndex}`,
        role: "assistant",
        content:
          callIndex === 1
            ? "RUN: agent-1 attempt=1 → ok — implementation ready\n\nWAITING: Approve the manual graph result."
            : callIndex === 2
              ? "Implementation continued, but no protocol marker was returned."
              : "RUN: goal attempt=1 → ok — complete\n\nFINAL: Graph completed",
        created_at: now,
        status: "complete",
        metadata: { provider: args?.ai?.provider ?? "claude" },
      },
    ];
    state.__graphMessages = messages;
    return {
      schema_version: 1,
      session_id: "graph-chat",
      session: {
        id: "graph-chat",
        workspace_path: "/tmp/demo",
        title: "Graph chat",
        active_provider: args?.ai?.provider ?? "claude",
        active_model: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: now,
      },
      provider: args?.ai?.provider ?? "claude",
      model: null,
      messages,
      turns: [],
      provider_threads: [],
      context_snapshots: [],
      memory: {
        session_id: "graph-chat",
        summary: null,
        important_decisions: [],
        facts: [],
        through_message_id: null,
        updated_at: now,
      },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: now,
    };
  });

  await page.goto("/");

  await page
    .getByRole("button", { name: "Graph Engineering: Graph · Auto" })
    .click();
  const editor = page.getByRole("dialog", { name: "Graph Engineering" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Manual graph" }).click();

  await expect(editor.getByRole("status")).toContainText(
    "Graph is incomplete",
  );
  await expect(
    editor.getByRole("list", { name: "Graph validation errors" }),
  ).toContainText("A manual work graph needs at least one executable node.");
  await expect(editor.getByRole("button", { name: "Apply graph" })).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __graphSendCalls?: unknown[] })
          .__graphSendCalls ?? [],
    ),
  ).toHaveLength(0);

  await editor.getByRole("button", { name: "Agent", exact: true }).click();
  await editor.getByRole("textbox", { name: "agent-1 Title" }).fill("Implement");
  await editor
    .getByRole("textbox", { name: "agent-1 Instruction" })
    .fill("Implement the requested change and report the result.");
  await expect(editor.getByRole("button", { name: "Apply graph" })).toBeDisabled();

  await editor.getByRole("button", { name: "Connect" }).click();
  await expect(editor.getByRole("status")).toContainText("Ready to run");
  await expect(editor.getByText("flowchart TD", { exact: false })).toBeVisible();
  await editor.getByRole("button", { name: "Apply graph" }).click();

  await expect(
    page.getByRole("button", { name: "Graph Engineering: Graph · Manual" }),
  ).toContainText("1");
  await page.getByRole("textbox", { name: "Chat message" }).fill(
    "Keep this exact raw prompt",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("WAITING: Approve the manual graph result.")).toBeVisible();

  let calls = await page.evaluate(
    () =>
      (window as unknown as { __graphSendCalls?: unknown[] })
        .__graphSendCalls,
  );
  expect(calls).toHaveLength(1);
  expect(calls?.[0]).toMatchObject({
    sessionId: "graph-chat",
    content: "Keep this exact raw prompt",
    graphPromptPlan: {
      version: 1,
      mode: "manual",
      graph: {
        version: 1,
        nodes: [
          {
            id: "agent-1",
            kind: "agent",
            title: "Implement",
            instruction: "Implement the requested change and report the result.",
          },
          {
            id: "goal",
            kind: "goal_sink",
            title: "GOAL",
            instruction: "",
          },
        ],
        edges: [
          {
            id: "edge-1",
            from: "agent-1",
            to: "goal",
          },
        ],
      },
    },
  });
  await expect(
    page.getByRole("button", { name: "Graph Engineering: Graph · Manual" }),
  ).toBeDisabled();

  await page
    .getByRole("textbox", { name: "Chat message" })
    .fill("Approved; finish the remaining nodes");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText(
      "The graph continuation returned neither WAITING: nor FINAL:. The active graph was preserved; reply to continue or retry the response.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Graph Engineering: Graph · Manual" }),
  ).toBeDisabled();

  calls = await page.evaluate(
    () =>
      (window as unknown as { __graphSendCalls?: unknown[] })
        .__graphSendCalls,
  );
  expect(calls).toHaveLength(2);
  expect(calls?.[1]).toMatchObject({
    sessionId: "graph-chat",
    content: "Approved; finish the remaining nodes",
    graphPromptPlan: {
      version: 1,
      mode: "manual",
      continuation: { version: 1 },
      graph: {
        version: 1,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "agent-1" }),
          expect.objectContaining({ id: "goal", kind: "goal_sink" }),
        ]),
      },
    },
  });
  await page
    .getByRole("textbox", { name: "Chat message" })
    .fill("Continue and finish with the protocol");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("FINAL: Graph completed")).toBeVisible();

  calls = await page.evaluate(
    () =>
      (window as unknown as { __graphSendCalls?: unknown[] })
        .__graphSendCalls,
  );
  expect(calls).toHaveLength(3);
  expect(calls?.[2]).toMatchObject({
    sessionId: "graph-chat",
    content: "Continue and finish with the protocol",
    graphPromptPlan: {
      version: 1,
      mode: "manual",
      continuation: { version: 1 },
    },
  });
  await expect(
    page.getByRole("button", { name: "Graph Engineering: Graph · Auto" }),
  ).toBeEnabled();
});
