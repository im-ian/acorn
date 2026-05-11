# CLAUDE.md

Conventions and gotchas for AI coding agents working on Acorn. This is a living doc — add things future-you would have wanted to know.

## Project shape

- **Tauri 2** desktop app. Frontend in `src/`, Rust backend in `src-tauri/`.
- **Bun** is the package manager. Use `bun install`, `bun run dev`, `bun add` — not `npm`/`yarn`/`pnpm`.
- Frontend: React 19, Vite, Tailwind 4, zustand. UI talks to Rust via `invoke()` from `@tauri-apps/api/core`, centralized in `src/lib/api.ts`.
- React **StrictMode is on** (`src/main.tsx`). Effects run twice on mount in dev — guard async work with a cancellation flag, don't assume single-mount.

## Testing

Two layers, do not mix them up. Full decision framework: [`docs/TESTING.md`](docs/TESTING.md).

| Layer | Where | When |
| --- | --- | --- |
| Vitest | `src/**/*.test.ts` | Pure functions, store actions, anything callable as `f(x) === y` |
| Playwright | `tests/e2e/**/*.spec.ts` | Anything the user clicks / types / sees on screen |

One-line rule: **visible to the user → Playwright; just a function → Vitest.**

When extending behavior:

- New util in `src/lib/foo.ts` → add `src/lib/foo.test.ts` (Vitest, next to it).
- New action in `src/store.ts` → extend `src/store.test.ts` (Vitest with `vi.mock("./lib/api")`).
- New component / modal / shortcut → add `tests/e2e/foo.spec.ts` (Playwright).
- New `invoke` wrapper in `api.ts` → usually no dedicated unit test (it's a passthrough); E2E exercises it.

Playwright-specific patterns (mock setup, hotkey helper, closure rules, capturing invoke args) live in [`docs/E2E_TESTING.md`](docs/E2E_TESTING.md). Read it before writing E2E.

Two recurring traps in E2E:
1. **Handler functions are serialized to source.** They cannot close over test-side variables, helpers, or imports. Inline the data inside each handler.
2. **OS keyboard shortcuts (Cmd+P, Cmd+,) are intercepted by Chromium.** Use `pressHotkey()` from `tests/e2e/support.ts`, not `page.keyboard.press()`.

## Code conventions

- **Custom window events use the `acorn:` prefix** (`acorn:new-session`, `acorn:add-project`, `acorn:terminal-clear`). When adding a global event, follow this convention so listener wiring stays greppable.
- **Sessions have a `kind`** (`SessionKind`): `regular` or `control`. Control sessions get `ACORN_SESSION_ID` + `ACORN_IPC_SOCKET` injected into their PTY env and can drive siblings via the `acorn-ipc` CLI. See [`docs/CONTROL_SESSIONS.md`](docs/CONTROL_SESSIONS.md). When touching session creation flow, preserve the kind through every path (api wrapper → Tauri command → `Session::new` → persistence).
- **Keyboard shortcuts** are defined as `Hotkeys` constants in `src/lib/hotkeys.ts` and use `tinykeys` with `$mod` for the platform-primary modifier (Cmd on macOS, Ctrl elsewhere). Don't hardcode `Meta+` or `Control+` at call sites.
- **Local persistence** (UI state like collapsed groups, dismissed update version) goes in `localStorage` under the `acorn:` key prefix. Don't reach for it from inside pure logic — keep it at the component / store edge.
- **Logic stuck inside a component** that wants a unit test should be extracted to `src/lib/`. Don't try to test it through the rendered component. Example: `Sidebar.tsx`'s `buildProjectGroups` could move out if it grows.
- **`src/lib/api.ts` is the only place that calls `invoke()` from app code.** New backend commands get a wrapper there with explicit types. Components import from `api`, not from `@tauri-apps/api/core`.

## Things that go wrong if you forget

- **Adding a new boot-time invoke without a default in `tests/e2e/fixtures/tauriMock.ts`** → E2E tests crash silently with a RightPanel-style error and missing data. Add the default when you add the wrapper.
- **Returning `null` from a backend command that the UI iterates with `.length` / `.map`** → boot crash. Return empty arrays/objects, not nullable wrappers.
- **Forgetting StrictMode double-fire when wiring `listen()`** → duplicate side effects. Use a `cancelled`/`disposed` flag. See `Terminal.tsx`'s `spawnPty` for the pattern.
- **Creating files for "future" abstractions** → don't. KISS. Add the second use case before the abstraction.

## Build / run

```sh
bun install
bun run tauri dev      # full app (Rust + Vite)
bun run dev            # Vite only — frontend in browser, no Tauri
bun run test           # Vitest
bun run test:e2e       # Playwright
bun run typecheck
bun run build          # tsc + vite build
```

## When in doubt

- Reading: `docs/TESTING.md`, `docs/E2E_TESTING.md`, `docs/PR_LABELS.md`.
- Patterns: search `src/` first for similar code already in the repo. Match its shape.
