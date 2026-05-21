import { test, expect } from "./support";

test.describe("scrollbar hidden in vertical scroll areas", () => {
  test("sidebar session list applies acorn-no-scrollbar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

    const container = page.locator(".acorn-no-scrollbar").first();
    await expect(container).toHaveCount(1);

    const scrollbarWidth = await container.evaluate(
      (el) => getComputedStyle(el).scrollbarWidth,
    );
    expect(scrollbarWidth).toBe("none");
  });

  test("right panel exposes hidden-scrollbar containers", async ({
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

    await page.goto("/");
    await expect(
      page.getByRole("listitem").filter({ hasText: "demo" }),
    ).toBeVisible();

    const count = await page.locator(".acorn-no-scrollbar").count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe("scrollbar hidden in horizontal tab areas", () => {
  test("workspace tab strip hides the horizontal scrollbar", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "s-1",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);

    await page.goto("/");
    await page
      .locator('[data-panel-id="sidebar"]')
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first()
      .click();

    const strip = page.locator('[data-pane-tab-strip="root"]');
    await expect(strip).toBeVisible();

    const scrollbarWidth = await strip.evaluate(
      (el) => getComputedStyle(el).scrollbarWidth,
    );
    expect(scrollbarWidth).toBe("none");
  });
});
