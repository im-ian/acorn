import { expect, test } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const ORDINARY_CHAT = {
  id: "ordinary-chat",
  name: "Ordinary chat",
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
  goal: null,
  graph: null,
  owner: { kind: "user" },
  position: null,
  in_worktree: false,
  agent_provider: null,
};

function emptyChatState(sessionId: string) {
  const now = "2026-01-01T00:00:00Z";
  return {
    schema_version: 1,
    session_id: sessionId,
    session: {
      id: sessionId,
      workspace_path: "/tmp/demo",
      title: null,
      active_provider: null,
      active_model: null,
      created_at: now,
      updated_at: now,
    },
    provider: null,
    model: null,
    messages: [],
    turns: [],
    provider_threads: [],
    context_snapshots: [],
    memory: {
      session_id: sessionId,
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

test("creates, connects, persists, and runs a visual Graph session", async ({
  page,
  tauri,
}) => {
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.handle("list_sessions", () => {
    const raw = localStorage.getItem("acorn:e2e-graph-session");
    return raw ? [JSON.parse(raw)] : [];
  });
  await tauri.handle("create_session", (args) => {
    const now = "2026-01-01T00:00:00Z";
    const session = {
      id: "graph-session",
      name: args?.name || "Graph · test",
      repo_path: args?.repoPath || "/tmp/demo",
      worktree_path: "/tmp/demo/.acorn/worktrees/graph-session",
      branch: "graph-session",
      isolated: true,
      project_scoped: true,
      status: "ready",
      created_at: now,
      updated_at: now,
      last_message: null,
      title_source: "default",
      kind: "regular",
      mode: "chat",
      goal: null,
      graph: args?.graph,
      owner: { kind: "user" },
      position: null,
      in_worktree: true,
      agent_provider: args?.agentProvider || "claude",
    };
    localStorage.setItem("acorn:e2e-graph-create", JSON.stringify(args));
    localStorage.setItem("acorn:e2e-graph-session", JSON.stringify(session));
    return session;
  });
  await tauri.handle("load_chat_session_state", (args) => {
    const now = "2026-01-01T00:00:00Z";
    return {
      schema_version: 1,
      session_id: args?.sessionId || "graph-session",
      session: {
        id: args?.sessionId || "graph-session",
        workspace_path: "/tmp/demo/.acorn/worktrees/graph-session",
        title: null,
        active_provider: null,
        active_model: null,
        created_at: now,
        updated_at: now,
      },
      provider: null,
      model: null,
      messages: [],
      turns: [],
      provider_threads: [],
      context_snapshots: [],
      memory: {
        session_id: args?.sessionId || "graph-session",
        summary: null,
        important_decisions: [],
        facts: [],
        through_message_id: null,
        updated_at: now,
      },
      created_at: now,
      updated_at: now,
    };
  });
  await tauri.handle("run_graph_session", (args) => {
    localStorage.setItem("acorn:e2e-graph-run", JSON.stringify(args));
    const now = "2026-01-01T00:00:01Z";
    return {
      schema_version: 1,
      session_id: args?.sessionId || "graph-session",
      session: {
        id: args?.sessionId || "graph-session",
        workspace_path: "/tmp/demo/.acorn/worktrees/graph-session",
        title: null,
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
        session_id: args?.sessionId || "graph-session",
        summary: null,
        important_decisions: [],
        facts: [],
        through_message_id: null,
        updated_at: now,
      },
      created_at: now,
      updated_at: now,
    };
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Project demo" }).hover();
  await page
    .getByRole("button", { name: "Create session in this project" })
    .click();
  await page.getByRole("menuitem", { name: "New Graph session" }).click();

  const dialog = page.getByRole("dialog", { name: "New Graph session" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-graph-node="goal"]')).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create & Run" })).toBeDisabled();

  await dialog
    .getByPlaceholder("What should this graph accomplish?")
    .fill("Build the visual graph editor");
  await dialog.getByRole("button", { name: "Agent", exact: true }).click();
  await dialog
    .getByPlaceholder("Describe the work this node must complete.")
    .fill("Implement and verify the requested graph editor.");

  const agentNode = dialog.locator('[data-graph-node="agent-1"]');
  const before = await agentNode.boundingBox();
  expect(before).not.toBeNull();
  await page.mouse.move(before!.x + 80, before!.y + 35);
  await page.mouse.down();
  await page.mouse.move(before!.x + 150, before!.y + 105, { steps: 8 });
  await page.mouse.up();

  const source = agentNode.locator(".react-flow__handle-right");
  const target = dialog
    .locator('[data-graph-node="goal"]')
    .locator(".react-flow__handle-left");
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(
    sourceBox!.x + sourceBox!.width / 2,
    sourceBox!.y + sourceBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();

  await expect(dialog.getByRole("status")).toContainText("Ready to run");
  await dialog.getByRole("button", { name: "Create & Run" }).click();

  await expect(page.locator("[data-graph-session-view]")).toBeVisible();
  await expect.poll(async () =>
    page.evaluate(() => localStorage.getItem("acorn:e2e-graph-run")),
  ).not.toBeNull();

  const createArgs = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("acorn:e2e-graph-create") || "null"),
  );
  expect(createArgs).toMatchObject({
    isolated: true,
    mode: "chat",
    agentProvider: "claude",
    graph: {
      version: 1,
      objective: "Build the visual graph editor",
      definition: {
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "agent-1", kind: "agent" }),
          expect.objectContaining({ id: "goal", kind: "goal_sink" }),
        ]),
        edges: [expect.objectContaining({ from: "agent-1", to: "goal" })],
      },
    },
  });
  expect(createArgs.graph.canvas.node_positions["agent-1"]).not.toEqual({
    x: 80,
    y: 80,
  });

  await page.reload();
  await expect(page.locator("[data-graph-session-view]")).toBeVisible();
  await page.getByRole("button", { name: "Design" }).click();
  const restoredCanvas = page.locator(
    '[data-graph-session-view] [data-testid="graph-canvas"]',
  );
  const restoredAgent = page.locator(
    '[data-graph-session-view] [data-graph-node="agent-1"]',
  );
  const restoredGoal = page.locator(
    '[data-graph-session-view] [data-graph-node="goal"]',
  );
  await expect(restoredAgent).toBeVisible();
  await expect(restoredGoal).toBeVisible();
  await expect
    .poll(async () => {
      const canvasBox = await restoredCanvas.boundingBox();
      const nodeBoxes = await Promise.all([
        restoredAgent.boundingBox(),
        restoredGoal.boundingBox(),
      ]);
      if (!canvasBox || nodeBoxes.some((box) => box === null)) return false;
      return nodeBoxes.every(
        (box) =>
          box!.x >= canvasBox.x - 1 &&
          box!.y >= canvasBox.y - 1 &&
          box!.x + box!.width <= canvasBox.x + canvasBox.width + 1 &&
          box!.y + box!.height <= canvasBox.y + canvasBox.height + 1,
      );
    })
    .toBe(true);
});

test("ordinary Chat stays automatic and exposes no manual graph control", async ({
  page,
  tauri,
}) => {
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.respond("list_sessions", [ORDINARY_CHAT]);
  await tauri.respond("load_chat_session_state", emptyChatState("ordinary-chat"));

  await page.goto("/");

  await expect(page.getByRole("textbox", { name: "Chat message" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Graph Engineering/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manual graph" })).toHaveCount(0);
});
