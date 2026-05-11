import { test, expect, pressHotkey } from "./support";

const REPO_PATH = "/tmp/demo";

const PROJECT = {
  repo_path: REPO_PATH,
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

test.describe("control session: creation flow", () => {
  test("Cmd+Alt+Shift+T creates a control session, surfaces the bot icon, and shows the guide modal", async ({
    page,
    tauri,
  }) => {
    // Seed an existing project; the hotkey targets the active project, so
    // we don't need to drive the directory picker.
    await tauri.respond("list_projects", [PROJECT]);
    // The store starts with no sessions, then `create_session` populates one.
    // `list_sessions` is called after creation via `refreshAll`, so it has to
    // return the freshly-created control session on subsequent calls.
    await tauri.handle("list_sessions", () => {
      // Tests-side state is forbidden inside the handler (serialized to source),
      // so we read the *last* created session out of a window-scoped store.
      const w = window as unknown as {
        __ACORN_CTL_LAST__?: Record<string, unknown> | null;
      };
      return w.__ACORN_CTL_LAST__ ? [w.__ACORN_CTL_LAST__] : [];
    });
    await tauri.handle("create_session", (args) => {
      const input = (args ?? {}) as {
        name?: string;
        repoPath?: string;
        kind?: string;
      };
      const created = {
        id: "ctl-1",
        name: input.name ?? "control-demo",
        repo_path: input.repoPath ?? "/tmp/demo",
        worktree_path: input.repoPath ?? "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        startup_mode: null,
        kind: input.kind ?? "regular",
      };
      (window as unknown as { __ACORN_CTL_LAST__: unknown }).__ACORN_CTL_LAST__ =
        created;
      return created;
    });

    await page.goto("/");
    // Clear any previously-persisted dismissal so the guide is allowed to fire.
    await page.evaluate(() => {
      window.localStorage.removeItem("acorn:control-guide-dismissed-v1");
    });

    // Trigger the hotkey. Bindings live on `window` via tinykeys; pressHotkey
    // dispatches a synthetic keydown to bypass Chromium's own intercepts.
    await pressHotkey(page, { mod: true, alt: true, shift: true, key: "t" });

    // The new session appears in the sidebar with the control accessory icon.
    const sidebar = page.locator("aside");
    const controlIcon = sidebar.locator(
      "[aria-label='control session']",
    );
    await expect(controlIcon).toBeVisible();

    // The guide modal opens on first creation.
    await expect(
      page.getByRole("heading", { name: "Control session" }),
    ).toBeVisible();

    // Dismiss with "don't show again" so the localStorage gate is set.
    await page
      .getByRole("checkbox", { name: /Don't show this again/i })
      .check();
    await page.getByRole("button", { name: "Got it" }).click();

    await expect(
      page.getByRole("heading", { name: "Control session" }),
    ).toBeHidden();

    // The flag was written.
    const dismissed = await page.evaluate(() =>
      window.localStorage.getItem("acorn:control-guide-dismissed-v1"),
    );
    expect(dismissed).toBe("1");
  });

  test("command palette exposes a 'New control session' entry", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", []);

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "p" });

    await expect(
      page.getByRole("dialog", { name: /Command palette/i }),
    ).toBeVisible();
    // cmdk renders items with role="option"; matching by visible text is
    // resilient to cmdk's exact aria implementation.
    await expect(page.getByText("New control session")).toBeVisible();
  });
});
