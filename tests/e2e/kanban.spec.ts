import { test, expect } from "./support";

const PROJECT = {
  repo_path: "/tmp/demo",
  name: "demo",
  created_at: "2026-01-01T00:00:00Z",
  position: 0,
};

function project(repoPath: string, name: string, position: number) {
  return {
    repo_path: repoPath,
    name,
    created_at: "2026-01-01T00:00:00Z",
    position,
  };
}

function session(
  id: string,
  name: string,
  status: "idle" | "running" | "needs_input" | "failed" | "completed",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    repo_path: "/tmp/demo",
    worktree_path: `/tmp/demo/.worktrees/${id}`,
    branch: `feat/${id}`,
    isolated: false,
    status,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:05Z",
    last_message: null,
    kind: "regular",
    owner: { kind: "user" },
    position: null,
    in_worktree: false,
    ...overrides,
  };
}

test.describe("workspace kanban mode", () => {
  test("groups active workspace sessions by status and opens a card in a popup", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("needs-review", "needs-review", "needs_input", {
        agent_provider: "claude",
      }),
      session("runner", "runner", "running", {
        agent_provider: "codex",
      }),
      session("alpha", "alpha", "idle", {
        updated_at: "2026-01-01T00:00:01Z",
      }),
      session("shell", "shell", "idle"),
      session("done", "done", "completed", {
        agent_provider: "antigravity",
      }),
      session("broken", "broken", "failed", {
        agent_provider: "codex",
      }),
    ]);

    await page.goto("/");

    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Panes",
    );
    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    await expect(board).toBeVisible();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    await expect(page.getByTestId("sidebar-kanban-workspace-row")).toHaveCount(
      0,
    );
    const createSessionButton = board.getByRole("button", {
      name: "Create session",
    });
    await expect(createSessionButton).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Reset sizes" }),
    ).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Equalize sizes" }),
    ).toBeVisible();
    await createSessionButton.click();
    await expect(
      page.getByRole("menuitem", { name: "New session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New worktree session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New chat session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(
      board.getByRole("heading", { name: "Needs input" }),
    ).toBeVisible();
    await expect(board.getByRole("heading", { name: "Failed" })).toBeVisible();
    await expect(board.getByRole("heading", { name: "Running" })).toBeVisible();
    await expect(board.getByRole("heading", { name: "Idle" })).toBeVisible();
    await expect(
      board.getByRole("heading", { name: "Completed" }),
    ).toBeVisible();
    await expect(
      board.locator("section > header h2"),
    ).toHaveText(["Idle", "Needs input", "Running", "Failed", "Completed"]);

    const filterInput = board.getByLabel("Filter sessions");
    await expect(filterInput).toBeVisible();
    await filterInput.fill("shell");
    await expect(
      board.getByRole("button", { name: "Open shell" }),
    ).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Open runner" }),
    ).toBeHidden();
    await filterInput.fill("");

    await board.getByLabel("Sort sessions").selectOption("name-asc");
    const idleCards = board.locator(
      'section[aria-label="Idle"] [data-testid="workspace-kanban-card"]',
    );
    await expect(idleCards).toHaveCount(2);
    await expect(idleCards.nth(0)).toHaveAttribute(
      "data-kanban-session-id",
      "alpha",
    );
    await expect(idleCards.nth(1)).toHaveAttribute(
      "data-kanban-session-id",
      "shell",
    );

    await expect(
      board.getByRole("button", { name: "Open needs-review" }),
    ).toBeVisible();
    await expect(
      board.getByRole("button", { name: "Open runner" }),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="needs-review"]')
        .locator('[data-kanban-agent-icon="claude"]'),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="broken"]')
        .locator('[data-kanban-agent-icon="codex"]'),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="runner"]')
        .locator('[data-kanban-agent-icon="codex"]'),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="shell"]')
        .locator('[data-kanban-session-icon="terminal"]'),
    ).toBeVisible();
    await expect(
      board
        .locator('[data-kanban-session-id="done"]')
        .locator('[data-kanban-agent-icon="antigravity"]'),
    ).toBeVisible();

    const shellCardWidths = await board
      .locator('[data-kanban-session-id="shell"]')
      .evaluate((button) => {
        const wrapper = button.parentElement;
        const list = wrapper?.parentElement;
        if (!wrapper || !list) {
          throw new Error("missing kanban card wrapper");
        }
        const listStyle = window.getComputedStyle(list);
        const listContentWidth =
          list.getBoundingClientRect().width -
          parseFloat(listStyle.paddingLeft) -
          parseFloat(listStyle.paddingRight);
        return {
          card: button.getBoundingClientRect().width,
          wrapper: wrapper.getBoundingClientRect().width,
          listContent: listContentWidth,
        };
      });
    expect(
      Math.abs(shellCardWidths.card - shellCardWidths.wrapper),
    ).toBeLessThan(1);
    expect(
      Math.abs(shellCardWidths.wrapper - shellCardWidths.listContent),
    ).toBeLessThan(1);

    const kanbanScroll = page.getByTestId("workspace-kanban-scroll");
    const kanbanColumnWidths = () =>
      board
        .locator("[data-kanban-column-status]")
        .evaluateAll((columns) =>
          columns.map((column) => column.getBoundingClientRect().width),
        );
    const idleColumn = board.locator('[data-kanban-column-status="idle"]');
    const needsInputColumn = board.locator(
      '[data-kanban-column-status="needs_input"]',
    );
    const idleResizeHandle = board
      .locator('[data-kanban-resize-status="idle"]');
    await expect(idleResizeHandle).toBeVisible();
    const [idleWidthBefore, needsInputWidthBefore, scrollWidthBefore] =
      await Promise.all([
        idleColumn.evaluate((column) => column.getBoundingClientRect().width),
        needsInputColumn.evaluate((column) =>
          column.getBoundingClientRect().width,
        ),
        kanbanScroll.evaluate((scroll) => scroll.scrollWidth),
      ]);
    const handleBox = await idleResizeHandle.boundingBox();
    expect(handleBox).not.toBeNull();
    if (!handleBox) throw new Error("missing kanban resize handle");
    await page.mouse.move(
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handleBox.x + handleBox.width / 2 + 360,
      handleBox.y + handleBox.height / 2,
    );
    await page.mouse.up();
    await expect
      .poll(async () =>
        idleColumn.evaluate((column) => column.getBoundingClientRect().width),
      )
      .toBeGreaterThan(idleWidthBefore + 300);
    const [idleWidthAfter, needsInputWidthAfter, scrollWidthAfter] =
      await Promise.all([
        idleColumn.evaluate((column) => column.getBoundingClientRect().width),
        needsInputColumn.evaluate((column) =>
          column.getBoundingClientRect().width,
        ),
        kanbanScroll.evaluate((scroll) => scroll.scrollWidth),
      ]);
    expect(
      Math.abs(needsInputWidthAfter - needsInputWidthBefore),
    ).toBeLessThan(1);
    expect(scrollWidthAfter).toBeGreaterThan(scrollWidthBefore + 40);

    await board.getByRole("button", { name: "Equalize sizes" }).click();
    await expect
      .poll(async () => {
        const widths = await kanbanColumnWidths();
        return Math.max(
          ...widths.map((width) => Math.abs(width - idleWidthAfter)),
        );
      })
      .toBeLessThan(1);

    await board.getByRole("button", { name: "Reset sizes" }).click();
    await expect
      .poll(async () => {
        const widths = await kanbanColumnWidths();
        return Math.max(...widths.map((width) => Math.abs(width - 192)));
      })
      .toBeLessThan(1);

    await board
      .getByRole("button", { name: "Open shell" })
      .click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Open shell" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Open Work Summary" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Reveal in Finder" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Remove Session" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await board.getByRole("button", { name: "Open broken" }).click();

    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    const dialog = page.getByRole("dialog", { name: "broken" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator('[data-popup-agent-icon="codex"]'),
    ).toBeVisible();
    await expect(page.getByTestId("terminal-popup-body")).toBeVisible();
    await expect(
      page
        .getByTestId("terminal-popup-body")
        .locator('[data-acorn-terminal-slot="broken"] .acorn-terminal-shell'),
    ).toBeVisible();
  });

  test("uses the configured default workspace mode on first project load", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          interface: { defaultWorkspaceViewMode: "kanban" },
        }),
      );
    });
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.respond("list_sessions", [
      session("default-kanban", "default-kanban", "idle"),
    ]);

    await page.goto("/");

    await expect(page.getByTestId("workspace-view-status")).toContainText(
      "Kanban",
    );
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
  });

  test("restores kanban or pane mode per project", async ({ page, tauri }) => {
    const alpha = project("/tmp/alpha", "alpha", 0);
    const beta = project("/tmp/beta", "beta", 1);
    await tauri.respond("list_projects", [alpha, beta]);
    await tauri.respond("list_sessions", [
      session("alpha-session", "alpha-session", "idle", {
        repo_path: "/tmp/alpha",
        worktree_path: "/tmp/alpha/.worktrees/alpha-session",
      }),
      session("beta-session", "beta-session", "idle", {
        repo_path: "/tmp/beta",
        worktree_path: "/tmp/beta/.worktrees/beta-session",
      }),
    ]);

    await page.goto("/");

    const modeSelect = page.getByTestId("workspace-view-status");
    await expect(modeSelect).toContainText("Panes");
    await modeSelect.click();
    await page.getByRole("option", { name: "Kanban" }).click();
    await expect(modeSelect).toContainText("Kanban");
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();

    await page.getByRole("button", { name: "Project beta" }).click();
    await expect(modeSelect).toContainText("Panes");
    await expect(page.getByTestId("workspace-kanban")).toHaveCount(0);

    await page.getByRole("button", { name: "Project alpha" }).click();
    await expect(modeSelect).toContainText("Kanban");
    await expect(page.getByTestId("workspace-kanban")).toBeVisible();
  });

  test("creates regular and worktree sessions from the kanban toolbar", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [PROJECT]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "seed",
          name: "seed",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "idle",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          mode: "terminal",
          owner: { kind: "user" },
          position: null,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = args as Record<string, unknown>;
      const w = window as unknown as {
        __createSessionCalls?: Array<Record<string, unknown>>;
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(input);
      const id = `created-${w.__createSessionCalls.length}`;
      const repoPath =
        typeof input.repoPath === "string" ? input.repoPath : "/tmp/demo";
      const cwdPath =
        typeof input.cwdPath === "string" ? input.cwdPath : repoPath;
      const isolated = input.isolated === true;
      const session = {
        id,
        name: typeof input.name === "string" ? input.name : id,
        repo_path: repoPath,
        worktree_path: isolated
          ? `${repoPath}/.worktrees/${id}`
          : cwdPath,
        branch: isolated ? `acorn/${id}` : "main",
        isolated,
        project_scoped: input.projectScoped !== false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: typeof input.kind === "string" ? input.kind : "regular",
        mode: typeof input.mode === "string" ? input.mode : "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: isolated,
      };
      w.__sessions = [...(w.__sessions ?? []), session];
      return session;
    });

    await page.goto("/");

    await page.getByTestId("workspace-view-status").click();
    await page.getByRole("option", { name: "Kanban" }).click();

    const board = page.getByTestId("workspace-kanban");
    const createSessionButton = board.getByRole("button", {
      name: "Create session",
    });
    await createSessionButton.click();
    await page.getByRole("menuitem", { name: "New session" }).click();
    await createSessionButton.click();
    await page.getByRole("menuitem", { name: "New worktree session" }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __createSessionCalls?: Array<Record<string, unknown>>;
              }
            ).__createSessionCalls?.length ?? 0,
        ),
      )
      .toBe(2);

    const calls = await page.evaluate(
      () =>
        (
          window as unknown as {
            __createSessionCalls?: Array<Record<string, unknown>>;
          }
        ).__createSessionCalls ?? [],
    );
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
    });
    expect(calls[1]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: true,
      kind: "regular",
    });
  });
});
