import { test, expect } from "./support";

test.describe("sessions: list rendering", () => {
  test("each status renders its label", async ({ page, tauri }) => {
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
        id: "s-idle",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        startup_mode: null,
      },
      {
        id: "s-run",
        name: "beta",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:04Z",
        last_message: null,
        startup_mode: null,
      },
      {
        id: "s-need",
        name: "gamma",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "needs_input",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:03Z",
        last_message: null,
        startup_mode: null,
      },
      {
        id: "s-fail",
        name: "delta",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "failed",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:02Z",
        last_message: null,
        startup_mode: null,
      },
      {
        id: "s-done",
        name: "epsilon",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "completed",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
        last_message: null,
        startup_mode: null,
      },
    ]);

    await page.goto("/");

    // Each session row exposes a button with accessible name
    // "<session> <branch> · <Status>" — assert one per status.
    await expect(
      page.getByRole("button", { name: /^alpha main · Idle$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^beta main · Running$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^gamma main · Needs input$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^delta main · Failed$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^epsilon main · Completed$/ }),
    ).toBeVisible();
  });

  test("isolated worktree marker shows on isolated sessions only", async ({
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
        id: "s-iso",
        name: "iso",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo-iso",
        branch: "feature/iso",
        isolated: true,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        startup_mode: null,
      },
      {
        id: "s-plain",
        name: "plain",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:04Z",
        last_message: null,
        startup_mode: null,
      },
    ]);

    await page.goto("/");

    // Isolated sessions render with the GitBranch icon's "isolated worktree"
    // aria-label baked into the row's accessible name.
    await expect(
      page.getByRole("button", {
        name: /^iso isolated worktree feature\/iso · Idle$/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^plain main · Idle$/ }),
    ).toBeVisible();
    // The GitBranch icon next to isolated session names carries
    // aria-label="isolated worktree".
    await expect(page.getByLabel("isolated worktree")).toHaveCount(1);
  });
});
