import { test, expect, pressHotkey } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

test.describe("session archive", () => {
  test("archives a session from the sidebar and resumes it from Archived", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __archived?: boolean;
      };
      return [
        {
          id: "s-1",
          name: "alpha",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
          branch: "main",
          isolated: true,
          in_worktree: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:05Z",
          last_message: null,
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          archived_at: w.__archived ? "2026-04-01T00:00:00Z" : null,
        },
      ];
    });
    await tauri.handle("archive_session", (args) => {
      const w = window as unknown as {
        __archiveCalls?: unknown[];
        __archived?: boolean;
      };
      w.__archiveCalls = w.__archiveCalls ?? [];
      w.__archiveCalls.push(args);
      w.__archived = true;
      return {
        id: "s-1",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
        branch: "main",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        archived_at: "2026-04-01T00:00:00Z",
      };
    });
    await tauri.handle("resume_session", (args) => {
      const w = window as unknown as {
        __resumeCalls?: unknown[];
        __archived?: boolean;
      };
      w.__resumeCalls = w.__resumeCalls ?? [];
      w.__resumeCalls.push(args);
      w.__archived = false;
      return {
        id: "s-1",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
        branch: "main",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        archived_at: null,
      };
    });

    await page.goto("/");

    const sidebar = page.locator('[data-testid="sidebar"]');
    const row = sidebar
      .getByRole("button", { name: /alpha.*Ready/ })
      .first();
    await expect(row).toBeVisible();

    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive Session", exact: true })
      .click();

    await expect(
      sidebar.getByRole("button", { name: /alpha.*Ready/ }),
    ).toHaveCount(0);

    const archiveCalls = (await page.evaluate(
      () =>
        (window as unknown as { __archiveCalls?: unknown[] }).__archiveCalls,
    )) as Array<{ id: string }>;
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0].id).toBe("s-1");

    const removeCalls = await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls ??
        [],
    );
    expect(removeCalls).toEqual([]);

    const preview = page.getByRole("dialog", {
      name: /archived session preview/i,
    });
    await expect(preview).toBeVisible();
    await expect(
      preview.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByRole("button", { name: "Remove", exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __resumeCalls?: unknown[] }).__resumeCalls
                ?.length ?? 0,
          ),
        { timeout: 1_000 },
      )
      .toBe(0);

    await preview.getByRole("button", { name: "Restore", exact: true }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __resumeCalls?: unknown[] }).__resumeCalls
                ?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);
    await expect(preview).toHaveCount(0);
    await expect(
      sidebar.getByRole("button", { name: /alpha.*Ready/ }),
    ).toBeVisible();
  });

  test("restore banner spawns a PTY after preview", async ({ page, tauri }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __archived?: boolean };
      return [
        {
          id: "s-live",
          name: "feature-auth",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo/.acorn/worktrees/feature-auth",
          branch: "feat/auth",
          isolated: true,
          in_worktree: true,
          status: "working",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-04-01T00:00:08Z",
          last_message: null,
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          title_source: "default",
          archived_at: null,
        },
        {
          id: "s-1",
          name: "alpha",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
          branch: "main",
          isolated: true,
          in_worktree: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:05Z",
          last_message: null,
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          title_source: "default",
          archived_at: w.__archived === false ? null : "2026-04-01T00:00:00Z",
        },
      ];
    });
    await tauri.handle("resume_session", (args) => {
      const w = window as unknown as {
        __resumeCalls?: unknown[];
        __archived?: boolean;
      };
      w.__resumeCalls = w.__resumeCalls ?? [];
      w.__resumeCalls.push(args);
      w.__archived = false;
      return {
        id: "s-1",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
        branch: "main",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        title_source: "default",
        archived_at: null,
      };
    });
    await tauri.handle("pty_spawn", (args) => {
      const w = window as unknown as { __ptySpawnCalls?: unknown[] };
      w.__ptySpawnCalls = w.__ptySpawnCalls ?? [];
      w.__ptySpawnCalls.push(args);
      return null;
    });

    await page.goto("/");
    const sidebar = page.locator('[data-testid="sidebar"]');
    await sidebar.getByRole("button", { name: /Archived/ }).click();
    await sidebar.getByRole("button", { name: /alpha.*Ready/ }).click();
    const preview = page.getByRole("dialog", {
      name: /archived session preview/i,
    });
    await expect(preview).toBeVisible();
    await expect(
      preview.getByRole("button", { name: "Restore", exact: true }),
    ).toBeVisible();

    const previewSpawns = (await page.evaluate(
      () =>
        (window as unknown as { __ptySpawnCalls?: Array<{ sessionId: string }> })
          .__ptySpawnCalls ?? [],
    )) as Array<{ sessionId: string }>;
    expect(previewSpawns.filter((call) => call.sessionId === "s-1")).toEqual(
      [],
    );

    await preview.getByRole("button", { name: "Restore", exact: true }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (
                (window as unknown as {
                  __ptySpawnCalls?: Array<{ sessionId: string }>;
                }).__ptySpawnCalls ?? []
              ).filter((call) => call.sessionId === "s-1").length,
          ),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const restoredSpawns = (await page.evaluate(
      () =>
        (window as unknown as {
          __ptySpawnCalls?: Array<{ sessionId: string; cwd: string }>;
        }).__ptySpawnCalls ?? [],
    )) as Array<{ sessionId: string; cwd: string }>;
    const spawned = restoredSpawns.find((call) => call.sessionId === "s-1");
    expect(spawned?.cwd).toBe("/tmp/demo/.acorn/worktrees/alpha");
    await expect(preview).toHaveCount(0);
  });

  test("removes an archived session from the sidebar context menu", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      {
        id: "s-live",
        name: "feature-auth",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/feature-auth",
        branch: "feat/auth",
        isolated: true,
        in_worktree: true,
        status: "working",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:08Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        title_source: "default",
        archived_at: null,
      },
      {
        id: "s-1",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
        branch: "main",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        title_source: "default",
        archived_at: "2026-04-01T00:00:00Z",
      },
    ]);

    await page.goto("/");
    const sidebar = page.locator('[data-testid="sidebar"]');
    await sidebar.getByRole("button", { name: /Archived/ }).click();
    await sidebar.getByRole("button", { name: /alpha.*Ready/ }).click({
      button: "right",
    });

    await expect(
      page.getByRole("menuitem", { name: "Resume Session", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "Remove Session", exact: true })
      .click();

    await expect(page.getByRole("heading", { name: "Remove session" })).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: /archived session preview/i }),
    ).toHaveCount(0);
  });

  test("resumes an archived session from the command palette", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __archived?: boolean };
      return [
        {
          id: "s-1",
          name: "alpha",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
          branch: "main",
          isolated: true,
          in_worktree: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:05Z",
          last_message: null,
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          archived_at:
            w.__archived === false ? null : "2026-04-01T00:00:00Z",
        },
      ];
    });
    await tauri.handle("resume_session", (args) => {
      const w = window as unknown as {
        __resumeCalls?: unknown[];
        __archived?: boolean;
      };
      w.__resumeCalls = w.__resumeCalls ?? [];
      w.__resumeCalls.push(args);
      w.__archived = false;
      return {
        id: "s-1",
        name: "alpha",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/alpha",
        branch: "main",
        isolated: true,
        in_worktree: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        archived_at: null,
      };
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "p" });
    await page.getByRole("option", { name: /Resume alpha/ }).click();

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __resumeCalls?: unknown[] }).__resumeCalls
                ?.length ?? 0,
          ),
        { timeout: 3_000 },
      )
      .toBe(1);
  });
});
