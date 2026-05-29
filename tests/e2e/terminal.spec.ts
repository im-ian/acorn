import { test, expect, pressHotkey, type Page } from "./support";
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

async function emitSubscribedPtyOutput(
  page: Page,
  channelIdKey: string,
  text: string,
): Promise<void> {
  await page.evaluate(
    ({ channelIdKey, text }) => {
      const w = window as unknown as {
        [key: string]: unknown;
      };
      const id = w[channelIdKey];
      if (typeof id !== "number") {
        throw new Error(`missing terminal output channel: ${channelIdKey}`);
      }
      const callback = w[`_${id}`] as
        | ((payload: { index: number; message: number[] }) => void)
        | undefined;
      if (!callback) throw new Error("missing terminal output callback");
      callback({
        index: 0,
        message: Array.from(new TextEncoder().encode(text)),
      });
    },
    { channelIdKey, text },
  );
}

async function terminalTextAndUnderlineRects(
  page: Page,
  text: string,
): Promise<{
  text: { top: number; bottom: number; left: number; width: number };
  underline: { top: number; bottom: number; left: number; width: number };
} | null> {
  return page.evaluate((target) => {
    const toPlainRect = (rect: DOMRect) => ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
    });
    const underline = document.querySelector<HTMLElement>(
      '[data-acorn-terminal-link-underline="true"]',
    );
    if (!underline) return null;

    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(".xterm-rows > div"),
    )) {
      const rowText = row.textContent ?? "";
      const start = rowText.indexOf(target);
      if (start < 0) continue;

      const end = start + target.length;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let startSet = false;
      let endSet = false;

      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const textLength = node.textContent?.length ?? 0;
        const nextOffset = offset + textLength;
        if (!startSet && start <= nextOffset) {
          range.setStart(node, Math.max(0, start - offset));
          startSet = true;
        }
        if (startSet && end <= nextOffset) {
          range.setEnd(node, Math.max(0, end - offset));
          endSet = true;
          break;
        }
        offset = nextOffset;
      }

      if (!startSet || !endSet) {
        range.detach();
        return null;
      }

      const textRect = range.getBoundingClientRect();
      range.detach();
      return {
        text: toPlainRect(textRect),
        underline: toPlainRect(underline.getBoundingClientRect()),
      };
    }

    return null;
  }, text);
}

async function terminalEmojiTrailingOffsets(page: Page): Promise<{
  cellWidth: number;
  offsets: Record<string, number>;
}> {
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(".xterm-rows > div"),
    );
    const rowFor = (marker: string) => {
      const row = rows.find((candidate) =>
        (candidate.textContent ?? "").includes(marker),
      );
      if (!row) throw new Error(`missing terminal row: ${marker}`);
      return row;
    };
    const rangeRect = (
      row: HTMLElement,
      start: number,
      end: number,
    ): DOMRect => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      let offset = 0;
      let startSet = false;
      let endSet = false;

      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const textLength = node.textContent?.length ?? 0;
        const nextOffset = offset + textLength;
        if (!startSet && start <= nextOffset) {
          range.setStart(node, Math.max(0, start - offset));
          startSet = true;
        }
        if (startSet && end <= nextOffset) {
          range.setEnd(node, Math.max(0, end - offset));
          endSet = true;
          break;
        }
        offset = nextOffset;
      }

      if (!startSet || !endSet) {
        range.detach();
        throw new Error("missing terminal text range");
      }
      const rect = range.getBoundingClientRect();
      range.detach();
      return rect;
    };
    const characterRect = (row: HTMLElement, index: number) =>
      rangeRect(row, index, index + 1);
    const trailingOffset = (marker: string): number => {
      const row = rowFor(marker);
      const text = row.textContent ?? "";
      const markerStart = text.indexOf(marker);
      const aStart = markerStart + marker.length;
      const bStart = text.indexOf("B", aStart + 1);
      if (markerStart < 0 || bStart < 0) {
        throw new Error(`missing A/B cells for ${marker}`);
      }
      return characterRect(row, bStart).left - characterRect(row, aStart).left;
    };
    const refRow = rowFor("R: AB");
    const refText = refRow.textContent ?? "";
    const refA = refText.indexOf("A");
    const refB = refText.indexOf("B", refA + 1);
    if (refA < 0 || refB < 0) throw new Error("missing reference cells");

    return {
      cellWidth:
        characterRect(refRow, refB).left - characterRect(refRow, refA).left,
      offsets: {
        heart: trailingOffset("H: "),
        skinTone: trailingOffset("S: "),
        zwj: trailingOffset("Z: "),
      },
    };
  });
}

async function installOversizedEmojiMeasurement(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    const originalGet = descriptor?.get;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        const element = this as HTMLElement;
        if (
          element.classList.contains("xterm-char-measure-element") &&
          (element.textContent ?? "").includes("🦊")
        ) {
          return 32 * 24;
        }
        return originalGet?.call(this) ?? 0;
      },
    });
  });
}

async function enableCjkCellWidthHeuristic(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "acorn:settings:v1",
      JSON.stringify({
        experiments: { cjkCellWidthHeuristic: true },
      }),
    );
  });
}

async function terminalEmojiLetterSpacing(
  page: Page,
  marker: string,
  emoji: string,
): Promise<number> {
  return page.evaluate(
    ({ marker, emoji }) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(".xterm-rows > div"),
      ).find((candidate) => (candidate.textContent ?? "").includes(marker));
      if (!row) throw new Error(`missing terminal row: ${marker}`);

      const span = Array.from(row.querySelectorAll<HTMLElement>("span")).find(
        (candidate) => (candidate.textContent ?? "").includes(emoji),
      );
      if (!span) throw new Error(`missing emoji span: ${emoji}`);

      const parsed = Number.parseFloat(
        window.getComputedStyle(span).letterSpacing,
      );
      return Number.isFinite(parsed) ? parsed : 0;
    },
    { marker, emoji },
  );
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

  test("renders emoji grapheme clusters as two-cell terminal glyphs", async ({
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __emojiWidthChannelId?: number;
      };
      w.__emojiWidthChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __emojiWidthChannelId?: number })
              .__emojiWidthChannelId ?? null,
        ),
      )
      .not.toBeNull();

    await emitSubscribedPtyOutput(
      page,
      "__emojiWidthChannelId",
      [
        "R: AB",
        'Q: "🦊🌪️⚡🎸🚀🐙🧻🎲🦕"Z',
        "H: A\u2764\uFE0FB",
        "S: A\u{1F44D}\u{1F3FD}B",
        "Z: A\u{1F9D1}\u200D\u{1F4BB}B",
      ].join("\r\n") + "\r\n",
    );
    await expect(page.locator(".xterm-rows")).toContainText("Z: A");

    const { cellWidth, offsets } = await terminalEmojiTrailingOffsets(page);
    const expected = cellWidth * 3;
    for (const offset of Object.values(offsets)) {
      expect(Math.abs(offset - expected)).toBeLessThan(cellWidth * 0.35);
    }
  });

  test("keeps oversized emoji font measurements on the terminal grid", async ({
    page,
    tauri,
  }) => {
    await installOversizedEmojiMeasurement(page);
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __emojiOverhangChannelId?: number;
      };
      w.__emojiOverhangChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __emojiOverhangChannelId?: number })
              .__emojiOverhangChannelId ?? null,
        ),
      )
      .not.toBeNull();

    await emitSubscribedPtyOutput(
      page,
      "__emojiOverhangChannelId",
      "E: A🦊B\r\n",
    );
    await expect(page.locator(".xterm-rows")).toContainText("E: A");

    const spacing = await terminalEmojiLetterSpacing(page, "E: A", "🦊");
    expect(spacing).toBeLessThan(-1);
  });

  test("keeps oversized emoji measurements on the terminal grid with CJK width heuristic enabled", async ({
    page,
    tauri,
  }) => {
    await enableCjkCellWidthHeuristic(page);
    await installOversizedEmojiMeasurement(page);
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __emojiOverhangCjkChannelId?: number;
      };
      w.__emojiOverhangCjkChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __emojiOverhangCjkChannelId?: number })
              .__emojiOverhangCjkChannelId ?? null,
        ),
      )
      .not.toBeNull();

    await emitSubscribedPtyOutput(
      page,
      "__emojiOverhangCjkChannelId",
      "E: A🦊B\r\n",
    );
    await expect(page.locator(".xterm-rows")).toContainText("E: A");

    const spacing = await terminalEmojiLetterSpacing(page, "E: A", "🦊");
    expect(spacing).toBeLessThan(-1);
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
    await tauri.handle("fs_file_exists", (args) => {
      const { path } = args as { path: string };
      const w = window as unknown as { __fsFileExistsCalls?: string[] };
      w.__fsFileExistsCalls = [...(w.__fsFileExistsCalls ?? []), path];
      return path === "/tmp/demo/src/components/FolderPermissionWarmupModal.tsx";
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as unknown as { __fsFileExistsCalls?: string[] })
              .__fsFileExistsCalls ?? []
          ).includes("/tmp/demo/src/components/FolderPermissionWarmupModal.tsx"),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(30);
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
    await tauri.handle("fs_file_exists", (args) => {
      const { path } = args as { path: string };
      const w = window as unknown as { __fsFileExistsCalls?: string[] };
      w.__fsFileExistsCalls = [...(w.__fsFileExistsCalls ?? []), path];
      return path === "/tmp/demo/.claude/rules/typescript/coding-style.md";
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as unknown as { __fsFileExistsCalls?: string[] })
              .__fsFileExistsCalls ?? []
          ).includes("/tmp/demo/.claude/rules/typescript/coding-style.md"),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(30);
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

  test("opens home-relative terminal file links in the code viewer", async ({
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
    await tauri.handle("plugin:path|resolve_directory", () => "/Users/tester");
    await tauri.handle("pty_spawn", () => null);
    await tauri.handle("pty_cwd", () => "/tmp/demo");
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __homeFileLinkChannelId?: number;
        [key: string]: unknown;
      };
      w.__homeFileLinkChannelId = channel.id;
      return 1;
    });
    await tauri.handle("fs_file_exists", (args) => {
      const { path } = args as { path: string };
      const w = window as unknown as { __fsFileExistsCalls?: string[] };
      w.__fsFileExistsCalls = [...(w.__fsFileExistsCalls ?? []), path];
      return path === "/Users/tester/projects/acorn/src/App.tsx";
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (path !== "/Users/tester/projects/acorn/src/App.tsx") {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "home-relative file link\nresolved target",
        size: 48,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __homeFileLinkChannelId?: number })
              .__homeFileLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const linkText = "~/projects/acorn/src/App.tsx:2";
    await emitSubscribedPtyOutput(
      page,
      "__homeFileLinkChannelId",
      `${linkText}\r\n`,
    );
    await expect(page.locator(".xterm")).toContainText(linkText);

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 36, screenBox!.y + 10);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as unknown as { __fsFileExistsCalls?: string[] })
              .__fsFileExistsCalls ?? []
          ).includes("/Users/tester/projects/acorn/src/App.tsx"),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(30);
    await page.mouse.click(screenBox!.x + 36, screenBox!.y + 10);

    await expect(
      page.getByRole("button", {
        name: /App\.tsx Close tab/,
      }),
    ).toBeVisible();
    await expect(page.locator('[data-acorn-target-line="true"]')).toContainText(
      "resolved target",
    );
  });

  test("opens repo-root Acorn worktree file links from a worktree cwd", async ({
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
        worktree_path: "/tmp/demo/.acorn/worktrees/current",
        branch: "main",
        isolated: false,
        status: "idle",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:05Z",
        last_message: null,
      },
    ]);
    await tauri.handle("pty_spawn", () => null);
    await tauri.handle(
      "pty_cwd",
      () => "/tmp/demo/.acorn/worktrees/current/src",
    );
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __repoRootFileLinkChannelId?: number;
        [key: string]: unknown;
      };
      w.__repoRootFileLinkChannelId = channel.id;
      return 1;
    });
    await tauri.handle("fs_file_exists", (args) => {
      const { path } = args as { path: string };
      const w = window as unknown as { __fsFileExistsCalls?: string[] };
      w.__fsFileExistsCalls = [...(w.__fsFileExistsCalls ?? []), path];
      return (
        path === "/tmp/demo/.acorn/worktrees/other/src/components/RightPanel.tsx"
      );
    });
    await tauri.handle("fs_read_file", (args) => {
      const { path } = args as { path: string };
      if (
        path !== "/tmp/demo/.acorn/worktrees/other/src/components/RightPanel.tsx"
      ) {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        content: "repo-root worktree link\nresolved target",
        size: 48,
        truncated: false,
        binary: false,
      };
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __repoRootFileLinkChannelId?: number })
              .__repoRootFileLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const linkText =
      ".acorn/worktrees/other/src/components/RightPanel.tsx:2";
    await emitSubscribedPtyOutput(
      page,
      "__repoRootFileLinkChannelId",
      `${linkText}\r\n`,
    );
    await expect(page.locator(".xterm")).toContainText(linkText);

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as unknown as { __fsFileExistsCalls?: string[] })
              .__fsFileExistsCalls ?? []
          ).includes(
            "/tmp/demo/.acorn/worktrees/other/src/components/RightPanel.tsx",
          ),
        ),
      )
      .toBe(true);
    await page.waitForTimeout(30);
    await page.mouse.click(screenBox!.x + 12, screenBox!.y + 10);

    await expect(
      page.getByRole("button", {
        name: /RightPanel\.tsx Close tab/,
      }),
    ).toBeVisible();
    await expect(page.locator('[data-acorn-target-line="true"]')).toContainText(
      "resolved target",
    );
  });

  test("does not underline or open missing file terminal links", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ terminal: { linkActivation: "modifier-click" } }),
      );
    });
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
        __missingFileLinkChannelId?: number;
        [key: string]: unknown;
      };
      w.__missingFileLinkChannelId = channel.id;
      return 1;
    });
    await tauri.handle("fs_file_exists", (args) => {
      const { path } = args as { path: string };
      const w = window as unknown as { __fsFileExistsCalls?: string[] };
      w.__fsFileExistsCalls = [...(w.__fsFileExistsCalls ?? []), path];
      return false;
    });
    await tauri.handle("fs_read_file", () => {
      throw new Error("missing file link should not be opened");
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __missingFileLinkChannelId?: number })
              .__missingFileLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const linkText = "src/missing-file.tsx:10";
    await emitSubscribedPtyOutput(
      page,
      "__missingFileLinkChannelId",
      `${linkText}\r\n`,
    );
    await expect(page.locator(".xterm")).toContainText(linkText);

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as unknown as { __fsFileExistsCalls?: string[] })
              .__fsFileExistsCalls ?? []
          ).includes("/tmp/demo/src/missing-file.tsx"),
        ),
      )
      .toBe(true);
    await expect(
      page.locator('[data-acorn-terminal-link-underline="true"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("tooltip", { name: /to open link/ }),
    ).toHaveCount(0);

    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.down(modifier);
    await page.mouse.click(screenBox!.x + 12, screenBox!.y + 10);
    await page.keyboard.up(modifier);
    await page.waitForTimeout(150);

    await expect(
      page.getByRole("button", {
        name: /missing-file\.tsx Close tab/,
      }),
    ).toHaveCount(0);
  });

  test("keeps modifier-click link tooltip mounted while output streams", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ terminal: { linkActivation: "modifier-click" } }),
      );
    });
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __linkTooltipChannelId?: number;
      };
      w.__linkTooltipChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __linkTooltipChannelId?: number })
              .__linkTooltipChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const url = "https://example.test/docs";
    await emitSubscribedPtyOutput(
      page,
      "__linkTooltipChannelId",
      `${url}\r\n`,
    );
    await expect(page.locator(".xterm")).toContainText(url);

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);

    const tooltip = page.getByRole("tooltip", { name: /to open link/ });
    await expect(tooltip).toBeVisible();
    const underline = page.locator(
      '[data-acorn-terminal-link-underline="true"]',
    );
    await expect(underline).toHaveCount(1);
    await expect(underline.first()).toBeVisible();
    const countXtermUnderlines = () =>
      page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll<HTMLElement>(".xterm-rows span"),
          ).filter((el) =>
            getComputedStyle(el).textDecorationLine.includes("underline"),
          ).length,
      );
    await expect.poll(countXtermUnderlines).toBe(0);
    const initialTooltipPosition = await tooltip.evaluate((el) => ({
      top: (el as HTMLElement).style.top,
      left: (el as HTMLElement).style.left,
    }));
    const initialUnderlinePosition = await underline.first().evaluate((el) => ({
      top: (el as HTMLElement).style.top,
      left: (el as HTMLElement).style.left,
      width: (el as HTMLElement).style.width,
    }));

    await page.evaluate(() => {
      const w = window as unknown as {
        __tooltipRemovalCount?: number;
        __tooltipObserver?: MutationObserver;
      };
      w.__tooltipRemovalCount = 0;
      w.__tooltipObserver?.disconnect();
      w.__tooltipObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.removedNodes)) {
            if (
              node instanceof HTMLElement &&
              node.getAttribute("role") === "tooltip"
            ) {
              w.__tooltipRemovalCount = (w.__tooltipRemovalCount ?? 0) + 1;
            }
          }
        }
      });
      w.__tooltipObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });

    for (let i = 0; i < 5; i += 1) {
      await emitSubscribedPtyOutput(page, "__linkTooltipChannelId", ".");
      await page.waitForTimeout(30);
      await expect(tooltip).toBeVisible();
      await expect(underline).toHaveCount(1);
      await expect(underline.first()).toBeVisible();
      await expect
        .poll(() =>
          tooltip.evaluate((el) => ({
            top: (el as HTMLElement).style.top,
            left: (el as HTMLElement).style.left,
          })),
        )
        .toEqual(initialTooltipPosition);
      await expect
        .poll(() =>
          underline.first().evaluate((el) => ({
            top: (el as HTMLElement).style.top,
            left: (el as HTMLElement).style.left,
            width: (el as HTMLElement).style.width,
          })),
        )
        .toEqual(initialUnderlinePosition);
      await expect.poll(countXtermUnderlines).toBe(0);
    }

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __tooltipRemovalCount?: number })
              .__tooltipRemovalCount ?? 0,
        ),
      )
      .toBe(0);
    await page.evaluate(() => {
      (window as unknown as { __tooltipObserver?: MutationObserver })
        .__tooltipObserver?.disconnect();
    });
  });

  test("shows stable hover underline for OSC URI terminal links", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ terminal: { linkActivation: "modifier-click" } }),
      );
    });
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __oscLinkChannelId?: number;
      };
      w.__oscLinkChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __oscLinkChannelId?: number })
              .__oscLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const label = "OSC URI";
    await emitSubscribedPtyOutput(
      page,
      "__oscLinkChannelId",
      `\x1b]8;;https://example.test/osc\x1b\\${label}\x1b]8;;\x1b\\\r\n`,
    );
    await expect(page.locator(".xterm")).toContainText(label);

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);

    await expect(
      page.getByRole("tooltip", { name: /to open link/ }),
    ).toBeVisible();
    await expect(
      page.locator('[data-acorn-terminal-link-underline="true"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Array.from(
              document.querySelectorAll<HTMLElement>(".xterm-rows span"),
            ).filter((el) =>
              getComputedStyle(el).textDecorationLine.includes("underline"),
            ).length,
        ),
      )
      .toBeGreaterThanOrEqual(1);
  });

  test("positions link hover underline with app UI scale", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({
          appearance: { uiScalePercent: 125 },
          terminal: { linkActivation: "modifier-click" },
        }),
      );
    });
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __scaledLinkChannelId?: number;
      };
      w.__scaledLinkChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--acorn-ui-scale"),
        ),
      )
      .toBe("1.25");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __scaledLinkChannelId?: number })
              .__scaledLinkChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const url = "https://example.test/scaled";
    await emitSubscribedPtyOutput(
      page,
      "__scaledLinkChannelId",
      `${url}\r\n`,
    );
    await expect(page.locator(".xterm")).toContainText(url);

    const screenBox = await page.locator(".xterm-screen").boundingBox();
    expect(screenBox).not.toBeNull();
    await page.mouse.move(screenBox!.x + 12, screenBox!.y + 10);

    const underline = page.locator(
      '[data-acorn-terminal-link-underline="true"]',
    );
    await expect(underline).toHaveCount(1);
    await expect(underline.first()).toBeVisible();
    await expect
      .poll(() =>
        underline.first().evaluate((el) => el.parentElement === document.body),
      )
      .toBe(true);

    const rects = await terminalTextAndUnderlineRects(page, url);
    expect(rects).not.toBeNull();
    expect(Math.abs(rects!.underline.left - rects!.text.left)).toBeLessThan(2);
    expect(Math.abs(rects!.underline.width - rects!.text.width)).toBeLessThan(
      2,
    );
    expect(
      Math.abs(rects!.underline.top - (rects!.text.bottom - 1)),
    ).toBeLessThan(2);
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

  test("conversation shortcuts move through terminal conversation prompts", async ({
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
    await tauri.handle("pty_subscribe_output", (args) => {
      const { channel } = args as { channel: { id: number } };
      const w = window as unknown as {
        __conversationNavChannelId?: number;
        [key: string]: unknown;
      };
      w.__conversationNavChannelId = channel.id;
      return 1;
    });

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __conversationNavChannelId?: number })
              .__conversationNavChannelId ?? null,
        ),
      )
      .not.toBeNull();

    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`intro ${i}`);
    lines.push("> first prompt");
    for (let i = 0; i < 18; i++) lines.push(`first answer ${i}`);
    lines.push("> second prompt");
    for (let i = 0; i < 18; i++) lines.push(`second answer ${i}`);
    lines.push("> third prompt");
    for (let i = 0; i < 36; i++) lines.push(`tail ${i}`);
    await emitSubscribedPtyOutput(
      page,
      "__conversationNavChannelId",
      lines.join("\r\n") + "\r\n",
    );
    await expect(page.locator(".xterm-rows")).toContainText("tail 35");

    await page.locator(".xterm-helper-textarea").focus();
    await pressHotkey(page, { mod: true, alt: true, key: "ArrowUp" });
    await expect(page.locator(".xterm-rows")).toContainText("third prompt");

    await pressHotkey(page, { mod: true, alt: true, key: "ArrowUp" });
    await expect(page.locator(".xterm-rows")).toContainText("second prompt");

    await pressHotkey(page, { mod: true, alt: true, key: "ArrowDown" });
    await expect(page.locator(".xterm-rows")).toContainText("third prompt");

    await pressHotkey(page, { mod: true, alt: true, key: "ArrowDown" });
    await expect(page.locator(".xterm-rows")).toContainText("tail 35");
  });

  test("global modifier shortcuts are claimed before terminal key listeners", async ({
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

    await page.goto("/");
    await page
      .getByRole("button", { name: /^shell main · Idle$/ })
      .click();
    await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });

    const result = await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        ".xterm-helper-textarea",
      );
      if (!textarea) throw new Error("xterm helper textarea missing");

      let descendantListenerRan = false;
      textarea.addEventListener(
        "keydown",
        () => {
          descendantListenerRan = true;
        },
        { capture: true, once: true },
      );

      const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const canceled = !textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "e",
          code: "KeyE",
          metaKey: isMac,
          ctrlKey: !isMac,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      return { canceled, descendantListenerRan };
    });

    expect(result).toEqual({
      canceled: true,
      descendantListenerRan: false,
    });
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
