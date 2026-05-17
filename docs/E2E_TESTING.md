# E2E testing

> Deciding **whether** a test belongs here vs in Vitest? Start with [`TESTING.md`](./TESTING.md). This doc is the Playwright reference — what each piece does, how to write a spec, what to mock.

Acorn runs Playwright against `vite dev` in a regular Chromium tab — **not** against the actual Tauri binary. The Rust backend isn't running during tests; instead, a small init script stands up a fake `window.__TAURI_INTERNALS__` so every `invoke()` call gets answered by JavaScript-side handlers.

This is a deliberate trade-off: tests are fast (no native build, no app launch, parallel-safe) and broad coverage is cheap, but the Rust side is never exercised. Use these tests for UI flow regressions; rely on manual checks (or future tauri-driver smoke tests) for backend behavior.

## Layout

```
tests/e2e/
├── fixtures/
│   └── tauriMock.ts     # injected into the page; defines window.__TAURI_INTERNALS__
├── support.ts           # Playwright fixture exposing tauri.handle()
├── smoke.spec.ts        # one example
└── tsconfig.json
playwright.config.ts     # webServer auto-starts `pnpm run dev` at :1420
```

## Running

```sh
pnpm run test:e2e          # headless
pnpm run test:e2e:headed   # watch the browser drive itself
pnpm run test:e2e:ui       # Playwright UI mode (test picker + time travel)
```

The config auto-starts vite at `localhost:1420` and reuses an already-running dev server when present, so you can keep `pnpm run dev` open in another terminal and tests will reuse it.

Failure artifacts (`test-results/`, `playwright-report/`) are gitignored. Open the last HTML report with `pnpm exec playwright show-report`.

## Writing a test

The simplest case — return canned data, assert what shows up:

```ts
import { test, expect } from "./support";

test("seeded project appears in the sidebar", async ({ page, tauri }) => {
  await tauri.handle("list_projects", () => [
    { repo_path: "/tmp/demo", name: "demo", order: 0 },
  ]);

  await page.goto("/");

  await expect(
    page.getByRole("listitem").filter({ hasText: "demo" }),
  ).toBeVisible();
});
```

Two rules that matter:

- **Always register handlers before `page.goto`.** Handlers ride along as init scripts so they're in place before the React tree renders. Calling `tauri.handle` after navigation does nothing useful.
- **Handler functions are serialized to source.** `fn.toString()` ships the function body to the page; the page evaluates it as a fresh function with no access to test-side variables, imports, or `require()`. **Closures over Node-side values do not survive the boundary.** Treat each handler as a pure self-contained snippet.

### Stateful flows (write → read)

For "create something then check it shows up", state must live on the `window` because handlers can't share a Node-side variable. Two options:

**Option A — replace the handler between actions:**

```ts
await tauri.handle("list_projects", () => []);
await tauri.handle("add_project", (args: { repoPath: string }) => ({
  repo_path: (args as { repoPath: string }).repoPath,
  name: "demo",
  order: 0,
}));
await page.goto("/");

await page.getByRole("button", { name: "Add project" }).click();
// ... drive the dialog ...

// Swap in the post-create list state, then trigger a refresh.
await tauri.handle("list_projects", () => [
  { repo_path: "/tmp/demo", name: "demo", order: 0 },
]);
```

**Option B — keep state on `window` and let handlers read/write it:**

```ts
await tauri.handle("list_projects", () => {
  const w = window as unknown as { __projects?: unknown[] };
  return w.__projects ?? [];
});
await tauri.handle("add_project", (args) => {
  const w = window as unknown as { __projects?: unknown[] };
  const next = {
    repo_path: (args as { repoPath: string }).repoPath,
    name: "demo",
    order: 0,
  };
  w.__projects = [...(w.__projects ?? []), next];
  return next;
});
```

Option A is clearer for short flows; option B is better when many handlers share state.

## Default fallbacks (don't mock these unless you need to)

The mock returns safe values for the boot path so empty UIs render without crashing:

| Command                                    | Default                                          |
| ------------------------------------------ | ------------------------------------------------ |
| `list_sessions`, `list_projects`, `list_*` | `[]`                                             |
| `detect_session_statuses`                  | `[]`                                             |
| `read_session_todos`                       | `[]`                                             |
| `list_commits`, `list_staged`              | `[]`                                             |
| `list_pull_requests`                       | `{ items: [], account: null, error: null }`      |
| `staged_diff`, `commit_diff`               | `{ files: [] }`                                  |
| `scrollback_load`                          | `null`                                           |
| `scrollback_orphan_size` / `_clear`        | `0`                                              |
| `get_memory_usage`                         | `{ rss_bytes: 0, sessions: [], scrollback_disk_bytes: 0 }` |
| `plugin:event\|listen` / `\|unlisten`      | resolved (callback id)                           |
| `plugin:app\|version`                      | `"0.0.0-test"`                                   |
| `plugin:updater\|check`                    | `null` (no update)                               |
| `plugin:notification\|*`                   | granted / no-op                                  |
| `plugin:dialog\|open`                      | `null` (override to return a path)               |
| anything else                              | `null`                                           |

If your test path triggers one of these and the default is fine, don't override. Override only when the test asserts on the result.

## Hotkeys

Don't use `page.keyboard.press('Meta+P')` for app shortcuts. Chromium intercepts native shortcuts (Cmd+P prints, Cmd+, opens preferences) before the page sees them. Use the `pressHotkey` helper from `support.ts` instead — it dispatches a synthetic `KeyboardEvent` directly on `window`, which is where tinykeys is listening.

```ts
import { test, pressHotkey } from "./support";

test("opens command palette via shortcut", async ({ page }) => {
  await page.goto("/");
  await pressHotkey(page, { mod: true, key: "p" });          // $mod+P
  await pressHotkey(page, { mod: true, shift: true, key: "S" }); // $mod+Shift+S
  await pressHotkey(page, { mod: true, key: "," });          // $mod+, (Settings)
});
```

`mod` resolves to Meta on macOS Chromium and Control elsewhere — same convention tinykeys uses. The helper sets both `event.key` and `event.code` so bindings written as `$mod+Comma` (matched by code) and `$mod+p` (matched by key) both fire.

For non-app keys like Escape that aren't intercepted by the OS, plain `page.keyboard.press('Escape')` is fine.

## Static seed data — `tauri.respond`

If you only need a constant return value (no per-call logic), use `respond` instead of `handle`. It JSON-serializes the value into the page, so test-side factories work just fine:

```ts
import { makeProject } from "./fixtures/factories";

await tauri.respond("list_projects", [makeProject({ name: "demo" })]);
await tauri.respond("list_pull_requests", { items: [], account: null, error: null });
```

Use `handle` when the response depends on the call args, when it needs to mutate state on `window`, or when later actions in the same test should change what the next call returns.

## Console error gating

Every test runs through the `errorTracker` fixture automatically. If a `pageerror` or `console.error` slips through and isn't on the allow-list, the test fails after the body finishes — even if every assertion passed. This catches React error boundaries firing on unrelated panels, missing default mocks for new commands, and similar silent regressions.

Known benign noise (Vite HMR chatter, the radix `DialogTitle` warning) is whitelisted in `IGNORED_ERROR_PATTERNS` inside `support.ts`. Add to it sparingly — every entry is debt.

If a specific test legitimately provokes an error, opt in:

```ts
test("invoking add_project with bad input surfaces an error", async ({
  page,
  tauri,
  errorTracker,
}) => {
  errorTracker.allow(/add project failed/i);
  await tauri.handle("add_project", () => { throw new Error("nope"); });
  // ...
});
```

## Capturing invoke arguments

Handlers can't close over Node-side variables, so to record what the app called with, write to `window`:

```ts
await tauri.handle("pty_spawn", (args) => {
  const w = window as unknown as { __spawnCalls?: unknown[] };
  w.__spawnCalls = w.__spawnCalls ?? [];
  w.__spawnCalls.push(args);
  return null;
});

// ...drive the UI...

const calls = await page.evaluate(
  () => (window as unknown as { __spawnCalls?: unknown[] }).__spawnCalls,
);
expect(calls).toHaveLength(1);
```

Combine with `expect.poll(...)` when the invoke happens after a chain of awaits the test can't directly observe.

## Selector conventions

Prefer accessible queries — they double as a check that the UI is reachable by keyboard and screen readers:

```ts
page.getByRole("button", { name: "Add project" })
page.getByRole("heading", { name: "Projects" })
page.getByText(/No projects yet/i)
```

Reach for `data-testid` only when there's no semantic anchor. Most components in `src/components/` already expose `aria-label`s — search there first.

## What this setup does NOT cover

- Real `git` operations, commit/diff content, PR sync — the Rust commands aren't running.
- The PTY / xterm wiring beyond rendering. Terminal output is driven by Tauri events the mock doesn't emit.
- The auto-updater install path, OS notifications, dialog open/save — plugin internals are stubbed flat.
- macOS app menu accelerators (Cmd+,) — those are wired in Rust.
- Window lifecycle (`onCloseRequested` flush) beyond "the listener attaches without throwing".

If a feature lives mostly in `src-tauri/`, an E2E test here will mostly tell you "the UI didn't crash". That's still useful, but don't expect it to catch backend regressions.

## When to add a test

- A regression a manual check would have caught: write the missing test alongside the fix.
- A new component or modal: at minimum, one test that opens it and asserts it renders.
- A flow that spans multiple components (Add Project → sidebar update → click into session): exactly the kind of thing that's painful to retest by hand and worth automating.

Skip pure-function logic (lives under `src/lib/*.test.ts` via Vitest) and one-off UI tweaks where eyeballing is faster.

## Troubleshooting

**`Cannot read properties of undefined (...)` from `@tauri-apps/api`**
A new boot-time API is being touched that the mock doesn't cover. Add a default in `tests/e2e/fixtures/tauriMock.ts` (`pluginDefault` for `plugin:*` commands, `appDefault` for app commands).

**Test passes locally, fails in CI**
Probably a race with the dev server. The config sets `reuseExistingServer: !process.env.CI`, so CI always starts fresh — bump the `webServer.timeout` if vite is slow on the runner.

**`page.evaluate` complains about a closure**
Handlers are stringified, so any reference to a Node-side variable will fail at runtime. Move the value into the handler's argument or the seeded payload instead of capturing it from the test scope.

**Console errors break the test**
Some smoke tests assert on a clean console. If you legitimately expect a warning, scope the assertion to ignore it rather than silencing the listener globally.
