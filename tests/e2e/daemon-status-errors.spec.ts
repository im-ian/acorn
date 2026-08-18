import { expect, test } from "./support";

test.describe("daemon status errors", () => {
  test("surfaces status access failures in the status bar and settings", async ({
    page,
    tauri,
  }) => {
    const error = "failed to resolve daemon log path: permission denied";
    await tauri.respond("get_acorn_ipc_status", {
      bundled_path: "/tmp/acorn-ipc",
      bundled_exists: true,
      socket_path: "/tmp/acorn-dev/ipc.sock",
      server_running: true,
      shim_paths: [],
    });
    await tauri.respond("daemon_status", {
      running: false,
      enabled: true,
      daemon_version: null,
      uptime_seconds: null,
      session_count_total: null,
      session_count_alive: null,
      log_path: null,
      last_error: error,
    });

    await page.goto("/");

    await page.getByRole("button", { name: "Service status" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText(error);

    await menu.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await expect(settings.getByText(error, { exact: true })).toBeVisible();
  });
});
