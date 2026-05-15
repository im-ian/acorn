import { test, expect } from "./support";

test.describe("sidebar: project lifecycle", () => {
  test("seeded project appears with name and add session affordances", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => []);

    await page.goto("/");

    await expect(
      page.getByRole("listitem").filter({ hasText: "demo" }),
    ).toBeVisible();
    await expect(page.getByText(/No projects yet/i)).toHaveCount(0);
    await expect(page.getByText(/No sessions\./i)).toBeVisible();
  });

  test("Add existing project invokes add_project with the picked path", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:dialog|open", () => "/tmp/picked");
    // Capture the add_project call arguments on window so the test can
    // verify the picked path actually flowed into the invoke.
    await tauri.handle("add_project", (args) => {
      const w = window as unknown as { __addProjectCalls?: unknown[] };
      w.__addProjectCalls = w.__addProjectCalls ?? [];
      w.__addProjectCalls.push(args);
      const a = args as { repoPath: string };
      return {
        repo_path: a.repoPath,
        name: "picked",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      };
    });
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/picked",
        name: "picked",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);

    await page.goto("/");
    await page.getByRole("button", { name: "Add existing project" }).click();

    await expect(
      page.getByRole("listitem").filter({ hasText: "picked" }),
    ).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __addProjectCalls?: unknown[] })
          .__addProjectCalls,
    )) as Array<{ repoPath: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].repoPath).toBe("/tmp/picked");
  });

  test("New project creates a git-backed project under the selected parent", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:dialog|open", () => "/tmp/parent");
    await tauri.handle("create_new_project", (args) => {
      const w = window as unknown as {
        __newProjectCalls?: unknown[];
        __projectCreated?: boolean;
      };
      w.__newProjectCalls = w.__newProjectCalls ?? [];
      w.__newProjectCalls.push(args);
      w.__projectCreated = true;
      const a = args as { parentPath: string; name: string };
      return {
        repo_path: `${a.parentPath}/${a.name}`,
        name: a.name,
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      };
    });
    await tauri.handle("list_projects", () => {
      const w = window as unknown as { __projectCreated?: boolean };
      return w.__projectCreated
        ? [
            {
              repo_path: "/tmp/parent/fresh-app",
              name: "fresh-app",
              created_at: "2026-01-01T00:00:00Z",
              position: 0,
            },
          ]
        : [];
    });

    await page.goto("/");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("fresh-app");
    await page.getByRole("button", { name: "Choose" }).click();
    await expect(page.getByText("/tmp/parent/fresh-app")).toBeVisible();
    await page.getByRole("button", { name: "Create project" }).click();

    await expect(
      page.getByRole("listitem").filter({ hasText: "fresh-app" }),
    ).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __newProjectCalls?: unknown[] })
          .__newProjectCalls,
    )) as Array<{ parentPath: string; name: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      parentPath: "/tmp/parent",
      name: "fresh-app",
    });
  });

  test("Close project removes the project after confirming", async ({
    page,
    tauri,
  }) => {
    // Capture remove_project args; after invocation, swap list_projects to
    // return an empty list so the post-remove refreshAll empties the sidebar.
    await tauri.handle("list_projects", () => {
      const w = window as unknown as { __projectRemoved?: boolean };
      return w.__projectRemoved
        ? []
        : [
            {
              repo_path: "/tmp/demo",
              name: "demo",
              created_at: "2026-01-01T00:00:00Z",
              position: 0,
            },
          ];
    });
    await tauri.handle("remove_project", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __projectRemoved?: boolean;
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      w.__projectRemoved = true;
      return null;
    });

    await page.goto("/");

    await expect(
      page.getByRole("listitem").filter({ hasText: "demo" }),
    ).toBeVisible();

    // Hover the project header to reveal the (visually hidden) Close button,
    // then click it. This opens the RemoveProjectDialog.
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.hover();
    await page.getByRole("button", { name: "Close project" }).first().click();

    // RemoveProjectDialog renders a Modal without an explicit aria-label,
    // so we identify it by its heading. With no isolated worktrees the
    // primary action button is also labeled "Close project".
    const confirmDialog = page.getByRole("dialog");
    await expect(
      confirmDialog.getByRole("heading", { name: "Close project" }),
    ).toBeVisible();
    await confirmDialog
      .getByRole("button", { name: /^Close project$/ })
      .click();

    await expect(page.getByText(/No projects yet/i)).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ repoPath: string; removeWorktrees: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].repoPath).toBe("/tmp/demo");
    expect(calls[0].removeWorktrees).toBe(false);
  });

  test("multiple projects render in seeded order", async ({ page, tauri }) => {
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/alpha",
        name: "alpha",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
      {
        repo_path: "/tmp/beta",
        name: "beta",
        created_at: "2026-01-01T00:00:00Z",
        position: 1,
      },
    ]);

    await page.goto("/");

    // The project header is a div with role=button and accessible name
    // "Project <name>" composed by the inner controls.
    const projects = page.getByRole("button", { name: /^Project / });
    await expect(projects).toHaveCount(2);
    await expect(projects.first()).toHaveAccessibleName("Project alpha");
    await expect(projects.last()).toHaveAccessibleName("Project beta");
  });
});
