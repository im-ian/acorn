# CLAUDE.md

Conventions and gotchas for AI coding agents working on Acorn. This is a living doc — add things future-you would have wanted to know.

## Project shape

- **Tauri 2** desktop app. Frontend in `src/`, Rust backend in `src-tauri/`.
- **pnpm** is the package manager. Use `pnpm install`, `pnpm run dev`, `pnpm add` — not `npm`/`yarn`/`bun`.
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
- **The `acornd` background daemon** owns persistent PTY sessions across Acorn restarts. It lives in `src-tauri/src/daemon/`, ships as a sidecar binary alongside `acorn`, and is reachable both from inside the app (via `daemon_bridge::DaemonBridge` on `AppState`) and from a control session's PTY (the `acornd` CLI subcommand). The killswitch lives in `localStorage` under `acorn:daemon-enabled` (default ON); the bridge's `set_enabled(false)` short-circuits every call so the caller falls back to the in-process PTY path. The daemon binary is built automatically by `pnpm run dev:sidecar`, which `tauri.conf.json::beforeDevCommand` chains in front of `vite`, and is staged for release by `src-tauri/scripts/build-sidecar.sh` alongside `acorn-ipc`. Anything that adds a new `daemon_*` Tauri command must also add a matching mock in `tests/e2e/fixtures/tauriMock.ts` (existing handlers default to "disabled / not running" so non-daemon E2Es keep passing).
- **Agent conversation tracking via filesystem-watcher persister.** The shim-based capture (`src-tauri/shims/claude.sh` + `codex.sh`) was structurally fragile: macOS `/etc/zprofile` runs `path_helper` for every login zsh, which rebuilds `PATH` from `/etc/paths` + `/etc/paths.d/*` and pushes Acorn-prepended entries to the back. Any user-rc `PATH` prepend (`export PATH="$HOME/.local/bin:$PATH"`) buried the shim further, real `claude`/`codex` resolved first, the shim never ran, and the focus-time "이전 대화 이어하기" modal was dead-on-arrival for most users. The shim is gone. Replacement: `agent_resume_persister` spawns at boot and polls `transcript_watcher::collect_live_mappings` on a 2-second interval. That helper walks every Acorn session's PTY descendant tree, finds the live `claude` / `codex` process, resolves the JSONL it's writing (cwd + mtime + start-time match against `~/.claude/projects/<slug>/` for claude or `$CODEX_HOME/sessions/<y>/<m>/<d>/` for codex), and the persister writes the resolved UUID to `<data_dir>/agent-state/<session-uuid>/claude.id` (resp. `codex.id`) whenever it differs from the current value. The frontend modal calls `get_claude_resume_candidate` / `get_codex_resume_candidate` on session focus; those compare `*.id` against `*.id.acknowledged` (written by the modal's dismiss path) and surface a candidate only when a *new* UUID has landed. Codex no longer auto-resumes — same modal pattern as claude — because the shell-side `exec codex resume <uuid>` trick disappeared with the shim. `ACORN_AGENT_STATE_DIR` is still exported into the PTY env for end-user scripts that wanted to introspect Acorn state; nothing inside the PTY needs it for the modal to work.
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
pnpm install
pnpm run build:sidecar  # stage acorn-ipc — required for fresh checkouts / worktrees
pnpm run tauri dev      # full app (Rust + Vite)
pnpm run dev            # Vite only — frontend in browser, no Tauri
pnpm run test           # Vitest
pnpm run test:e2e       # Playwright
pnpm run typecheck
pnpm run build          # tsc + vite build
```

`src-tauri/binaries/acorn-ipc-<target-triple>` is `.gitignore`d, so every fresh checkout — including each new `git worktree add` — starts without it, and Tauri's `externalBin` existence check fails the build before anything else runs. Run `pnpm run build:sidecar` once per worktree (and again after any IPC change); plain `cargo build --bin acorn-ipc` is not enough because it skips the target-tripled staging step. See [`docs/CONTROL_SESSIONS.md`](docs/CONTROL_SESSIONS.md#the-acorn-ipc-cli) for details.

## Reading webview logs in dev

`vite-console-forward-plugin` is wired in `vite.config.ts` (dev only). Every `console.log` / `warn` / `error` / `info` / `debug` call inside the running webview is POSTed to the Vite dev server and printed to the same terminal `pnpm run tauri dev` is logging to, prefixed with `[browser]`. AI agents and humans can read app logs without opening the WKWebView inspector (which is blocked anyway by the keybinding guards in `src/main.tsx`).

The plugin no-ops in `vite build` and is not loaded by Vitest (it only injects via `transformIndexHtml` + `configureServer`, neither of which fire during unit tests).

## When in doubt

- Reading: `docs/TESTING.md`, `docs/E2E_TESTING.md`, `docs/PR_LABELS.md`, `docs/COMMENTS.md`.
- Patterns: search `src/` first for similar code already in the repo. Match its shape.
