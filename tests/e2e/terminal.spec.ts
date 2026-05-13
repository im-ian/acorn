import { test, expect } from "./support";

test.describe("terminal: spawn", () => {
  test("activating a session calls pty_spawn with the session's cwd", async ({
    page,
    tauri,
  }) => {
    // All seeded data is inlined inside each handler — handlers run in the
    // page context and cannot close over variables declared in the test
    // function. Module-scope `const` won't reach the browser either.
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => [
      {
        id: "s-term",
        name: "shell",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    // Record every pty_spawn invocation on `window` so the test can read it
    // back via page.evaluate.
    await tauri.handle("pty_spawn", (args) => {
      const w = window as unknown as { __ptySpawnCalls?: unknown[] };
      w.__ptySpawnCalls = w.__ptySpawnCalls ?? [];
      w.__ptySpawnCalls.push(args);
      return null;
    });

    await page.goto("/");

    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __ptySpawnCalls?: unknown[] })
                .__ptySpawnCalls?.length ?? 0,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __ptySpawnCalls?: unknown[] }).__ptySpawnCalls,
    )) as Array<{
      sessionId: string;
      cwd: string;
    }>;

    const first = calls[0];
    expect(first.sessionId).toBe("s-term");
    expect(first.cwd).toBe("/tmp/demo");
  });
});
