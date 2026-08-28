# COMMON.md

Conventions and gotchas for AI coding agents working on Acorn. This is a living doc — add things future-you would have wanted to know.

## Project shape

- **Tauri 2** desktop app. Frontend in `src/`, Rust backend in `src-tauri/`.
- **pnpm** is the package manager. Use `pnpm install`, `pnpm run dev`, `pnpm add` — not `npm`/`yarn`/`bun`.
- Frontend: React 19, Vite, Tailwind 4, zustand. UI talks to Rust via `invoke()` from `@tauri-apps/api/core`, centralized in `src/lib/api.ts`.
- React **StrictMode is on** (`src/main.tsx`). Effects run twice on mount in dev — guard async work with a cancellation flag, don't assume single-mount.

## Testing

Two layers, do not mix them up. Full decision framework: [`docs/TESTING.md`](TESTING.md).

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

Playwright-specific patterns (mock setup, hotkey helper, closure rules, capturing invoke args) live in [`docs/E2E_TESTING.md`](E2E_TESTING.md). Read it before writing E2E.

Two recurring traps in E2E:
1. **Handler functions are serialized to source.** They cannot close over test-side variables, helpers, or imports. Inline the data inside each handler.
2. **OS keyboard shortcuts (Cmd+P, Cmd+,) are intercepted by Chromium.** Use `pressHotkey()` from `tests/e2e/support.ts`, not `page.keyboard.press()`.

Rust unit tests resolve persistence through a process-local temporary data
directory and ignore inherited `ACORN_DATA_DIR`. Keep project source-grouping
helpers free of `persist()` calls; the Tauri command boundary owns the durable
write.

## Code conventions

- **Custom window events use the `acorn:` prefix** (`acorn:new-session`, `acorn:add-project`, `acorn:terminal-clear`). When adding a global event, follow this convention so listener wiring stays greppable.
- **Sessions have a `kind`** (`SessionKind`): `regular` or `control`. Every session spawns the native interactive shell (`$SHELL` on Unix, then PowerShell/cmd fallbacks on Windows); an agent CLI is only present when the user runs one inside that shell. Control sessions get `ACORN_SESSION_ID`, `ACORN_IPC_SOCKET`, and `ACORN_DAEMON_SOCKET` injected into their PTY env, the bundled `acorn-ipc` directory prepended to `PATH`, and a `<cwd>/.acorn-control.md` marker so any agent the user invokes can drive siblings via the `acorn-ipc` CLI (in-process IPC server) or the newer `acornd` CLI (background daemon) — see [`docs/CONTROL_SESSIONS.md`](CONTROL_SESSIONS.md). When touching session creation flow, preserve the kind through every path (api wrapper → Tauri command → `Session::new` → persistence). When touching `commands::pty_spawn`, keep the `kind == Control` branch intact — losing it silently disables the IPC priming.
- **IPC-created sessions can target a frontend workspace.** `TerminalHost` passes `ACORN_WORKSPACE_ID`, `ACORN_WORKSPACE_PATH`, and `ACORN_WORKSPACE_NAME` into PTY spawn env. `acorn-ipc list-workspaces` bridges through the frontend because named workspace folders live in Zustand/localStorage, not backend `SessionStore`. `acorn-ipc new-session --workspace current` sends those hints back through the IPC server, and the frontend `acorn:ipc-sessions-changed` listener applies the workspace assignment after `refreshSessions()`. Backend session records still only persist `repo_path` and `worktree_path`; backend-only code must not infer exact named root workspace placement from path alone.
- **The `acornd` background daemon** owns persistent PTY sessions across Acorn restarts. Its reusable runtime lives in `src-tauri/crates/acorn-daemon/`, its host binary is `src-tauri/src/bin/acornd.rs`, and it ships as a sidecar alongside `acorn`. It is reachable both from inside the app (via `daemon_bridge::DaemonBridge` on `AppState`) and from a control session's PTY (the `acornd` CLI subcommand). The killswitch lives in `localStorage` under `acorn:daemon-enabled` (default ON); disabling it routes new, unbound sessions to the in-process PTY path, while rows with a persisted `daemon_session_id` stay on the daemon route until explicitly terminated so one UUID can never split across two PTYs. At app-version changes, an idle older daemon is shut down and replaced automatically. An older daemon with live PTYs is retained as one generation, and new daemon-routed sessions join that generation; takeover happens before the first RPC after every session in it has drained. The tokenless minor-0 client shipped before daemon authentication remains compatible only when its kernel peer PID resolves to the exact Acorn executable path that started the daemon; all newer clients require the shared token. The daemon binary is built automatically by `pnpm run dev:sidecar`, which `tauri.conf.json::beforeDevCommand` chains in front of `vite`, and is staged for release by `src-tauri/scripts/build-sidecar.mjs` alongside `acorn-ipc`. Anything that adds a new `daemon_*` Tauri command must also add a matching mock in `tests/e2e/fixtures/tauriMock.ts` (existing handlers default to "disabled / not running" so non-daemon E2Es keep passing).
- **Agent conversation tracking via filesystem-watcher persister.** The shim-based capture (`src-tauri/shims/claude.sh` + `codex.sh`) was structurally fragile: macOS `/etc/zprofile` runs `path_helper` for every login zsh, which rebuilds `PATH` from `/etc/paths` + `/etc/paths.d/*` and pushes Acorn-prepended entries to the back. Any user-rc `PATH` prepend (`export PATH="$HOME/.local/bin:$PATH"`) buried the shim further, real agent binaries resolved first, and the focus-time "이전 대화 이어하기" modal was dead-on-arrival for most users. The shim is gone. Replacement: `agent_resume_persister` spawns at boot and polls `transcript_watcher::collect_live_mappings` on a 2-second interval. That helper walks every Acorn session's PTY descendant tree, finds live `claude` / `codex` / `agy` / `grok` processes, and resolves the transcript each is writing using cwd, file metadata, and process start time. Provider roots are `~/.claude/projects/<slug>/`, `$CODEX_HOME/sessions/<y>/<m>/<d>/`, `${ANTIGRAVITY_DIR:-~/.gemini}/antigravity*/brain/<uuid>/.system_generated/logs/transcript.jsonl`, and `${GROK_HOME:-~/.grok}/sessions/<cwd-bucket>/<uuid>/updates.jsonl`; Grok ownership is verified against the sibling `summary.json` and hidden/subagent sessions are excluded. The persister writes the resolved UUID to `<data_dir>/agent-state/<session-uuid>/{claude,codex,antigravity,grok}.id` whenever it changes. For Antigravity, it also writes `antigravity.cwd` because brain transcripts may omit workspace metadata. The frontend uses the generic provider resume-candidate commands on session focus; those compare `*.id` against `*.id.acknowledged` and surface a candidate only when a new UUID lands. Settings → Sessions → auto-resume (`sessions.autoResume`) sends that candidate's resume command into the PTY instead of showing the modal; probing still skips sessions that already have a live agent. `ACORN_AGENT_STATE_DIR` remains exported for end-user scripts; nothing inside the PTY needs it for the modal to work.
- **A project spans one or more repository roots.** `Project.repo_path` is the primary root and the store key; `Project.source_paths` holds extra roots the user attached. A session always records exactly one real root as its `repo_path`, so diffs, the GitHub panel, and agent history stay anchored to a genuine repository — the project is purely the grouping drawn around those roots. Backend authorization (`registered_project_roots`, `ensure_project_for_root`) resolves through every root, which is what keeps a session started under a source folder from minting a duplicate top-level project. On the frontend, `projectFolders` stays keyed by real root: `buildProjectFolderGroups` merges a project's roots into one sidebar group, and only the primary root's default folder is flattened under the project header (`isGroupDefaultFolder`) — a source root's default folder renders as a workspace row. When adding a "is this a registered project?" check, route it through `projectRootPaths` / `buildProjectRootIndex` rather than comparing against `repo_path` alone.
- **Keyboard shortcuts** are defined as `Hotkeys` constants in `src/lib/hotkeys.ts` and use `tinykeys` with `$mod` for the platform-primary modifier (Cmd on macOS, Ctrl elsewhere). Don't hardcode `Meta+` or `Control+` at call sites.
- **Local persistence** (UI state like collapsed groups, dismissed update version) goes in `localStorage` under the `acorn:` key prefix. Don't reach for it from inside pure logic — keep it at the component / store edge.
- **Logic stuck inside a component** that wants a unit test should be extracted to `src/lib/`. Don't try to test it through the rendered component. Example: `Sidebar.tsx`'s project folder grouping logic should live in `src/lib/projectFolders.ts`.
- **`src/lib/api.ts` is the only place that calls `invoke()` from app code.** New backend commands get a wrapper there with explicit types. Components import from `api`, not from `@tauri-apps/api/core`.
- **Comments describe current state only.** No history accumulation, no "previously/legacy/v1/PR #N" framing, no WHAT restatement. Present-tense WHY only — see [`docs/COMMENTS.md`](COMMENTS.md).
- **Rust is `rustfmt`-formatted, and CI enforces it.** Style is pinned in `src-tauri/rustfmt.toml`, the `Rust format` CI job runs `cargo fmt --all --check`, and `.githooks/pre-commit` reformats staged `.rs` files so drift never reaches a commit. Enable the hook once per clone: `git config core.hooksPath .githooks`.

## Things that go wrong if you forget

- **Adding a new boot-time invoke without a default in `tests/e2e/fixtures/tauriMock.ts`** → E2E tests crash silently with a RightPanel-style error and missing data. Add the default when you add the wrapper.
- **Returning `null` from a backend command that the UI iterates with `.length` / `.map`** → boot crash. Return empty arrays/objects, not nullable wrappers.
- **Forgetting StrictMode double-fire when wiring `listen()`** → duplicate side effects. Use a `cancelled`/`disposed` flag. See `Terminal.tsx`'s `spawnPty` for the pattern.
- **Creating files for "future" abstractions** → don't. KISS. Add the second use case before the abstraction.

## Build / run

```sh
pnpm install
pnpm run build:sidecar  # stage Rust sidecars — required for fresh checkouts / worktrees
pnpm run tauri dev      # full app (Rust + Vite)
pnpm run dev            # Vite only — frontend in browser, no Tauri
pnpm run test           # Vitest
pnpm run test:e2e       # Playwright
pnpm run typecheck
pnpm run build          # tsc + vite build
```

`src-tauri/binaries/<name>-<target-triple>[.exe]` sidecars are `.gitignore`d, so every fresh checkout — including each new `git worktree add` — starts without them, and Tauri's `externalBin` existence check fails the build before anything else runs. Run `pnpm run build:sidecar` once per worktree (and again after any sidecar change); plain `cargo build -p acorn-ipc --bin acorn-ipc` is not enough because it skips the target-tripled staging step. See [`docs/CONTROL_SESSIONS.md`](CONTROL_SESSIONS.md#the-acorn-ipc-cli) for details.

For local Rust work across multiple Acorn worktrees, set `CARGO_TARGET_DIR` to a shared directory outside the worktree so Cargo can reuse dependency artifacts across worktrees:

```sh
export CARGO_TARGET_DIR=/path/to/acorn/.acorn/cargo-target
```

`src-tauri/scripts/build-sidecar.mjs` honours the same setting when staging Tauri sidecars. Native sidecar builds use Cargo's standard host output directory, so the following Tauri app build reuses those dependency artifacts instead of compiling them again in a target-triple subdirectory. Keep `CARGO_TARGET_DIR` as a local environment setting rather than a committed default so CI and release builds keep their normal per-workspace target layout.

**Launching `tauri dev` from inside a control session.** Acorn injects `ACORN_DATA_DIR`, `ACORN_IPC_SOCKET`, `ACORN_DAEMON_SOCKET`, and related session metadata into every control-session PTY so bundled CLIs talk to the host profile. `acorn-paths::data_dir` honours `ACORN_DATA_DIR` ahead of the debug/release profile fallback, and `acorn-ipc` honours `ACORN_IPC_SOCKET` ahead of computed profile paths. A plain `pnpm run tauri dev` from that shell can silently run the debug app against `profiles/prod` — same daemon, same `sessions.json`, same staged shell-init dir as the installed app. Strip the overrides before launching:

```sh
env -u ACORN_DATA_DIR \
    -u ACORN_IPC_SOCKET \
    -u ACORN_DAEMON_SOCKET \
    -u ACORN_WORKSPACE_ID \
    -u ACORN_WORKSPACE_PATH \
    -u ACORN_WORKSPACE_NAME \
    -u ACORN_AGENT_STATE_DIR \
    -u ACORN_AGENT_WRAPPER_DIR \
    -u ACORN_AGENT_HOOK_SESSION_ID \
    -u ACORN_AGENT_HOOK_URL \
    -u ACORN_AGENT_HOOK_TOKEN \
    -u ACORN_AGENT_HOOK_PROVIDER \
    -u ACORN_AGENT_INVOCATION_ROOT \
    -u ACORN_AGENT_INVOCATION_TOKEN \
    -u ACORN_AGENT_INVOCATION_DEPTH \
    -u ACORN_CLI_DIR \
    -u ACORN_RESUME_TOKEN \
    -u ACORN_STAGED_REV \
    -u ACORN_USER_ZDOTDIR \
    ACORN_PROFILE=dev \
    pnpm run tauri dev
```

Outside a control session (your own login shell, CI) the overrides aren't set, so a plain `pnpm run tauri dev` already lands on `profiles/dev`. See [`docs/CONTROL_SESSIONS.md`](CONTROL_SESSIONS.md#the-acorn-ipc-cli) for the full env table.

## Reading webview logs in dev

`vite-console-forward-plugin` is wired in `vite.config.ts` (dev only). Every `console.log` / `warn` / `error` / `info` / `debug` call inside the running webview is POSTed to the Vite dev server and printed to the same terminal `pnpm run tauri dev` is logging to, prefixed with `[browser]`. AI agents and humans can read app logs without opening the WKWebView inspector (which is blocked anyway by the keybinding guards in `src/main.tsx`).

The plugin no-ops in `vite build` and is not loaded by Vitest (it only injects via `transformIndexHtml` + `configureServer`, neither of which fire during unit tests).

## When in doubt

- Reading: `docs/TESTING.md`, `docs/E2E_TESTING.md`, `docs/PR_LABELS.md`, `docs/COMMENTS.md`, `docs/CONTROL_SESSIONS.md` (acorn-ipc CLI + control session env table).
- Patterns: search `src/` first for similar code already in the repo. Match its shape.
