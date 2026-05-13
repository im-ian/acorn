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
- **Sessions have a `kind`** (`SessionKind`): `regular` or `control`. Every session spawns the user's `$SHELL`; an agent CLI is only present when the user runs one inside that shell. Control sessions get `ACORN_SESSION_ID`, `ACORN_IPC_SOCKET`, and `ACORN_DAEMON_SOCKET` injected into their PTY env, the bundled `acorn-ipc` directory prepended to `PATH`, and a `<cwd>/.acorn-control.md` marker so any agent the user invokes can drive siblings via the `acorn-ipc` CLI (in-process IPC server) or the newer `acornd` CLI (background daemon) — see [`docs/CONTROL_SESSIONS.md`](docs/CONTROL_SESSIONS.md). When touching session creation flow, preserve the kind through every path (api wrapper → Tauri command → `Session::new` → persistence). When touching `commands::pty_spawn`, keep the `kind == Control` branch intact — losing it silently disables the IPC priming.
- **The `acornd` background daemon** owns persistent PTY sessions across Acorn restarts. It lives in `src-tauri/src/daemon/`, ships as a sidecar binary alongside `acorn`, and is reachable both from inside the app (via `daemon_bridge::DaemonBridge` on `AppState`) and from a control session's PTY (the `acornd` CLI subcommand). The killswitch lives in `localStorage` under `acorn:daemon-enabled` (default ON); the bridge's `set_enabled(false)` short-circuits every call so the caller falls back to the in-process PTY path. The daemon binary is built automatically by `bun run dev:sidecar`, which `tauri.conf.json::beforeDevCommand` chains in front of `vite`, and is staged for release by `src-tauri/scripts/build-sidecar.sh` alongside `acorn-ipc`. Anything that adds a new `daemon_*` Tauri command must also add a matching mock in `tests/e2e/fixtures/tauriMock.ts` (existing handlers default to "disabled / not running" so non-daemon E2Es keep passing).
- **Agent conversation persistence via PATH shim.** Every Acorn session gets a stable UUID minted on first spawn (persisted as `Session.agent_resume_token`) and exported as `ACORN_RESUME_TOKEN`. A `claude` shim (`src-tauri/shims/claude.sh`, materialised at app start under `<data_dir>/shims/`) is prepended to the PTY's `PATH`; when the user runs `claude` inside a terminal it intercepts the call and injects `--session-id $ACORN_RESUME_TOKEN`, so claude's JSONL conversation file is reachable again across Acorn restarts. The token + PATH prepend are applied to every PTY (regular + control), so the persistence works regardless of the daemon killswitch. Bundled via `include_str!` — no extra build step.
- **Keyboard shortcuts** are defined as `Hotkeys` constants in `src/lib/hotkeys.ts` and use `tinykeys` with `$mod` for the platform-primary modifier (Cmd on macOS, Ctrl elsewhere). Don't hardcode `Meta+` or `Control+` at call sites.
- **Local persistence** (UI state like collapsed groups, dismissed update version) goes in `localStorage` under the `acorn:` key prefix. Don't reach for it from inside pure logic — keep it at the component / store edge.
- **Logic stuck inside a component** that wants a unit test should be extracted to `src/lib/`. Don't try to test it through the rendered component. Example: `Sidebar.tsx`'s `buildProjectGroups` could move out if it grows.
- **`src/lib/api.ts` is the only place that calls `invoke()` from app code.** New backend commands get a wrapper there with explicit types. Components import from `api`, not from `@tauri-apps/api/core`.
- **Comments describe current state only.** No history accumulation, no "previously/legacy/v1/PR #N" framing, no WHAT restatement. Present-tense WHY only — see [`docs/COMMENTS.md`](docs/COMMENTS.md).

## Things that go wrong if you forget

- **Adding a new boot-time invoke without a default in `tests/e2e/fixtures/tauriMock.ts`** → E2E tests crash silently with a RightPanel-style error and missing data. Add the default when you add the wrapper.
- **Returning `null` from a backend command that the UI iterates with `.length` / `.map`** → boot crash. Return empty arrays/objects, not nullable wrappers.
- **Forgetting StrictMode double-fire when wiring `listen()`** → duplicate side effects. Use a `cancelled`/`disposed` flag. See `Terminal.tsx`'s `spawnPty` for the pattern.
- **Creating files for "future" abstractions** → don't. KISS. Add the second use case before the abstraction.

## Build / run

```sh
bun install
bun run build:sidecar  # stage acorn-ipc — required for fresh checkouts / worktrees
bun run tauri dev      # full app (Rust + Vite)
bun run dev            # Vite only — frontend in browser, no Tauri
bun run test           # Vitest
bun run test:e2e       # Playwright
bun run typecheck
bun run build          # tsc + vite build
```

`src-tauri/binaries/acorn-ipc-<target-triple>` is `.gitignore`d, so every fresh checkout — including each new `git worktree add` — starts without it, and Tauri's `externalBin` existence check fails the build before anything else runs. Run `bun run build:sidecar` once per worktree (and again after any IPC change); plain `cargo build --bin acorn-ipc` is not enough because it skips the target-tripled staging step. See [`docs/CONTROL_SESSIONS.md`](docs/CONTROL_SESSIONS.md#the-acorn-ipc-cli) for details.

## When in doubt

- Reading: `docs/TESTING.md`, `docs/E2E_TESTING.md`, `docs/PR_LABELS.md`, `docs/COMMENTS.md`.
- Patterns: search `src/` first for similar code already in the repo. Match its shape.
