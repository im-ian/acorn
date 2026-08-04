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
  await tauri.handle("load_graph_run_state", () => {
    const raw = localStorage.getItem("acorn:e2e-graph-run-state");
    return raw ? JSON.parse(raw) : null;
  });
  await tauri.handle("run_graph_session", (args) => {
    localStorage.setItem("acorn:e2e-graph-run", JSON.stringify(args));
    const session = JSON.parse(
      localStorage.getItem("acorn:e2e-graph-session") || "null",
    );
    const now = "2026-01-01T00:00:01Z";
    const definition = JSON.parse(JSON.stringify(session.graph.definition));
    const executable = definition.nodes.find(
      (node: { kind: string }) => node.kind !== "goal_sink",
    );
    executable.title = "Runtime materialized task";
    const state = {
      schema_version: 1,
      session_id: args?.sessionId || "graph-session",
      run_id: "graph-run-1",
      revision: 1,
      graph_revision: session.graph.revision,
      objective: session.graph.objective,
      agent: session.graph.agent,
      status: "running",
      definition,
      nodes: Object.fromEntries(
        definition.nodes.map((node: { id: string; kind: string }) => [
          node.id,
          {
            node_id: node.id,
            status: node.id === executable.id ? "working" : "queued",
            attempt: node.id === executable.id ? 1 : 0,
            started_at: node.id === executable.id ? now : null,
          },
        ]),
      ),
      edges: Object.fromEntries(
        definition.edges.map((edge: { id: string }) => [
          edge.id,
          { edge_id: edge.id, active: true, traversed: false, retry_count: 0 },
        ]),
      ),
      started_at: now,
      updated_at: now,
    };
    localStorage.setItem("acorn:e2e-graph-run-state", JSON.stringify(state));
    window.__ACORN_EMIT_TAURI_EVENT__?.("acorn:graph-run-state-changed", {
      session_id: state.session_id,
      state,
    });
    return state;
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
  await dialog.getByRole("button", { name: "Node", exact: true }).click();
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

  const agentSize = await agentNode.boundingBox();
  const goalSize = await dialog.locator('[data-graph-node="goal"]').boundingBox();
  expect(agentSize?.width).toBe(goalSize?.width);
  expect(agentSize?.height).toBe(goalSize?.height);

  const source = agentNode.locator(".react-flow__handle-right");
  const target = dialog
    .locator('[data-graph-node="goal"]')
    .locator(".react-flow__handle-left");
  const edgePath = dialog.locator(".react-flow__edge-path").first();
  async function connectAgentToGoal() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
      if ((await edgePath.count()) > 0) return;
      await page.waitForTimeout(100);
    }
    await expect(edgePath).toBeVisible();
  }

  await connectAgentToGoal();
  await edgePath.click({ force: true });
  await dialog.getByRole("button", { name: /Disconnect edge edge-1/ }).click();
  await expect(dialog.getByRole("status")).toContainText("Graph is incomplete");

  await connectAgentToGoal();

  await expect(dialog.getByRole("status")).toContainText("Ready to run");

  await dialog.getByRole("textbox", { name: "Graph preset name" }).fill("Simple flow");
  await dialog.getByRole("button", { name: "Save preset" }).click();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("acorn:graph-presets:v2");
        return raw ? JSON.parse(raw).customPresets?.[0]?.name : null;
      }),
    )
    .toBe("Simple flow");

  const viewportLayer = dialog.locator(".react-flow__viewport");
  const savedViewportTransform = await viewportLayer.evaluate(
    (element) => (element as HTMLElement).style.transform,
  );
  await dialog.locator(".react-flow__controls-zoomin").click();
  await expect
    .poll(() =>
      viewportLayer.evaluate(
        (element) => (element as HTMLElement).style.transform,
      ),
    )
    .not.toBe(savedViewportTransform);
  await page.waitForTimeout(300);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect
    .poll(() =>
      viewportLayer.evaluate(
        (element) => (element as HTMLElement).style.transform,
      ),
    )
    .toBe(savedViewportTransform);

  await dialog.getByRole("combobox", { name: "Select graph preset" }).click();
  await page
    .getByRole("option", { name: /Parallel research, build, and verify/ })
    .click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  const researchGroup = dialog.locator('[data-graph-group="research-group"]');
  await expect(researchGroup).toBeVisible();
  await dialog
    .getByTestId("rf__node-research-group")
    .click({ position: { x: 24, y: 24 } });
  const groupInspector = dialog
    .locator("aside section")
    .filter({ hasText: "Group inspector" });
  await groupInspector.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Generated from prompt" }).click();
  await expect(researchGroup).toContainText("auto nodes");
  await expect(
    dialog.locator('[data-graph-node^="agent-"]'),
  ).toHaveCount(1);

  await dialog.getByRole("combobox", { name: "Select graph preset" }).click();
  await page.getByRole("option", { name: /Simple flow/ }).click();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog.locator('[data-graph-group="research-group"]')).toHaveCount(0);
  await expect(dialog.locator('[data-graph-node="agent-1"]')).toBeVisible();

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
        version: 2,
        execution_mode: "parallel",
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
  await expect(page.getByRole("button", { name: "Live run" })).toBeVisible();
  await expect(
    page.locator('[data-graph-node="agent-1"][data-graph-node-status="working"]'),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-graph-node="agent-1"]')
      .getByText("Runtime materialized task"),
  ).toBeVisible();
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

test("keeps a newer Graph event when a slower snapshot arrives", async ({
  page,
  tauri,
}) => {
  const definition = {
    version: 2,
    execution_mode: "parallel",
    nodes: [
      { id: "build", kind: "agent", title: "Build", instruction: "Build it." },
      { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
    ],
    edges: [{ id: "build-goal", from: "build", to: "goal" }],
    groups: [],
  };
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.respond("list_sessions", [
    {
      id: "race-graph",
      name: "Graph · state race",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo/.acorn/worktrees/race-graph",
      branch: "race-graph",
      isolated: true,
      project_scoped: true,
      status: "working",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message: null,
      title_source: "default",
      kind: "regular",
      mode: "chat",
      goal: null,
      graph: {
        version: 1,
        objective: "Preserve the newest run state",
        agent: { provider: "claude" },
        definition,
        canvas: {
          version: 2,
          node_positions: {
            build: { x: 100, y: 180 },
            goal: { x: 420, y: 180 },
          },
          group_positions: {},
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        revision: 1,
      },
      owner: { kind: "user" },
      position: null,
      in_worktree: true,
      agent_provider: "claude",
    },
  ]);
  await tauri.handle("load_graph_run_state", (args) => {
    const definition = {
      version: 2,
      execution_mode: "parallel",
      nodes: [
        { id: "build", kind: "agent", title: "Build", instruction: "Build it." },
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [{ id: "build-goal", from: "build", to: "goal" }],
      groups: [],
    };
    const base = {
      schema_version: 1,
      session_id: args?.sessionId || "race-graph",
      run_id: "race-run-1",
      graph_revision: 1,
      objective: "Preserve the newest run state",
      agent: { provider: "claude" },
      definition,
      edges: {
        "build-goal": {
          edge_id: "build-goal",
          active: false,
          traversed: false,
          retry_count: 0,
        },
      },
      started_at: "2026-01-01T00:00:00Z",
    };
    const stale = {
      ...base,
      revision: 7,
      status: "running",
      nodes: {
        build: { node_id: "build", status: "working", attempt: 1 },
        goal: { node_id: "goal", status: "queued", attempt: 0 },
      },
      updated_at: "2026-01-01T00:00:07Z",
    };
    const newer = {
      ...base,
      revision: 8,
      status: "completed",
      nodes: {
        build: {
          node_id: "build",
          status: "completed",
          attempt: 1,
          output: "Newest result",
        },
        goal: {
          node_id: "goal",
          status: "completed",
          attempt: 0,
          output: "Newest result",
        },
      },
      edges: {
        "build-goal": {
          ...base.edges["build-goal"],
          traversed: true,
        },
      },
      updated_at: "2026-01-01T00:00:08Z",
      completed_at: "2026-01-01T00:00:08Z",
      final_output: "Newest result",
    };
    return new Promise((resolve) => {
      setTimeout(() => {
        window.__ACORN_EMIT_TAURI_EVENT__?.("acorn:graph-run-state-changed", {
          session_id: newer.session_id,
          state: newer,
        });
      }, 0);
      setTimeout(() => resolve(stale), 40);
    });
  });

  await page.goto("/");

  await expect(
    page.locator('[data-graph-node="build"][data-graph-node-status="completed"]'),
  ).toBeVisible();
  await expect(page.locator("[data-graph-run-summary]")).toContainText("Completed");
  await page.waitForTimeout(80);
  await expect(
    page.locator('[data-graph-node="build"][data-graph-node-status="working"]'),
  ).toHaveCount(0);
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

test("shows live node state and accepts input inside a waiting Human node", async ({
  page,
  tauri,
}) => {
  await tauri.respond("list_projects", [PROJECT]);
  await tauri.handle("list_sessions", () => {
    const now = "2026-01-01T00:00:00Z";
    const definition = {
      version: 2,
      execution_mode: "parallel",
      nodes: [
        {
          id: "approve",
          kind: "human",
          title: "Human approval",
          instruction: "Review and approve the result.",
        },
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [
        {
          id: "approve-goal",
          from: "approve",
          to: "goal",
          label: "Approve",
          condition: "approved",
        },
      ],
      groups: [],
    };
    const graph = {
      version: 1,
      objective: "Approve the graph result",
      agent: { provider: "claude" },
      definition,
      canvas: {
        version: 2,
        node_positions: {
          approve: { x: 100, y: 180 },
          goal: { x: 420, y: 180 },
        },
        group_positions: {},
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      revision: 1,
    };
    if (!localStorage.getItem("acorn:e2e-waiting-graph-run")) {
      localStorage.setItem(
        "acorn:e2e-waiting-graph-run",
        JSON.stringify({
          schema_version: 1,
          session_id: "waiting-graph",
          run_id: "waiting-run-1",
          revision: 7,
          graph_revision: 1,
          objective: graph.objective,
          agent: graph.agent,
          status: "waiting",
          definition,
          nodes: {
            approve: {
              node_id: "approve",
              status: "waiting",
              attempt: 0,
              question: "Approve this result?",
            },
            goal: { node_id: "goal", status: "queued", attempt: 0 },
          },
          edges: {
            "approve-goal": {
              edge_id: "approve-goal",
              active: false,
              traversed: false,
              retry_count: 0,
            },
          },
          started_at: now,
          updated_at: now,
        }),
      );
    }
    return [
      {
        id: "waiting-graph",
        name: "Graph · approval",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/waiting-graph",
        branch: "waiting-graph",
        isolated: true,
        project_scoped: true,
        status: "waiting_for_input",
        created_at: now,
        updated_at: now,
        last_message: null,
        title_source: "default",
        kind: "regular",
        mode: "chat",
        goal: null,
        graph,
        owner: { kind: "user" },
        position: null,
        in_worktree: true,
        agent_provider: "claude",
      },
    ];
  });
  await tauri.handle("load_graph_run_state", () =>
    JSON.parse(localStorage.getItem("acorn:e2e-waiting-graph-run") || "null"),
  );
  await tauri.handle("submit_graph_node_input", (args) => {
    localStorage.setItem("acorn:e2e-human-input", JSON.stringify(args));
    const current = JSON.parse(
      localStorage.getItem("acorn:e2e-waiting-graph-run") || "null",
    );
    const now = "2026-01-01T00:00:10Z";
    const next = {
      ...current,
      revision: current.revision + 1,
      status: "completed",
      nodes: {
        ...current.nodes,
        approve: {
          ...current.nodes.approve,
          status: "completed",
          output: args?.input,
          verdict: "approved",
          completed_at: now,
        },
        goal: {
          ...current.nodes.goal,
          status: "completed",
          output: args?.input,
          completed_at: now,
        },
      },
      edges: {
        "approve-goal": {
          ...current.edges["approve-goal"],
          traversed: true,
        },
      },
      final_output: args?.input,
      updated_at: now,
      completed_at: now,
    };
    localStorage.setItem("acorn:e2e-waiting-graph-run", JSON.stringify(next));
    window.__ACORN_EMIT_TAURI_EVENT__?.("acorn:graph-run-state-changed", {
      session_id: next.session_id,
      state: next,
    });
    return next;
  });

  await page.goto("/");

  const humanNode = page.locator(
    '[data-graph-node="approve"][data-graph-node-status="waiting"]',
  );
  await expect(humanNode).toBeVisible();
  await humanNode.getByRole("textbox", { name: "Approve this result?" }).fill("Approved");
  await humanNode.getByRole("button", { name: "Approve" }).click();

  await expect(
    page.locator('[data-graph-node="approve"][data-graph-node-status="completed"]'),
  ).toBeVisible();
  await expect(page.locator("[data-graph-run-summary]")).toContainText("Completed");
  const inputArgs = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("acorn:e2e-human-input") || "null"),
  );
  expect(inputArgs).toMatchObject({
    sessionId: "waiting-graph",
    runId: "waiting-run-1",
    nodeId: "approve",
    input: "Approved",
    verdict: "approved",
    expectedRevision: 7,
  });
});
