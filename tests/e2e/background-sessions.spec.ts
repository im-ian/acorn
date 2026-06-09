import { test, expect, pressHotkey } from "./support";

const SETTINGS_DIALOG_NAME = /^(Settings|설정)$/;

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
  status: "idle",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:05Z",
  last_message: null,
  title_source: "manual",
  kind: "regular",
  owner: { kind: "user" },
  position: null,
  in_worktree: false,
  agent_provider: null,
};

const DAEMON_RUNNING = {
  running: true,
  enabled: true,
  daemon_version: "test",
  uptime_seconds: 60,
  session_count_total: 1,
  session_count_alive: 1,
  log_path: "/tmp/acorn/daemon.log",
  last_error: null,
};

async function openServicesSettings(page: import("./support").Page) {
  await page.goto("/");
  await pressHotkey(page, { mod: true, key: "," });
  const modal = page.getByRole("dialog", { name: SETTINGS_DIALOG_NAME });
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Services", exact: true }).click();
  return modal;
}

test.describe("background sessions settings", () => {
  test("shows the app tab name when daemon metadata still has the UUID name", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [SESSION]);
    await tauri.respond("daemon_status", DAEMON_RUNNING);
    await tauri.respond("daemon_list_sessions", [
      {
        id: "s-1",
        name: "s-1",
        kind: "regular",
        alive: true,
        cwd: "/tmp/demo",
        repo_path: "/tmp/demo",
        branch: "main",
        agent_kind: null,
      },
    ]);

    const modal = await openServicesSettings(page);

    await expect(modal.getByText("alpha", { exact: true })).toBeVisible();
    await expect(modal.getByText("s-1", { exact: true })).toHaveCount(0);
    await expect(
      modal.getByRole("button", { name: "Restore session" }),
    ).toBeVisible();

    await modal.getByText("alpha", { exact: true }).hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("ID");
    await expect(tooltip).toContainText("s-1");
    await expect(tooltip).toContainText("Tab");
    await expect(tooltip).toContainText("alpha");
    await expect(tooltip).toContainText("Branch");
    await expect(tooltip).toContainText("main");
    await expect(tooltip).toContainText("Status");
    await expect(tooltip).toContainText("idle");
    await expect(tooltip).toContainText("Worktree");
    await expect(tooltip).toContainText("/tmp/demo");
    await expect(tooltip.locator("svg")).toHaveCount(5);
  });

  test("restore adopts an orphaned daemon session and opens its project tab", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __adopted?: boolean };
      return w.__adopted
        ? [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "orphan restored",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo",
              branch: "main",
              isolated: false,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:05Z",
              last_message: null,
              title_source: "manual",
              kind: "regular",
              owner: { kind: "user" },
              position: null,
              in_worktree: false,
              agent_provider: null,
            },
          ]
        : [];
    });
    await tauri.respond("daemon_status", DAEMON_RUNNING);
    await tauri.respond("daemon_list_sessions", [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "550e8400-e29b-41d4-a716-446655440000",
        kind: "regular",
        alive: true,
        cwd: "/tmp/demo",
        repo_path: "/tmp/demo",
        branch: "main",
        agent_kind: null,
      },
    ]);
    await tauri.handle("daemon_adopt_session", (args) => {
      const w = window as unknown as {
        __adopted?: boolean;
        __adoptCalls?: unknown[];
      };
      w.__adoptCalls = w.__adoptCalls ?? [];
      w.__adoptCalls.push(args);
      w.__adopted = true;
      return undefined;
    });

    const modal = await openServicesSettings(page);
    await modal.getByRole("button", { name: "Restore session" }).click();

    await expect(
      page.locator(
        '[data-tab-drag-handle="550e8400-e29b-41d4-a716-446655440000"]',
      ),
    ).toBeVisible();
    await expect(
      modal.getByText("orphan restored", { exact: true }),
    ).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __adoptCalls?: unknown[] }).__adoptCalls,
    )) as Array<{ targetSessionId: string }>;
    expect(calls).toEqual([
      { targetSessionId: "550e8400-e29b-41d4-a716-446655440000" },
    ]);
  });

  test("hides inactive daemon sessions and clears them in bulk", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", []);
    await tauri.handle("daemon_status", () => {
      const w = window as unknown as { __inactiveCleared?: boolean };
      const cleared = w.__inactiveCleared === true;
      return {
        running: true,
        enabled: true,
        daemon_version: "test",
        uptime_seconds: 60,
        session_count_total: cleared ? 1 : 2,
        session_count_alive: 1,
        log_path: "/tmp/acorn/daemon.log",
        last_error: null,
      };
    });
    await tauri.handle("daemon_list_sessions", () => {
      const live = {
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "live session",
        kind: "regular",
        alive: true,
        cwd: "/tmp/demo",
        repo_path: "/tmp/demo",
        branch: "main",
        agent_kind: null,
      };
      const inactive = {
        id: "550e8400-e29b-41d4-a716-446655440002",
        name: "inactive session",
        kind: "regular",
        alive: false,
        cwd: "/tmp/demo",
        repo_path: "/tmp/demo",
        branch: "main",
        agent_kind: null,
      };
      const w = window as unknown as { __inactiveCleared?: boolean };
      return w.__inactiveCleared === true ? [live] : [live, inactive];
    });
    await tauri.handle("daemon_forget_inactive_sessions", () => {
      const w = window as unknown as {
        __inactiveCleared?: boolean;
        __forgetInactiveCalls?: number;
      };
      w.__forgetInactiveCalls = (w.__forgetInactiveCalls ?? 0) + 1;
      w.__inactiveCleared = true;
      return 1;
    });

    const modal = await openServicesSettings(page);

    await expect(modal.getByText("live session", { exact: true })).toBeVisible();
    await expect(
      modal.getByText("inactive session", { exact: true }),
    ).toHaveCount(0);

    const clearInactive = modal.getByRole("button", {
      name: "Clear inactive sessions",
    });
    await expect(clearInactive).toBeEnabled();
    await clearInactive.click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as { __forgetInactiveCalls?: number })
              .__forgetInactiveCalls ?? 0,
        ),
      )
      .toBe(1);
    await expect(clearInactive).toBeDisabled();
  });
});
