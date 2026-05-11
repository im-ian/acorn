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
      status: "idle",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:05Z",
      last_message: null,
      startup_mode: "terminal",
    },
  ]);
  // Spawn is a no-op for these tests — we only care about pty_write.
  await tauri.handle("pty_spawn", () => null);
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
    .getByRole("button", { name: /^shell main · Idle$/ })
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

test.describe("terminal: IME (PR #104 regression)", () => {
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
