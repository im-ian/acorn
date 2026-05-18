# Testing

Acorn has two test layers, each catching a different class of bug. Pick the right layer up front — writing the wrong kind of test is more expensive than not writing one.

| Layer | Tool | Where | Runs in |
| --- | --- | --- | --- |
| Unit / logic | Vitest | `src/**/*.test.ts` | Node + jsdom |
| End-to-end / UI | Playwright | `tests/e2e/**/*.spec.ts` | Real Chromium |

```sh
pnpm run test       # Vitest — sub-second, all logic
pnpm run test:e2e   # Playwright — ~5s, all UI flows
```

For Playwright-specific patterns (mocking Tauri invoke, hotkey helper, capturing call args), see [`E2E_TESTING.md`](./E2E_TESTING.md).

## Which layer should this test live in?

Three questions, in order:

1. **Can I describe it as "given X, expect Y" without mentioning the UI?** → **Vitest**
2. **Does the user have to click, type, or press a shortcut to trigger it?** → **Playwright**
3. **Does it require multiple components, a modal/portal, or a real Tauri invoke?** → **Playwright**

If none of the three apply, you probably don't need a test for it.

## Quick lookup by file location

| File | Default layer | Why |
| --- | --- | --- |
| `src/lib/*.ts` (utilities) | Vitest | Almost always pure functions |
| `src/store.ts` (actions, reducers) | Vitest | Deterministic state transitions |
| `src/components/*.tsx` | Playwright | DOM, focus, event integration |
| Global keyboard shortcuts | Playwright | `window`-level wiring |
| Tauri `invoke` calls | Playwright | Easier to capture call args end-to-end |
| First-render / boot behavior | Playwright | Multiple components colliding |

## Concrete examples in this repo

### Vitest territory

```ts
// src/lib/layout.test.ts — pure tree algorithm
expect(splitPaneInLayout(layout, "p1", "horizontal")).toEqual({...});

// src/lib/paths.test.ts — string utility
expect(joinPath("/a", "b")).toBe("/a/b");

// src/store.test.ts — store action with mocked api
vi.mock("./lib/api", () => ({ api: { addProject: vi.fn(...) } }));
await store.getState().addProject("/tmp/x");
expect(store.getState().projects).toHaveLength(1);
```

### Playwright territory

```ts
// tests/e2e/command-palette.spec.ts — global shortcut + DOM
await pressHotkey(page, { mod: true, key: "p" });
await expect(page.getByRole("dialog", { name: /Command palette/i })).toBeVisible();

// tests/e2e/sidebar.spec.ts — flow across components
await tauri.handle("plugin:dialog|open", () => "/tmp/picked");
await page.getByRole("button", { name: "Add project" }).click();
await expect(page.getByRole("listitem").filter({ hasText: "picked" })).toBeVisible();

// tests/e2e/terminal.spec.ts — invoke argument capture
await tauri.handle("pty_spawn", (args) => {
  (window as any).__calls = [...((window as any).__calls ?? []), args];
  return null;
});
await page.getByRole("button", { name: /^shell main · Idle$/ }).click();
const calls = await page.evaluate(() => (window as any).__calls);
expect(calls[0].sessionId).toBe("s-term");
```

## Gray-zone rules

**Logic stuck inside a component**
If a `Foo.tsx` defines a pure helper (sorting, grouping, predicate building), extract it to `src/lib/foo.ts` and Vitest-test it there. Don't try to test the helper through the component.

Example: `Sidebar.tsx` defines `buildProjectGroups(projects, sessions)` — that should live (and is tested) at the lib layer, not via a Playwright assertion on the rendered list.

**Custom hooks**
- Pure logic only → Vitest with `renderHook` (jsdom)
- Needs real DOM measurements (IntersectionObserver, scroll, focus) → Playwright via the component that uses it

**"Does this component render?" checks**
Skip them. They're free-rider tested by any Playwright flow that mounts the same screen. A test that does nothing but `render(<Foo />)` and checks for a string pays maintenance for almost no signal.

## Smell tests

You're in the wrong layer if:

| In Vitest, you find yourself... | Move it to Playwright |
| --- | --- |
| Calling `render()` and clicking through DOM to drive a flow | UI flow belongs to E2E |
| Mocking 5+ Tauri commands | Plumbing has outgrown unit scope |
| Working around jsdom's missing layout APIs | jsdom isn't the right environment |

| In Playwright, you find yourself... | Move it to Vitest |
| --- | --- |
| Calling `page.evaluate(() => myFn(...))` and asserting the result | Pure function — test it directly |
| Repeating the same test 10× with different inputs | Parametrized unit test territory |
| Never reading the screen between actions | UI isn't being exercised |

## Coverage philosophy

Different targets for different layers:

- **Vitest**: aim for high coverage on logic. ~80% on `src/lib/*` and `src/store.ts` is reasonable. Branches matter — write the failing input cases.
- **Playwright**: aim for **all critical user flows work**, not for line coverage. One good flow test beats five shallow ones. The right question is "if this breaks, will the user notice?"

Don't measure them with the same yardstick. A Vitest "added a new util → covered" is a different bar from a Playwright "added a new modal → flow covered".

## When to add what

| Change | What to write |
| --- | --- |
| New utility in `src/lib/` | Vitest test next to it |
| New store action | Vitest test in `src/store.test.ts` |
| New component or modal | Playwright spec covering open/close + one happy path |
| New keyboard shortcut | Playwright spec using `pressHotkey` |
| New Tauri invoke wrapper in `api.ts` | Vitest only if there's logic to test (most are passthroughs); otherwise let E2E exercise it |
| Bug fix | Whichever layer would have caught it. If the bug was visible to the user, that's E2E. If it was a wrong calculation, that's Vitest. |

## One-line rule

> **Visible to the user → Playwright. Just a function → Vitest.**

If you're still unsure, walk the three questions at the top.
