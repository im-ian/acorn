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

    await sidebar.getByRole("button", { name: /Archived/ }).click();
    const archivedRow = sidebar.getByRole("button", {
      name: /alpha.*Ready/,
    });
    await expect(archivedRow).toBeVisible();
    await archivedRow.click();

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
    await expect(
      sidebar.getByRole("button", { name: /alpha.*Ready/ }),
    ).toBeVisible();
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
