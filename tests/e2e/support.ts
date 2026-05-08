import { test as base, expect, type Page } from "@playwright/test";
import { tauriMockSource } from "./fixtures/tauriMock";

type InvokeHandler = (args: unknown) => unknown | Promise<unknown>;

export interface TauriMock {
  /**
   * Register a handler for a Tauri command. Must be called *before*
   * `page.goto()` so it lands as an init script and is in place before any
   * boot-time `invoke()` runs. The function body is serialized into the page
   * context, so it cannot close over Node-side variables, imports, or
   * helpers — write each handler as a self-contained snippet.
   */
  handle: (cmd: string, fn: InvokeHandler) => Promise<void>;

  /**
   * Like `handle`, but takes a static value instead of a function.
   * The value is JSON-serialized into the page context, so test-side
   * factories work here even though they can't survive the closure
   * boundary in `handle`. Use this for shape-matching seed data.
   */
  respond: (cmd: string, value: unknown) => Promise<void>;
}

declare global {
  interface Window {
    __ACORN_MOCK_HANDLERS__: Record<string, InvokeHandler>;
    __ACORN_MOCK_INSTALLED__: boolean;
    __ACORN_TEST_MODE__: boolean;
    __TAURI_INTERNALS__: unknown;
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
  }
}

// Pageerror / console.error messages we expect during normal boot. Anything
// else surfacing in a test is treated as a regression. Add to this list only
// when the noise is genuinely benign and external (e.g. third-party warnings
// the app cannot silence) or a known issue tracked separately.
const IGNORED_ERROR_PATTERNS: RegExp[] = [
  // Vite HMR connection chatter, only present in dev.
  /\[vite\]/i,
  // Radix Dialog (used by cmdk's Command.Dialog and our Modal) warns when a
  // DialogTitle child is missing. Acorn's CommandPalette and several Modal
  // call sites currently rely on aria-label only. This is a known a11y gap
  // tracked separately — silence it here so the gate stays focused on new
  // regressions rather than pre-existing warnings.
  /DialogContent.*requires a `DialogTitle`/i,
];

interface ErrorTracker {
  errors: string[];
  /** Tests opt out of the auto-fail when they're intentionally provoking errors. */
  allow: (pattern: RegExp) => void;
}

export const test = base.extend<{
  tauri: TauriMock;
  errorTracker: ErrorTracker;
  _tauriBase: void;
}>({
  // Auto-on for every test: install the base `__TAURI_INTERNALS__` shim so
  // the app can boot without crashing, even in tests that never touch
  // `tauri.handle` / `tauri.respond`. Splitting this out from the public
  // `tauri` fixture means tests don't need a `void tauri;` line just to
  // activate the mock.
  _tauriBase: [
    async ({ page }, use) => {
      await page.addInitScript({ content: tauriMockSource });
      await use();
    },
    { auto: true },
  ],

  tauri: async ({ page, _tauriBase }, use) => {
    void _tauriBase;
    const tauri: TauriMock = {
      handle: async (cmd, fn) => {
        const fnSource = fn.toString();
        await page.addInitScript({
          content: `(() => {
  const fn = (${fnSource});
  window.__ACORN_MOCK_HANDLERS__ = window.__ACORN_MOCK_HANDLERS__ || {};
  window.__ACORN_MOCK_HANDLERS__[${JSON.stringify(cmd)}] = fn;
})();`,
        });
      },
      respond: async (cmd, value) => {
        const valueJson = JSON.stringify(value);
        await page.addInitScript({
          content: `(() => {
  const v = ${valueJson};
  window.__ACORN_MOCK_HANDLERS__ = window.__ACORN_MOCK_HANDLERS__ || {};
  window.__ACORN_MOCK_HANDLERS__[${JSON.stringify(cmd)}] = () => v;
})();`,
        });
      },
    };

    await use(tauri);
  },

  // Auto-on for every test: capture pageerror + console.error and fail the
  // test if anything unexpected leaked. Tests that intentionally provoke
  // errors can opt specific patterns out via `errorTracker.allow(...)`.
  errorTracker: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      const allowed: RegExp[] = [...IGNORED_ERROR_PATTERNS];

      const onPageError = (err: Error) =>
        errors.push(`pageerror: ${err.message}`);
      const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
        if (msg.type() !== "error") return;
        errors.push(`console.error: ${msg.text()}`);
      };

      page.on("pageerror", onPageError);
      page.on("console", onConsole);

      const tracker: ErrorTracker = {
        errors,
        allow: (pattern) => {
          allowed.push(pattern);
        },
      };

      await use(tracker);

      page.off("pageerror", onPageError);
      page.off("console", onConsole);

      // Skip the gate when the test is already failing — the underlying
      // assertion failure is more informative than a tail of error noise.
      if (testInfo.status !== testInfo.expectedStatus) return;

      const unexpected = errors.filter(
        (msg) => !allowed.some((re) => re.test(msg)),
      );
      if (unexpected.length > 0) {
        throw new Error(
          "Unexpected page errors during test:\n" +
            unexpected.map((m) => "  - " + m).join("\n"),
        );
      }
    },
    { auto: true },
  ],
});

/**
 * Dispatch a synthetic keydown event on `window` so app-level hotkeys
 * (registered via tinykeys on `window`) receive it.
 *
 * Using `page.keyboard.press('Meta+P')` is unreliable here: Chromium
 * intercepts native shortcuts (Cmd+P prints, Cmd+, opens preferences)
 * before the page sees them. Dispatching a raw KeyboardEvent bypasses
 * the OS layer entirely.
 *
 * tinykeys resolves `$mod` to `Meta` when `navigator.platform` matches
 * `Mac/iPod/iPhone/iPad` (true in Playwright's macOS Chromium build) and
 * `Control` otherwise. We honor the same detection so tests stay
 * platform-agnostic.
 */
export async function pressHotkey(
  page: Page,
  combo: { mod?: boolean; shift?: boolean; alt?: boolean; key: string },
): Promise<void> {
  await page.evaluate((c) => {
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

    // tinykeys matches against event.key.toUpperCase() OR event.code.
    // Set both so bindings like "$mod+Comma" (which matches by code) and
    // "$mod+p" (which matches by key) both fire.
    function deriveCode(key: string): string {
      if (/^[a-zA-Z]$/.test(key)) return "Key" + key.toUpperCase();
      if (/^[0-9]$/.test(key)) return "Digit" + key;
      const map: Record<string, string> = {
        ",": "Comma",
        ".": "Period",
        "/": "Slash",
        "\\": "Backslash",
        ";": "Semicolon",
        "'": "Quote",
        "[": "BracketLeft",
        "]": "BracketRight",
        "-": "Minus",
        "=": "Equal",
        "`": "Backquote",
        " ": "Space",
        Tab: "Tab",
        Enter: "Enter",
        Escape: "Escape",
        Backspace: "Backspace",
        ArrowUp: "ArrowUp",
        ArrowDown: "ArrowDown",
        ArrowLeft: "ArrowLeft",
        ArrowRight: "ArrowRight",
      };
      return map[key] ?? key;
    }

    const ev = new KeyboardEvent("keydown", {
      key: c.key,
      code: deriveCode(c.key),
      metaKey: !!c.mod && isMac,
      ctrlKey: !!c.mod && !isMac,
      shiftKey: !!c.shift,
      altKey: !!c.alt,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
  }, combo);
}

export { expect };
export type { Page };
