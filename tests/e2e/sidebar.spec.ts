import { test, expect, pressHotkey, seedSettingsLanguage } from "./support";

test.describe("sidebar: project lifecycle", () => {
  test("Korean mode localizes project chrome and empty state", async ({
    page,
  }) => {
    await seedSettingsLanguage(page, "ko");

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "프로젝트" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "새 프로젝트" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "기존 프로젝트 추가" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "클릭하면 프로젝트를 열 수 있습니다.",
      }),
    ).toBeVisible();
  });

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
    await expect(page.getByText(/Click to open a project/i)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Double-click to start a session." }),
    ).toBeVisible();
  });

  test("clicking the chats add button creates a local terminal session", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:path|resolve_directory", () => "/Users/tester");
    await tauri.handle("list_projects", () => []);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __localSessionCreated?: boolean };
      return w.__localSessionCreated
        ? [
            {
              id: "local-1",
              name: "terminal",
              repo_path: "/Users/tester",
              worktree_path: "/Users/tester",
              branch: "HEAD",
              isolated: false,
              project_scoped: false,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              last_message: null,
              kind: "regular",
              owner: { kind: "user" },
              position: null,
              in_worktree: false,
            },
          ]
        : [];
    });
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as {
        __localSessionCreated?: boolean;
        __createSessionCalls?: unknown[];
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      w.__localSessionCreated = true;
      return {
        id: "local-1",
        name: "terminal",
        repo_path: "/Users/tester",
        worktree_path: "/Users/tester",
        branch: "HEAD",
        isolated: false,
        project_scoped: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
    });

    await page.goto("/");
    const chats = page.getByRole("region", { name: "Local terminal sessions" });
    await chats.getByRole("button", { name: "New chat" }).click();

    await expect(page.getByText("Chats")).toBeVisible();
    await expect(
      chats.getByRole("button", { name: "terminal", exact: true }),
    ).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      name: string;
      repoPath: string;
      isolated: boolean;
      kind: string;
      projectScoped: boolean;
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "terminal",
      repoPath: "/Users/tester",
      isolated: false,
      kind: "regular",
      projectScoped: false,
    });
  });

  test("local chat sessions show agent provider icons", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("list_projects", () => []);
    await tauri.handle("list_sessions", () => [
      {
        id: "local-codex",
        name: "codex",
        repo_path: "/Users/tester",
        worktree_path: "/Users/tester",
        branch: "HEAD",
        isolated: false,
        project_scoped: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
        agent_provider: "codex",
      },
    ]);

    await page.goto("/");

    const chats = page.getByRole("region", { name: "Local terminal sessions" });
    await expect(chats.getByRole("img", { name: "Codex" })).toBeVisible();
    await expect(
      chats.getByRole("button", { name: /codex/i }),
    ).toBeVisible();
  });

  test("new-session hotkey preserves local chat scope", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("list_projects", () => []);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __hotkeyLocalCreated?: boolean };
      const sessions = [
        {
          id: "local-1",
          name: "terminal",
          repo_path: "/Users/tester",
          worktree_path: "/Users/tester",
          branch: "HEAD",
          isolated: false,
          project_scoped: false,
          status: "idle",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          kind: "regular",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
        },
      ];
      return w.__hotkeyLocalCreated
        ? [
            ...sessions,
            {
              ...sessions[0],
              id: "local-2",
              name: "terminal-2",
            },
          ]
        : sessions;
    });
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as {
        __hotkeyLocalCreated?: boolean;
        __createSessionCalls?: unknown[];
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      w.__hotkeyLocalCreated = true;
      return {
        id: "local-2",
        name: "terminal-2",
        repo_path: "/Users/tester",
        worktree_path: "/Users/tester",
        branch: "HEAD",
        isolated: false,
        project_scoped: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
    });

    await page.goto("/");
    await pressHotkey(page, { mod: true, key: "t" });

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      name: string;
      repoPath: string;
      projectScoped: boolean;
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "terminal-2",
      repoPath: "/Users/tester",
      projectScoped: false,
    });
  });

  test("clicking the chats area makes new-session hotkey create a chat", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:path|resolve_directory", () => "/Users/tester");
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/repo/app",
        name: "app",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => []);
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as { __createSessionCalls?: unknown[] };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      return {
        id: "local-1",
        name: "terminal",
        repo_path: "/Users/tester",
        worktree_path: "/Users/tester",
        branch: "HEAD",
        isolated: false,
        project_scoped: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      };
    });

    await page.goto("/");
    await page
      .getByRole("region", { name: "Local terminal sessions" })
      .click({ position: { x: 16, y: 48 } });
    await pressHotkey(page, { mod: true, key: "t" });

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      name: string;
      repoPath: string;
      projectScoped: boolean;
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "terminal",
      repoPath: "/Users/tester",
      projectScoped: false,
    });
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

  test("empty project state opens an existing project picker", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:dialog|open", () => "/tmp/empty-picked");
    await tauri.handle("list_projects", () => {
      const w = window as unknown as { __projectOpened?: boolean };
      return w.__projectOpened
        ? [
            {
              repo_path: "/tmp/empty-picked",
              name: "empty-picked",
              created_at: "2026-01-01T00:00:00Z",
              position: 0,
            },
          ]
        : [];
    });
    await tauri.handle("add_project", (args) => {
      const w = window as unknown as {
        __addProjectCalls?: unknown[];
        __projectOpened?: boolean;
      };
      w.__addProjectCalls = w.__addProjectCalls ?? [];
      w.__addProjectCalls.push(args);
      w.__projectOpened = true;
      return {
        repo_path: "/tmp/empty-picked",
        name: "empty-picked",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      };
    });

    await page.goto("/");
    await page
      .getByRole("button", {
        name: "Click to open a project.",
      })
      .click();

    await expect(
      page.getByRole("listitem").filter({ hasText: "empty-picked" }),
    ).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __addProjectCalls?: unknown[] })
          .__addProjectCalls,
    )) as Array<{ repoPath: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].repoPath).toBe("/tmp/empty-picked");
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
      ignoreSafeName: false,
    });
  });

  test("New project can override long-name safe warnings", async ({
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
              repo_path: `/tmp/parent/${"a".repeat(256)}`,
              name: "a".repeat(256),
              created_at: "2026-01-01T00:00:00Z",
              position: 0,
            },
          ]
        : [];
    });

    await page.goto("/");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("a".repeat(256));
    await page.getByRole("button", { name: "Choose" }).click();

    await expect(page.getByRole("alert")).toContainText(
      "longer than 255 bytes",
    );
    await expect(
      page.getByRole("button", { name: "Create project" }),
    ).toBeDisabled();

    await page.getByLabel("Ignore safe-name check").check();
    await page.getByRole("button", { name: "Create project" }).click();

    await expect(
      page.getByRole("listitem").filter({ hasText: "a".repeat(256) }),
    ).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __newProjectCalls?: unknown[] })
          .__newProjectCalls,
    )) as Array<{ parentPath: string; name: string; ignoreSafeName: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      parentPath: "/tmp/parent",
      name: "a".repeat(256),
      ignoreSafeName: true,
    });
  });

  test("Close project skips the confirmation modal when the project has no sessions", async ({
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
    // then click it. With no sessions there should be no confirmation dialog.
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.hover();
    await page.getByRole("button", { name: "Close project" }).first().click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(/Click to open a project/i)).toBeVisible();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ repoPath: string; removeWorktrees: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].repoPath).toBe("/tmp/demo");
    expect(calls[0].removeWorktrees).toBe(false);
  });

  test("Close project still shows the confirmation modal when sessions exist", async ({
    page,
    tauri,
  }) => {
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __projectRemoved?: boolean };
      return w.__projectRemoved
        ? []
        : [
            {
              id: "sess-1",
              name: "work",
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

    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.hover();
    await page.getByRole("button", { name: "Close project" }).first().click();

    const confirmDialog = page.getByRole("dialog");
    await expect(
      confirmDialog.getByRole("heading", { name: "Close project" }),
    ).toBeVisible();
    await confirmDialog
      .getByRole("button", { name: /^Close project$/ })
      .click();

    await expect(page.getByText(/Click to open a project/i)).toBeVisible();

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
