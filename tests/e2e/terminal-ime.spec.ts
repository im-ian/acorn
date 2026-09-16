import { test, expect, type Page } from "./support";
import type { TauriMock } from "./support";

// Regression coverage for PR #104 — "fix(terminal): unify IME commit path,
// fix duplicate syllable on space".
//
// The bug: composing Korean text via Family B event shapes
// (insertText / insertReplacementText) and then pressing space — a terminator
// that on macOS Family A also fires `insertFromComposition` *after* the
// terminator-keydown flushes the syllable. Pre-#104 both paths emitted the
// same syllable, so `한 ` arrived at the PTY as `한한 `.
//
// The fix: a single `composing` flag + idempotent `commitComposition()`.
// Whichever path commits first wins; the second call is a no-op.
//
// These tests drive synthetic IME `InputEvent`s on xterm's
// `.xterm-helper-textarea` (the same target macOS WKWebView writes into) and
// inspect the recorded `pty_write` invocations to assert the syllable lands
// exactly once.

interface ImeKeydown {
  type: "keydown";
  key: string;
  keyCode?: number;
  /** Pre-set the textarea, as the browser does before dispatching the key. */
  taValue?: string;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

interface ImeInput {
  type: "input";
  inputType: string;
  data?: string | null;
  /** Pre-set the textarea value to mimic what the browser would have written. */
  taValue?: string;
}

type ImeStep = ImeKeydown | ImeInput;

async function seed(tauri: TauriMock): Promise<void> {
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
      id: "s-ime",
      name: "shell",
      repo_path: "/tmp/demo",
      worktree_path: "/tmp/demo",
      branch: "main",
      isolated: false,
      status: "ready",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
    },
  ]);
  // Spawn is a no-op for these tests — we only care about pty_write.
  await tauri.handle("pty_spawn", () => null);
  await tauri.handle("pty_subscribe_output", (args: unknown) => {
    const { channel } = args as { channel: { id: number } };
    const w = window as unknown as { __imeOutputChannelId?: number };
    w.__imeOutputChannelId = channel.id;
    return 1;
  });
  // Record every pty_write call as a decoded UTF-8 string on `window`.
  // Handlers are serialized into page context — no closures over Node-side
  // helpers, so the base64 decode is inlined here.
  await tauri.handle("pty_write", (args: unknown) => {
    const w = window as unknown as { __ptyWrites?: string[] };
    w.__ptyWrites = w.__ptyWrites ?? [];
    const { data } = args as { data: string };
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    w.__ptyWrites.push(new TextDecoder().decode(bytes));
    return null;
  });
}

async function activateTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("button", { name: /^shell main · Ready$/ })
    .click();
  // xterm renders its hidden helper textarea once `term.open(container)` runs.
  // The element is intentionally off-screen ("hidden" to Playwright) — wait
  // for attachment, not visibility.
  await page.locator(".xterm-helper-textarea").waitFor({ state: "attached" });
  // Let listen() callbacks attach and any scrollback_load -> spawnPty chain
  // settle so stray initial pty_write events do not bleed into our captures.
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    (window as unknown as { __ptyWrites?: string[] }).__ptyWrites = [];
  });
}

async function runIme(page: Page, steps: ImeStep[]): Promise<void> {
  await page.evaluate((events) => {
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".xterm-helper-textarea",
    );
    if (!ta) throw new Error("xterm helper textarea missing");
    for (const ev of events) {
      if (ev.type === "keydown") {
        if (ev.taValue !== undefined) ta.value = ev.taValue;
        ta.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: ev.key,
            keyCode: ev.keyCode,
            which: ev.keyCode,
            shiftKey: !!ev.shift,
            metaKey: !!ev.meta,
            ctrlKey: !!ev.ctrl,
            altKey: !!ev.alt,
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        if (ev.taValue !== undefined) ta.value = ev.taValue;
        // Chromium's InputEvent constructor accepts the `inputType` dictionary
        // member but does NOT propagate it to the resulting event in this
        // Playwright build — `ev.inputType` ends up as "". Pin it (and `data`)
        // via accessor descriptors so the handler in Terminal.tsx switches on
        // the actual IME shape we want to test.
        const inputEvent = new InputEvent("input", {
          bubbles: true,
          cancelable: false,
        });
        Object.defineProperty(inputEvent, "inputType", {
          get: () => ev.inputType,
        });
        Object.defineProperty(inputEvent, "data", {
          get: () => ev.data ?? null,
        });
        ta.dispatchEvent(inputEvent);
      }
    }
  }, steps);
}

async function getWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __ptyWrites?: string[] }).__ptyWrites ?? [],
  );
}

function countToken(writes: string[], token: string): number {
  const joined = writes.join("");
  if (token.length === 0) return 0;
  let n = 0;
  let from = 0;
  while (from < joined.length) {
    const i = joined.indexOf(token, from);
    if (i < 0) break;
    n += 1;
    from = i + token.length;
  }
  return n;
}

/** Text currently painted by the IME overlay ("" when it is torn down). */
async function imeOverlayText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = document.querySelector<HTMLElement>(
      ".composition-view.active",
    );
    return (
      view?.querySelector<HTMLElement>(".acorn-ime-composition-text")
        ?.textContent ?? ""
    );
  });
}

/** Inline geometry of the cloned line-tail inside the composition overlay. */
async function imeTailBox(
  page: Page,
): Promise<{ text: string; left: string; clipLeft: string }> {
  return page.evaluate(() => {
    const tail = document.querySelector<HTMLElement>(
      ".composition-view.active .acorn-ime-line-tail",
    );
    const clipPath = tail?.style.clipPath ?? "";
    // `inset(0 0 0 0px)` is normalised to `inset(0px)`, so read the last
    // length rather than matching the string the code wrote.
    const parts = clipPath.replace(/inset\(|\)/g, "").trim().split(/\s+/);
    return {
      text: tail?.textContent ?? "",
      left: tail?.style.left ?? "",
      clipLeft: clipPath ? (parts[parts.length - 1] ?? "") : "",
    };
  });
}

async function emitPtyOutput(page: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __imeOutputChannelId?: number })
            .__imeOutputChannelId ?? null,
      ),
    )
    .not.toBeNull();
  await page.evaluate((output) => {
    const w = window as unknown as {
      __imeOutputChannelId?: number;
      __imeOutputIndexByChannel?: Record<number, number>;
      [key: string]: unknown;
    };
    const id = w.__imeOutputChannelId;
    if (typeof id !== "number") throw new Error("IME output channel missing");
    const callback = w[`_${id}`] as
      | ((payload: { index: number; message: number[] }) => void)
      | undefined;
    if (!callback) throw new Error("IME output callback missing");
    // Tauri's Channel reorders by `index` and parks anything out of sequence.
    // The sequence is per channel: a terminal remount re-subscribes with a
    // fresh one that expects to start at 0 again, so carrying a single global
    // counter across it parks every later emit forever.
    const sequences = (w.__imeOutputIndexByChannel ??= {});
    const index = sequences[id] ?? 0;
    sequences[id] = index + 1;
    callback({
      index,
      message: Array.from(new TextEncoder().encode(output)),
    });
  }, text);
}

test.describe("terminal: IME (PR #104 regression)", () => {
  test("mid-line Korean composition stays intact with the pill cursor", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ terminal: { cursorStyle: "pill" } }),
      );
    });
    await seed(tauri);
    await activateTerminal(page);
    await page.addStyleTag({
      content: ":root { --color-accent: rgb(12, 34, 56) !important; }",
    });

    // Render "테스트" and place the terminal cursor immediately before "트".
    await emitPtyOutput(page, "› 테스트\x1b[2D");
    await expect(page.locator(".xterm-rows")).toContainText("› 테스트");

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "한",
      },
    ]);

    const composition = page.locator(".composition-view.active");
    await expect(composition.locator(".acorn-ime-composition-text")).toHaveText(
      "한",
    );
    await expect(composition.locator(".acorn-ime-line-tail")).toHaveText("트");
    await expect(composition).toHaveText("한트");
    await expect(composition.locator(".xterm-cursor")).toHaveCount(0);

    const imeCursor = composition.locator(".acorn-ime-composition-cursor");
    await expect(imeCursor).toHaveAttribute(
      "data-acorn-ime-cursor-style",
      "pill",
    );
    await expect(page.locator(".acorn-terminal")).toHaveClass(
      /acorn-terminal-composing/,
    );

    const cursorLayout = await composition.evaluate((element) => {
      const children = Array.from(element.children) as HTMLElement[];
      const text = element.querySelector<HTMLElement>(
        ".acorn-ime-composition-text",
      );
      const cursor = element.querySelector<HTMLElement>(
        ".acorn-ime-composition-cursor",
      );
      const tail = element.querySelector<HTMLElement>(
        ".acorn-ime-line-tail",
      );
      if (!text || !cursor || !tail) {
        throw new Error("IME composition layout nodes missing");
      }
      const textRect = text.getBoundingClientRect();
      const cursorRect = cursor.getBoundingClientRect();
      const tailRect = tail.getBoundingClientRect();
      const marker = getComputedStyle(cursor, "::after");
      const nativeCursor = document.querySelector<HTMLElement>(
        ".acorn-terminal .xterm-cursor",
      );
      return {
        childClasses: children.map((child) => child.className),
        cellWidth: Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--acorn-ime-cell-width"),
        ),
        textWidth: textRect.width,
        markerBackground: marker.backgroundColor,
        markerHeight: Number.parseFloat(marker.height),
        markerWidth: Number.parseFloat(marker.width),
        nativeCursorOpacity: nativeCursor
          ? getComputedStyle(nativeCursor).opacity
          : null,
        cursorAnchorWidth: cursorRect.width,
        cursorAfterText: Math.abs(cursorRect.left - textRect.right),
        tailAtOrigin: Math.abs(tailRect.left - textRect.left),
        markerLeft: Number.parseFloat(marker.left),
      };
    });

    expect(cursorLayout.childClasses).toEqual([
      "acorn-ime-composition-text",
      "acorn-ime-composition-cursor",
      "acorn-ime-line-tail xterm-rows",
    ]);
    expect(cursorLayout.markerBackground).toBe("rgb(12, 34, 56)");
    expect(cursorLayout.markerWidth).toBe(3);
    expect(cursorLayout.markerHeight).toBeGreaterThan(0);
    expect(cursorLayout.nativeCursorOpacity).toBe("0");
    expect(cursorLayout.cursorAnchorWidth).toBe(0);
    // "한" spends two terminal columns; the preview lays it out on that grid
    // instead of collapsing to the glyph's own advance.
    expect(cursorLayout.textWidth).toBeCloseTo(2 * cursorLayout.cellWidth, 0);
    // Caret follows the composing cells.
    expect(cursorLayout.cursorAfterText).toBeLessThan(0.5);
    expect(cursorLayout.markerLeft).toBeCloseTo(-1, 0);
    // The cloned tail is painted at the cursor column and the composing cells
    // are drawn over its first columns, so pinning it at the overlay origin
    // hides whatever really sits under the cursor — here 트. It stays pinned
    // only while those columns are blank (a TUI box, covered by the test
    // below); with real text there it shifts by the composed width, which is
    // how the line will actually shift once 한 lands.
    expect(cursorLayout.tailAtOrigin).toBeCloseTo(2 * cursorLayout.cellWidth, 0);

    await runIme(page, [
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "한",
        taValue: "한",
      },
    ]);
    // The commit only sends the syllable; the overlay holds it until the echo
    // hands ownership to the xterm buffer.
    await emitPtyOutput(page, "한");
    await expect(page.locator(".acorn-terminal")).not.toHaveClass(
      /acorn-terminal-composing/,
    );
    await expect(imeCursor).toHaveCount(0);
  });

  test("the composing caret sits where the real cursor will land", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await emitPtyOutput(page, "> ");
    await expect(page.locator(".xterm-rows")).toContainText(">");

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "한",
      },
    ]);
    // Measure the caret as rendered, and again with the cell-grid width
    // removed — the difference is what the preview would be off by if it laid
    // the syllable out at the font's natural advance.
    const composing = await page.evaluate(() => {
      const text = document.querySelector<HTMLElement>(
        ".acorn-ime-composition-text",
      );
      const caret = document.querySelector<HTMLElement>(
        ".acorn-ime-composition-cursor",
      );
      if (!text || !caret) throw new Error("IME overlay nodes missing");
      const snapped = caret.getBoundingClientRect().left;
      const cellMarkup = text.innerHTML;
      text.textContent = text.textContent ?? "";
      const naturalAdvance = caret.getBoundingClientRect().left;
      text.innerHTML = cellMarkup;
      return { snapped, naturalAdvance };
    });

    await runIme(page, [
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "한",
        taValue: "한",
      },
    ]);
    await emitPtyOutput(page, "한");
    // Wait on the echo reaching the buffer, not on the overlay clearing — the
    // hold also expires on its own ceiling, which would let the cursor be
    // measured before it ever advanced.
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      "> 한",
    );
    await expect(page.locator(".composition-view.active")).toHaveCount(0);

    const realCursorLeft = await page.evaluate(() => {
      const cursor = document.querySelector<HTMLElement>(
        ".acorn-terminal .xterm-cursor",
      );
      if (!cursor) throw new Error("terminal cursor missing");
      return cursor.getBoundingClientRect().left;
    });

    // The caret *anchor* tracks the cell boundary the real cursor lands on,
    // so committing does not jump the cloned tail. The marker sits 1px inside
    // that boundary via ::after. Laying the preview out at the glyph's
    // natural advance instead lands short, so the caret would visibly jump
    // outward on every echo.
    expect(realCursorLeft - composing.snapped).toBeCloseTo(0, 0);
    // Not asserted as a magnitude: how far short the raw glyph advance falls
    // depends on the CJK font the test browser happens to resolve.
    expect(composing.naturalAdvance).toBeLessThanOrEqual(composing.snapped);
  });

  test("committed syllables stay painted until the PTY echo lands", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await emitPtyOutput(page, "› ");
    await expect(page.locator(".xterm-rows")).toContainText("›");

    const commit = (syllable: string) => [
      { type: "keydown" as const, key: "Process", keyCode: 229 },
      {
        type: "input" as const,
        inputType: "insertCompositionText",
        data: syllable,
        taValue: syllable,
      },
      {
        type: "input" as const,
        inputType: "insertFromComposition",
        data: syllable,
        taValue: syllable,
      },
    ];

    // Without the hold, a committed syllable exists in neither the overlay nor
    // the buffer for a full IPC round trip — the "one syllable behind" gap.
    await runIme(page, commit("안"));
    expect(await imeOverlayText(page)).toBe("안");

    // Typing faster than the echo must accumulate against the same cell, not
    // replace the syllable already in flight.
    await runIme(page, commit("녕"));
    expect(await imeOverlayText(page)).toBe("안녕");
    // Two held syllables span four columns. Laid out as raw text they would
    // bunch to the left of the box and drift away from the committed text.
    const heldLayout = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>(".composition-view")!;
      const text = view.querySelector<HTMLElement>(
        ".acorn-ime-composition-text",
      )!;
      return {
        width: text.getBoundingClientRect().width,
        cellWidth: Number.parseFloat(
          getComputedStyle(view).getPropertyValue("--acorn-ime-cell-width"),
        ),
      };
    });
    expect(heldLayout.width).toBeCloseTo(4 * heldLayout.cellWidth, 0);

    // The echo advances the cursor off the committed cell: the buffer now owns
    // the glyphs, so the overlay must let go instead of double-painting them.
    await emitPtyOutput(page, "안녕");
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    await expect(page.locator(".xterm-rows")).toContainText("› 안녕");

    const writes = await getWrites(page);
    expect(countToken(writes, "안")).toBe(1);
    expect(countToken(writes, "녕")).toBe(1);
  });

  test("hold stays while the next syllable is still composing", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "안",
        taValue: "",
      },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "녕",
        taValue: "녕",
      },
    ]);
    expect(await imeOverlayText(page)).toBe("안녕");

    // Old ceiling was 400ms from the first commit and cleared 안 while 녕
    // was still being composed, so the caret jumped back to the TUI cursor.
    await page.waitForTimeout(600);
    expect(await imeOverlayText(page)).toBe("안녕");
  });

  test("a partial echo releases only the syllables the buffer took over", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);
    await emitPtyOutput(page, "> ");
    await expect(page.locator(".xterm-rows")).toContainText(">");

    const commit = (syllable: string) => [
      { type: "keydown" as const, key: "Process", keyCode: 229 },
      {
        type: "input" as const,
        inputType: "insertCompositionText",
        data: syllable,
        taValue: syllable,
      },
      {
        type: "input" as const,
        inputType: "insertFromComposition",
        data: syllable,
        taValue: syllable,
      },
    ];

    await runIme(page, commit("안"));
    await runIme(page, commit("녕"));
    expect(await imeOverlayText(page)).toBe("안녕");

    // Only the first syllable comes back. Dropping the whole hold here would
    // strand 녕 in neither the overlay nor the buffer until its own echo —
    // exactly the gap the hold exists to close.
    await emitPtyOutput(page, "안");
    await expect.poll(() => imeOverlayText(page)).toBe("녕");
    // `.xterm-rows` alone also matches the overlay's tail view while the
    // composition is live.
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      "> 안",
    );

    await emitPtyOutput(page, "녕");
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      "> 안녕",
    );
  });

  test("composing Hangul does not slide a TUI right border inward", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Grok/Codex/Claude-style chrome: rounded corners on adjacent rows, `│`
    // on the cursor line. Normal buffer — overlay TUIs do not have to enter
    // the alternate screen.
    await emitPtyOutput(page, "╭────╮\r\n│    │\r\n╰────╯\x1b[2;2H");
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      "╭────╮",
    );

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "한",
      },
    ]);

    const composition = page.locator(".composition-view.active");
    await expect(composition.locator(".acorn-ime-composition-text")).toHaveText(
      "한",
    );
    await expect(composition.locator(".acorn-ime-line-tail")).toContainText("│");

    const layout = await composition.evaluate((element) => {
      const text = element.querySelector<HTMLElement>(
        ".acorn-ime-composition-text",
      );
      const tail = element.querySelector<HTMLElement>(".acorn-ime-line-tail");
      if (!text || !tail) throw new Error("IME overlay nodes missing");
      return {
        tailAtOrigin: Math.abs(
          tail.getBoundingClientRect().left - text.getBoundingClientRect().left,
        ),
        textWidth: text.getBoundingClientRect().width,
        cellWidth: Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--acorn-ime-cell-width"),
        ),
      };
    });
    // Tail starts at the cursor column, not after the 2-cell Hangul box.
    expect(layout.tailAtOrigin).toBeLessThan(0.5);
    expect(layout.textWidth).toBeCloseTo(2 * layout.cellWidth, 0);
  });

  test("composition cursor follows an application-owned DECSCUSR shape", async ({
    page,
    tauri,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "acorn:settings:v1",
        JSON.stringify({ terminal: { cursorStyle: "pill" } }),
      );
    });
    await seed(tauri);
    await activateTerminal(page);

    // A foreground TUI selects a steady underline cursor. Its presentation
    // must take precedence over the user's pill fallback during composition.
    await emitPtyOutput(page, "prompt \x1b[4 q");
    const terminal = page.locator(".acorn-terminal");
    await expect(terminal).toHaveAttribute(
      "data-acorn-cursor-application-override",
      "",
    );

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "한",
      },
    ]);

    const imeCursor = page.locator(
      ".composition-view.active .acorn-ime-composition-cursor",
    );
    await expect(imeCursor).toHaveAttribute(
      "data-acorn-ime-cursor-style",
      "underline",
    );
    await expect(
      page.locator(".composition-view.active .acorn-ime-composition-text"),
    ).toHaveCSS("text-decoration-line", "none");
    const marker = await imeCursor.evaluate((element) => {
      const computed = getComputedStyle(element, "::after");
      return {
        bottom: computed.bottom,
        height: computed.height,
        width: Number.parseFloat(computed.width),
      };
    });
    expect(marker.bottom).toBe("0px");
    expect(marker.height).toBe("1px");
    expect(marker.width).toBeGreaterThan(0);
  });

  test("composition preserves the dim color of a prompt placeholder", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    const placeholder = "Use /skills to list available skills";
    // Render the placeholder dimmed, then return to the first placeholder
    // column. This matches agent prompts that paint guidance after the cursor.
    await emitPtyOutput(
      page,
      `› \x1b[2m${placeholder}\x1b[0m\x1b[3G`,
    );
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      placeholder,
    );

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "한",
      },
    ]);

    const colors = await page.evaluate((expectedPlaceholder) => {
      const tailRun = document.querySelector<HTMLElement>(
        ".composition-view.active .acorn-ime-tail-run",
      );
      const sourceRow = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".xterm-screen > .xterm-rows > div",
        ),
      ).find((row) => row.textContent?.includes(expectedPlaceholder));
      const sourceSpan = Array.from(
        sourceRow?.querySelectorAll<HTMLElement>("span") ?? [],
      ).find((span) => span.textContent?.includes("/skills"));
      const compositionText = document.querySelector<HTMLElement>(
        ".composition-view.active .acorn-ime-composition-text",
      );
      if (!tailRun || !sourceSpan || !compositionText) {
        throw new Error("IME placeholder style nodes missing");
      }
      return {
        tailText: tailRun.textContent,
        tail: getComputedStyle(tailRun).color,
        source: getComputedStyle(sourceSpan).color,
        composition: getComputedStyle(compositionText).color,
      };
    }, placeholder);

    expect(colors.tailText).toBe(placeholder);
    expect(colors.tail).toBe(colors.source);
    expect(colors.tail).not.toBe(colors.composition);
  });

  test("composition preserves each ANSI color after the cursor", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await emitPtyOutput(
      page,
      "› \x1b[31mred\x1b[32mgreen\x1b[34mblue\x1b[0m\x1b[3G",
    );
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      "redgreenblue",
    );

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "한",
      },
    ]);

    const colors = await page.evaluate(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".xterm-screen > .xterm-rows > div",
        ),
      ).find((candidate) => candidate.textContent?.includes("redgreenblue"));
      if (!row) throw new Error("colored source row missing");
      const sourceSpans = Array.from(
        row.querySelectorAll<HTMLElement>("span"),
      );
      const sourceColor = (text: string) => {
        const span = sourceSpans.find((candidate) =>
          candidate.textContent?.includes(text),
        );
        if (!span) throw new Error(`colored source span missing: ${text}`);
        return getComputedStyle(span).color;
      };
      const tailRuns = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".composition-view.active .acorn-ime-tail-run",
        ),
      );
      return {
        tailText: tailRuns.map((run) => run.textContent).join(""),
        tail: tailRuns.map((run) => getComputedStyle(run).color),
        source: [sourceColor("ed"), sourceColor("green"), sourceColor("blue")],
      };
    });

    expect(colors.tailText).toBe("redgreenblue");
    expect(colors.tail).toEqual(colors.source);
  });

  test("Korean syllable + spacebar terminator emits the syllable exactly once", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Compose "한" via Family B (insertText) then press space. macOS Family A
    // follows the terminator-keydown with `insertFromComposition` carrying
    // the same syllable. Pre-#104: terminator-keydown flushed via textarea
    // diff AND `insertFromComposition` unconditionally re-emitted ev.data —
    // PTY received "한한". Post-#104: `commitComposition` is idempotent.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "input", inputType: "insertText", data: "한", taValue: "한" },
      { type: "keydown", key: " ", keyCode: 229 },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "한",
        taValue: "",
      },
    ]);

    const writes = await getWrites(page);
    const syllableCount = countToken(writes, "한");
    expect(syllableCount).toBe(1);
    // And the syllable never coalesces into a doubled-up chunk either.
    expect(writes.join("")).not.toContain("한한");
  });

  test("Korean syllable + no-break-space terminator commits the syllable", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "input", inputType: "insertText", data: "한", taValue: "한" },
      { type: "keydown", key: "\u00a0", keyCode: 229 },
      {
        type: "input",
        inputType: "insertText",
        data: "\u00a0",
        taValue: "\u00a0",
      },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "한")).toBe(1);
    expect(writes.join("")).toBe("한 ");
    expect(writes.join("")).not.toContain("한한");
  });

  test("insertFromComposition arriving before any terminator still commits once", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Family A-only path: compose via insertCompositionText (preview only),
    // then macOS delivers the final commit via insertFromComposition with no
    // terminator keydown beforehand. The syllable must still reach the PTY.
    // We leave the helper textarea holding the composed text — `commitComposition`
    // reads the tail past `sentPrefix` as the source of truth.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "안",
      },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "안")).toBe(1);
  });

  test("Shift keydown mid-composition does not flush — ssang-jamo 있 stays joined", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Korean 2-set IME emits Shift before the second jamo of ㅆ. A Shift
    // keydown that flushed the in-flight syllable would commit "이" early,
    // then ㅆ would arrive standalone and the user would see "이ㅆ" instead
    // of "있". The MODIFIER_KEYS guard in onKeydown prevents that.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "이",
        taValue: "이",
      },
      // Shift down — must not commit anything.
      { type: "keydown", key: "Shift", shift: true },
      { type: "keydown", key: "Process", keyCode: 229, shift: true },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "있",
        taValue: "있",
      },
      // Space terminator finalises the full syllable.
      { type: "keydown", key: " ", keyCode: 229 },
    ]);

    const writes = await getWrites(page);
    const joined = writes.join("");
    expect(joined).toContain("있");
    // The bug shape would interleave a premature "이" commit followed by a
    // standalone "ㅆ" — explicitly assert neither slipped through.
    expect(joined).not.toContain("이ㅆ");
    expect(writes).not.toContain("이");
  });

  test("In-syllable backspace under active composition is swallowed (no PTY \\x7f)", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Backspace WHILE composing edits the IME preview ("있" → "이"); the
    // committed "이" must not race a backspace byte to the PTY, or the line
    // ends up in a torn state.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "있",
        taValue: "있",
      },
      // Backspace inside active composition — keyCode 229, ta.value non-empty.
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "이",
        taValue: "이",
      },
    ]);

    const writes = await getWrites(page);
    // 0x7f is what xterm would emit for a non-IME Backspace. Must not appear.
    expect(writes).not.toContain("\x7f");
    // Nor should the in-progress syllable have leaked to the PTY yet.
    expect(writes).not.toContain("있");
    expect(writes).not.toContain("이");
  });

  test("backspacing the last jamo clears the overlay immediately", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // 안 → ㅇ → empty. The last Backspace used to be treated as a terminator
    // that committed ㅇ into the pending-commit hold, so the glyph lingered
    // until the hold timer (400ms) fired.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "",
        taValue: "",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "ㅇ",
        taValue: "",
      },
    ]);

    expect(await imeOverlayText(page)).toBe("");
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    const writes = await getWrites(page);
    expect(writes).not.toContain("안");
    expect(writes).not.toContain("ㅇ");
    expect(writes).not.toContain("\x7f");
  });

  test("insertFromComposition after IME backspace does not hold the last jamo", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Real WKWebView order: Backspace while the textarea still holds ㅇ,
    // then insertFromComposition("ㅇ"), then an empty preview. Committing
    // that compositionend parks ㅇ in the echo-hold until the timer.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "",
        taValue: "",
      },
    ]);

    expect(await imeOverlayText(page)).toBe("");
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    const writes = await getWrites(page);
    expect(writes).not.toContain("안");
    expect(writes).not.toContain("ㅇ");
  });

  test("plain Backspace after IME compositionend does not hold the last jamo", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // After the last jamo is gone, WKWebView may deliver a normal
    // Backspace (keyCode 8). That used to hit the terminator path and
    // commitComposition(), parking ㅇ in the 2s echo-hold.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      { type: "keydown", key: "Backspace", keyCode: 8 },
    ]);

    expect(await imeOverlayText(page)).toBe("");
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    const writes = await getWrites(page);
    expect(writes).not.toContain("ㅇ");
  });

  test("Backspace after IME preview is empty deletes the echoed syllable", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // 안녕하세요 already in the buffer (TUI echo). Decomposing a leftover
    // ㅇ must not leave imeDeleting sticky — the next Backspace has to
    // emit \x7f so 세 can delete.
    await emitPtyOutput(page, "안녕하세요");
    await expect(page.locator(".xterm-screen > .xterm-rows")).toContainText(
      "안녕하세요",
    );

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "",
        taValue: "",
      },
      { type: "keydown", key: "Backspace", keyCode: 8 },
    ]);

    const writes = await getWrites(page);
    expect(writes).toContain("\x7f");
  });

  test("Backspace after decomposing 요 reaches PTY despite leftover ta.value", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Incremental insertText leaves committed syllables in the helper
    // textarea. After 안녕하세요, ta.value is "안녕하세" + composing "요".
    // Treating !!ta.value as a live preview would swallow the Backspace
    // that should delete echoed 세.
    const syllable = (soFar: string, next: string) =>
      [
        { type: "keydown" as const, key: "Process", keyCode: 229 },
        {
          type: "input" as const,
          inputType: "insertText",
          data: next,
          taValue: soFar + next,
        },
      ];

    await runIme(page, [
      ...syllable("", "안"),
      ...syllable("안", "녕"),
      ...syllable("안녕", "하"),
      ...syllable("안녕하", "세"),
      ...syllable("안녕하세", "요"),
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "안녕하세ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "",
        taValue: "안녕하세",
      },
      { type: "keydown", key: "Backspace", keyCode: 8 },
    ]);

    const writes = await getWrites(page);
    expect(writes.join("")).toContain("\x7f");
  });

  test("unmarked trailing jamo from insertReplacementText does not swallow later Backspaces", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Real WKWebView stream (captured 2026-09-14): backspacing 요 fires
    // insertReplacementText("ㅇ") and ENDS the composition — the ㅇ stays
    // in the textarea as plain unmarked text, and every following
    // Backspace arrives as keyCode 8 with NO input event. The swallow
    // must consume the tail from the textarea, or previewTail() stays
    // non-empty and 안녕하세요 never deletes past 요.
    const syllable = (soFar: string, next: string) =>
      [
        { type: "keydown" as const, key: "Process", keyCode: 229 },
        {
          type: "input" as const,
          inputType: "insertText",
          data: next,
          taValue: soFar + next,
        },
      ];

    await runIme(page, [
      ...syllable("", "안"),
      ...syllable("안", "녕"),
      ...syllable("안녕", "하"),
      ...syllable("안녕하", "세"),
      ...syllable("안녕하세", "요"),
      // 요 → ㅇ decomposition: the replacement input precedes its keydown.
      {
        type: "input",
        inputType: "insertReplacementText",
        data: "ㅇ",
        taValue: "안녕하세ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertReplacementText",
        data: "ㅇ",
        taValue: "안녕하세ㅇ",
      },
      // Composition is over; the rest are plain keyCode-8 Backspaces with
      // no input events. First one consumes the leftover ㅇ preview.
      { type: "keydown", key: "Backspace", keyCode: 8 },
      { type: "keydown", key: "Backspace", keyCode: 8 },
      { type: "keydown", key: "Backspace", keyCode: 8 },
      { type: "keydown", key: "Backspace", keyCode: 8 },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "\x7f")).toBe(3);
  });

  test("held Backspace keeps deleting past 요 when keydowns stay keyCode 229", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // xterm's CompositionHelper drops every keyCode-229 keydown, so after
    // composition teardown the handler must emit DEL itself — otherwise
    // holding Backspace deletes 요 and then goes dead (세/하/녕 survive).
    const syllable = (soFar: string, next: string) =>
      [
        { type: "keydown" as const, key: "Process", keyCode: 229 },
        {
          type: "input" as const,
          inputType: "insertText",
          data: next,
          taValue: soFar + next,
        },
      ];

    await runIme(page, [
      ...syllable("", "안"),
      ...syllable("안", "녕"),
      ...syllable("안녕", "하"),
      ...syllable("안녕하", "세"),
      ...syllable("안녕하세", "요"),
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "안녕하세ㅇ",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "",
        taValue: "안녕하세",
      },
      // Auto-repeat continues with the IME keyCode; no input events follow.
      { type: "keydown", key: "Backspace", keyCode: 229 },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      { type: "keydown", key: "Backspace", keyCode: 229 },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "\x7f")).toBe(3);
  });

  test("Alt+Backspace outside composition keeps xterm's ESC DEL mapping", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Word-delete must reach xterm untouched — the IME DEL takeover only
    // owns the plain keyCode-229 case.
    await runIme(page, [
      { type: "keydown", key: "Backspace", keyCode: 8, alt: true },
    ]);

    const writes = await getWrites(page);
    expect(writes.join("")).toContain("\x1b\x7f");
    expect(countToken(writes, "\x7f")).toBe(1);
  });

  test("insertFromComposition of a lone jamo does not echo-hold it", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // WKWebView can fire compositionend(ㅇ) with no Backspace keydown
    // first. That used to commit+hold ㅇ until PENDING_COMMIT_MAX_MS.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "ㅇ",
        taValue: "",
      },
    ]);

    expect(await imeOverlayText(page)).toBe("");
    await expect(page.locator(".composition-view.active")).toHaveCount(0);
    const writes = await getWrites(page);
    // Confirmed jamo (ㅋㅋㅋ, click-away ㅇ) must reach the PTY. The overlay
    // hold is what lingered; a PTY write of ㅇ is normal IME confirm.
    expect(writes).toContain("ㅇ");
  });

  test("NFD Hangul syllable still commits as a precomposed character", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    const nfdAn = "안".normalize("NFD");
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: nfdAn,
        taValue: nfdAn,
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: nfdAn,
        taValue: "",
      },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "안")).toBe(1);
    expect(writes.join("")).not.toContain(nfdAn);
  });

  test("ㅋㅋㅋ via insertFromComposition commits each jamo", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    const jamo = (char: string) =>
      [
        { type: "keydown" as const, key: "Process", keyCode: 229 },
        {
          type: "input" as const,
          inputType: "insertCompositionText",
          data: char,
          taValue: char,
        },
        {
          type: "input" as const,
          inputType: "insertFromComposition",
          data: char,
          taValue: "",
        },
      ];

    await runIme(page, [...jamo("ㅋ"), ...jamo("ㅋ"), ...jamo("ㅋ")]);

    const writes = await getWrites(page);
    expect(countToken(writes, "ㅋ")).toBe(3);
    expect(await imeOverlayText(page)).toBe("");
  });

  test("나나 commits the repeated syllable twice", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    const syllable = (char: string) =>
      [
        { type: "keydown" as const, key: "Process", keyCode: 229 },
        {
          type: "input" as const,
          inputType: "insertCompositionText",
          data: char,
          taValue: char,
        },
        {
          type: "input" as const,
          inputType: "insertFromComposition",
          data: char,
          taValue: "",
        },
      ];

    await runIme(page, [...syllable("나"), ...syllable("나")]);

    const writes = await getWrites(page);
    expect(countToken(writes, "나")).toBe(2);
  });

  test("after decomposing 안 to ㅇ, typing 아 still commits", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      { type: "keydown", key: "Backspace", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "ㅇ",
        taValue: "ㅇ",
      },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "아",
        taValue: "아",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "아",
        taValue: "",
      },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "아")).toBe(1);
    expect(writes).not.toContain("안");
    expect(writes).not.toContain("ㅇ");
  });

  // Verbatim event trace captured from a real macOS Korean 2-set IME inside
  // Acorn's WKWebView (document-capture tracer, 2026-09-15). The production
  // shape has three properties none of the synthetic cases above model:
  //   * `input` lands BEFORE its `keydown`
  //   * no composition events at all — only insertText / insertReplacementText
  //   * the helper textarea accumulates the whole run ("안녕"), never one syllable
  // Growing a syllable in place is insertReplacementText; starting a new one is
  // insertReplacementText(finished syllable) + insertText(new jamo).
  // Removed 2026-09-15: three tests modelled the helper textarea as holding
  // ONE syllable at a time (taValue "안" then "녕"). A verbatim capture from a
  // real macOS Korean IME shows it ACCUMULATES the whole run ("안", "안ㄴ",
  // "안녀", "안녕", "안녕ㅎ", …) and only resets after a terminator. Committing
  // on the replaced-in-place assumption is what shipped 반갑값갑습니다 — the
  // "verbatim WKWebView trace" tests below cover the same scenarios for real.
  test("verbatim WKWebView trace: 안녕 + space sends each syllable once", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㅇ", taValue: "ㅇ" },
      { type: "keydown", key: "ㅇ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "아", taValue: "아" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "안", taValue: "안" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "안", taValue: "안" },
      { type: "input", inputType: "insertText", data: "ㄴ", taValue: "안ㄴ" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녀", taValue: "안녀" },
      { type: "keydown", key: "ㅕ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "안녕" },
      { type: "keydown", key: "ㅇ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "안녕" },
      { type: "keydown", key: " ", keyCode: 32 },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined).toContain("안");
    expect(joined).toContain("녕");
    // The reported symptom: 안 dropped, leaving "녕", and the run re-emitted.
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("안녕");
  });

  test("verbatim WKWebView trace: ㅋㅋㅋ commits every jamo", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Same capture. A repeated jamo never becomes a syllable, so every
    // keystroke is insertText(ㅋ) + insertReplacementText(ㅋ) against a
    // growing textarea. Dropping jamo-only commits collapsed this to one ㅋ.
    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㅋ", taValue: "ㅋ" },
      { type: "keydown", key: "ㅋ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "ㅋ", taValue: "ㅋ" },
      { type: "input", inputType: "insertText", data: "ㅋ", taValue: "ㅋㅋ" },
      { type: "keydown", key: "ㅋ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "ㅋ", taValue: "ㅋㅋ" },
      { type: "input", inputType: "insertText", data: "ㅋ", taValue: "ㅋㅋㅋ" },
      { type: "keydown", key: "ㅋ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "ㅋ", taValue: "ㅋㅋㅋ" },
      { type: "keydown", key: " ", keyCode: 32 },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(countToken(joined.split(""), "ㅋ")).toBe(3);
  });

  test("verbatim WKWebView trace: 반갑습니다 does not re-emit cluster syllables", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Captured with PTY writes interleaved (2026-09-15). 갑 grows a jongseong
    // cluster (갑 → 값) and drops it again (값 → 갑 + 스). Korean NFD keeps the
    // cluster as ONE character — 값 is 값, not 갑+ᄉ — so any "did the syllable
    // advance / decompose" prefix test reads both transitions as a brand new
    // composition and flushes mid-syllable: PTY got 반갑값갑습니다.
    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㅂ", taValue: "ㅂ" },
      { type: "keydown", key: "ㅂ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "바", taValue: "바" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "반", taValue: "반" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "반", taValue: "반" },
      { type: "input", inputType: "insertText", data: "ㄱ", taValue: "반ㄱ" },
      { type: "keydown", key: "ㄱ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "가", taValue: "반가" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "갑", taValue: "반갑" },
      { type: "keydown", key: "ㅂ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "값", taValue: "반값" },
      { type: "keydown", key: "ㅅ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "갑", taValue: "반갑" },
      { type: "input", inputType: "insertText", data: "스", taValue: "반갑스" },
      { type: "keydown", key: "ㅡ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "습", taValue: "반갑습" },
      { type: "keydown", key: "ㅂ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "습", taValue: "반갑습" },
      { type: "input", inputType: "insertText", data: "ㄴ", taValue: "반갑습ㄴ" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "니", taValue: "반갑습니" },
      { type: "keydown", key: "ㅣ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "닏", taValue: "반갑습닏" },
      { type: "keydown", key: "ㄷ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "니", taValue: "반갑습니" },
      { type: "input", inputType: "insertText", data: "다", taValue: "반갑습니다" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "다", taValue: "반갑습니다" },
      { type: "keydown", key: " ", keyCode: 32 },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("반갑습니다");
  });

  test("verbatim WKWebView trace: 안녕하세요 + space is not duplicated", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // The terminator flushes `ta.value.slice(sentPrefix)`. Any commit path
    // that sends text without advancing `sentPrefix` leaves the whole run
    // pending, so space re-emitted it: 안녕하세요 안녕하세요.
    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㅇ", taValue: "ㅇ" },
      { type: "keydown", key: "ㅇ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "아", taValue: "아" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "안", taValue: "안" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "안", taValue: "안" },
      { type: "input", inputType: "insertText", data: "ㄴ", taValue: "안ㄴ" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녀", taValue: "안녀" },
      { type: "keydown", key: "ㅕ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "안녕" },
      { type: "keydown", key: "ㅇ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "안녕" },
      { type: "input", inputType: "insertText", data: "ㅎ", taValue: "안녕ㅎ" },
      { type: "keydown", key: "ㅎ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "하", taValue: "안녕하" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "핫", taValue: "안녕핫" },
      { type: "keydown", key: "ㅅ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "하", taValue: "안녕하" },
      { type: "input", inputType: "insertText", data: "세", taValue: "안녕하세" },
      { type: "keydown", key: "ㅔ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "셍", taValue: "안녕하셍" },
      { type: "keydown", key: "ㅇ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "세", taValue: "안녕하세" },
      { type: "input", inputType: "insertText", data: "요", taValue: "안녕하세요" },
      { type: "keydown", key: "ㅛ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "요", taValue: "안녕하세요" },
      { type: "keydown", key: " ", keyCode: 32 },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("안녕하세요");
  });

  test("a cursor move back onto the commit cell releases the echo hold", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Type 안, press ArrowLeft, type 녕. The shell echoes 안 (cursor +2) and
    // then the arrow puts the cursor back on the commit cell, so the hold's
    // cursor-delta test sees `advanced === 0` and reads it as "echo has not
    // landed". The overlay then paints the stale 안 in front of the live 녕
    // and the line reads 안녕 while the buffer really holds 녕안 — the lie
    // only clears on the next cursor move.
    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㅇ", taValue: "ㅇ" },
      { type: "keydown", key: "ㅇ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "아", taValue: "아" },
      { type: "keydown", key: "ㅏ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "안", taValue: "안" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "안", taValue: "안" },
      { type: "keydown", key: "ArrowLeft", keyCode: 37 },
    ]);

    // 안 echoes back, then the ArrowLeft returns the cursor to the cell it was
    // committed from.
    await emitPtyOutput(page, "안\u001b[2D");

    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㄴ", taValue: "ㄴ" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녀", taValue: "녀" },
      { type: "keydown", key: "ㅕ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "녕" },
    ]);

    // The buffer owns 안 now, so the overlay must show only the live syllable.
    await expect.poll(() => imeOverlayText(page)).toBe("녕");
  });

  test("mid-line composition shifts the tail instead of covering it", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // 안 on the line with the cursor sitting back on it, then compose 녕.
    // The tail is painted at the cursor column and the composing cells go on
    // top, so covering its first columns hides the 안 that is really there.
    await emitPtyOutput(page, "안\u001b[2D");
    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㄴ", taValue: "ㄴ" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녀", taValue: "녀" },
      { type: "keydown", key: "ㅕ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "녕" },
    ]);

    const tail = await imeTailBox(page);
    expect(tail.text).toContain("안");
    // Nothing covered — the two columns after the cursor hold 안, not blanks.
    expect(parseFloat(tail.clipLeft)).toBe(0);
    // ...and it moves right by the composed width, the way the real line will.
    expect(parseFloat(tail.left)).toBeGreaterThan(0);
  });

  test("composing over blank tail columns still pins a TUI border", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // A TUI input box: blanks after the cursor, border far to the right. Those
    // blanks must stay covered and the tail must NOT shift, or the border
    // slides off the column the rows above and below draw it on.
    await emitPtyOutput(page, "\u001b[1;1H│    │\u001b[1;3H");
    await runIme(page, [
      { type: "input", inputType: "insertText", data: "ㄴ", taValue: "ㄴ" },
      { type: "keydown", key: "ㄴ", keyCode: 229 },
      { type: "input", inputType: "insertReplacementText", data: "녕", taValue: "녕" },
    ]);

    const tail = await imeTailBox(page);
    expect(tail.left === "" || parseFloat(tail.left) === 0).toBe(true);
    expect(parseFloat(tail.clipLeft)).toBeGreaterThan(0);
  });

  // Verbatim capture from the installed RELEASE build (2026-09-15). The .app
  // bundle gets a different WebKit IME integration than the bare
  // `target/debug/acorn` binary `tauri dev` runs: composition events fire,
  // input arrives as insertCompositionText / deleteCompositionText /
  // insertFromComposition, and the textarea is emptied per syllable instead of
  // accumulating the run. Both shapes ship, so both must commit.
  test("release-build trace: 반갑습니다 commits every syllable", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    const syllable = (
      previews: Array<[string, string]>,
      deleteTa: string,
      committed: string,
      committedTa: string,
    ): ImeStep[] => [
      ...previews.flatMap(([data, taValue]): ImeStep[] => [
        { type: "input", inputType: "insertCompositionText", data, taValue },
        { type: "keydown", key: "Process", keyCode: 229 },
      ]),
      {
        type: "input",
        inputType: "deleteCompositionText",
        data: null,
        taValue: deleteTa,
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: committed,
        taValue: committedTa,
      },
    ];

    await runIme(page, [
      // 반 — the textarea empties on deleteCompositionText, which is the case
      // that used to kill the commit.
      ...syllable(
        [["ㅂ", "ㅂ"], ["바", "바"], ["반", "반"], ["반", "반"]],
        "",
        "반",
        "반",
      ),
      // 갑 — leftover text in the textarea, the case that survived.
      ...syllable(
        [["ㄱ", "반ㄱ"], ["가", "반가"], ["갑", "반갑"], ["값", "반값"], ["갑", "반갑"]],
        "반",
        "갑",
        "반갑",
      ),
      ...syllable([["스", "스"], ["습", "습"], ["습", "습"]], "", "습", "습"),
      ...syllable(
        [["ㄴ", "습ㄴ"], ["니", "습니"], ["닏", "습닏"], ["니", "습니"]],
        "습",
        "니",
        "습니",
      ),
      ...syllable([["다", "다"], ["다", "다"]], "", "다", "다"),
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("반갑습니다");
  });

  test("release-build trace: a repeated syllable commits twice", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // 나나 through the release shape. The insertFromComposition de-dupe keyed
    // off the previously committed syllable, so the second 나 read as a
    // duplicate of the first and never reached the PTY.
    await runIme(page, [
      { type: "input", inputType: "insertCompositionText", data: "ㄴ", taValue: "ㄴ" },
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "input", inputType: "insertCompositionText", data: "나", taValue: "나" },
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "input", inputType: "deleteCompositionText", data: null, taValue: "" },
      { type: "input", inputType: "insertFromComposition", data: "나", taValue: "나" },
      { type: "input", inputType: "insertCompositionText", data: "ㄴ", taValue: "ㄴ" },
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "input", inputType: "insertCompositionText", data: "나", taValue: "나" },
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "input", inputType: "deleteCompositionText", data: null, taValue: "" },
      { type: "input", inputType: "insertFromComposition", data: "나", taValue: "나" },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("나나");
  });

  test("release-build trace: terminator then late insertFromComposition sends once", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // 요 + space in the release shape. The terminator keydown flushes 요, then
    // WebKit still delivers deleteCompositionText + insertFromComposition for
    // the same syllable. That late pair must not commit again — 안녕하세요
    // arrived as 안녕하세요 요.
    await runIme(page, [
      { type: "input", inputType: "insertCompositionText", data: "요", taValue: "요" },
      { type: "keydown", key: "Process", keyCode: 229 },
      { type: "keydown", key: " ", keyCode: 229 },
      { type: "input", inputType: "deleteCompositionText", data: null, taValue: "" },
      { type: "input", inputType: "insertFromComposition", data: "요", taValue: "요" },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("요");
  });

  test("release-build trace: IME-folded terminator commits once", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Verbatim capture, byte for byte. The Korean IME folds the space into the
    // composition and `insertFromComposition` hands it over with a PLAIN space
    // (U+0020), while WebKit leaves a NO-BREAK SPACE (U+00A0) in the helper
    // textarea for that same character. Comparing them raw, the committed text
    // is not found in the textarea, the whole value reads as leftover, the
    // composition never closes, and the terminator keydown commits it again —
    // 안녕하세요 arrived as 안녕하세요 요.
    await runIme(page, [
      { type: "input", inputType: "insertCompositionText", data: "요", taValue: "요" },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "요\u00a0",
        taValue: "요\u00a0",
      },
      { type: "input", inputType: "deleteCompositionText", data: null, taValue: "" },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "요 ",
        taValue: "요\u00a0",
      },
      { type: "keydown", key: " ", keyCode: 229, taValue: "요\u00a0" },
    ]);

    const joined = (await getWrites(page)).join("");
    expect(joined.replace(/[^가-힣]/gu, "")).toBe("요");
  });

  test("Shift+Enter sends LF, not CR", async ({ page, tauri }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "Enter", keyCode: 13, shift: true },
    ]);

    const writes = await getWrites(page);
    expect(writes).toContain("\n");
    expect(writes.join("")).not.toContain("\r");
  });

  test("Cmd+ArrowLeft sends \\x01 (start-of-line)", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "ArrowLeft", keyCode: 37, meta: true },
    ]);

    const writes = await getWrites(page);
    expect(writes).toContain("\x01");
  });

  test("Cmd+ArrowRight sends \\x05 (end-of-line)", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "ArrowRight", keyCode: 39, meta: true },
    ]);

    const writes = await getWrites(page);
    expect(writes).toContain("\x05");
  });

  test("insertReplacementText ㅎ → 하 → 한 does not flush mid-syllable", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertReplacementText",
        data: "ㅎ",
        taValue: "ㅎ",
      },
      {
        type: "input",
        inputType: "insertReplacementText",
        data: "하",
        taValue: "하",
      },
      {
        type: "input",
        inputType: "insertReplacementText",
        data: "한",
        taValue: "한",
      },
    ]);

    const writes = await getWrites(page);
    expect(writes).not.toContain("ㅎ");
    expect(writes).not.toContain("하");
    expect(writes).not.toContain("한");
    expect(await imeOverlayText(page)).toContain("한");
  });

  test("Two sequential Korean syllables (안 → 녕) each commit exactly once", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Real macOS Korean 2-set IME chains compositions without a terminator
    // when the next jamo cannot legally join the current syllable. The first
    // syllable commits via `insertFromComposition`, then a fresh
    // composition starts with the next jamo. Tests that `sentPrefix` and
    // `composing` reset cleanly so the second syllable doesn't see stale
    // state from the first.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "안",
        taValue: "",
      },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "녕",
        taValue: "녕",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "녕",
        taValue: "",
      },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "안")).toBe(1);
    expect(countToken(writes, "녕")).toBe(1);
    // Order matters — 안 must arrive before 녕.
    const joined = writes.join("");
    expect(joined.indexOf("안")).toBeLessThan(joined.indexOf("녕"));
    // No coalesced doubles from stale sentPrefix leaking the prior syllable
    // into the next composition's textarea-tail slice.
    expect(joined).not.toContain("안녕안");
    expect(joined).not.toContain("녕녕");
  });

  test("chained Hangul keeps the next syllable in the overlay (안녕하)", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // WKWebView often starts the next syllable before it commits the
    // previous one: insertCompositionText("하") then
    // insertFromComposition("녕"). The overlay must still show 하.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "안",
        taValue: "안",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "안",
        taValue: "",
      },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "녕",
        taValue: "녕",
      },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "하",
        taValue: "하",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "녕",
        taValue: "하",
      },
    ]);

    expect(await imeOverlayText(page)).toContain("하");
    const writes = await getWrites(page);
    expect(countToken(writes, "안")).toBe(1);
    expect(countToken(writes, "녕")).toBe(1);
    expect(countToken(writes, "하")).toBe(0);
  });

  test("late insertFromComposition after insertText does not flush the next jamo", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // Family B: insertText commits 녕 and previews 하, then Family A's
    // insertFromComposition("녕") arrives. Must not PTY-write 하 or clear it.
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertText",
        data: "녕",
        taValue: "녕",
      },
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertText",
        data: "하",
        taValue: "녕하",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "녕",
        taValue: "하",
      },
    ]);

    expect(await imeOverlayText(page)).toContain("하");
    const writes = await getWrites(page);
    expect(countToken(writes, "녕")).toBe(1);
    expect(countToken(writes, "하")).toBe(0);
  });

  test("있 → space → 안 — syllable + terminator + next composition all clean", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // The exact shape the original bug surfaced in: a syllable, the space
    // that triggered the duplicate, then another syllable. The post-space
    // composition must start fresh (sentPrefix="", composing=false) and
    // emit "안" exactly once with no residue from "있".
    await runIme(page, [
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertText",
        data: "있",
        taValue: "있",
      },
      // Space terminator under IME — commits "있" via terminator path.
      { type: "keydown", key: " ", keyCode: 229 },
      // Family A follow-up that the bug abused.
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "있",
        taValue: "",
      },
      // Fresh composition begins.
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertText",
        data: "안",
        taValue: "안",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "안",
        taValue: "",
      },
    ]);

    const writes = await getWrites(page);
    expect(countToken(writes, "있")).toBe(1);
    expect(countToken(writes, "안")).toBe(1);
    const joined = writes.join("");
    // Critical: the post-space composition's textarea-tail slice would
    // re-emit "있" if sentPrefix wasn't reset by the prior commit.
    expect(joined).not.toContain("있있");
    expect(joined).not.toContain("있안있");
    expect(joined.indexOf("있")).toBeLessThan(joined.indexOf("안"));
  });

  test("Composition resumes cleanly after a non-IME insertText (있Abc shape)", async ({
    page,
    tauri,
  }) => {
    await seed(tauri);
    await activateTerminal(page);

    // The "있Abc" scenario: user commits Korean syllable, then types ASCII,
    // then comes back to Korean. After ASCII, sentPrefix tracks the textarea
    // tail. A fresh IME composition must slice past sentPrefix so the next
    // syllable doesn't drag the ASCII prefix into its commit.
    //
    // We assert only what our handler controls (the IME path's pty_write
    // calls). ASCII characters that xterm emits via its own keydown path
    // duplicate noisily under synthetic events and are not part of this
    // contract — the regression we care about is the IME path NOT re-emitting
    // "있" or pulling "Abc" into the next Hangul commit.
    await runIme(page, [
      // Compose + commit "있".
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "있",
        taValue: "있",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "있",
        taValue: "",
      },
      // Plain ASCII run — our handler must enter the non-IME branch and
      // advance sentPrefix to match the textarea so a later IME composition
      // slices from the right offset.
      { type: "keydown", key: "A", keyCode: 65 },
      { type: "input", inputType: "insertText", data: "A", taValue: "A" },
      { type: "keydown", key: "b", keyCode: 66 },
      { type: "input", inputType: "insertText", data: "b", taValue: "Ab" },
      { type: "keydown", key: "c", keyCode: 67 },
      { type: "input", inputType: "insertText", data: "c", taValue: "Abc" },
      // Resume Korean — fresh composition appended to the existing tail.
      { type: "keydown", key: "Process", keyCode: 229 },
      {
        type: "input",
        inputType: "insertCompositionText",
        data: "한",
        taValue: "Abc한",
      },
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "한",
        taValue: "Abc",
      },
    ]);

    const writes = await getWrites(page);
    // The two Hangul syllables on the IME path must each commit exactly once.
    expect(countToken(writes, "있")).toBe(1);
    expect(countToken(writes, "한")).toBe(1);
    // sentPrefix-regression markers: the next Hangul commit must not drag
    // the ASCII prefix into its emit, and must not re-emit "있".
    expect(writes).not.toContain("Abc한");
    expect(writes).not.toContain("있Abc");
    expect(writes).not.toContain("있Abc한");
  });
});
