import { test, expect, pressHotkey } from "./support";
import type { Locator } from "@playwright/test";
import type { Page, TauriMock } from "./support";

async function installNativeDragEventRecorder(
  tauri: TauriMock,
): Promise<void> {
  await tauri.handle("plugin:event|listen", (args: unknown) => {
    const { event, handler } = args as { event: string; handler: number };
    const w = window as unknown as {
      __tauriEventHandlers?: Record<string, number>;
    };
    w.__tauriEventHandlers = w.__tauriEventHandlers ?? {};
    w.__tauriEventHandlers[event] = handler;
    return handler;
  });
  await tauri.handle("plugin:event|unlisten", () => undefined);
}

async function emitNativeFileDragEnter(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  paths: string[],
): Promise<void> {
  await page.evaluate(
    ({ box, paths }) => {
      const w = window as unknown as {
        __tauriEventHandlers?: Record<string, number>;
        [key: string]: unknown;
      };
      const id = w.__tauriEventHandlers?.["tauri://drag-enter"];
      if (typeof id !== "number") throw new Error("missing drag-enter handler");
      const callback = w[`_${id}`] as
        | ((payload: {
            event: string;
            id: number;
            payload: {
              paths: string[];
              position: { x: number; y: number };
            };
          }) => void)
        | undefined;
      if (!callback) throw new Error("missing drag-enter callback");
      callback({
        event: "tauri://drag-enter",
        id,
        payload: {
          paths,
          position: {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          },
        },
      });
    },
    { box, paths },
  );
}

async function installPtyWriteRecorder(tauri: TauriMock): Promise<void> {
  await tauri.handle("pty_write", (args: unknown) => {
    const w = window as unknown as { __ptyWrites?: string[] };
    w.__ptyWrites = w.__ptyWrites ?? [];
    const { data } = args as { data: string };
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    w.__ptyWrites.push(new TextDecoder().decode(bytes));
    return null;
  });
}

async function dragCenterTo(
  page: Page,
  source: Locator,
  target: Locator,
  options: { release?: boolean } = {},
): Promise<void> {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  const from = {
    x: sourceBox!.x + sourceBox!.width / 2,
    y: sourceBox!.y + sourceBox!.height / 2,
  };
  const to = {
    x: targetBox!.x + targetBox!.width / 2,
    y: targetBox!.y + targetBox!.height / 2,
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 16, from.y, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  if (options.release !== false) await page.mouse.up();
}

test.describe("file explorer", () => {
  test("shows a tab drop affordance when dragging a file onto the tab strip", async ({
    page,
    tauri,
  }) => {
    const repo = "/tmp/demo";
    const file = `${repo}/src/App.tsx`;
    const secondFile = `${repo}/src/Utils.ts`;

    await installNativeDragEventRecorder(tauri);
    await installPtyWriteRecorder(tauri);
    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "s-1",
        name: "alpha",
        repo_path: repo,
        worktree_path: repo,
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("pty_repo_root", () => "/tmp/demo");
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path === "/tmp/demo") {
        return {
          repo_root: "/tmp/demo",
          entries: [
            {
              name: "src",
              path: "/tmp/demo/src",
              is_dir: true,
              is_symlink: false,
              size: 0,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      if (path === "/tmp/demo/src") {
        return {
          repo_root: "/tmp/demo",
          entries: [
            {
              name: "App.tsx",
              path: "/tmp/demo/src/App.tsx",
              is_dir: false,
              is_symlink: false,
              size: 42,
              modified_ms: 0,
              gitignored: false,
            },
            {
              name: "Utils.ts",
              path: "/tmp/demo/src/Utils.ts",
              is_dir: false,
              is_symlink: false,
              size: 24,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      return { repo_root: "/tmp/demo", entries: [] };
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      return {
        content:
          path === "/tmp/demo/src/App.tsx"
            ? "export default function App() {}\n"
            : path === "/tmp/demo/src/Utils.ts"
              ? "export const util = true;\n"
              : "",
        size: path === "/tmp/demo/src/Utils.ts" ? 26 : 31,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^alpha main · Ready$/ })
      .click();
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await page.getByRole("button", { name: "src" }).click();

    const fileRow = page.getByRole("button", { name: "App.tsx", exact: true });
    const tabStrip = page.locator('[data-pane-tab-strip="root"]');
    await expect(fileRow).toBeVisible();
    await expect(tabStrip).toBeVisible();

    const terminalBox = await page
      .locator("[data-pane-body] .acorn-terminal")
      .boundingBox();
    expect(terminalBox).not.toBeNull();
    await emitNativeFileDragEnter(page, terminalBox!, [file]);
    await expect(page.locator('[data-file-drop-hover="terminal"]')).toContainText(
      "Drop into terminal",
    );

    const terminal = page.locator("[data-pane-body] .acorn-terminal");
    await dragCenterTo(page, fileRow, terminal);

    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __ptyWrites?: string[] }).__ptyWrites ?? [],
        ),
      )
      .toContain("src/App.tsx ");
    await expect(page.locator("[data-file-drag-ghost]")).toHaveCount(0);

    await page.evaluate(() => {
      (window as unknown as { __ptyWrites?: string[] }).__ptyWrites = [];
    });
    const sourceBox = await fileRow.boundingBox();
    const terminalDragBox = await terminal.boundingBox();
    const rightPanelBox = await page.locator('[data-panel-id="right"]').boundingBox();
    expect(sourceBox).not.toBeNull();
    expect(terminalDragBox).not.toBeNull();
    expect(rightPanelBox).not.toBeNull();

    await page.mouse.move(
      sourceBox!.x + sourceBox!.width / 2,
      sourceBox!.y + sourceBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      terminalDragBox!.x + terminalDragBox!.width / 2,
      terminalDragBox!.y + terminalDragBox!.height / 2,
      { steps: 20 },
    );
    await expect(page.locator('[data-file-drop-hover="terminal"]')).toContainText(
      "Drop into terminal",
    );
    await expect(page.locator("[data-file-drag-ghost]")).toContainText(
      "App.tsx",
    );
    await page.mouse.move(
      rightPanelBox!.x + rightPanelBox!.width / 2,
      rightPanelBox!.y + rightPanelBox!.height / 2,
      { steps: 20 },
    );
    await page.mouse.up();

    await expect(page.locator('[data-file-drop-hover="terminal"]')).toHaveCount(
      0,
    );
    await expect(page.locator("[data-file-drag-ghost]")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __ptyWrites?: string[] }).__ptyWrites ?? [],
        ),
      )
      .toEqual([]);

    await dragCenterTo(page, fileRow, tabStrip, { release: false });

    await expect(page.locator('[data-file-drop-hover="tab"]')).toContainText(
      "Drop to open tab",
    );
    await expect(page.locator('[data-file-drop-hover="tab"]')).toContainText(
      "App.tsx",
    );
    await expect(page.locator("[data-file-drag-ghost]")).toContainText(
      "App.tsx",
    );
    await expect(page.locator('[data-file-drop-hover="terminal"]')).toHaveCount(
      0,
    );

    await page.mouse.up();

    await expect(page.locator('[data-file-drop-hover="tab"]')).toHaveCount(0);
    await expect(page.locator("[data-file-drag-ghost]")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /App\.tsx Close tab/ }),
    ).toBeVisible();

    const secondFileRow = page.getByRole("button", {
      name: "Utils.ts",
      exact: true,
    });
    const paneBody = page.locator('[data-pane-body="root"]');
    await expect(secondFileRow).toBeVisible();
    await dragCenterTo(page, secondFileRow, paneBody, { release: false });

    await expect(page.locator('[data-file-drop-hover="preview"]')).toContainText(
      "Drop to preview",
    );
    await expect(page.locator('[data-file-drop-hover="preview"]')).toContainText(
      "Utils.ts",
    );

    await page.mouse.up();

    await expect(page.locator('[data-file-drop-hover="preview"]')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: /Utils\.ts Close tab/ }),
    ).toBeVisible();
    await expect(page.getByText("export const util = true;")).toBeVisible();
  });

  test("keeps expanded worktree folders after opening and closing a file", async ({
    page,
    tauri,
  }) => {
    const repo = "/tmp/demo";
    const worktree = "/tmp/demo-worktree";

    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "s-1",
        name: "sess",
        repo_path: repo,
        worktree_path: worktree,
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("pty_repo_root", () => "/tmp/demo-worktree");
    await tauri.handle("fs_list_dir", (args) => {
      const worktree = "/tmp/demo-worktree";
      const src = `${worktree}/src`;
      const docs = `${worktree}/docs`;
      const file = `${src}/App.tsx`;
      const { path } = args as { path: string };
      if (path === worktree) {
        return {
          repo_root: worktree,
          entries: [
            {
              name: "src",
              path: src,
              is_dir: true,
              is_symlink: false,
              size: 0,
              modified_ms: 0,
              gitignored: false,
            },
            {
              name: "docs",
              path: docs,
              is_dir: true,
              is_symlink: false,
              size: 0,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      if (path === src) {
        return {
          repo_root: worktree,
          entries: [
            {
              name: "App.tsx",
              path: file,
              is_dir: false,
              is_symlink: false,
              size: 42,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      if (path === docs) {
        return {
          repo_root: worktree,
          entries: [
            {
              name: "Guide.md",
              path: `${docs}/Guide.md`,
              is_dir: false,
              is_symlink: false,
              size: 24,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      return { repo_root: path, entries: [] };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "src" }).click();
    await expect(page.getByRole("button", { name: "App.tsx" })).toBeVisible();
    await page.getByRole("button", { name: "docs" }).click();
    await expect(page.getByRole("button", { name: "Guide.md" })).toBeVisible();

    await page.getByRole("button", { name: "App.tsx" }).dblclick();

    await expect(
      page.getByRole("button", { name: /App\.tsx Close tab/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "App.tsx", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: /App\.tsx Close tab/ }).click();

    await expect(
      page.getByRole("button", { name: "App.tsx", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Guide.md", exact: true }),
    ).toBeVisible();

    const guideRow = page.getByRole("button", {
      name: "Guide.md",
      exact: true,
    });
    const guideBox = await guideRow.boundingBox();
    expect(guideBox).not.toBeNull();
    await page.mouse.dblclick(
      guideBox!.x + guideBox!.width - 12,
      guideBox!.y + guideBox!.height / 2,
    );

    await expect(
      page.getByRole("button", { name: /Guide\.md Close tab/ }),
    ).toBeVisible();
  });

  test("keeps expanded folders when the live repo root carries a trailing slash", async ({
    page,
    tauri,
  }) => {
    // libgit2's `Repository::workdir()` — what `pty_repo_root` returns — always
    // carries a trailing slash. Recorded paths (project/session) never do. If
    // the slashed form reaches the panel it fails to match any retained repo
    // path, so the expansion cache silently drops writes and folders collapse
    // on the next remount. This drives a project switch (which remounts the
    // File Explorer) to prove the expansion survives.
    const repoA = "/tmp/alpha";
    const repoB = "/tmp/beta";
    const worktreeA = "/tmp/alpha/.worktrees/a-session";
    const worktreeB = "/tmp/beta/.worktrees/b-session";

    await tauri.respond("list_projects", [
      {
        repo_path: repoA,
        name: "alpha",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
      {
        repo_path: repoB,
        name: "beta",
        created_at: "2026-01-01T00:00:00Z",
        position: 1,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "a-session",
        name: "a-session",
        repo_path: repoA,
        worktree_path: worktreeA,
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "b-session",
        name: "b-session",
        repo_path: repoB,
        worktree_path: worktreeB,
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    // Mirror real libgit2 behavior: hand the frontend a trailing-slash workdir.
    await tauri.handle("pty_repo_root", (args) => {
      const { sessionId } = args as { sessionId: string };
      if (sessionId === "a-session") return "/tmp/alpha/.worktrees/a-session/";
      if (sessionId === "b-session") return "/tmp/beta/.worktrees/b-session/";
      return null;
    });
    await tauri.handle("fs_list_dir", (args) => {
      // The backend tolerates either form; normalize so the tree still renders
      // pre-fix (the bug is purely about persistence, not initial listing).
      const { path } = args as { path: string };
      const normalized = path.replace(/\/+$/, "");
      const wt = "/tmp/alpha/.worktrees/a-session";
      const src = `${wt}/src`;
      if (normalized === wt) {
        return {
          repo_root: wt,
          entries: [
            {
              name: "src",
              path: src,
              is_dir: true,
              is_symlink: false,
              size: 0,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      if (normalized === src) {
        return {
          repo_root: wt,
          entries: [
            {
              name: "App.tsx",
              path: `${src}/App.tsx`,
              is_dir: false,
              is_symlink: false,
              size: 42,
              modified_ms: 0,
              gitignored: false,
            },
          ],
        };
      }
      return { repo_root: normalized, entries: [] };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "src" }).click();
    await expect(page.getByRole("button", { name: "App.tsx" })).toBeVisible();

    // Switch to the other project and back — this remounts the File Explorer.
    await page.getByRole("button", { name: "Project beta" }).click();
    await page.getByRole("button", { name: "Project alpha" }).click();

    // The expansion must survive the remount.
    await expect(
      page.getByRole("button", { name: "App.tsx", exact: true }),
    ).toBeVisible();
  });

  test("previews markdown files from a code viewer tab", async ({
    page,
    tauri,
  }) => {
    const repo = "/tmp/demo";

    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", []);
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo") {
        return { repo_root: "/tmp/demo", entries: [] };
      }
      return {
        repo_root: "/tmp/demo",
        entries: [
          {
            name: "README.md",
            path: "/tmp/demo/README.md",
            is_dir: false,
            is_symlink: false,
            size: 40,
            modified_ms: 0,
            gitignored: false,
          },
        ],
      };
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo/README.md") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "# Project notes\n\n- [x] Markdown preview",
        size: 40,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "README.md" }).dblclick();

    await expect(
      page.getByRole("button", { name: /README\.md Close tab/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Project notes" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Preview" }).click();

    await expect(
      page.getByRole("heading", { name: "Project notes" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Source" })).toBeVisible();
    await expect(page.getByText("Markdown preview")).toBeVisible();

    await pressHotkey(page, { mod: true, key: "f" });
    await page.getByLabel("Find in file").fill("preview");

    await expect(page.locator("[data-acorn-preview-search]")).toHaveCount(1);
    await expect(page.getByText("1/1")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Project notes" }),
    ).toBeVisible();
  });

  test("opens media files from the file explorer in a media viewer", async ({
    page,
    tauri,
  }) => {
    const repo = "/tmp/demo";

    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", []);
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo") {
        return { repo_root: "/tmp/demo", entries: [] };
      }
      return {
        repo_root: "/tmp/demo",
        entries: [
          {
            name: "logo.png",
            path: "/tmp/demo/logo.png",
            is_dir: false,
            is_symlink: false,
            size: 512,
            modified_ms: 0,
            gitignored: false,
          },
          {
            name: "spec.pdf",
            path: "/tmp/demo/spec.pdf",
            is_dir: false,
            is_symlink: false,
            size: 1024,
            modified_ms: 0,
            gitignored: false,
          },
        ],
      };
    });
    await tauri.handle("fs_prepare_asset", (args) => {
      const { path } = args as { path: string };
      if (path === "/tmp/demo/logo.png") return { size: 512 };
      if (path === "/tmp/demo/spec.pdf") return { size: 1024 };
      throw new Error(`unexpected media path: ${path}`);
    });
    await tauri.handle("fs_read_file", () => {
      throw new Error("media files should not be read as text");
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "logo.png" }).dblclick();

    await expect(
      page.getByRole("button", { name: /logo\.png Close tab/ }),
    ).toBeVisible();
    await expect(
      page.locator('[data-acorn-media-viewer="image"]'),
    ).toBeVisible();
    await expect(page.locator('img[alt="logo.png"]')).toHaveAttribute(
      "src",
      /%2Ftmp%2Fdemo%2Flogo\.png/,
    );
    await expect(
      page.locator('[data-acorn-media-viewer="image"]'),
    ).toHaveAttribute("data-acorn-media-zoom", "1");

    await page.getByRole("button", { name: "Zoom in" }).click();

    await expect(
      page.locator('[data-acorn-media-viewer="image"]'),
    ).toHaveAttribute("data-acorn-media-zoom", "1.25");
    await expect(page.locator('img[alt="logo.png"]')).toHaveAttribute(
      "style",
      /scale\(1\.25\)/,
    );

    await page.getByRole("button", { name: "Reset zoom" }).click();

    await expect(
      page.locator('[data-acorn-media-viewer="image"]'),
    ).toHaveAttribute("data-acorn-media-zoom", "1");

    await page.getByRole("button", { name: "spec.pdf" }).dblclick();

    await expect(
      page.getByRole("button", { name: /spec\.pdf Close tab/ }),
    ).toBeVisible();
    await expect(
      page.locator('[data-acorn-media-viewer="pdf"]'),
    ).toBeVisible();
    await expect(page.locator('iframe[title="spec.pdf"]')).toHaveAttribute(
      "src",
      /%2Ftmp%2Fdemo%2Fspec\.pdf/,
    );
  });

  test("finds matches inside a code viewer tab", async ({ page, tauri }) => {
    const repo = "/tmp/demo";

    await tauri.respond("list_projects", [
      {
        repo_path: repo,
        name: "demo",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
    ]);
    await tauri.respond("list_sessions", []);
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo") {
        return { repo_root: "/tmp/demo", entries: [] };
      }
      return {
        repo_root: "/tmp/demo",
        entries: [
          {
            name: "search.txt",
            path: "/tmp/demo/search.txt",
            is_dir: false,
            is_symlink: false,
            size: 28,
            modified_ms: 0,
            gitignored: false,
          },
        ],
      };
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/demo/search.txt") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "alpha\nbeta alpha\nALPHA",
        size: 22,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "search.txt" }).dblclick();
    await expect(
      page.getByRole("button", { name: /search\.txt Close tab/ }),
    ).toBeVisible();

    await pressHotkey(page, { mod: true, key: "f" });
    await page.getByLabel("Find in file").fill("alpha");

    await expect(page.locator("mark")).toHaveCount(3);
    await expect(page.getByText("1/3")).toBeVisible();

    await page.getByLabel("Find in file").press("Enter");
    await expect(page.getByText("2/3")).toBeVisible();
  });

  test("reopens a worktree file tab after switching away and back to its project", async ({
    page,
    tauri,
  }) => {
    const repoA = "/tmp/alpha";
    const repoB = "/tmp/beta";
    const worktreeA = "/tmp/alpha/.worktrees/a-session";

    await tauri.respond("list_projects", [
      {
        repo_path: repoA,
        name: "alpha",
        created_at: "2026-01-01T00:00:00Z",
        position: 0,
      },
      {
        repo_path: repoB,
        name: "beta",
        created_at: "2026-01-01T00:00:00Z",
        position: 1,
      },
    ]);
    await tauri.respond("list_sessions", [
      {
        id: "a-session",
        name: "a-session",
        repo_path: repoA,
        worktree_path: worktreeA,
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
      {
        id: "b-session",
        name: "b-session",
        repo_path: repoB,
        worktree_path: "/tmp/beta/.worktrees/b-session",
        branch: "main",
        isolated: false,
        status: "ready",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("fs_list_dir", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/alpha/.worktrees/a-session") {
        return { repo_root: path, entries: [] };
      }
      return {
        repo_root: "/tmp/alpha/.worktrees/a-session",
        entries: [
          {
            name: "README.md",
            path: "/tmp/alpha/.worktrees/a-session/README.md",
            is_dir: false,
            is_symlink: false,
            size: 28,
            modified_ms: 0,
            gitignored: false,
          },
        ],
      };
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/tmp/alpha/.worktrees/a-session/README.md") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "# Alpha README\n\nProject A notes",
        size: 28,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Files", exact: true }).click();

    await page.getByRole("button", { name: "README.md" }).dblclick();
    await expect(
      page.getByRole("button", { name: /README\.md Close tab/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: /a-session Close session/ }).click();
    await page.getByRole("button", { name: "Project beta" }).click();
    await page.getByRole("button", { name: "Project alpha" }).click();
    await page.getByRole("button", { name: /README\.md Close tab/ }).click();

    await expect(page.getByRole("button", { name: "Preview" })).toBeVisible();
  });
});
