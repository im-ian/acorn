import { expect, test, type Locator, type Page } from "./support";

// A narrow window is where the task chips used to push Refresh and New out
// of the panel. The actions have to stay on the right edge either way.
test.use({ viewport: { width: 880, height: 700 } });

async function openWorkspace(page: Page) {
  const groups = page.getByRole("navigation", { name: "Right panel group" });
  const panel = page.locator("aside").filter({ has: groups });
  await groups.getByRole("button", { name: "Workspace" }).click();
  return panel;
}

async function expectActionsPinnedRight(panel: Locator) {
  const panelBox = await panel.boundingBox();
  const refresh = panel.getByRole("button", { name: "Refresh", exact: true });
  const create = panel.getByRole("button", { name: "New", exact: true });
  await expect(refresh).toBeVisible();
  await expect(create).toBeVisible();
  const refreshBox = await refresh.boundingBox();
  const createBox = await create.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(refreshBox).not.toBeNull();
  expect(createBox).not.toBeNull();
  if (!panelBox || !refreshBox || !createBox) return;

  expect(refreshBox.x + refreshBox.width).toBeLessThanOrEqual(createBox.x + 1);
  expect(createBox.x).toBeGreaterThanOrEqual(refreshBox.x + refreshBox.width - 1);
  const rightGap = panelBox.x + panelBox.width - (createBox.x + createBox.width);
  expect(rightGap).toBeGreaterThanOrEqual(4);
  expect(rightGap).toBeLessThanOrEqual(16);
  expect(createBox.x).toBeGreaterThan(panelBox.x + panelBox.width / 2);
  await expect(create).toHaveClass(/bg-accent/);
}

test("workspace task and schedule actions stay on the right", async ({
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

  await page.goto("/");
  const groups = page.getByRole("navigation", { name: "Right panel group" });
  await expect(
    groups.getByRole("button", { name: "Workspace" }).locator("svg"),
  ).toHaveClass(/lucide-layout-panel-left/);
  const panel = await openWorkspace(page);
  await expect(panel.getByText("No tasks yet")).toBeVisible();
  await expectActionsPinnedRight(panel);

  const inReview = panel
    .getByRole("button", { name: "In review", exact: true })
    .first();
  await inReview.click();
  await expect(inReview).toHaveAttribute("aria-pressed", "true");
  await expectActionsPinnedRight(panel);

  await panel.getByRole("button", { name: "New", exact: true }).click();
  const taskEditor = page.getByRole("dialog", { name: "New task" });
  await expect(taskEditor).toBeVisible();
  await taskEditor.getByRole("button", { name: "Cancel" }).click();
  await expect(taskEditor).toHaveCount(0);

  const shot = process.env.ACORN_UI_SHOT;
  if (shot) await panel.screenshot({ path: shot });

  await panel.getByRole("button", { name: "Schedules" }).click();
  await expect(panel.getByText("No schedules yet")).toBeVisible();
  await expectActionsPinnedRight(panel);
  await panel.getByRole("button", { name: "New", exact: true }).click();
  const scheduleEditor = page.getByRole("dialog", { name: "New schedule" });
  await expect(scheduleEditor).toBeVisible();
  await scheduleEditor.getByRole("button", { name: "Cancel" }).click();
  await expect(scheduleEditor).toHaveCount(0);
  if (shot) {
    await panel.screenshot({ path: shot.replace(/\.png$/, "-schedules.png") });
  }
});
