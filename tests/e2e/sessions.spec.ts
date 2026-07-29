import { test, expect } from "./support";

test.describe("sessions: list rendering", () => {
  test("highlights the active session in the Projects panel", async ({
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
        id: "s-alpha",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "s-beta",
        name: "beta",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:01Z",
        updated_at: "2026-01-01T00:00:04Z",
        last_message: null,
      },
    ]);

    await page.goto("/");

    const projectsPanel = page.locator("aside").first();
    const alpha = projectsPanel
      .getByRole("button", { name: /^alpha main · Ready/ })
      .first();
    const beta = projectsPanel
      .getByRole("button", { name: /^beta main · Ready/ })
      .first();

    await alpha.click();
    await expect(alpha).toHaveClass(/acorn-tab-active-bg/);
    await expect(beta).not.toHaveClass(/acorn-tab-active-bg/);

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Canvas" }).click();
    await expect(alpha).toHaveClass(/acorn-tab-active-bg/);
    await expect(beta).not.toHaveClass(/acorn-tab-active-bg/);

    await beta.click();
    await expect(beta).toHaveClass(/acorn-tab-active-bg/);
    await expect(alpha).not.toHaveClass(/acorn-tab-active-bg/);
  });

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
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "s-run",
        name: "beta",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "working",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:04Z",
        last_message: null,
      },
      {
        id: "s-need",
        name: "gamma",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "waiting_for_input",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:03Z",
        last_message: null,
      },
      {
        id: "s-fail",
        name: "delta",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "errored",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:02Z",
        last_message: null,
      },
    ]);

    await page.goto("/");

    // Each session row exposes a button with accessible name
    // "<session> <branch> · <Status>" — assert one per status.
    await expect(
      page.getByRole("button", { name: /^alpha main · Ready$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^beta main · Working$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^gamma main · Waiting for input$/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^delta main · Error$/ }),
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
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "s-plain",
        name: "plain",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:04Z",
        last_message: null,
      },
    ]);

    await page.goto("/");

    // Worktree-marked sessions render with the GitBranch icon's "worktree"
    // aria-label baked into the row's accessible name. The label is the same
    // for Acorn-isolated sessions and for any other session whose
    // worktree_path is a linked worktree — the icon doesn't distinguish.
    await expect(
      page.getByRole("button", {
        name: /^iso worktree feature\/iso · Ready$/,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^plain main · Ready$/ }),
    ).toBeVisible();
    // Scope to the sidebar and use exact match — the tab strip renders the
    // same icon, and the parent button's accessible name also contains
    // "worktree" so a non-exact substring match double-counts.
    await expect(
      page.locator('aside').getByLabel("worktree", { exact: true }),
    ).toHaveCount(1);
  });

  test("unpositioned sidebar sessions keep created order when updated_at changes", async ({
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
        id: "older-created",
        name: "older-created",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-05T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      },
      {
        id: "newer-created",
        name: "newer-created",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-03T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      },
    ]);

    await page.goto("/");

    const newer = page.getByRole("button", {
      name: /^newer-created main · Ready$/,
    });
    const older = page.getByRole("button", {
      name: /^older-created main · Ready$/,
    });
    await expect(newer).toBeVisible();
    await expect(older).toBeVisible();

    const newerBox = await newer.boundingBox();
    const olderBox = await older.boundingBox();
    expect(newerBox).not.toBeNull();
    expect(olderBox).not.toBeNull();
    expect(newerBox!.y).toBeLessThan(olderBox!.y);
  });
});
