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
        name: "foreground",
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
      {
        id: "session-2",
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
        position: 1,
        in_worktree: false,
      },
    ]);
    await tauri.handle("detect_session_statuses", () => [
      {
        id: "session-2",
        status: "needs_input",
        branch: null,
        agent_provider: null,
      },
    ]);

    await page.goto("/");

    await expect(page.getByRole("button", { name: "Session notifications" }))
      .toContainText("1");

    const instantSessions = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    const activity = page.getByRole("region", {
      name: "Session activity",
    });
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("1 unread");
    const [instantBox, activityBox] = await Promise.all([
      instantSessions.boundingBox(),
      activity.boundingBox(),
    ]);
    expect(activityBox?.y ?? 0).toBeGreaterThan(instantBox?.y ?? 0);
    await expect(activity.getByText("demo · agent run")).toBeVisible();

    const activityBody = page.getByTestId("sidebar-activity-body");
    const resizeHandle = page.getByTestId("sidebar-activity-resize-handle");
    const [bodyBoxBefore, resizeHandleBox] = await Promise.all([
      activityBody.boundingBox(),
      resizeHandle.boundingBox(),
    ]);
    expect(bodyBoxBefore).not.toBeNull();
    expect(resizeHandleBox).not.toBeNull();
    if (!bodyBoxBefore || !resizeHandleBox) {
      throw new Error("missing sidebar activity resize target");
    }
    expect(resizeHandleBox.height).toBeGreaterThanOrEqual(12);
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2 - 72,
    );
    await page.mouse.up();
    await expect
      .poll(async () =>
        activityBody.evaluate((element) =>
          element.getBoundingClientRect().height,
        ),
      )
      .toBeGreaterThan(bodyBoxBefore.height + 48);

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
    await expect(activity).toContainText("0 unread");
  });
});
