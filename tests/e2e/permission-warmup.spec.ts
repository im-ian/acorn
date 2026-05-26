import type { Page } from "@playwright/test";
import { test, expect } from "./support";

async function enableMacWarmup(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __ACORN_ENABLE_PERMISSION_WARMUP__?: boolean })
      .__ACORN_ENABLE_PERMISSION_WARMUP__ = true;
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      get: () => "MacIntel",
    });
  });
}

test.describe("folder permission warmup", () => {
  test("checks protected folders on startup without opening when access is ready", async ({
    page,
    tauri,
  }) => {
    await enableMacWarmup(page);
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
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __warmupCalls?: number }).__warmupCalls,
        ),
      )
      .toBe(1);
  });

  test("shows guidance when macOS reports a denied folder", async ({
    page,
    tauri,
  }) => {
    await enableMacWarmup(page);
    await tauri.handle("reset_macos_folder_permissions", () => {
      const w = window as unknown as { __resetCalls?: number };
      w.__resetCalls = (w.__resetCalls ?? 0) + 1;
      return [];
    });
    await tauri.handle("warm_macos_folder_permissions", () => {
      const w = window as unknown as { __resetCalls?: number };
      if ((w.__resetCalls ?? 0) > 0) {
        return [
          {
            id: "downloads",
            path: "/Users/tester/Downloads",
            status: "ok",
            error: null,
          },
        ];
      }
      return [
        {
          id: "downloads",
          path: "/Users/tester/Downloads",
          status: "denied",
          error: "Operation not permitted",
        },
      ];
    });

    await page.goto("/");
    const dialog = page.getByRole("dialog");

    await expect(dialog.getByText("Downloads", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Denied", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(
        "If macOS has already saved a denial, it may not show the prompt again.",
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Reset permissions" }).click();
    await expect(dialog.getByText("Ready", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __resetCalls?: number }).__resetCalls,
        ),
      )
      .toBe(1);
  });

  test("checks again on restart and reopens when access is denied", async ({
    page,
    tauri,
  }) => {
    await enableMacWarmup(page);
    await tauri.handle("warm_macos_folder_permissions", () => {
      const w = window as unknown as { __restartWarmupCalls?: number };
      w.__restartWarmupCalls = (w.__restartWarmupCalls ?? 0) + 1;
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
          status: "denied",
          error: "Operation not permitted",
        },
      ];
    });

    await page.goto("/");

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Check folder permissions now?" }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Some protected folders need attention."),
    ).toBeVisible();
    await expect(dialog.getByText("Documents", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Denied", { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Check now" }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __restartWarmupCalls?: number })
              .__restartWarmupCalls ?? 0,
        ),
      )
      .toBeGreaterThan(0);

    await dialog.getByRole("button", { name: "Done" }).click();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Check folder permissions now?" }),
    ).toBeVisible();
  });
});
