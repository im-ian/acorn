import { expect, pressHotkey, test } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const SESSION = {
  id: "s-1",
  name: "alpha",
  repo_path: "/tmp/demo",
  worktree_path: "/tmp/demo",
  branch: "main",
  isolated: false,
  status: "ready" as const,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:05Z",
  last_message: null,
};

test.describe("multi-input", () => {
  test("toggles from the default shortcut and shows status", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);
    await page.goto("/");

    await pressHotkey(page, { mod: true, alt: true, key: "i" });
    const enabledToast = page
      .getByRole("status")
      .filter({ hasText: "Multi-input enabled." });
    await expect(enabledToast).toBeVisible();
    await expect(page.getByTestId("multi-input-status")).toHaveText(
      "multi-input: on",
    );

    await enabledToast.click();
    await expect(enabledToast).toHaveCount(0);

    await pressHotkey(page, { mod: true, alt: true, key: "i" });
    await expect(
      page.getByRole("status").filter({ hasText: "Multi-input disabled." }),
    ).toBeVisible();
    await expect(page.getByTestId("multi-input-status")).toHaveCount(0);
  });
});
