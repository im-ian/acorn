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

  test("syncs the keep-awake toggle with the backend and local settings", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ power: { preventSleep: true } }),
      );
      (window as typeof window & { __ACORN_PREVENT_SLEEP_CALLS__?: boolean[] })
        .__ACORN_PREVENT_SLEEP_CALLS__ = [];
    });
    await tauri.handle("set_prevent_sleep", (args) => {
      const win = window as typeof window & {
        __ACORN_PREVENT_SLEEP_CALLS__?: boolean[];
      };
      const enabled =
        !!args &&
        typeof args === "object" &&
        "enabled" in args &&
        !!args.enabled;
      win.__ACORN_PREVENT_SLEEP_CALLS__ =
        win.__ACORN_PREVENT_SLEEP_CALLS__ || [];
      win.__ACORN_PREVENT_SLEEP_CALLS__.push(enabled);
      return { supported: true, enabled };
    });

    await page.goto("/");

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & {
              __ACORN_PREVENT_SLEEP_CALLS__?: boolean[];
            }).__ACORN_PREVENT_SLEEP_CALLS__ ?? [],
        ),
      )
      .toEqual([true]);

    await pressHotkey(page, { mod: true, key: "," });
    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Sessions|세션)$/ }).click();

    const checkbox = modal.getByRole("checkbox", {
      name: /Keep this Mac awake|이 Mac 잠자기 방지/,
    });
    await expect(checkbox).toBeChecked();
    await checkbox.click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & {
              __ACORN_PREVENT_SLEEP_CALLS__?: boolean[];
            }).__ACORN_PREVENT_SLEEP_CALLS__ ?? [],
        ),
      )
      .toEqual([true, false]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).power?.preventSleep : null;
        }),
      )
      .toBe(false);
  });

  test("toggles the running-session close warning from Sessions settings", async ({
    page,
  }) => {
    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "," });

    const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
    await modal.getByRole("button", { name: /^(Sessions|세션)$/ }).click();

    const checkbox = modal.getByRole("checkbox", {
      name: /Show running-session warning|실행 중 세션 경고 표시/,
    });
    await expect(checkbox).toBeChecked();
    await checkbox.click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).sessions?.warnBeforeClosingRunning : null;
        }),
      )
      .toBe(false);
  });
});
