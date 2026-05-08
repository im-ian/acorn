import { test, expect, pressHotkey } from "./support";

test.describe("settings modal", () => {
  test("opens with $mod+, and closes with Escape", async ({ page }) => {
    await page.goto("/");

    const modal = page.getByRole("dialog", { name: /Settings/i });
    await expect(modal).toHaveCount(0);

    await pressHotkey(page, { mod: true, key: "," });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Terminal" })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Agents" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });

  test("clicking the close button dismisses the modal", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: /Settings/i });
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: /close/i }).first().click();
    await expect(modal).toHaveCount(0);
  });
});
