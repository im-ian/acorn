import {
  test,
  expect,
  COMPACT_VIEWPORTS,
  expectFullyInViewport,
  modalShell,
} from "./support";

test.describe("project settings", () => {
  test("manages project worktrees from the Worktrees settings tab", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/acorn",
        name: "acorn",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_project_worktrees", () => {
      const w = window as unknown as {
        __worktrees?: Array<{
          name: string;
          path: string;
          modified_ms: number | null;
        }>;
      };
      w.__worktrees = w.__worktrees ?? [
        {
          name: "feature-alpha",
          path: "/tmp/acorn/.acorn/worktrees/feature-alpha",
          modified_ms: Date.UTC(2026, 4, 19, 12, 0, 0),
        },
        {
          name: "feature-beta",
          path: "/tmp/acorn/.acorn/worktrees/feature-beta",
          modified_ms: null,
        },
      ];
      return w.__worktrees;
    });
    await tauri.handle("remove_worktree", (args) => {
      const w = window as unknown as {
        __removeWorktreeCalls?: unknown[];
        __worktrees?: Array<{ path: string }>;
      };
      w.__removeWorktreeCalls = w.__removeWorktreeCalls ?? [];
      w.__removeWorktreeCalls.push(args);
      const worktreePath = (args as { worktreePath?: string }).worktreePath;
      w.__worktrees = (w.__worktrees ?? []).filter(
        (worktree) => worktree.path !== worktreePath,
      );
      return undefined;
    });

    await page.goto("/");

    await page
      .getByRole("button", { name: "Project acorn" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Project Settings" }).click();

    const modal = page.getByRole("dialog", { name: "Project Settings" });
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Worktrees" }).click();

    const alphaRow = modal.getByRole("listitem").filter({
      hasText: "feature-alpha",
    });
    await expect(alphaRow).toContainText("May 19, 2026");
    await expect(alphaRow).toContainText(
      "/tmp/acorn/.acorn/worktrees/feature-alpha",
    );
    await expect(
      modal.getByRole("listitem").filter({ hasText: "feature-beta" }),
    ).toContainText("Last modified unknown");

    await alphaRow
      .getByRole("button", { name: "Remove feature-alpha worktree" })
      .click();
    await page
      .getByRole("dialog", { name: "Delete worktree" })
      .getByRole("button", { name: "Delete worktree" })
      .click();

    await expect(alphaRow).toHaveCount(0);
    await expect(
      modal.getByRole("listitem").filter({ hasText: "feature-beta" }),
    ).toBeVisible();
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeWorktreeCalls?: unknown[] })
          .__removeWorktreeCalls,
    )) as Array<{ repoPath: string; worktreePath: string }>;
    expect(calls).toEqual([
      {
        repoPath: "/tmp/acorn",
        worktreePath: "/tmp/acorn/.acorn/worktrees/feature-alpha",
      },
    ]);
  });

  test("confirms before deleting a worktree used by the active sidebar session", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/acorn",
        name: "acorn",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "s-alpha",
          name: "alpha terminal",
          repo_path: "/tmp/acorn",
          worktree_path: "/tmp/acorn/.acorn/worktrees/feature-alpha",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "ready",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:05Z",
          last_message: null,
          title_source: "default",
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          in_worktree: true,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("list_project_worktrees", () => {
      const w = window as unknown as {
        __worktrees?: Array<{
          name: string;
          path: string;
          modified_ms: number | null;
        }>;
      };
      w.__worktrees = w.__worktrees ?? [
        {
          name: "feature-alpha",
          path: "/tmp/acorn/.acorn/worktrees/feature-alpha",
          modified_ms: null,
        },
      ];
      return w.__worktrees;
    });
    await tauri.handle("remove_worktree", (args) => {
      const w = window as unknown as {
        __removeWorktreeCalls?: unknown[];
        __sessions?: Array<Record<string, unknown>>;
        __worktrees?: Array<{ path: string }>;
      };
      w.__removeWorktreeCalls = w.__removeWorktreeCalls ?? [];
      w.__removeWorktreeCalls.push(args);
      const worktreePath = (args as { worktreePath?: string }).worktreePath;
      if ((args as { removeSessions?: boolean }).removeSessions) {
        w.__sessions = (w.__sessions ?? []).filter(
          (session) => session.worktree_path !== worktreePath,
        );
      }
      w.__worktrees = (w.__worktrees ?? []).filter(
        (worktree) => worktree.path !== worktreePath,
      );
      return undefined;
    });

    await page.goto("/");

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(
      sidebar.getByRole("button", {
        name: /^alpha terminal worktree main · Ready/,
      }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Project acorn" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Project Settings" }).click();

    const modal = page.getByRole("dialog", { name: "Project Settings" });
    await modal.getByRole("button", { name: "Worktrees" }).click();

    const alphaRow = modal.getByRole("listitem").filter({
      hasText: "feature-alpha",
    });
    await expect(alphaRow).toContainText("Used by 1 session");
    await alphaRow
      .getByRole("button", { name: "Remove feature-alpha worktree" })
      .click();

    const confirm = page.getByRole("dialog", { name: "Delete worktree" });
    await expect(confirm).toContainText("alpha terminal");
    await confirm
      .getByRole("button", { name: "Remove sessions and delete worktree" })
      .click();

    await expect(
      sidebar.getByRole("button", {
        name: /^alpha terminal worktree main · Ready/,
      }),
    ).toHaveCount(0);
    await expect(alphaRow).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeWorktreeCalls?: unknown[] })
          .__removeWorktreeCalls,
    )) as Array<{
      repoPath: string;
      worktreePath: string;
      removeSessions: boolean;
    }>;
    expect(calls).toEqual([
      {
        repoPath: "/tmp/acorn",
        worktreePath: "/tmp/acorn/.acorn/worktrees/feature-alpha",
        removeSessions: true,
      },
    ]);
  });

  test("does not open the delete confirmation while another session uses the worktree", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/acorn",
        name: "acorn",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => [
      {
        id: "s-alpha",
        name: "alpha terminal",
        repo_path: "/tmp/acorn",
        worktree_path: "/tmp/acorn/.acorn/worktrees/feature-alpha",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        title_source: "default",
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: true,
      },
      {
        id: "s-alpha-other",
        name: "alpha reviewer",
        repo_path: "/tmp/acorn",
        worktree_path: "/tmp/acorn/.acorn/worktrees/feature-alpha/",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        title_source: "default",
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: true,
      },
    ]);
    await tauri.handle("list_project_worktrees", () => [
      {
        name: "feature-alpha",
        path: "/tmp/acorn/.acorn/worktrees/feature-alpha",
        modified_ms: null,
      },
    ]);
    await tauri.handle("remove_worktree", (args) => {
      const w = window as unknown as { __removeWorktreeCalls?: unknown[] };
      w.__removeWorktreeCalls = w.__removeWorktreeCalls ?? [];
      w.__removeWorktreeCalls.push(args);
      return undefined;
    });

    await page.goto("/");

    await page
      .getByRole("button", { name: "Project acorn" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Project Settings" }).click();

    const modal = page.getByRole("dialog", { name: "Project Settings" });
    await modal.getByRole("button", { name: "Worktrees" }).click();

    const alphaRow = modal.getByRole("listitem").filter({
      hasText: "feature-alpha",
    });
    await expect(alphaRow).toContainText("Used by 2 sessions");
    await expect(alphaRow).toContainText(
      "Close other sessions using this worktree before removing it.",
    );
    await expect(
      alphaRow.getByRole("button", {
        name: "Remove feature-alpha worktree",
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("dialog", { name: "Delete worktree" }),
    ).toHaveCount(0);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeWorktreeCalls?: unknown[] })
          .__removeWorktreeCalls ?? [],
    )) as unknown[];
    expect(calls).toEqual([]);
  });

  test("lists and removes a project's source folders", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("list_projects", () => {
      const w = window as unknown as {
        __projects?: Array<Record<string, unknown>>;
      };
      w.__projects = w.__projects ?? [
        {
          repo_path: "/tmp/acorn",
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
          source_paths: ["/tmp/acorn-api", "/tmp/acorn-docs"],
        },
      ];
      return w.__projects;
    });
    await tauri.handle("list_sessions", () => [
      {
        id: "s-api",
        name: "api terminal",
        repo_path: "/tmp/acorn-api",
        worktree_path: "/tmp/acorn-api",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
        title_source: "default",
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      },
    ]);
    await tauri.handle("remove_project_source", (args) => {
      const w = window as unknown as {
        __removeSourceCalls?: unknown[];
        __projects?: Array<Record<string, unknown>>;
      };
      w.__removeSourceCalls = w.__removeSourceCalls ?? [];
      w.__removeSourceCalls.push(args);
      const sourcePath = (args as { sourcePath?: string }).sourcePath;
      w.__projects = (w.__projects ?? []).map((project) => ({
        ...project,
        source_paths: ((project.source_paths as string[]) ?? []).filter(
          (path) => path !== sourcePath,
        ),
      }));
      return w.__projects?.[0];
    });

    await page.goto("/");

    await page
      .getByRole("button", { name: "Project acorn" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Project Settings" }).click();

    const modal = page.getByRole("dialog", { name: "Project Settings" });
    await modal.getByRole("button", { name: "Source folders" }).click();

    await expect(
      modal.getByRole("listitem").filter({ hasText: "/tmp/acorn-api" }),
    ).toContainText("Used by 1 session");
    await expect(modal.getByRole("listitem").first()).toContainText("Primary");
    // The primary root has no remove control; a source folder in use is
    // blocked, and an unused one can be detached.
    await expect(
      modal.getByRole("button", { name: "Remove source folder acorn-api" }),
    ).toBeDisabled();

    await modal
      .getByRole("button", { name: "Remove source folder acorn-docs" })
      .click();

    await expect(
      modal.getByRole("listitem").filter({ hasText: "/tmp/acorn-docs" }),
    ).toHaveCount(0);
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeSourceCalls?: unknown[] })
          .__removeSourceCalls,
    )) as Array<{ repoPath: string; sourcePath: string }>;
    expect(calls).toEqual([
      { repoPath: "/tmp/acorn", sourcePath: "/tmp/acorn-docs" },
    ]);
  });
});

test.describe("project settings: compact height", () => {
  for (const viewport of COMPACT_VIEWPORTS) {
    test(`keeps the shell and the footer actions on screen at ${viewport.width}x${viewport.height}`, async ({
      page,
      tauri,
    }) => {
      await page.setViewportSize({ ...viewport });
      await tauri.respond("list_projects", [
        {
          repo_path: "/tmp/acorn",
          name: "acorn",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ]);

      await page.goto("/");
      await page
        .getByRole("button", { name: "Project acorn" })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Project Settings" }).click();

      const modal = page.getByRole("dialog", { name: "Project Settings" });
      await expect(modal).toBeVisible();
      await expectFullyInViewport(page, modalShell(modal));
      await expectFullyInViewport(
        page,
        modal.getByRole("button", { name: "Save" }),
      );
      await expectFullyInViewport(
        page,
        modal.getByRole("button", { name: "Cancel" }),
      );
    });
  }
});
