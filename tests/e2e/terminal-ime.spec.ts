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
      [key: string]: unknown;
    };
    const id = w.__imeOutputChannelId;
    if (typeof id !== "number") throw new Error("IME output channel missing");
    const callback = w[`_${id}`] as
      | ((payload: { index: number; message: number[] }) => void)
      | undefined;
    if (!callback) throw new Error("IME output callback missing");
    callback({
      index: 0,
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
        markerBackground: marker.backgroundColor,
        markerHeight: Number.parseFloat(marker.height),
        markerWidth: Number.parseFloat(marker.width),
        nativeCursorOpacity: nativeCursor
          ? getComputedStyle(nativeCursor).opacity
          : null,
        cursorAnchorWidth: cursorRect.width,
        cursorAfterText: Math.abs(cursorRect.left - textRect.right),
        tailAfterCursor: Math.abs(tailRect.left - cursorRect.left),
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
    expect(cursorLayout.cursorAfterText).toBeLessThan(0.5);
    expect(cursorLayout.tailAfterCursor).toBeLessThan(0.5);

    await runIme(page, [
      {
        type: "input",
        inputType: "insertFromComposition",
        data: "한",
        taValue: "한",
      },
    ]);
    await expect(page.locator(".acorn-terminal")).not.toHaveClass(
      /acorn-terminal-composing/,
    );
    await expect(imeCursor).toHaveCount(0);
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
    const syllableCount = writes.filter((w) => w === "한").length;
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
    expect(writes.filter((w) => w === "한").length).toBe(1);
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
    expect(writes.filter((w) => w === "안").length).toBe(1);
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
    expect(writes.filter((w) => w === "안").length).toBe(1);
    expect(writes.filter((w) => w === "녕").length).toBe(1);
    // Order matters — 안 must arrive before 녕.
    const joined = writes.join("");
    expect(joined.indexOf("안")).toBeLessThan(joined.indexOf("녕"));
    // No coalesced doubles from stale sentPrefix leaking the prior syllable
    // into the next composition's textarea-tail slice.
    expect(joined).not.toContain("안녕안");
    expect(joined).not.toContain("녕녕");
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
    expect(writes.filter((w) => w === "있").length).toBe(1);
    expect(writes.filter((w) => w === "안").length).toBe(1);
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
    expect(writes.filter((w) => w === "있").length).toBe(1);
    expect(writes.filter((w) => w === "한").length).toBe(1);
    // sentPrefix-regression markers: the next Hangul commit must not drag
    // the ASCII prefix into its emit, and must not re-emit "있".
    expect(writes).not.toContain("Abc한");
    expect(writes).not.toContain("있Abc");
    expect(writes).not.toContain("있Abc한");
  });
});
