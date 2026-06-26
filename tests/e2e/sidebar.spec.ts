import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, pressHotkey, seedSettingsLanguage } from "./support";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function dragBetween(
  page: Page,
  source: Locator,
  target: Locator,
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("drag source or target is not visible");
  }
  await page.mouse.move(
    sourceBox.x + Math.min(60, sourceBox.width / 2),
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + Math.min(84, sourceBox.width - 2),
    sourceBox.y + sourceBox.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
}

async function clickMoveToTarget(
  page: Page,
  targetName: string,
): Promise<void> {
  await page
    .getByRole("menuitem", { name: "Move to", exact: true })
    .hover();
  await page
    .getByRole("menuitem", { name: targetName, exact: true })
    .click();
}

async function expectMoveToTarget(
  page: Page,
  targetName: string,
): Promise<void> {
  await page
    .getByRole("menuitem", { name: "Move to", exact: true })
    .hover();
  await expect(
    page.getByRole("menuitem", { name: targetName, exact: true }),
  ).toBeVisible();
}

async function expectNoMoveToTarget(
  page: Page,
  targetName: string,
): Promise<void> {
  const moveTo = page.getByRole("menuitem", {
    name: "Move to",
    exact: true,
  });
  if ((await moveTo.count()) > 0) {
    await moveTo.hover();
  }
  await expect(
    page.getByRole("menuitem", { name: targetName, exact: true }),
  ).toHaveCount(0);
}

async function expectRootWorkspaceMetadataHidden(row: Locator) {
  await expect(row).not.toContainText("repo root");
  await expect(row).not.toContainText(/\b\d+\s+sessions?\b/);
}

async function expectWorkspacePathOnly(row: Locator, label: string | RegExp) {
  await expect(row).toContainText(label);
  await expect(row).not.toContainText(/\b\d+\s+sessions?\b/);
}

function createLinkedWorktreeFixture(): {
  root: string;
  repo: string;
  alpha: string;
  beta: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "acorn-title-worktrees-"));
  const repo = join(root, "repo");
  const alpha = join(root, "wt-alpha");
  const beta = join(root, "wt-beta");
  mkdirSync(repo, { recursive: true });
  git(["init"], repo);
  git(["config", "user.email", "acorn-test@example.com"], repo);
  git(["config", "user.name", "Acorn Test"], repo);
  writeFileSync(join(repo, "README.md"), "# worktree title test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial"], repo);
  git(["worktree", "add", "-b", "feature/alpha", alpha], repo);
  git(["worktree", "add", "-b", "feature/beta", beta], repo);

  const realRepo = realpathSync(repo);
  const realAlpha = realpathSync(alpha);
  const realBeta = realpathSync(beta);
  const list = git(["worktree", "list", "--porcelain"], repo);
  expect(list).toContain(`worktree ${realAlpha}`);
  expect(list).toContain(`worktree ${realBeta}`);

  return {
    root,
    repo: realRepo,
    alpha: realAlpha,
    beta: realBeta,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test.describe("sidebar: project lifecycle", () => {
  test("session context menu can regenerate a session name", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: unknown[];
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "session-1",
          name: "demo-session",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "needs_input",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
          agent_provider: "codex",
          agent_transcript_id: "codex-1",
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("generate_session_title", (args) => {
      const w = window as unknown as {
        __generateTitleCalls?: unknown[];
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__generateTitleCalls = w.__generateTitleCalls ?? [];
      w.__generateTitleCalls.push(args);
      const updated = {
        id: "session-1",
        name: "fresh-title",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "needs_input",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "generated",
        generated_title_transcript_id: "codex-1",
        kind: "regular",
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
        agent_provider: "codex",
        agent_transcript_id: "codex-1",
      };
      w.__sessions = [updated];
      return { status: "generated", session: updated };
    });

    await page.goto("/");

    await page.locator("aside").getByRole("button", { name: /demo-session/ }).click({
      button: "right",
    });
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("Session");
    await expect(menu).toContainText("Open");
    await expect(menu).toContainText("Copy");
    await expect(menu).toContainText("Danger");
    await expect(menu).not.toContainText("Equalize Pane Sizes");
    await expect(menu).not.toContainText("Duplicate Session");
    await expect(menu).not.toContainText("Remove Others in Project");
    await expect(menu).not.toContainText("Remove All in Project");
    await expect(
      page.getByRole("menuitem", { name: "Remove Session", exact: true }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Regenerate Name" }).click();

    await expect(
      page.locator("aside").getByRole("button", { name: /fresh-title/ }),
    ).toBeVisible();
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __generateTitleCalls?: unknown[] })
          .__generateTitleCalls,
    )) as Array<{ id: string; force: boolean; ai: { provider: string } }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "session-1",
      force: true,
      ai: { provider: "claude" },
    });
  });

  test("tab context menu can regenerate a session name", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: unknown[];
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "session-1",
          name: "demo-session",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "needs_input",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
          agent_provider: "codex",
          agent_transcript_id: "codex-1",
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("generate_session_title", (args) => {
      const w = window as unknown as {
        __generateTitleCalls?: unknown[];
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__generateTitleCalls = w.__generateTitleCalls ?? [];
      w.__generateTitleCalls.push(args);
      const updated = {
        id: "session-1",
        name: "tab-title",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "needs_input",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "generated",
        generated_title_transcript_id: "codex-1",
        kind: "regular",
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
        agent_provider: "codex",
        agent_transcript_id: "codex-1",
      };
      w.__sessions = [updated];
      return { status: "generated", session: updated };
    });

    await page.goto("/");

    await page.locator('[data-tab-drag-handle="session-1"]').click({
      button: "right",
    });
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("Session");
    await expect(menu).toContainText("Layout");
    await expect(menu).toContainText("Open");
    await expect(menu).toContainText("Copy");
    await expect(menu).toContainText("Close");
    await expect(menu).not.toContainText("Duplicate Session");
    await page.getByRole("menuitem", { name: "Regenerate Name" }).click();

    await expect(page.locator('[data-tab-drag-handle="session-1"]')).toContainText(
      "tab-title",
    );
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __generateTitleCalls?: unknown[] })
          .__generateTitleCalls,
    )) as Array<{ id: string; force: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: "session-1", force: true });
  });

  test("ordinary terminal sessions cannot regenerate a session name", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "session-1",
        name: "plain-terminal",
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
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
        agent_provider: null,
        agent_transcript_id: null,
      },
    ]);
    await tauri.handle("generate_session_title", (args) => {
      const w = window as unknown as { __generateTitleCalls?: unknown[] };
      w.__generateTitleCalls = w.__generateTitleCalls ?? [];
      w.__generateTitleCalls.push(args);
      return { status: "skipped", session: null };
    });

    await page.goto("/");

    await page
      .locator("aside")
      .getByRole("button", { name: /plain-terminal/ })
      .click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Regenerate Name" }),
    ).toBeDisabled();
    await expect(
      page.locator('[data-tab-drag-handle="session-1"]'),
    ).toContainText("plain-terminal");
    const calls = await page.evaluate(
      () =>
        (window as unknown as { __generateTitleCalls?: unknown[] })
          .__generateTitleCalls ?? [],
    );
    expect(calls).toHaveLength(0);
  });

  test("session hover details render as icon rows", async ({ page, tauri }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "session-1",
        name: "detail-session",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/detail-session",
        branch: "feature/readable-tooltip",
        isolated: true,
        project_scoped: true,
        status: "needs_input",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: "control",
        mode: "terminal",
        owner: { kind: "user" },
        position: 0,
        in_worktree: true,
        agent_provider: null,
        agent_transcript_id: null,
      },
    ]);

    await page.goto("/");

    await page
      .locator("aside")
      .getByRole("button", { name: /detail-session/ })
      .hover();

    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Name");
    await expect(tooltip).toContainText("detail-session");
    await expect(tooltip).toContainText("Branch");
    await expect(tooltip).toContainText("feature/readable-tooltip");
    await expect(tooltip).toContainText("Working directory");
    await expect(tooltip).toContainText(
      "/tmp/demo/.acorn/worktrees/detail-session",
    );
    await expect(tooltip).toContainText("Status");
    await expect(tooltip).toContainText("Needs input");
    await expect(tooltip).toContainText("Kind");
    await expect(tooltip).toContainText("Control session");
    await expect(tooltip).toContainText("Isolated worktree");
    await expect(tooltip.locator("svg")).toHaveCount(6);
  });

  test("clears agent provider icon after the agent process exits", async ({
    page,
    tauri,
  }) => {
    await tauri.respond("list_projects", [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "session-1",
        name: "codex",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "needs_input",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: "regular",
        mode: "terminal",
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
        agent_provider: "codex",
        agent_transcript_id: "codex-1",
      },
    ]);
    await tauri.handle("detect_session_statuses", () => [
      {
        id: "session-1",
        status: "idle",
        branch: null,
        agent_provider: null,
        agent_transcript_id: "codex-1",
      },
    ]);

    await page.goto("/");

    await expect(page.locator("aside").getByRole("img", { name: "Codex" }))
      .toHaveCount(0);
    await expect(
      page.locator("aside").getByRole("button", { name: /codex/ }),
    ).toBeVisible();
  });

  test("regenerates a name for sessions backed by real git worktrees", async ({
    page,
    tauri,
  }) => {
    const fixture = createLinkedWorktreeFixture();
    const alphaSession = {
      id: "wt-alpha",
      name: "alpha-session",
      repo_path: fixture.repo,
      worktree_path: fixture.alpha,
      branch: "feature/alpha",
      isolated: true,
      project_scoped: true,
      status: "needs_input",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message: null,
      title_source: "manual",
      kind: "regular",
      owner: { kind: "user" },
      position: 0,
      in_worktree: true,
      agent_provider: "codex",
      agent_transcript_id: "codex-alpha",
    };
    try {
      await tauri.respond("list_projects", [
        {
          repo_path: fixture.repo,
          name: "repo",
          created_at: "2026-01-01T00:00:00Z",
          position: 0,
        },
      ]);
      await tauri.respond("list_sessions", [
        alphaSession,
        {
          id: "wt-beta",
          name: "beta-session",
          repo_path: fixture.repo,
          worktree_path: fixture.beta,
          branch: "feature/beta",
          isolated: true,
          project_scoped: true,
          status: "needs_input",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          owner: { kind: "user" },
          position: 1,
          in_worktree: true,
          agent_provider: "codex",
          agent_transcript_id: "codex-beta",
        },
      ]);
      await tauri.respond("generate_session_title", {
        status: "generated",
        session: {
          ...alphaSession,
          name: "linked-worktree-title",
          title_source: "generated",
          generated_title_transcript_id: "codex-alpha",
        },
      });

      await page.goto("/");

      await expect(
        page.locator("aside").getByRole("button", { name: /alpha-session/ }),
      ).toBeVisible();
      await expect(
        page.locator("aside").getByRole("button", { name: /beta-session/ }),
      ).toBeVisible();

      await page
        .locator("aside")
        .getByRole("button", { name: /alpha-session/ })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Regenerate Name" }).click();

      await expect(
        page
          .locator("aside")
          .getByRole("button", { name: /linked-worktree-title/ }),
      ).toBeVisible();
      await expect(page.locator('[data-tab-drag-handle="wt-alpha"]')).toContainText(
        "linked-worktree-title",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("Korean mode localizes project chrome and empty state", async ({
    page,
  }) => {
    test.slow();
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
    await expect(
      page.getByRole("button", { name: "Project demo" }),
    ).toHaveText("demo");
    await expect(page.getByText(/Click to open a project/i)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Double-click to start a session." }),
    ).toBeVisible();
  });

  test("project workspaces can be named and group sessions conceptually", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessions?: unknown[] };
      w.__sessions = w.__sessions ?? [
        {
          id: "root-session",
          name: "root",
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
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as {
        __createSessionCalls?: unknown[];
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      const session = {
        id: "web-session",
        name: "web",
        repo_path: "/tmp/demo",
        worktree_path: args?.cwdPath ?? args?.repoPath ?? "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "manual",
        kind: "regular",
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
      };
      w.__sessions = [...(w.__sessions ?? []), session];
      return session;
    });

    await page.goto("/");

    await page
      .getByRole("button", { name: "Project demo" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();

    const folderRow = page
      .locator("aside [data-sidebar-workspace-id]")
      .first();
    await expect(folderRow).toBeVisible();
    await expectRootWorkspaceMetadataHidden(folderRow);
    await folderRow.dblclick();
    const input = page.locator("aside").getByRole("textbox");
    await expect(input).toBeVisible();
    await expect
      .poll(async () => {
        const rowBox = await folderRow.boundingBox();
        const inputBox = await input.boundingBox();
        if (!rowBox || !inputBox) return "missing";
        return inputBox.x + inputBox.width <= rowBox.x + rowBox.width + 1
          ? "contained"
          : "overflowing";
      })
      .toBe("contained");
    await input.fill("Frontend");
    await input.press("Enter");
    await expect(
      page.locator("aside").getByRole("button", { name: /Frontend/ }),
    ).toBeVisible();
    await expect(
      page.locator("aside").getByRole("button", { name: /root main · Idle/ }),
    ).toBeVisible();
    await expect(
      page.locator("aside").getByRole("button", { name: /^Default\b/ }),
    ).toHaveCount(0);

    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await clickMoveToTarget(page, "Frontend");
    const frontendFolder = page
      .locator("aside")
      .getByRole("button", { name: /Frontend/ })
      .first();
    await expect(frontendFolder).toBeVisible();
    await expectRootWorkspaceMetadataHidden(frontendFolder);
    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await expectMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    await frontendFolder.hover();
    await expect(
      page.getByRole("button", { name: "New session in this project" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create session in this project" }),
    ).toHaveCount(0);

    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click();
    await page.getByRole("button", { name: "Project demo" }).hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();
    await expect(
      page.locator("aside").getByRole("button", { name: /web main · Idle/ }),
    ).toBeVisible();
    await page
      .locator("aside")
      .getByRole("button", { name: /web main · Idle/ })
      .click({ button: "right" });
    await expectNoMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await clickMoveToTarget(page, "Project root");
    await expect(frontendFolder).toBeVisible();
    await expectRootWorkspaceMetadataHidden(frontendFolder);
    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await expectNoMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{ repoPath: string; projectScoped?: boolean }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
    });
  });

  test("project workspace context menu can create sessions in that workspace", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessions?: unknown[] };
      w.__sessions = w.__sessions ?? [];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = (args ?? {}) as {
        name?: string;
        repoPath?: string;
        isolated?: boolean;
        kind?: string;
        mode?: string;
        projectScoped?: boolean;
        cwdPath?: string;
      };
      const w = window as unknown as {
        __createSessionCalls?: unknown[];
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__sessions = w.__sessions ?? [];
      w.__createSessionCalls.push(args);
      const id = `created-${w.__sessions.length + 1}`;
      const created = {
        id,
        name: input.name ?? id,
        repo_path: "/tmp/demo",
        worktree_path: input.cwdPath ?? input.repoPath ?? "/tmp/demo",
        branch: "main",
        isolated: Boolean(input.isolated),
        project_scoped: input.projectScoped ?? true,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "default",
        kind: input.kind ?? "regular",
        mode: input.mode ?? "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: Boolean(input.isolated),
      };
      w.__sessions.push(created);
      return created;
    });

    await page.goto("/");

    await page
      .getByRole("button", { name: "Project demo" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const folderRow = page
      .locator("aside")
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await expect(folderRow).toBeVisible();

    await folderRow.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "New session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "New worktree session",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New chat session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("menu")).toContainText("Session");
    await page
      .getByRole("menuitem", { name: "New chat session", exact: true })
      .click();

    const createdRow = page
      .locator("aside")
      .getByRole("button", { name: /^demo main · Idle/ })
      .first();
    await expect(createdRow).toBeVisible();
    await expectRootWorkspaceMetadataHidden(folderRow);
    await createdRow.click({ button: "right" });
    await expectMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    await folderRow.hover();
    const newSessionButton = folderRow.getByRole("button", {
      name: "New session in this workspace",
    });
    await expect(newSessionButton).toBeVisible();
    await newSessionButton.hover();
    await expect(
      page.getByRole("tooltip", { name: "New session in this workspace" }),
    ).toBeVisible();
    await newSessionButton.click();

    const createdFromButtonRow = page
      .locator("aside")
      .getByRole("button", { name: /^demo-2 main · Idle/ })
      .first();
    await expect(createdFromButtonRow).toBeVisible();
    await expectRootWorkspaceMetadataHidden(folderRow);
    await createdFromButtonRow.click({ button: "right" });
    await expectMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    await folderRow.hover();
    const createMenuButton = folderRow.getByRole("button", {
      name: "Create session in this workspace",
    });
    await expect(createMenuButton).toBeVisible();
    await createMenuButton.hover();
    await expect(
      page.getByRole("tooltip", { name: "Create session in this workspace" }),
    ).toBeVisible();
    await createMenuButton.click();
    await expect(
      page.getByRole("menuitem", {
        name: "New worktree session",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New chat session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", {
        name: "New worktree session",
        exact: true,
      })
      .click();

    const createdFromMenuRow = page
      .locator("aside")
      .getByRole("button", {
        name: /^demo-worktree-[a-f0-9]{12} worktree main · Idle/,
      })
      .first();
    await expect(createdFromMenuRow).toBeVisible();
    await expectRootWorkspaceMetadataHidden(folderRow);
    await createdFromMenuRow.click({ button: "right" });
    await expectMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      repoPath: string;
      isolated: boolean;
      kind: string;
      mode?: string;
    }>;
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
      mode: "chat",
    });
    expect(calls[1]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
    });
    expect(calls[1].mode ?? "terminal").toBe("terminal");
    expect(calls[2]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: true,
      kind: "regular",
    });
    expect(calls[2].mode ?? "terminal").toBe("terminal");
  });

  test("project workspace remove asks before removing sessions in the workspace", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
        __removedIds?: string[];
      };
      w.__sessions = w.__sessions ?? [
        {
          id: "root-session",
          name: "root",
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
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
        },
        {
          id: "child-session",
          name: "child",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "idle",
          created_at: "2026-01-01T00:00:01Z",
          updated_at: "2026-01-01T00:00:01Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          owner: { kind: "user" },
          position: 1,
          in_worktree: false,
        },
      ];
      const removed = new Set(w.__removedIds ?? []);
      return w.__sessions.filter(
        (session) => !removed.has(String(session.id)),
      );
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __removedIds?: string[];
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      const id = String(args?.id ?? "");
      w.__removedIds = Array.from(new Set([...(w.__removedIds ?? []), id]));
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator("aside");
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const folderRow = sidebar
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await folderRow.dblclick();
    await sidebar.getByRole("textbox").fill("Frontend");
    await sidebar.getByRole("textbox").press("Enter");

    const frontend = sidebar.getByRole("button", { name: /Frontend/ }).first();
    const root = sidebar
      .getByRole("button", { name: /^root main · Idle/ })
      .first();
    const child = sidebar
      .getByRole("button", { name: /^child main · Idle/ })
      .first();
    await child.click({ button: "right" });
    await clickMoveToTarget(page, "Frontend");

    await frontend.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove workspace" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1 session");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(frontend).toBeVisible();
    await expect(child).toBeVisible();

    await frontend.hover();
    const removeFolderButton = frontend.getByRole("button", {
      name: "Remove workspace",
    });
    await expect(removeFolderButton).toBeVisible();
    await removeFolderButton.hover();
    await expect(
      page.getByRole("tooltip", { name: "Remove workspace" }),
    ).toBeVisible();
    await removeFolderButton.click();
    const removeDialog = page.getByRole("dialog", { name: "Remove workspace" });
    await expect(
      removeDialog.getByRole("button", { name: "Move sessions out" }),
    ).toHaveCount(0);
    await removeDialog
      .getByRole("button", { name: "Remove with sessions" })
      .click();

    await expect(child).toHaveCount(0);
    await expect(frontend).toHaveCount(0);
    await expect(root).toBeVisible();

    const calls = (await page.evaluate(
      () => (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toEqual([{ id: "child-session", removeWorktree: false }]);
  });

  test("project workspace remove preserves shared worktrees despite auto-delete setting", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: true,
            confirmDeleteIsolatedWorktrees: false,
            showRestartPromptOnExit: true,
          },
        }),
      );
      localStorage.setItem(
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
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/demo",
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __removedIds?: string[] };
      const removed = new Set(w.__removedIds ?? []);
      return removed.has("worktree-session")
        ? []
        : [
            {
              id: "worktree-session",
              name: "alpha",
              repo_path: "/tmp/demo",
              worktree_path: "/tmp/demo/.acorn/worktrees/feature",
              branch: "main",
              isolated: true,
              project_scoped: true,
              status: "idle",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              last_message: null,
              title_source: "manual",
              kind: "regular",
              owner: { kind: "user" },
              position: 0,
              in_worktree: true,
            },
          ];
    });
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as {
        __removeCalls?: unknown[];
        __removedIds?: string[];
      };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      const id = String(args?.id ?? "");
      w.__removedIds = Array.from(new Set([...(w.__removedIds ?? []), id]));
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator("aside");
    const workspace = sidebar
      .getByRole("button", { name: /Feature workspace/ })
      .first();
    await expect(workspace).toBeVisible();

    await workspace.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove workspace" });
    await expect(dialog).toContainText(
      "Worktree workspace sessions will be removed from Acorn only.",
    );
    await expect(dialog).toContainText(
      "The workspace worktree will be kept on disk.",
    );
    await dialog.getByRole("button", { name: "Remove with sessions" }).click();

    const calls = (await page.evaluate(
      () => (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toEqual([
      { id: "worktree-session", removeWorktree: false },
    ]);
  });

  test("project workspace remove skips confirmation for empty workspaces", async ({
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

    const sidebar = page.locator("aside");
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace" }).click();

    const folderRows = sidebar
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" });
    await expect(folderRows).toHaveCount(1);
    await folderRows.first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove workspace" }).click();

    await expect(
      page.getByRole("dialog", { name: "Remove workspace" }),
    ).toHaveCount(0);
    await expect(folderRows).toHaveCount(0);
    await expect(projectRow).toBeVisible();
  });

  test("project workspace remove asks before deleting an empty worktree workspace worktree", async ({
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
    await tauri.handle("remove_worktree", (args) => {
      const w = window as unknown as { __removeWorktreeCalls?: unknown[] };
      w.__removeWorktreeCalls = w.__removeWorktreeCalls ?? [];
      w.__removeWorktreeCalls.push(args);
      return null;
    });
    await page.addInitScript(() => {
      localStorage.setItem(
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
                  id: "project-folder:/tmp/demo:feature-empty",
                  repoPath: "/tmp/demo",
                  name: "feature-empty",
                  cwdPath: "/tmp/demo/.acorn/worktrees/feature-empty",
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

    await page.goto("/");

    const sidebar = page.locator("aside");
    const folderRow = sidebar
      .getByRole("button", { name: /feature-empty/ })
      .first();
    await expect(folderRow).toBeVisible();

    await folderRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove workspace" }).click();

    const dialog = page.getByRole("dialog", { name: "Remove workspace" });
    await expect(dialog).toContainText("This workspace has no sessions.");
    await expect(dialog).toContainText(
      "/tmp/demo/.acorn/worktrees/feature-empty",
    );
    await expect(dialog).toContainText("Also delete this worktree from disk?");
    const remember = dialog.getByRole("checkbox", {
      name: "Ask before deleting empty worktree workspace directories",
    });
    await expect(remember).toBeChecked();
    await remember.uncheck();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          JSON.parse(localStorage.getItem("acorn:settings:v1") ?? "{}")
            .sessions?.confirmDeleteEmptyWorktreeWorkspaces,
        ),
      )
      .toBe(false);
    await dialog.getByRole("button", { name: "Delete worktree" }).click();

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeWorktreeCalls?: unknown[] })
          .__removeWorktreeCalls,
    )) as Array<{ repoPath: string; worktreePath: string }>;
    expect(calls).toEqual([
      {
        repoPath: "/tmp/demo",
        worktreePath: "/tmp/demo/.acorn/worktrees/feature-empty",
      },
    ]);
    await expect(folderRow).toHaveCount(0);
  });

  test("project workspace worktree removal toast restores the worktree", async ({
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
    await tauri.respond("remove_worktree", {
      token: "undo-token",
      repoPath: "/tmp/demo",
      worktreePath: "/tmp/demo/.acorn/worktrees/feature-empty",
      gitCommonDir: "/tmp/demo/.git",
    });
    await tauri.handle("restore_removed_worktree", (args) => {
      const w = window as unknown as { __restoreWorktreeCalls?: unknown[] };
      w.__restoreWorktreeCalls = w.__restoreWorktreeCalls ?? [];
      w.__restoreWorktreeCalls.push(args);
      return null;
    });
    await tauri.handle("discard_removed_worktree", (args) => {
      const w = window as unknown as { __discardWorktreeCalls?: unknown[] };
      w.__discardWorktreeCalls = w.__discardWorktreeCalls ?? [];
      w.__discardWorktreeCalls.push(args);
      return null;
    });
    await page.addInitScript(() => {
      localStorage.setItem(
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
                  id: "project-folder:/tmp/demo:feature-empty",
                  repoPath: "/tmp/demo",
                  name: "feature-empty",
                  cwdPath: "/tmp/demo/.acorn/worktrees/feature-empty",
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

    await page.goto("/");

    const sidebar = page.locator("aside");
    const folderRow = sidebar
      .getByRole("button", { name: /feature-empty/ })
      .first();
    await expect(folderRow).toBeVisible();

    await folderRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove workspace" }).click();
    await page
      .getByRole("dialog", { name: "Remove workspace" })
      .getByRole("button", { name: "Delete worktree" })
      .click();

    await expect(folderRow).toHaveCount(0);
    await page
      .getByText(/Removing feature-empty worktree in \d+s\. Undo/)
      .click();

    await expect(
      sidebar.getByRole("button", { name: /feature-empty/ }).first(),
    ).toBeVisible();
    const restoreCalls = (await page.evaluate(
      () =>
        (window as unknown as { __restoreWorktreeCalls?: unknown[] })
          .__restoreWorktreeCalls,
    )) as Array<{
      token: string;
      repoPath: string;
      worktreePath: string;
      gitCommonDir: string;
    }>;
    expect(restoreCalls).toEqual([
      {
        token: "undo-token",
        repoPath: "/tmp/demo",
        worktreePath: "/tmp/demo/.acorn/worktrees/feature-empty",
        gitCommonDir: "/tmp/demo/.git",
      },
    ]);
    const discardCalls = await page.evaluate(
      () =>
        (window as unknown as { __discardWorktreeCalls?: unknown[] })
          .__discardWorktreeCalls,
    );
    expect(discardCalls).toBeUndefined();
  });

  test("project workspace remove can auto-delete empty worktree workspaces", async ({
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
    await tauri.handle("remove_worktree", (args) => {
      const w = window as unknown as { __removeWorktreeCalls?: unknown[] };
      w.__removeWorktreeCalls = w.__removeWorktreeCalls ?? [];
      w.__removeWorktreeCalls.push(args);
      return null;
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          sessions: {
            confirmRemove: true,
            confirmDeleteIsolatedWorktrees: true,
            confirmDeleteEmptyWorktreeWorkspaces: false,
            showRestartPromptOnExit: true,
          },
        }),
      );
      localStorage.setItem(
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
                  id: "project-folder:/tmp/demo:feature-empty",
                  repoPath: "/tmp/demo",
                  name: "feature-empty",
                  cwdPath: "/tmp/demo/.acorn/worktrees/feature-empty",
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

    await page.goto("/");

    const sidebar = page.locator("aside");
    const folderRow = sidebar
      .getByRole("button", { name: /feature-empty/ })
      .first();
    await expect(folderRow).toBeVisible();

    await folderRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove workspace" }).click();

    await expect(
      page.getByRole("dialog", { name: "Remove workspace" }),
    ).toHaveCount(0);
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __removeWorktreeCalls?: unknown[] })
          .__removeWorktreeCalls,
    )) as Array<{ repoPath: string; worktreePath: string }>;
    expect(calls).toEqual([
      {
        repoPath: "/tmp/demo",
        worktreePath: "/tmp/demo/.acorn/worktrees/feature-empty",
      },
    ]);
    await expect(folderRow).toHaveCount(0);
  });

  test("project workspaces and sessions can move by drag and drop", async ({
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
    await tauri.handle("list_sessions", () => [
      {
        id: "root-session",
        name: "root",
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
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
      },
    ]);

    await page.goto("/");

    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const firstFolder = page
      .locator("aside")
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await firstFolder.dblclick();
    await page.locator("aside").getByRole("textbox").fill("Frontend");
    await page.locator("aside").getByRole("textbox").press("Enter");

    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const secondFolder = page
      .locator("aside")
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await secondFolder.dblclick();
    await page.locator("aside").getByRole("textbox").fill("Backend");
    await page.locator("aside").getByRole("textbox").press("Enter");

    const frontend = page.locator("aside").getByRole("button", {
      name: /Frontend/,
    });
    const backend = page.locator("aside").getByRole("button", {
      name: /Backend/,
    });
    const rootSession = page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ });
    await dragBetween(page, frontend, backend);
    await expect.poll(async () => {
      const frontendBox = await frontend.boundingBox();
      const backendBox = await backend.boundingBox();
      if (!frontendBox || !backendBox) return "missing";
      return frontendBox.y > backendBox.y ? "moved" : "not-moved";
    }).toBe("moved");

    await dragBetween(page, backend, rootSession);
    await expect.poll(async () => {
      const backendBox = await backend.boundingBox();
      const rootBox = await rootSession.boundingBox();
      const frontendBox = await frontend.boundingBox();
      if (!backendBox || !rootBox || !frontendBox) return "missing";
      return backendBox.y < rootBox.y && rootBox.y < frontendBox.y
        ? "interleaved"
        : "not-interleaved";
    }).toBe("interleaved");

    await dragBetween(page, frontend, rootSession);
    await expect.poll(async () => {
      const backendBox = await backend.boundingBox();
      const frontendBox = await frontend.boundingBox();
      const rootBox = await rootSession.boundingBox();
      if (!backendBox || !frontendBox || !rootBox) return "missing";
      return backendBox.y < frontendBox.y && frontendBox.y < rootBox.y
        ? "folders-first"
        : "not-folders-first";
    }).toBe("folders-first");

    await dragBetween(page, rootSession, frontend);
    await expect(frontend).toBeVisible();
    await rootSession.click({ button: "right" });
    await expectMoveToTarget(page, "Project root");
  });

  test("project workspace sessions can be reordered by drag and drop", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessions?: unknown[] };
      w.__sessions = w.__sessions ?? [
        {
          id: "alpha-session",
          name: "alpha",
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
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
        },
        {
          id: "beta-session",
          name: "beta",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "idle",
          created_at: "2026-01-01T00:00:01Z",
          updated_at: "2026-01-01T00:00:01Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          owner: { kind: "user" },
          position: 1,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("reorder_sessions", (args) => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
        __reorderSessionCalls?: unknown[];
      };
      w.__reorderSessionCalls = w.__reorderSessionCalls ?? [];
      w.__reorderSessionCalls.push(args);
      const order = Array.isArray(args?.order) ? args.order : [];
      const indexById = new Map(order.map((id, index) => [id, index]));
      w.__sessions = (w.__sessions ?? []).map((session) => {
        const position = indexById.get(session.id);
        return typeof position === "number" ? { ...session, position } : session;
      });
      return w.__sessions;
    });

    await page.goto("/");

    const sidebar = page.locator("aside");
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const folderRow = sidebar
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await folderRow.dblclick();
    await sidebar.getByRole("textbox").fill("Frontend");
    await sidebar.getByRole("textbox").press("Enter");
    const frontend = sidebar.getByRole("button", { name: /Frontend/ }).first();

    const alpha = sidebar
      .getByRole("button", { name: /^alpha main · Idle/ })
      .first();
    const beta = sidebar
      .getByRole("button", { name: /^beta main · Idle/ })
      .first();
    await dragBetween(page, alpha, frontend);
    await dragBetween(page, beta, frontend);

    await dragBetween(page, beta, alpha);

    await expect
      .poll(async () => {
        const alphaBox = await alpha.boundingBox();
        const betaBox = await beta.boundingBox();
        if (!alphaBox || !betaBox) return "missing";
        return betaBox.y < alphaBox.y ? "reordered" : "not-reordered";
      })
      .toBe("reordered");
    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __reorderSessionCalls?: unknown[] })
          .__reorderSessionCalls,
    )) as Array<{ repoPath: string; order: string[] }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      repoPath: "/tmp/demo",
      order: ["beta-session", "alpha-session"],
    });
  });

  test("project workspace sessions can move out next to root sessions by drag and drop", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessions?: unknown[] };
      w.__sessions = w.__sessions ?? [
        {
          id: "root-session",
          name: "root",
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
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
        },
        {
          id: "child-session",
          name: "child",
          repo_path: "/tmp/demo",
          worktree_path: "/tmp/demo",
          branch: "main",
          isolated: false,
          project_scoped: true,
          status: "idle",
          created_at: "2026-01-01T00:00:01Z",
          updated_at: "2026-01-01T00:00:01Z",
          last_message: null,
          title_source: "manual",
          kind: "regular",
          owner: { kind: "user" },
          position: 1,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("reorder_sessions", (args) => {
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
        __reorderSessionCalls?: unknown[];
      };
      w.__reorderSessionCalls = w.__reorderSessionCalls ?? [];
      w.__reorderSessionCalls.push(args);
      const order = Array.isArray(args?.order) ? args.order : [];
      const indexById = new Map(order.map((id, index) => [id, index]));
      w.__sessions = (w.__sessions ?? []).map((session) => {
        const position = indexById.get(session.id);
        return typeof position === "number" ? { ...session, position } : session;
      });
      return w.__sessions;
    });

    await page.goto("/");

    const sidebar = page.locator("aside");
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const folderRow = sidebar
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await folderRow.dblclick();
    await sidebar.getByRole("textbox").fill("Frontend");
    await sidebar.getByRole("textbox").press("Enter");
    const frontend = sidebar.getByRole("button", { name: /Frontend/ }).first();
    const root = sidebar
      .getByRole("button", { name: /^root main · Idle/ })
      .first();
    const child = sidebar
      .getByRole("button", { name: /^child main · Idle/ })
      .first();

    await dragBetween(page, child, frontend);
    await child.click({ button: "right" });
    await expectMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    await dragBetween(page, child, root);

    await expect
      .poll(async () => {
        const childBox = await child.boundingBox();
        const rootBox = await root.boundingBox();
        if (!childBox || !rootBox) return "missing";
        return childBox.y < rootBox.y ? "moved-out" : "still-below";
      })
      .toBe("moved-out");
    await child.click({ button: "right" });
    await expectMoveToTarget(page, "Frontend");
    await expectNoMoveToTarget(page, "Project root");

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __reorderSessionCalls?: unknown[] })
          .__reorderSessionCalls,
    )) as Array<{ repoPath: string; order: string[] }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      repoPath: "/tmp/demo",
      order: ["child-session", "root-session"],
    });
  });

  test("worktree workspace session boundaries cannot be crossed by drag and drop", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __sessions?: unknown[] };
      w.__sessions = w.__sessions ?? [
        {
          id: "root-session",
          name: "root",
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
          owner: { kind: "user" },
          position: 0,
          in_worktree: false,
        },
      ];
      return w.__sessions;
    });
    await tauri.handle("create_session", (args) => {
      const input = (args ?? {}) as {
        name?: string;
        repoPath?: string;
        isolated?: boolean;
        kind?: string;
        mode?: string;
        projectScoped?: boolean;
        cwdPath?: string;
      };
      const w = window as unknown as {
        __sessions?: Array<Record<string, unknown>>;
      };
      w.__sessions = w.__sessions ?? [];
      const repoPath = input.repoPath ?? "/tmp/demo";
      const id = `created-${w.__sessions.length}`;
      const created = {
        id,
        name: input.name ?? id,
        repo_path: repoPath,
        worktree_path: input.isolated
          ? `${repoPath}/.acorn/worktrees/${id}`
          : (input.cwdPath ?? repoPath),
        branch: "main",
        isolated: Boolean(input.isolated),
        project_scoped: input.projectScoped ?? true,
        status: "idle",
        created_at: "2026-01-01T00:00:01Z",
        updated_at: "2026-01-01T00:00:01Z",
        last_message: null,
        title_source: "default",
        kind: input.kind ?? "regular",
        mode: input.mode ?? "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: Boolean(input.isolated),
      };
      w.__sessions.push(created);
      return created;
    });
    await tauri.handle("reorder_sessions", (args) => {
      const w = window as unknown as { __reorderSessionCalls?: unknown[] };
      w.__reorderSessionCalls = w.__reorderSessionCalls ?? [];
      w.__reorderSessionCalls.push(args);
      return [];
    });

    await page.goto("/");

    const sidebar = page.locator("aside");
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page
      .getByRole("menuitem", {
        name: "New worktree workspace",
        exact: true,
      })
      .click();

    const root = sidebar
      .getByRole("button", { name: /^root main · Idle/ })
      .first();
    const worktreeWorkspace = sidebar
      .getByRole("button", { name: /created-1/ })
      .first();
    const worktreeSession = sidebar
      .getByRole("button", {
        name: /^demo-worktree-[a-f0-9]{12} main · Idle/,
      })
      .first();
    await expect(root).toBeVisible();
    await expect(worktreeWorkspace).toBeVisible();
    await expect(worktreeSession).toBeVisible();

    await worktreeWorkspace.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "New session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "New worktree session",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "New chat session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await dragBetween(page, worktreeSession, root);
    await dragBetween(page, worktreeSession, projectRow);
    await dragBetween(page, root, worktreeWorkspace);

    await expect
      .poll(async () => {
        const rootBox = await root.boundingBox();
        const workspaceBox = await worktreeWorkspace.boundingBox();
        const sessionBox = await worktreeSession.boundingBox();
        if (!rootBox || !workspaceBox || !sessionBox) return "missing";
        return rootBox.y < workspaceBox.y && workspaceBox.y < sessionBox.y
          ? "still-in-worktree-workspace"
          : "moved-out";
      })
      .toBe("still-in-worktree-workspace");

    await worktreeSession.click({ button: "right" });
    await expectNoMoveToTarget(page, "Project root");

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __reorderSessionCalls?: unknown[] })
          .__reorderSessionCalls,
    )) as unknown[] | undefined;
    expect(calls ?? []).toEqual([]);
  });

  test("project workspaces can collapse and expand their sessions", async ({
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
    await tauri.handle("list_sessions", () => [
      {
        id: "root-session",
        name: "root",
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
        owner: { kind: "user" },
        position: 0,
        in_worktree: false,
      },
    ]);

    await page.goto("/");

    await page
      .getByRole("button", { name: "Project demo" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "New workspace", exact: true }).click();
    const folderRow = page
      .locator("aside")
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await folderRow.dblclick();
    await page.locator("aside").getByRole("textbox").fill("Frontend");
    await page.locator("aside").getByRole("textbox").press("Enter");
    const renamedFolderRow = page
      .locator("aside")
      .getByRole("button", { name: /Frontend/ })
      .first();
    const rootSession = page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ });
    await rootSession.click({ button: "right" });
    await clickMoveToTarget(page, "Frontend");
    await expect(rootSession).toBeVisible();

    await page
      .getByRole("button", { name: "Collapse workspace", exact: true })
      .click();
    await expect(rootSession).toHaveCount(0);

    await page
      .getByRole("button", { name: "Expand workspace", exact: true })
      .click();
    await expect(
      page.locator("aside").getByRole("button", { name: /root main · Idle/ }),
    ).toBeVisible();
  });

  test("hidden project header actions do not reserve title width", async ({
    page,
    tauri,
  }) => {
    const projectName = "codex-app-server-main";
    await tauri.handle("list_projects", () => [
      {
        repo_path: "/tmp/demo",
        name: "codex-app-server-main",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);

    await page.goto("/");
    await page.mouse.move(900, 500);

    const projectRow = page.getByRole("button", {
      name: `Project ${projectName}`,
    });
    await expect(projectRow).toBeVisible();

    const title = projectRow.getByText(projectName, { exact: true });
    const newSessionButton = page.locator(
      'button[aria-label="New session in this project"]',
    );
    await expect(newSessionButton).toHaveCount(1);

    const hiddenButtonWidth = await newSessionButton.evaluate(
      (el) => (el as HTMLElement).offsetWidth,
    );
    expect(hiddenButtonWidth).toBe(0);

    const titleMetrics = await title.evaluate((el) => {
      const titleEl = el as HTMLElement;
      return {
        clientWidth: titleEl.clientWidth,
        scrollWidth: titleEl.scrollWidth,
      };
    });
    expect(titleMetrics.scrollWidth).toBeLessThanOrEqual(
      titleMetrics.clientWidth + 1,
    );

    await projectRow.hover();
    await expect(newSessionButton).toBeVisible();
    await expect
      .poll(() =>
        newSessionButton.evaluate((el) => (el as HTMLElement).offsetWidth),
      )
      .toBeGreaterThan(0);
  });

  test("project header exposes regular and worktree session buttons outside the menu", async ({
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
    await tauri.handle("list_sessions", () => {
      return (
        (window as unknown as { __createdSessions?: unknown[] })
          .__createdSessions ?? []
      );
    });
    await tauri.handle("create_session", (args) => {
      const input = (args ?? {}) as {
        name?: string;
        repoPath?: string;
        isolated?: boolean;
        kind?: string;
        mode?: string;
        projectScoped?: boolean;
        cwdPath?: string;
      };
      const w = window as unknown as {
        __createSessionCalls?: unknown[];
        __createdSessions?: unknown[];
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createdSessions = w.__createdSessions ?? [];
      w.__createSessionCalls.push(args);
      const repoPath = input.repoPath ?? "/tmp/demo";
      const id = `created-${w.__createdSessions.length + 1}`;
      const created = {
        id,
        name: input.name ?? id,
        repo_path: repoPath,
        worktree_path: input.isolated
          ? `${repoPath}/.acorn/worktrees/${id}`
          : (input.cwdPath ?? repoPath),
        branch: "main",
        isolated: Boolean(input.isolated),
        project_scoped: input.projectScoped ?? true,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        title_source: "default",
        kind: input.kind ?? "regular",
        mode: input.mode ?? "terminal",
        owner: { kind: "user" },
        position: null,
        in_worktree: Boolean(input.isolated),
      };
      w.__createdSessions.push(created);
      return created;
    });

    await page.goto("/");

    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.hover();
    await expect(
      page.getByRole("button", { name: "New session in this project" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "New worktree session in this project",
      }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Create session in this project" })
      .click();
    await expect(page.getByRole("menu")).toContainText("Workspace");
    await expect(page.getByRole("menu")).toContainText("Session");
    const menuLabels = await page.getByRole("menuitem").evaluateAll((items) =>
      items.map((item) => item.textContent?.replace(/\s+/g, " ").trim()),
    );
    expect(menuLabels.slice(0, 4)).toEqual([
      "New workspace",
      "New worktree workspace",
      "New chat session",
      "New control session",
    ]);
    await expect(
      page.getByRole("menuitem", { name: "New session" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: /New worktree session/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "New chat session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New workspace", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "New worktree workspace",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "New workspace", exact: true })
      .click();
    await expect(
      page
        .locator("aside")
        .getByRole("button", { name: /New workspace/ })
        .filter({ hasText: "New workspace" }),
    ).toBeVisible();

    await projectRow.hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();
    await projectRow.hover();
    await page
      .getByRole("button", {
        name: "New worktree session in this project",
      })
      .click();

    await projectRow.hover();
    await page
      .getByRole("button", { name: "Create session in this project" })
      .click();
    await page
      .getByRole("menuitem", {
        name: "New worktree workspace",
        exact: true,
      })
      .click();

    const worktreeWorkspace = page
      .locator("aside")
      .getByRole("button", { name: /created-3/ })
      .first();
    await expect(worktreeWorkspace).toBeVisible();
    await expectWorkspacePathOnly(
      worktreeWorkspace,
      /demo-worktree-[a-f0-9]{12}/,
    );
    const worktreeSession = page
      .locator("aside")
      .getByRole("button", {
        name: /^demo-worktree-[a-f0-9]{12} main · Idle/,
      })
      .last();
    await expect(worktreeSession).toBeVisible();

    await worktreeSession.click();
    await projectRow.hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();

    const projectRootSession = page
      .locator("aside")
      .getByRole("button", { name: /^demo-2 main · Idle/ })
      .first();
    await expect(projectRootSession).toBeVisible();
    await projectRootSession.click({ button: "right" });
    await expectNoMoveToTarget(page, "Project root");
    await page.keyboard.press("Escape");

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      repoPath: string;
      isolated: boolean;
      kind: string;
      mode: string;
    }>;
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
      mode: "terminal",
    });
    expect(calls[1]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: true,
      kind: "regular",
      mode: "terminal",
    });
    expect(calls[2]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: true,
      kind: "regular",
      mode: "terminal",
    });
    expect(calls[3]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
      mode: "terminal",
    });
  });

  test("clicking the instant sessions add button creates a local terminal session", async ({
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
    await chats.getByRole("button", { name: "New instant session" }).click();

    await expect(page.getByText("Instant Sessions")).toBeVisible();
    await expect(
      chats.getByRole("button", { name: /^terminal\b/ }),
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

  test("clicking an existing instant session activates its terminal pane", async ({
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
    await tauri.handle("list_sessions", () => [
      {
        id: "project-1",
        name: "project",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        project_scoped: true,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      },
      {
        id: "local-1",
        name: "terminal-1",
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
      {
        id: "local-2",
        name: "terminal-2",
        repo_path: "/Users/tester",
        worktree_path: "/Users/tester",
        branch: "HEAD",
        isolated: false,
        project_scoped: false,
        status: "idle",
        created_at: "2026-01-01T00:00:01Z",
        updated_at: "2026-01-01T00:00:01Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
        in_worktree: false,
      },
    ]);
    await tauri.handle("pty_spawn", (args) => {
      const slot = document.querySelector<HTMLElement>(
        `[data-acorn-terminal-slot="${(args as { sessionId?: string }).sessionId ?? ""}"]`,
      );
      const parent = slot?.parentElement ?? null;
      const w = window as unknown as { __localSpawnCalls?: unknown[] };
      w.__localSpawnCalls = w.__localSpawnCalls ?? [];
      w.__localSpawnCalls.push({
        ...(args as Record<string, unknown>),
        parentPane: parent?.getAttribute("data-pane-body") ?? null,
        parentLimbo: parent?.getAttribute("data-acorn-terminal-limbo") ?? null,
      });
      return null;
    });

    await page.goto("/");
    await page.getByRole("button", { name: /^project main · Idle$/ }).click();

    const instant = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    const terminalRow = instant.getByRole("button", { name: /^terminal-2\b/ });
    const terminalBox = await terminalRow.boundingBox();
    expect(terminalBox).not.toBeNull();
    await page.mouse.click(
      terminalBox!.x + terminalBox!.width - 40,
      terminalBox!.y + terminalBox!.height / 2,
    );

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __localSpawnCalls?: unknown[] })
                .__localSpawnCalls?.some(
                  (call) =>
                    (call as { sessionId?: string }).sessionId === "local-2",
                ) ?? false,
          ),
        { timeout: 5_000 },
      )
      .toBe(true);

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __localSpawnCalls?: unknown[] })
          .__localSpawnCalls,
    )) as Array<{
      sessionId: string;
      cwd: string;
      parentPane: string | null;
      parentLimbo: string | null;
    }>;
    const localCall = calls.find((call) => call.sessionId === "local-2");
    expect(localCall).toMatchObject({
      sessionId: "local-2",
      cwd: "/Users/tester",
      parentLimbo: null,
    });
    expect(localCall?.parentPane).not.toBeNull();
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

  test("instant sessions can create workspaces and create sessions inside them", async ({
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
        __createSessionCalls?: unknown[];
        __localSessionCreated?: boolean;
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

    const instant = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    await instant
      .getByRole("button", { name: "New workspace" })
      .click();
    const folderRow = instant
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await expect(folderRow).toBeVisible();
    await folderRow.dblclick();
    const input = instant.getByRole("textbox");
    await input.fill("Scratch");
    await input.press("Enter");

    const scratch = instant
      .getByRole("button", { name: /Scratch/ })
      .first();
    await expect(scratch).toBeVisible();
    await scratch.hover();
    await scratch
      .getByRole("button", { name: "New instant session" })
      .click();
    await expect(
      instant.getByRole("button", { name: /^terminal\b/ }),
    ).toBeVisible();

    await scratch
      .getByRole("button", { name: "Collapse workspace" })
      .click();
    await expect(
      instant.getByRole("button", { name: /^terminal\b/ }),
    ).toHaveCount(0);

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

  test("instant sessions can move into workspaces by drag and drop", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("plugin:path|resolve_directory", () => "/Users/tester");
    await tauri.handle("list_projects", () => []);
    await tauri.handle("list_sessions", () => [
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
    ]);

    await page.goto("/");

    const instant = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    const terminal = instant
      .getByRole("button", { name: /^terminal\b/ })
      .first();
    await expect(terminal).toBeVisible();

    await instant
      .getByRole("button", { name: "New workspace" })
      .click();
    const folderRow = instant
      .getByRole("button", { name: /New workspace/ })
      .filter({ hasText: "New workspace" })
      .first();
    await expect(folderRow).toBeVisible();
    await folderRow.dblclick();
    const input = instant.getByRole("textbox");
    await input.fill("Scratch");
    await input.press("Enter");

    const scratch = instant
      .getByRole("button", { name: /Scratch/ })
      .first();
    await expect(scratch).toBeVisible();
    const scratchWorkspace = instant.locator("[data-sidebar-workspace-id]").first();

    await dragBetween(page, terminal, scratch);

    await expect(scratchWorkspace).toContainText("terminal");

    const terminalBox = await terminal.boundingBox();
    const instantBox = await instant.boundingBox();
    if (!terminalBox || !instantBox) {
      throw new Error("instant session drag target is not visible");
    }
    await page.mouse.move(
      terminalBox.x + Math.min(60, terminalBox.width / 2),
      terminalBox.y + terminalBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(instantBox.x + 18, instantBox.y + 24, { steps: 10 });
    await page.mouse.up();

    await expect(scratchWorkspace).not.toContainText("terminal");
    await expect
      .poll(async () => {
        const sessionBox = await terminal.boundingBox();
        const scratchBox = await scratch.boundingBox();
        if (!sessionBox || !scratchBox) return "missing";
        return sessionBox.y < scratchBox.y ? "root" : "workspace";
      })
      .toBe("root");
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

  test("new-session hotkey from a worktree session starts at the project root", async ({
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
    await tauri.handle("list_sessions", () => {
      const w = window as unknown as { __createdRootSession?: boolean };
      const baseSession = {
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        last_message: null,
        kind: "regular",
        owner: { kind: "user" },
        position: null,
      };
      const rootSession = {
        ...baseSession,
        id: "root",
        name: "root",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        in_worktree: false,
      };
      const worktreeSession = {
        ...baseSession,
        id: "worker",
        name: "worker",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo/.acorn/worktrees/main-copy",
        in_worktree: true,
      };
      const createdSession = {
        ...baseSession,
        id: "created-root",
        name: "demo",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        in_worktree: false,
      };
      return w.__createdRootSession
        ? [rootSession, worktreeSession, createdSession]
        : [rootSession, worktreeSession];
    });
    await tauri.handle("create_session", (args) => {
      const w = window as unknown as {
        __createdRootSession?: boolean;
        __createSessionCalls?: unknown[];
      };
      w.__createSessionCalls = w.__createSessionCalls ?? [];
      w.__createSessionCalls.push(args);
      w.__createdRootSession = true;
      return {
        id: "created-root",
        name: "demo",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
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
      .getByRole("button", { name: /^worker worktree main · Idle/ })
      .click();
    await pressHotkey(page, { mod: true, key: "t" });

    const calls = (await page.evaluate(
      () =>
        (window as unknown as { __createSessionCalls?: unknown[] })
          .__createSessionCalls,
    )) as Array<{
      repoPath: string;
      cwdPath?: string;
      isolated: boolean;
    }>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
    });
    expect(calls[0].cwdPath).toBeUndefined();
  });

  test("clicking the instant sessions area makes new-session hotkey create a local session", async ({
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

  test("Add existing project opens the backend project picker", async ({
    page,
    tauri,
  }) => {
    // Capture the add_project call arguments on window so the test can
    // verify the request goes through the backend-owned picker.
    await tauri.handle("add_project", (args) => {
      const w = window as unknown as { __addProjectCalls?: unknown[] };
      w.__addProjectCalls = w.__addProjectCalls ?? [];
      w.__addProjectCalls.push(args);
      return {
        repo_path: "/tmp/picked",
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
    )) as Array<{ title: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Select an existing project");
  });

  test("empty project state opens an existing project picker", async ({
    page,
    tauri,
  }) => {
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
    )) as Array<{ title: string }>;
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Select an existing project");
  });

  test("New project creates a git-backed project under the selected parent", async ({
    page,
    tauri,
  }) => {
    await tauri.handle("select_project_parent_folder", () => "/tmp/parent");
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
    await tauri.handle("select_project_parent_folder", () => "/tmp/parent");
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
