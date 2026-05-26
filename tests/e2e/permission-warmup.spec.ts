import { test, expect } from "./support";

test.describe("folder permission warmup", () => {
  test("checks protected folders and stores the handled version", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { __ACORN_ENABLE_PERMISSION_WARMUP__?: boolean })
        .__ACORN_ENABLE_PERMISSION_WARMUP__ = true;
      Object.defineProperty(Navigator.prototype, "platform", {
        configurable: true,
        get: () => "MacIntel",
      });
      if (!window.sessionStorage.getItem("__acornWarmupCleared")) {
        window.localStorage.removeItem("acorn:folder-permission-warmup:v1");
        window.sessionStorage.setItem("__acornWarmupCleared", "true");
      }
    });
    await tauri.handle("warm_macos_folder_permissions", () => {
      const w = window as unknown as { __warmupCalls?: number };
      w.__warmupCalls = (w.__warmupCalls ?? 0) + 1;
      return [
        {
          id: "desktop",
          path: "/Users/tester/Desktop",
          status: "ok",
          error: null,
        },
        {
          id: "documents",
          path: "/Users/tester/Documents",
          status: "ok",
          error: null,
        },
      ];
    });

    await page.goto("/");
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Folder access check" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Check folder access" }).click();
    await expect(dialog.getByText("Desktop", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Ready")).toHaveCount(2);

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __warmupCalls?: number }).__warmupCalls,
        ),
      )
      .toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem("acorn:folder-permission-warmup:v1"),
        ),
      )
      .toBe("0.0.0-test");

    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Folder access check" }),
    ).toHaveCount(0);
  });
});
