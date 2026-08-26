import { test, expect } from "./support";

test.describe("update banner", () => {
  test("does not show when no update is available", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText(/Acorn .* is available/)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Install & relaunch/i }),
    ).toHaveCount(0);
  });

  test("shows the banner when plugin:updater|check returns metadata", async ({
    page,
    tauri,
  }) => {
    // The plugin's check() turns this metadata into an Update instance whose
    // `version` is what the banner reads.
    await tauri.handle("plugin:updater|check", () => ({
      rid: 0,
      currentVersion: "1.0.0",
      version: "1.2.3",
      date: "2026-01-01T00:00:00Z",
      body: "Bug fixes and improvements.",
      rawJson: {},
    }));

    await page.goto("/");

    await expect(page.getByText(/Acorn 1\.2\.3/)).toBeVisible();
    await expect(page.getByText(/is available\./)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Install & relaunch/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /What's new/i }),
    ).toBeVisible();
  });

  test("dismiss hides the banner for the same version", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:updater|check", () => ({
      rid: 0,
      currentVersion: "1.0.0",
      version: "1.2.3",
      date: "2026-01-01T00:00:00Z",
      body: "",
      rawJson: {},
    }));

    await page.goto("/");

    const banner = page.getByText(/Acorn 1\.2\.3/);
    await expect(banner).toBeVisible();

    await page.getByRole("button", { name: /Hide until next version/i }).click();

    await expect(banner).toHaveCount(0);
  });
});
