import { expect, test } from "./support";

test("creates and revises a durable goal session inside a project", async ({
  page,
  tauri,
}) => {
  await tauri.handle("list_projects", () => [
    {
      repo_path: "/tmp/demo",
      name: "demo",
      created_at: "2026-01-01T00:00:00Z",
      position: 0,
    },
  ]);
  await tauri.handle("list_sessions", () => {
    const state = window as unknown as { __goalSessions?: unknown[] };
    state.__goalSessions = state.__goalSessions ?? [];
    return state.__goalSessions;
  });
  await tauri.handle("create_session", (args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const state = window as unknown as {
      __goalCreateCalls?: unknown[];
      __goalSessions?: Array<Record<string, unknown>>;
    };
    state.__goalCreateCalls = state.__goalCreateCalls ?? [];
    state.__goalSessions = state.__goalSessions ?? [];
    state.__goalCreateCalls.push(args);
    const created = {
      id: "goal-1",
      name: input.name ?? "Goal session",
      repo_path: input.repoPath ?? "/tmp/demo",
      worktree_path: "/tmp/demo/.acorn/worktrees/goal-1",
      branch: "goal-1",
      isolated: true,
      project_scoped: true,
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message: null,
      title_source: "default",
      auto_title_enabled: true,
      kind: "regular",
      mode: "chat",
      goal: input.goal,
      owner: { kind: "user" },
      position: null,
      in_worktree: true,
    };
    state.__goalSessions.push(created);
    return created;
  });
  await tauri.handle("update_session_goal", (args) => {
    const input = (args ?? {}) as {
      id?: string;
      expectedRevision?: number;
      goal?: Record<string, unknown>;
    };
    const state = window as unknown as {
      __goalUpdateCalls?: unknown[];
      __goalSessions?: Array<Record<string, unknown>>;
    };
    state.__goalUpdateCalls = state.__goalUpdateCalls ?? [];
    state.__goalSessions = state.__goalSessions ?? [];
    state.__goalUpdateCalls.push(args);
    const index = state.__goalSessions.findIndex(
      (session) => session.id === input.id,
    );
    const current = state.__goalSessions[index] ?? {};
    const updated = {
      ...current,
      goal: {
        ...(input.goal ?? {}),
        revision: Number(input.expectedRevision ?? 0) + 1,
      },
      updated_at: "2026-01-01T00:00:01Z",
    };
    if (index >= 0) state.__goalSessions[index] = updated;
    return updated;
  });

  await page.goto("/");

  await page
    .getByRole("button", { name: "Project demo" })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "New goal session", exact: true })
    .click();

  const createDialog = page.getByRole("dialog", { name: "New goal session" });
  await expect(createDialog).toBeVisible();
  await createDialog
    .getByPlaceholder(
      "For example: Add keyboard navigation to the command palette and verify it with tests.",
    )
    .fill("Add project-owned goal sessions");
  await createDialog
    .getByRole("button", { name: "Agent & Model", exact: true })
    .click();
  await createDialog
    .getByRole("combobox", { name: "Agent & model preset" })
    .click();
  await page
    .getByRole("option", { name: /^Codex · Agent default/ })
    .click();
  await createDialog.getByRole("button", { name: "Duplicate" }).click();
  await createDialog
    .getByRole("combobox", { name: "All stages Model" })
    .click();
  await page.getByRole("option", { name: /^GPT Test Default/ }).click();
  await createDialog
    .getByRole("combobox", { name: "All stages Effort" })
    .click();
  await page.getByRole("option", { name: /^ultra/ }).click();
  await createDialog.getByRole("button", { name: "Start goal" }).click();

  await expect(page.locator("[data-goal-session-header]")).toContainText(
    "Add project-owned goal sessions",
  );
  await expect(page.locator("[data-goal-session-header]")).toContainText(
    "Revision 1",
  );
  await expect(
    page.locator("aside > header").getByRole("button", {
      name: "New goal session",
    }),
  ).toHaveCount(0);

  const createCalls = await page.evaluate(
    () =>
      (window as unknown as { __goalCreateCalls?: unknown[] })
        .__goalCreateCalls,
  );
  expect(createCalls).toHaveLength(1);
  expect(createCalls?.[0]).toMatchObject({
    repoPath: "/tmp/demo",
    isolated: true,
    projectScoped: true,
    mode: "chat",
    agentProvider: "codex",
    goal: {
      objective: "Add project-owned goal sessions",
      provider: "codex",
      model_config: {
        single_model: true,
        default: {
          model: "gpt-test-default",
          effort: "ultra",
        },
      },
      revision: 1,
    },
  });

  await page.getByRole("button", { name: "Edit goal" }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit project goal" });
  await expect(editDialog).toBeVisible();
  await editDialog
    .getByPlaceholder(
      "For example: Add keyboard navigation to the command palette and verify it with tests.",
    )
    .fill("Add durable project-owned goal sessions");
  await editDialog.getByRole("button", { name: "Save & replan" }).click();

  await expect(page.locator("[data-goal-session-header]")).toContainText(
    "Add durable project-owned goal sessions",
  );
  await expect(page.locator("[data-goal-session-header]")).toContainText(
    "Revision 2",
  );

  const updateCalls = await page.evaluate(
    () =>
      (window as unknown as { __goalUpdateCalls?: unknown[] })
        .__goalUpdateCalls,
  );
  expect(updateCalls).toHaveLength(1);
  expect(updateCalls?.[0]).toMatchObject({
    id: "goal-1",
    expectedRevision: 1,
    goal: {
      objective: "Add durable project-owned goal sessions",
    },
  });
});
