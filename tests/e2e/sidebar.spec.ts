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

  test("project folders can be named and group sessions conceptually", async ({
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
        worktree_path: args?.repoPath ?? "/tmp/demo",
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();

    const folderRow = page
      .locator("aside")
      .getByRole("button", { name: /New folder/ })
      .first();
    await expect(folderRow).toBeVisible();
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
    await page
      .getByRole("menuitem", { name: "Move to folder: Frontend" })
      .click();
    const frontendFolder = page
      .locator("aside")
      .getByRole("button", { name: /Frontend/ })
      .first();
    await expect(frontendFolder).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toHaveCount(0);
    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove from folder" }).click();
    await expect(frontendFolder).toBeVisible();
    await page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ })
      .click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toHaveCount(0);
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

  test("project folder context menu can create sessions in that folder", async ({
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
        worktree_path: input.repoPath ?? "/tmp/demo",
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const folderRow = page
      .locator("aside")
      .getByRole("button", { name: /New folder/ })
      .first();
    await expect(folderRow).toBeVisible();

    await folderRow.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "New session", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "New isolated session (worktree)",
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
      .getByRole("menuitem", { name: "New chat session", exact: true })
      .click();

    const createdRow = page
      .locator("aside")
      .getByRole("button", { name: /^demo main · Idle/ })
      .first();
    await expect(createdRow).toBeVisible();
    await createdRow.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toBeVisible();
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
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      repoPath: "/tmp/demo",
      isolated: false,
      kind: "regular",
      mode: "chat",
    });
  });

  test("project folder remove asks before removing sessions in the folder", async ({
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const folderRow = sidebar.getByRole("button", { name: /New folder/ }).first();
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
    await page
      .getByRole("menuitem", { name: "Move to folder: Frontend" })
      .click();

    await frontend.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove folder" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove folder" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1 session");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(frontend).toBeVisible();
    await expect(child).toBeVisible();

    await frontend.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove folder" }).click();
    await page
      .getByRole("dialog", { name: "Remove folder" })
      .getByRole("button", { name: "Remove folder and sessions" })
      .click();

    await expect(child).toHaveCount(0);
    await expect(frontend).toHaveCount(0);
    await expect(root).toBeVisible();

    const calls = (await page.evaluate(
      () => (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as Array<{ id: string; removeWorktree: boolean }>;
    expect(calls).toEqual([{ id: "child-session", removeWorktree: false }]);
  });

  test("project folder remove can keep sessions and move them out", async ({
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
    ]);
    await tauri.handle("remove_session", (args) => {
      const w = window as unknown as { __removeCalls?: unknown[] };
      w.__removeCalls = w.__removeCalls ?? [];
      w.__removeCalls.push(args);
      return null;
    });

    await page.goto("/");

    const sidebar = page.locator("aside");
    const projectRow = page.getByRole("button", { name: "Project demo" });
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const folderRow = sidebar.getByRole("button", { name: /New folder/ }).first();
    await folderRow.dblclick();
    await sidebar.getByRole("textbox").fill("Frontend");
    await sidebar.getByRole("textbox").press("Enter");

    const frontend = sidebar.getByRole("button", { name: /Frontend/ }).first();
    const child = sidebar
      .getByRole("button", { name: /^child main · Idle/ })
      .first();
    await child.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Move to folder: Frontend" })
      .click();

    await frontend.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove folder" }).click();
    const dialog = page.getByRole("dialog", { name: "Remove folder" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("project before the folder is removed");
    await dialog.getByRole("button", { name: "Move sessions out" }).click();

    await expect(frontend).toHaveCount(0);
    await expect(child).toBeVisible();
    await child.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    const calls = (await page.evaluate(
      () => (window as unknown as { __removeCalls?: unknown[] }).__removeCalls,
    )) as unknown[] | undefined;
    expect(calls ?? []).toEqual([]);
  });

  test("project folders and sessions can move by drag and drop", async ({
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const firstFolder = page
      .locator("aside")
      .getByRole("button", { name: /New folder/ })
      .first();
    await firstFolder.dblclick();
    await page.locator("aside").getByRole("textbox").fill("Frontend");
    await page.locator("aside").getByRole("textbox").press("Enter");

    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const secondFolder = page
      .locator("aside")
      .getByRole("button", { name: /New folder/ })
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
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toBeVisible();
  });

  test("project folder sessions can be reordered by drag and drop", async ({
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const folderRow = sidebar.getByRole("button", { name: /New folder/ }).first();
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

  test("project folder sessions can move out next to root sessions by drag and drop", async ({
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const folderRow = sidebar.getByRole("button", { name: /New folder/ }).first();
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
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toBeVisible();
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
    await expect(
      page.getByRole("menuitem", { name: "Move to folder: Frontend" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Remove from folder" }),
    ).toHaveCount(0);

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

  test("project folders can collapse and expand their sessions", async ({
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
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    const folderRow = page
      .locator("aside")
      .getByRole("button", { name: /New folder/ })
      .first();
    await folderRow.dblclick();
    await page.locator("aside").getByRole("textbox").fill("Frontend");
    await page.locator("aside").getByRole("textbox").press("Enter");
    const renamedFolderRow = page
      .locator("aside")
      .getByRole("button", { name: /Frontend/ })
      .first();
    const folderIcon = renamedFolderRow.locator("svg").first();
    const folderChevron = renamedFolderRow.locator("svg").nth(1);
    await page.mouse.move(0, 0);
    await expect(folderIcon).toHaveCSS("opacity", "1");
    await expect(folderChevron).toHaveCSS("opacity", "0");
    await renamedFolderRow.hover();
    await expect(folderIcon).toHaveCSS("opacity", "0");
    await expect(folderChevron).toHaveCSS("opacity", "1");

    const rootSession = page
      .locator("aside")
      .getByRole("button", { name: /root main · Idle/ });
    await rootSession.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Move to folder: Frontend" })
      .click();
    await expect(rootSession).toBeVisible();

    await page
      .getByRole("button", { name: "Collapse folder", exact: true })
      .click();
    await expect(rootSession).toHaveCount(0);

    await page
      .getByRole("button", { name: "Expand folder", exact: true })
      .click();
    await expect(
      page.locator("aside").getByRole("button", { name: /root main · Idle/ }),
    ).toBeVisible();
  });

  test("project header exposes regular and isolated session buttons outside the menu", async ({
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
          : repoPath,
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
        name: "New isolated session in this project",
      }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Create session in this project" })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "New session" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: /New isolated session/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("menuitem", { name: "New chat session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New control session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "New project folder" }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "New project folder" }).click();
    await expect(
      page.locator("aside").getByRole("button", { name: /New folder/ }),
    ).toBeVisible();

    await projectRow.hover();
    await page
      .getByRole("button", { name: "New session in this project" })
      .click();
    await projectRow.hover();
    await page
      .getByRole("button", {
        name: "New isolated session in this project",
      })
      .click();

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
    expect(calls).toHaveLength(2);
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
  });

  test("instant sessions area stays compact when projects are present", async ({
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

    const instantSessions = page.getByRole("region", {
      name: "Local terminal sessions",
    });
    await expect(instantSessions).toBeVisible();

    const box = await instantSessions.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(180);
  });

  test("projects and instant sessions headers use the same font size", async ({
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

    const projects = page.getByRole("heading", { name: "Projects" });
    const instantSessions = page.getByText("Instant sessions", { exact: true });
    await expect(projects).toBeVisible();
    await expect(instantSessions).toBeVisible();

    const [projectsFontSize, instantSessionsFontSize] = await Promise.all([
      projects.evaluate((el) => getComputedStyle(el).fontSize),
      instantSessions.evaluate((el) => getComputedStyle(el).fontSize),
    ]);
    expect(instantSessionsFontSize).toBe(projectsFontSize);
    expect(instantSessionsFontSize).toBe("12px");
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

    await expect(page.getByText("Instant sessions")).toBeVisible();
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
