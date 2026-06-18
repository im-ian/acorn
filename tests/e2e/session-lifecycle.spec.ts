import { test, expect } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

const BASE_SESSION = {
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
};

test.describe("session lifecycle", () => {
  test("F2 → type → Enter invokes rename_session with the new name", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [BASE_SESSION]);
    // rename_session captures args and returns the renamed session shape so
    // the post-rename refresh path doesn't crash. The store reads our
    // updated list_sessions on the follow-up refresh — but to keep this
    // focused on the invoke contract we just confirm the call was made.
    await tauri.handle("rename_session", (args) => {
      const w = window as unknown as { __renameCalls?: unknown[] };
      w.__renameCalls = w.__renameCalls ?? [];
      w.__renameCalls.push(args);
      const a = args as { id: string; name: string };
      return { ...BASE_SESSION, id: a.id, name: a.name };
    });

    await page.goto("/");

    // Scope to the sidebar — once the session is activated, the main pane's
    // tab and right panel's controls also surface the session name, breaking
    // a global getByRole match.
    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first();
    await row.click();
    // After activation the row's accessible name now includes the visible
    // Remove button, so re-resolve via the rename input that opens on F2.
    await page.keyboard.press("F2");

    const input = sidebar.locator("input[type='text']");
    await expect(input).toBeVisible();
    await input.fill("renamed");
    await input.press("Enter");

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __renameCalls?: unknown[] })
                .__renameCalls?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __renameCalls?: unknown[] }).__renameCalls,
    )) as Array<{ id: string; name: string }>;
    expect(calls[0]).toEqual({ id: "s-1", name: "renamed" });
  });

  test("double-clicking a project session row starts rename", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [BASE_SESSION]);
    await tauri.handle("rename_session", (args) => {
      const w = window as unknown as { __renameCalls?: unknown[] };
      w.__renameCalls = w.__renameCalls ?? [];
      w.__renameCalls.push(args);
      const a = args as { id: string; name: string };
      return { ...BASE_SESSION, id: a.id, name: a.name };
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first();
    await row.dblclick();

    const input = sidebar.locator("input[type='text']");
    await expect(input).toBeFocused();
    await input.fill("renamed from double click");
    await input.press("Enter");

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __renameCalls?: unknown[] }).__renameCalls,
    )) as Array<{ id: string; name: string }>;
    expect(calls[0]).toEqual({
      id: "s-1",
      name: "renamed from double click",
    });
  });

  test("Remove session button → confirm → remove_session is invoked", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    // Switch list_sessions to empty after the remove fires so the post-remove
    // refresh visibly empties the row. Handler runs in the page context — no
    // closures, inline the seed.
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessionRemoved?: boolean };
      return w.__sessionRemoved
        ? []
        : [
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
          ];
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __sessionRemoved?: boolean;
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      w.__sessionRemoved = true;
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first();
    await expect(row).toBeVisible();

    // Hover to reveal the (visually hidden until hover) Remove session button.
    await row.hover();
    await sidebar
      .getByRole("button", { name: "Remove session", exact: true })
      .click();

    // RemoveSessionDialog has no aria-label on its dialog wrapper, so we
    // identify it via the "Remove session" heading inside.
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: /^Remove$/ }).click();

    await expect(
      sidebar.getByRole("button", { name: /^alpha main · Idle/ }),
    ).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("s-1");
    // Non-isolated session: primary button is "Remove" → session_only path,
    // which the store passes as removeWorktree = false.
    expect(calls[0].removeWorktree).toBe(false);
  });

  test("closing a running session shows a warning before removal", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: false,
            warnBeforeClosingRunning: true,
          },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessionRemoved?: boolean };
      return w.__sessionRemoved
        ? []
        : [
            {
              id: "s-1",
              name: "alpha",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo",
              branch: "main",
              isolated: false,
              status: "running",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:05Z",
              last_message: null,
            },
          ];
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __sessionRemoved?: boolean;
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      w.__sessionRemoved = true;
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha main · Running/ })
      .first();
    await expect(row).toBeVisible();

    await row.hover();
    await sidebar
      .getByRole("button", { name: "Remove session", exact: true })
      .click();

    const warning = page.getByRole("dialog", {
      name: "Close running session?",
    });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(
      "Closing it will terminate the active shell or agent process.",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __removeCalls?: unknown[] }).__removeCalls
              ?.length ?? 0,
        ),
      )
      .toBe(0);

    await warning
      .getByRole("checkbox", { name: /Don't warn again/ })
      .click();
    await warning.getByRole("button", { name: "Close session" }).click();

    await expect(
      sidebar.getByRole("button", { name: /^alpha main · Running/ }),
    ).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toEqual([{ id: "s-1", removeWorktree: false }]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw ? JSON.parse(raw).sessions?.warnBeforeClosingRunning : null;
        }),
      )
      .toBe(false);
  });

  test("standalone isolated worktree auto-delete skips the remove confirmation", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: true,
            confirmDeleteIsolatedWorktrees: false,
            showRestartPromptOnExit: true,
          },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessionRemoved?: boolean };
      return w.__sessionRemoved
        ? []
        : [
            {
              id: "s-1",
              name: "alpha",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
              branch: "main",
              isolated: true,
              in_worktree: true,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:05Z",
              last_message: null,
            },
          ];
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __sessionRemoved?: boolean;
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      w.__sessionRemoved = true;
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha worktree main · Idle/ })
      .first();
    await expect(row).toBeVisible();

    await row.hover();
    await sidebar
      .getByRole("button", { name: "Remove session", exact: true })
      .click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: /^alpha worktree main · Idle/ }),
    ).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "s-1", removeWorktree: true });
  });

  test("standalone isolated worktree prompt can enable future auto-delete", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: true,
            confirmDeleteIsolatedWorktrees: true,
            showRestartPromptOnExit: true,
          },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessionRemoved?: boolean };
      return w.__sessionRemoved
        ? []
        : [
            {
              id: "s-1",
              name: "alpha",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
              branch: "main",
              isolated: true,
              in_worktree: true,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:05Z",
              last_message: null,
            },
          ];
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __sessionRemoved?: boolean;
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      w.__sessionRemoved = true;
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha worktree main · Idle/ })
      .first();
    await expect(row).toBeVisible();

    await row.hover();
    await sidebar
      .getByRole("button", { name: "Remove session", exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove session" }),
    ).toBeVisible();

    const remember = dialog.getByRole("checkbox", {
      name: "Delete standalone isolated worktrees without asking next time",
    });
    await expect(remember).not.toBeChecked();
    await remember.check();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __removeCalls?: unknown[] }).__removeCalls
              ?.length ?? 0,
        ),
      )
      .toBe(0);

    await dialog
      .getByRole("button", { name: "Remove + delete worktree" })
      .click();

    await expect(
      sidebar.getByRole("button", { name: /^alpha worktree main · Idle/ }),
    ).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toEqual([{ id: "s-1", removeWorktree: true }]);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = window.localStorage.getItem("acorn:settings:v1");
          return raw
            ? JSON.parse(raw).sessions?.confirmDeleteIsolatedWorktrees
            : null;
        }),
      )
      .toBe(false);
  });

  test("shared worktree workspace session removal skips the confirmation", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: true,
            confirmDeleteIsolatedWorktrees: false,
            showRestartPromptOnExit: true,
          },
        }),
      );
      window.localStorage.setItem(
        "acorn-workspaces",
        JSON.stringify({
          state: {
            projectFolders: {
              "/tmp/demo": [
                {
                  id: "/tmp/demo",
                  repoPath: "/tmp/demo",
                  name: "Default",
                  cwdPath: "/tmp/demo",
                  position: 0,
                },
                {
                  id: "project-folder:/tmp/demo:feature-worktree",
                  repoPath: "/tmp/demo",
                  name: "Feature workspace",
                  cwdPath: "/tmp/demo/.acorn/worktrees/feature",
                  position: 1,
                },
              ],
            },
            sessionFolderIds: {},
          },
          version: 4,
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessionRemoved?: boolean };
      return w.__sessionRemoved
        ? []
        : [
            {
              id: "s-1",
              name: "alpha",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo/.acorn/worktrees/feature",
              branch: "main",
              isolated: true,
              in_worktree: true,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:05Z",
              last_message: null,
            },
          ];
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __sessionRemoved?: boolean;
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      w.__sessionRemoved = true;
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-panel-id="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first();
    await expect(row).toBeVisible();

    await row.hover();
    await sidebar
      .getByRole("button", { name: "Remove session", exact: true })
      .click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: /^alpha main · Idle/ }),
    ).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: "s-1", removeWorktree: false });
  });
});
