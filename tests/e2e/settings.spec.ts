import { test, expect, pressHotkey } from "./support";

const SETTINGS_DIALOG_NAME = /^(Settings|설정)$/;

test.describe("settings modal", () => {
  test("opens with $mod+, and closes with Escape", async ({ page }) => {
    await page.goto("/");

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal).toHaveCount(0);

    await pressHotkey(page, { mod: true, key: "," });
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /^(Terminal|터미널)$/ }),
    ).toBeVisible();
    await expect(
      modal.getByRole("button", { name: /^(Agents|에이전트)$/ }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
  });

  test("clicking the close button dismisses the modal", async ({ page }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await expect(modal).toBeVisible();

    await modal.getByRole("button", { name: /close/i }).first().click();
    await expect(modal).toHaveCount(0);
  });

  test("records a custom shortcut and reset all restores defaults", async ({
    page,
  }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Shortcuts|단축키)$/ }).click();

    await modal
      .getByRole("button", {
        name: "Record shortcut for Increase UI scale",
      })
      .click();
    await expect(modal.getByText("Press keys")).toBeVisible();

    await pressHotkey(page, { mod: true, alt: true, key: "u" });
    await expect(modal.getByText(/⌥⌘U|Ctrl\+Alt\+U/)).toBeVisible();

    await modal.getByRole("button", { name: /close/i }).first().click();
    await expect(modal).toHaveCount(0);

    await pressHotkey(page, { mod: true, alt: true, key: "u" });
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.05");

    await pressHotkey(page, { mod: true, key: "," });
    await modal.getByRole("button", { name: /^(Shortcuts|단축키)$/ }).click();
    await modal
      .getByRole("button", { name: "Reset all shortcuts" })
      .click();
    await expect(modal.getByText(/⌘=|Ctrl\+=/).first()).toBeVisible();
  });
});
