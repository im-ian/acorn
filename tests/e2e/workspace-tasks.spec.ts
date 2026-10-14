import { expect, test } from "./support";

test("workspace tasks can be created, commented, and closed", async ({
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
  await tauri.handle("list_sessions", () => [
    {
      id: "s-1",
      name: "sess",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
  await tauri.handle("list_project_tasks", () => []);
  await tauri.handle("create_project_task", (args) => {
    const input = args as {
      title?: string;
      description?: string;
      originSessionId?: string | null;
    };
    return {
      id: "task-1",
      number: 1,
      title: input.title ?? "",
      description: input.description ?? "",
      status: "todo",
      session_id: null,
      origin_session_id: input.originSessionId ?? null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      comments: [],
    };
  });
  await tauri.handle("delete_project_task_comment", () => ({
    id: "task-1",
    number: 1,
    title: "Fix the panel",
    description: "Keep the list in Acorn",
    status: "todo",
    session_id: null,
    origin_session_id: "s-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    comments: [],
    status_changes: [],
  }));
  await tauri.handle("add_project_task_comment", (args) => {
    const input = args as { id?: string; body?: string };
    if (input.body === "nope") throw new Error("too long");
    return {
      id: input.id ?? "task-1",
      number: 1,
      title: "Fix the panel",
      description: "Keep the list in Acorn",
      status: "todo",
      session_id: null,
      origin_session_id: "s-1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      comments: [
        {
          id: "c1",
          body: input.body ?? "",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
  });
  await tauri.handle("update_project_task", (args) => {
    const input = args as {
      id?: string;
      patch?: {
        title?: string;
        description?: string;
        status?: string;
        sessionId?: string | null;
      };
    };
    return {
      id: input.id ?? "task-1",
      number: 1,
      title: input.patch?.title ?? "Fix the panel",
      description: input.patch?.description ?? "Keep the list in Acorn",
      status: input.patch?.status ?? "todo",
      session_id: input.patch?.sessionId ?? null,
      origin_session_id: "s-1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      comments: [
        {
          id: "c1",
          body: "ready for review",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
  });

  await page.goto("/");

  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await expect(groups.getByRole("button", { name: "Workspace" })).toBeVisible();
  await expect(panel.getByText("Select a commit to see diff")).toBeVisible();
  await expect(panel.getByText("No tasks yet")).toHaveCount(0);

  await groups.getByRole("button", { name: "Workspace" }).click();
  await expect(panel.getByText("No tasks yet")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "In review", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Canceled", exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "New", exact: true }),
  ).toBeVisible();

  await panel.getByText("No tasks yet").dblclick();
  const editor = page.getByRole("dialog", { name: "New task" });
  await editor.getByLabel("Title").fill("Fix the panel");
  await editor.getByLabel("Description").fill("Keep the list in Acorn");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Fix the panel/ })).toBeVisible();

  await panel.getByRole("button", { name: /Fix the panel/ }).dblclick();
  await expect(page.getByRole("dialog", { name: "New task" })).toHaveCount(0);
  const detail = page.getByRole("dialog", { name: /Fix the panel/ });
  await expect(detail.getByText("Keep the list in Acorn")).toBeVisible();
  await expect(detail.locator("h3 span").first()).toHaveClass(/text-emerald-400/);
  await detail.getByPlaceholder("Leave a note…").fill("ready for review");
  await detail.getByRole("button", { name: "Comment" }).click();
  await expect(detail.getByText("ready for review")).toBeVisible();
  await detail.getByPlaceholder("Leave a note…").fill("nope");
  await detail.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(detail.getByPlaceholder("Leave a note…")).toHaveValue("nope");
  await expect(
    detail.getByRole("button", { name: "Delete", exact: true }),
  ).toBeVisible();
  const note = detail.getByPlaceholder("Leave a note…");
  await note.fill("one");
  const singleLine = await note.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  await note.fill("one\ntwo\nthree");
  await expect
    .poll(() => note.evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(singleLine);
  await detail.getByText("ready for review").hover();
  const shot = process.env.ACORN_UI_SHOT;
  if (shot) await detail.screenshot({ path: shot });

  await detail.getByRole("button", { name: "Delete comment" }).click();
  await expect(detail.getByText("ready for review")).toHaveCount(0);

  await detail.getByLabel("Status").selectOption("done");
  await expect(detail.locator("h3 span").first()).toHaveClass(/text-purple-400/);
  const row = panel.getByRole("button", { name: /Fix the panel/ });
  await expect(row).toBeVisible();
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toHaveCount(0);
  await expect(row.locator("span.text-purple-400")).toHaveText("Done");
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(row).toBeVisible();
  await row.click();
  const reopened = page.getByRole("dialog", { name: /Fix the panel/ });
  await reopened.getByLabel("Status").selectOption("todo");
  await expect(panel.getByRole("button", { name: "Done", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(row).toHaveCount(0);
  await reopened.getByRole("button", { name: "Close" }).click();
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await expect(row).toBeVisible();
  if (shot) {
    await panel.screenshot({ path: shot.replace(/\.png$/, "-list.png") });
  }
});

test("workspace task comments stop growing and reveal earlier notes", async ({
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
  await tauri.handle("list_sessions", () => []);
  await tauri.handle("list_project_tasks", () => [
    {
      id: "task-1",
      number: 1,
      title: "Fix the panel",
      description: "Keep the list in Acorn",
      status: "todo",
      session_id: null,
      origin_session_id: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      comments: Array.from({ length: 40 }, (_, index) => ({
        id: `c${index}`,
        body: `note ${index}`,
        created_at: "2026-01-01T00:00:00Z",
      })),
      status_changes: [],
    },
  ]);

  await page.goto("/");
  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await groups.getByRole("button", { name: "Workspace" }).click();
  await panel.getByRole("button", { name: /Fix the panel/ }).click();
  const detail = page.getByRole("dialog", { name: /Fix the panel/ });
  const list = detail.locator("[data-task-comments]");
  await expect(detail.getByText("note 39")).toBeInViewport();
  await expect(detail.getByText("note 0")).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: "Earlier comments" }),
  ).toBeVisible();
  const box = await list.evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(box.client).toBeLessThanOrEqual(300);
  const shot = process.env.ACORN_UI_SHOT;
  if (shot) await detail.screenshot({ path: shot });

  await detail.getByRole("button", { name: "Earlier comments" }).click();
  await expect(detail.getByText("note 0")).toHaveCount(1);
});
