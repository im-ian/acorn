import { test, expect, type Page } from "./support";
import type { TauriMock } from "./support";

// Tauri handler callbacks run in the page context and must not close over
// variables declared in the test body. These helpers only define handlers
// inline and only close over their own parameters, which keeps the
// serialization boundary clean.
async function seedAlphaBetaTerminals(tauri: TauriMock): Promise<void> {
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
      id: "s-alpha",
      name: "alpha",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
    {
      id: "s-beta",
      name: "beta",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "idle",
      created_at: "2026-01-01T00:00:01Z",
      updated_at: "2026-01-01T00:00:06Z",
      last_message: null,
    },
  ]);
  await tauri.handle("pty_spawn", () => null);
}

async function gotoWithAccent(page: Page): Promise<void> {
  await page.goto("/");
  await page.addStyleTag({
    content: `
      :root[data-acorn-theme="acorn-dark"] {
        --color-accent: rgb(12, 34, 56);
      }
    `,
  });
}

function makePillCursorAssertion(page: Page): () => Promise<void> {
  const activeCursor = page
    .locator("[data-pane-body] .acorn-terminal .xterm-cursor")
    .first();
  return async () => {
    const textarea = page
      .locator("[data-pane-body] .xterm-helper-textarea")
      .first();
    await textarea.waitFor({ state: "attached" });
    await textarea.focus();
    await textarea.evaluate((el) => el.blur());
    await expect(activeCursor).toBeAttached();
    await expect
      .poll(async () =>
        activeCursor.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe("rgb(12, 34, 56)");
    await expect
      .poll(async () =>
        activeCursor.evaluate((el) => getComputedStyle(el).borderRadius),
      )
      .toBe("999px");
    await expect
      .poll(async () =>
        activeCursor.evaluate((el) => getComputedStyle(el, "::after").content),
      )
      .toBe("none");
    await expect
      .poll(async () =>
        activeCursor.evaluate((el) => getComputedStyle(el).outlineWidth),
      )
      .toBe("0px");
  };
}

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
      const slot = document.querySelector<HTMLElement>(
        '[data-acorn-terminal-slot="s-term"]',
      );
      const parent = slot?.parentElement ?? null;
      const w = window as unknown as { __ptySpawnCalls?: unknown[] };
      w.__ptySpawnCalls = w.__ptySpawnCalls ?? [];
      w.__ptySpawnCalls.push({
        ...(args as Record<string, unknown>),
        parentPane: parent?.getAttribute("data-pane-body") ?? null,
        parentLimbo: parent?.getAttribute("data-acorn-terminal-limbo") ?? null,
      });
      return null;
    });
    await tauri.handle("pty_resize", (args) => {
      const w = window as unknown as { __ptyResizeCalls?: unknown[] };
      w.__ptyResizeCalls = w.__ptyResizeCalls ?? [];
      w.__ptyResizeCalls.push(args);
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
    expect(first.parentPane).not.toBeNull();
    expect(first.parentLimbo).toBeNull();
  });

  test("opens file:line terminal links in the code viewer", async ({
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
    await tauri.handle("pty_spawn", () => null);
    await tauri.handle("pty_cwd", () => "/tmp/demo");
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __fileLinkChannelId?: number;
        [key: string]: unknown;
      };
      w.__fileLinkChannelId = channel.id;
      return 1;
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo/src/components/FolderPermissionWarmupModal.tsx") {
        throw new Error(`unexpected path: ${path}`);
      }
      const lines = Array.from(
        { length: 100 },
        (_, index) => `line ${index + 1}`,
      );
      lines[77] = "target line 78";
      return {
        content: lines.join("\n"),
        size: 1024,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    const linkText = "src/components/FolderPermissionWarmupModal.tsx:78";
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __fileLinkChannelId?: number })
              .__fileLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();
    await page.evaluate((text) => {
      const w = window as unknown as {
        __fileLinkChannelId?: number;
        [key: string]: unknown;
      };
      const id = w.__fileLinkChannelId;
      if (id === undefined) throw new Error("missing terminal output channel");
      const callback = w[`_${id}`] as
        | ((payload: { index: number; message: number[] }) => void)
        | undefined;
      if (!callback) throw new Error("missing terminal output callback");
      callback({
        index: 0,
        message: Array.from(new TextEncoder().encode(`${text}\r\n`)),
      });
    }, linkText);
    await expect(page.locator(".xterm")).toContainText(linkText);
    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);
    await page.mouse.click(screenBox!.x + 12, screenBox!.y + 10);

    await expect(
      page.getByRole("button", {
        name: /FolderPermissionWarmupModal\.tsx Close tab/,
      }),
    ).toBeVisible();
    await expect(page.locator('[data-acorn-target-line="true"]')).toContainText(
      "target line 78",
    );
  });

  test("opens file-only terminal links in the code viewer", async ({
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
    await tauri.handle("pty_spawn", () => null);
    await tauri.handle("pty_cwd", () => "/tmp/demo/src/components");
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __fileLinkChannelId?: number;
        [key: string]: unknown;
      };
      w.__fileLinkChannelId = channel.id;
      return 1;
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo/.claude/rules/typescript/coding-style.md") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "file-only link target\nline 2",
        size: 128,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    const linkText = "../../.claude/rules/typescript/coding-style.md";
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __fileLinkChannelId?: number })
              .__fileLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();
    await page.evaluate((text) => {
      const w = window as unknown as {
        __fileLinkChannelId?: number;
        [key: string]: unknown;
      };
      const id = w.__fileLinkChannelId;
      if (id === undefined) throw new Error("missing terminal output channel");
      const callback = w[`_${id}`] as
        | ((payload: { index: number; message: number[] }) => void)
        | undefined;
      if (!callback) throw new Error("missing terminal output callback");
      callback({
        index: 0,
        message: Array.from(new TextEncoder().encode(`${text}\r\n`)),
      });
    }, linkText);
    await expect(page.locator(".xterm")).toContainText(linkText);
    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);
    await page.mouse.click(screenBox!.x + 12, screenBox!.y + 10);

    await expect(
      page.getByRole("button", {
        name: /coding-style\.md Close tab/,
      }),
    ).toBeVisible();
    await expect(page.getByText("file-only link target")).toBeVisible();
    await expect(page.locator('[data-acorn-target-line="true"]')).toHaveCount(
      0,
    );
  });

  test("submitting a command resyncs the PTY size for agent TUIs", async ({
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
    await tauri.handle("pty_spawn", () => null);
    await tauri.handle("pty_resize", (args) => {
      const w = window as unknown as { __ptyResizeCalls?: unknown[] };
      w.__ptyResizeCalls = w.__ptyResizeCalls ?? [];
      w.__ptyResizeCalls.push(args);
      return null;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      (window as unknown as { __ptyResizeCalls?: unknown[] })
        .__ptyResizeCalls = [];
    });
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Enter");

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __ptyResizeCalls?: unknown[] })
                .__ptyResizeCalls?.length ?? 0,
          ),
        { timeout: 1_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test("reattaching a live daemon session replays daemon scrollback instead of stale disk scrollback", async ({
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
        id: "s-term",
        name: "shell",
        repo_path: "/tmp/demo",
        worktree_path: "/tmp/demo",
        branch: "main",
        isolated: false,
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("daemon_list_sessions", () => [
      {
        id: "s-term",
        name: "shell",
        kind: "regular",
        alive: true,
        cwd: "/tmp/demo",
        repo_path: "/tmp/demo",
        branch: "main",
        agent_kind: null,
      },
    ]);
    await tauri.handle("scrollback_load", () => "stale disk snapshot\r\n");
    await tauri.handle("pty_spawn", (args) => {
      const w = window as unknown as { __ptySpawnCalls?: unknown[] };
      w.__ptySpawnCalls = w.__ptySpawnCalls ?? [];
      w.__ptySpawnCalls.push(args);
      return null;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Running$/ })
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
    )) as Array<{ replayScrollback: boolean }>;

    expect(calls[0].replayScrollback).toBe(true);
    await expect(page.locator(".xterm")).not.toContainText(
      "stale disk snapshot",
    );
  });
});
