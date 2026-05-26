import { test, expect } from "./support";

test.describe("session notification center", () => {
  test("collects actionable session status transitions", async ({
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
        id: "session-1",
        name: "agent run",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
      },
    ]);
    await tauri.handle("detect_session_statuses", () => [
      {
        id: "session-1",
        status: "needs_input",
        branch: null,
        agent_provider: null,
      },
    ]);

    await page.goto("/");

    await expect(page.getByRole("button", { name: "Session notifications" }))
      .toContainText("1");

    await page.getByRole("button", { name: "Agents" }).click();
    const subTabs = page.getByRole("navigation", {
      name: "Right panel sub-tab",
    });
    const activityTab = subTabs.getByRole("button", { name: /Activity/ });
    const historyTab = subTabs.getByRole("button", { name: "History" });
    await expect(activityTab).toBeVisible();
    await expect(activityTab).toContainText("1");
    await expect(historyTab).toBeVisible();
    const [activityBox, historyBox] = await Promise.all([
      activityTab.boundingBox(),
      historyTab.boundingBox(),
    ]);
    expect(activityBox?.x ?? 0).toBeLessThan(historyBox?.x ?? 0);
    await expect(page.getByText("demo · agent run")).toBeVisible();

    await page.getByRole("button", { name: "Session notifications" }).click();

    await expect(
      page.getByRole("menu").getByText("Needs input"),
    ).toBeVisible();
    await expect(
      page.getByRole("menu").getByText("demo · agent run"),
    ).toBeVisible();

    await page.getByRole("menuitem", { name: /Needs input/ }).click();

    await expect(page.getByRole("button", { name: "Session notifications" }))
      .not.toContainText("1");
    await expect(activityTab).not.toContainText("1");
  });
});
