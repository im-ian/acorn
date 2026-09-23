# Session IPC (`acorn-ipc`)

> **Platform support: macOS, Windows, and Linux.** The shared local transport
> uses owner-only Unix domain sockets on macOS/Linux and owner-only named
> pipes on Windows.

Every Acorn terminal can drive its sibling sessions over a local IPC protocol
called `acorn-ipc`. Any process running inside a session PTY — including
agents like Claude, Codex, or Grok — inherits that capability.

The mental model is tmux's *control mode* without a privileged dispatcher
pane: each session can list, spawn, type into, read, focus, or kill other
sessions in the same project. Acorn leans on the system process tree instead
of multiplexing over a single PTY.

Persisted sessions may still carry `kind: "control"` from older builds. That
field is coerced to `regular` on load/list and is not an authorization gate.

## Agent priming

Sessions always spawn the native interactive shell (`$SHELL` on Unix, then
PowerShell/cmd fallbacks on Windows), so Acorn never invokes the agent CLI
directly — the user does, from inside the shell. Whichever agent the user
launches should be able to orchestrate siblings immediately. Acorn ships that
priming through PTY environment on every spawn:

- `ACORN_RESUME_TOKEN` — this session's UUID, used for agent resume and as
  a fallback identity diagnostic.
- `ACORN_DATA_DIR` — the resolved Acorn profile data directory. This
  keeps bundled release sidecars aligned with the app's selected
  profile.
- `ACORN_IPC_SOCKET` — the canonical Unix-socket or Windows named-pipe endpoint.
- `ACORN_IPC_CAPABILITY` — a random per-PTY capability. The server also
  verifies the peer process is a live descendant of that PTY, so copying
  the value into an unrelated same-user process is insufficient.
- `PATH` — the directory containing the bundled `acorn-ipc` binary is
  prepended (de-duplicated), so the agent can invoke `acorn-ipc` by name
  without the user installing a shim.
- `ACORN_SESSION_ID` — the session UUID. This is the primary source id for
  IPC operations.
- `ACORN_WORKSPACE_ID`, `ACORN_WORKSPACE_PATH`, `ACORN_WORKSPACE_NAME` —
  the frontend workspace that owned the terminal when its PTY spawned.
  `acorn-ipc new-session --workspace current` uses these to place new
  sessions back into the same workspace.
- `ACORN_DAEMON_SOCKET` — the background daemon control endpoint, so
  scripts can also reach `acornd`.

When the PTY starts, the shell prints only the session id and a pointer
to this guide:

```text
Acorn session: <ACORN_SESSION_ID>
acorn-ipc guide: https://github.com/im-ian/acorn/blob/main/docs/SESSION_IPC.md
```

Agents reload the same protocol at any time with `acorn-ipc context`. The
primer lists the session id, IPC endpoints, and every `acorn-ipc`
subcommand. In a request to an agent, "new session" means a sibling Acorn
terminal in this project unless the user clearly means a new chat.

## The `acorn-ipc` CLI

When Acorn spawns a terminal it injects these env vars into the PTY:

| Env var             | Source                            |
| ------------------- | --------------------------------- |
| `ACORN_RESUME_TOKEN` | The session's UUID               |
| `ACORN_DATA_DIR`    | Resolved Acorn profile data dir   |
| `ACORN_IPC_SOCKET`  | In-app IPC endpoint              |
| `ACORN_IPC_CAPABILITY` | Random per-PTY capability    |
| `ACORN_SESSION_ID`  | The session's UUID                |
| `ACORN_WORKSPACE_ID` | Current frontend workspace id    |
| `ACORN_WORKSPACE_PATH` | Current frontend workspace cwd |
| `ACORN_WORKSPACE_NAME` | Current frontend workspace name |
| `ACORN_DAEMON_SOCKET` | Daemon control endpoint        |

The `acorn-ipc` binary reads `ACORN_SESSION_ID` first, then falls back to
`ACORN_RESUME_TOKEN`, and uses `ACORN_IPC_SOCKET` for transport. Commands run
straight from the shell without flags. Every request is rejected unless the
source session is live and the caller is a PTY descendant presenting the
matching capability.

By default, release builds use `profiles/prod` and debug builds use
`profiles/dev` below Acorn's app data directory. Set `ACORN_PROFILE=<name>`
to select another profile, or `ACORN_DATA_DIR=<path>` to pin all runtime
state, IPC endpoints, and staged shell init files to an
explicit directory.

> **Gotcha for agents running inside an Acorn terminal.** Acorn injects
> `ACORN_DATA_DIR`, `ACORN_IPC_SOCKET`, `ACORN_DAEMON_SOCKET`, and related
> session metadata into the PTY env so bundled CLIs talk to the right
> profile. `acorn-paths::data_dir` resolves `ACORN_DATA_DIR` **before** the
> profile fallback (see `src-tauri/crates/acorn-paths/src/lib.rs`), and
> `acorn-ipc` resolves `ACORN_IPC_SOCKET` **before** computed profile paths.
> Running `pnpm run tauri dev` from that shell can make the debug build
> inherit the host's `profiles/prod` directory or prod IPC socket — it reuses
> the prod sessions, prod daemon socket, and prod sidecar persistence, even
> though it is a debug binary. The dev app and the installed app then fight
> over the same daemon and `sessions.json`.
>
> When launching `tauri dev` from inside an Acorn-managed shell, strip the
> inherited overrides (and any other prod-only env Acorn injects) and pin
> the dev profile explicitly:
>
> ```sh
> env -u ACORN_DATA_DIR \
>     -u ACORN_IPC_SOCKET \
>     -u ACORN_DAEMON_SOCKET \
>     -u ACORN_WORKSPACE_ID \
>     -u ACORN_WORKSPACE_PATH \
>     -u ACORN_WORKSPACE_NAME \
>     -u ACORN_AGENT_STATE_DIR \
>     -u ACORN_AGENT_WRAPPER_DIR \
>     -u ACORN_CLI_DIR \
>     -u ACORN_RESUME_TOKEN \
>     -u ACORN_STAGED_REV \
>     -u ACORN_USER_ZDOTDIR \
>     ACORN_PROFILE=dev \
>     pnpm run tauri dev
> ```
>
> The same caveat applies to any process that should run in dev-profile
> isolation while being launched from an Acorn-managed shell — including
> `pnpm exec playwright test` if it spawns the bundled `acornd` sidecar.
> Outside an Acorn-managed shell (your own login shell, CI) there is nothing to
> strip; debug builds already default to `profiles/dev` on their own.

### Install

`acorn-ipc` ships inside the Acorn application bundle (Tauri's `externalBin`
mechanism — see `src-tauri/tauri.conf.json`). Inside an Acorn PTY there is
**nothing to install**: the bundled binary's directory is prepended to `PATH`,
so `acorn-ipc list-sessions` works out of the box.

You only need a system-wide install when you want to call `acorn-ipc`
from **outside** an Acorn terminal (debugging from your own shell, an
external script, a Makefile, …). In that case use the Settings shortcut
under Sessions → "acorn-ipc CLI", which generates a single-line
`ln -sf` command pointing at the bundled binary. The Copy button lands
the command on your clipboard; paste it into a terminal and run it.

If you are building from source rather than installing a release, the
sidecar is staged for you when you run `tauri build`. For a dev loop:

```sh
pnpm run build:sidecar   # one-time; run again after sidecar changes
pnpm run tauri dev
```

`pnpm run build:sidecar` runs `src-tauri/scripts/build-sidecar.mjs`,
which compiles the bundled sidecars and stages them at
`src-tauri/binaries/<name>-<target-triple>[.exe]`, the paths Tauri's
`externalBin` existence check requires before `tauri dev` / `tauri build`
will even start. Plain `cargo build -p acorn-ipc --bin acorn-ipc` skips the
staging step, so the build fails with
`resource path 'binaries/acorn-ipc-...' doesn't exist`.

When working across multiple local worktrees, you can set `CARGO_TARGET_DIR`
to a shared directory outside the worktree, for example
`/path/to/acorn/.acorn/cargo-target`. The sidecar script
honours that setting for Cargo's build output while still staging the final
binaries under `src-tauri/binaries/`, where Tauri expects them.

Settings → Sessions → "acorn-ipc CLI" shows the resolved binary path
Acorn currently sees (it looks for `acorn-ipc` next to the running app
binary; once the release bundle ships the CLI, that lookup will succeed
out of the box) and a one-click "Copy install command" for whatever shim
location your system has on `$PATH`.

To verify:

```sh
acorn-ipc --help
```

### Commands

```text
acorn-ipc promote-self
acorn-ipc context
acorn-ipc list-sessions
acorn-ipc list-workspaces
acorn-ipc new-session   <name> [--workspace current|PATH] [--workspace-id ID] [--isolated] [--owner me|user]
acorn-ipc send-keys     -t <uuid> --data "ls" --enter [--allow-foreign]
acorn-ipc read-buffer   -t <uuid> [--max-bytes N] [--allow-foreign]
acorn-ipc select-session -t <uuid> [--allow-foreign]
acorn-ipc close-self
acorn-ipc kill-session  -t <uuid> [--allow-foreign]
```

`--allow-foreign` is accepted for compatibility and has no effect. Sibling
actions in the same project succeed without it.

`send-keys` and `read-buffer` do not require the target to be focused.
They reach a live PTY, including one whose terminal view was detached to
stay under the mounted-terminal cap. `select-session` moves the user's
focus. Use it only when the target has no live PTY yet and you need that
shell's output: `new-session` persists a row and does not start a shell,
and focusing the session is what mounts the terminal and calls `pty_spawn`.

Add `--json` to any command to get machine-readable output. Each command
exits non-zero with a stable code on error:

| Exit | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 2    | Unauthorized — source session missing, capability/PID mismatch, etc. |
| 3    | Target session not found                                           |
| 4    | Target session belongs to a different project                      |
| 5    | Invalid request shape / arguments                                  |
| 6    | Internal — PTY write failed, persistence failed, etc.              |
| 7    | Foreign session — unused; older CLIs may still decode this tag     |

### Ownership

Sessions created from the UI are owned by `user`. Sessions created through
`acorn-ipc new-session` are owned by the creating session by default
(`control:<source session id>`), unless the caller passes `--owner user`.

Ownership is metadata: `list-sessions` reports `owned_by_me`, and
`close-self` / UI remove cascade to those owned workers. It does not gate
`send-keys`, `read-buffer`, `select-session`, or `kill-session`.

By default, `acorn-ipc new-session` still creates a session at the project
root. Pass `--workspace current` to create it in the same Acorn workspace as
the source session, or `--workspace /absolute/path` to target a registered
project cwd or one of that project's linked worktrees. `--workspace-id` is
the exact frontend workspace placement hint; it is filled automatically for
`--workspace current` when Acorn injected `ACORN_WORKSPACE_ID`.

`list-workspaces` is subject to the same authorization gate as every command:
the source session must be live, and the result is scoped to the source
session's `repo_path`. It asks the loaded frontend for named workspace
metadata in that project. The response includes each workspace's `id`,
`name`, `repo_path`, `workspace_path`, whether it is the default workspace,
whether it is active, whether it owns the source session, and its current
session count. Use the returned `workspace_path` and `id` together when
creating a session in a specific named workspace:

```sh
workspace_id=$(acorn-ipc list-workspaces --json | jq -r '.workspaces[] | select(.name == "Frontend") | .id')
workspace_path=$(acorn-ipc list-workspaces --json | jq -r '.workspaces[] | select(.name == "Frontend") | .workspace_path')
acorn-ipc new-session "frontend-worker" --workspace "$workspace_path" --workspace-id "$workspace_id"
```

Because named workspaces are renderer-owned UI state, `list-workspaces`
requires the Acorn frontend to be loaded and responsive. If the window is
reloading or the listener is unavailable, the IPC server returns an internal
error instead of guessing from backend session paths.

`close-self` is the explicit self-closing path. The server first acknowledges
the request, waits for the CLI to read the response and close its socket, then
terminates the source session's complete runtime and removes its session
record. Every session owned by that source is closed too; unrelated and
user-owned sessions are left running.

`promote-self` is an idempotent compatibility probe. It does not change
session kind.

### Examples

Send a command to every sibling and wait for output:

```sh
for id in $(acorn-ipc list-sessions --json | jq -r '.sessions[] | select(.is_source | not) | .id'); do
  acorn-ipc send-keys -t "$id" --data "git status" --enter
  sleep 1
  acorn-ipc read-buffer -t "$id" --max-bytes 4096
  echo "---"
done
```

Spin up a fresh isolated worktree. `select-session` is only here so the
new row gets a shell; skip it when the target already has a live PTY.

```sh
acorn-ipc promote-self   # no-op; confirms this terminal is authorized
new_id=$(acorn-ipc new-session "patch-bot" --isolated)
acorn-ipc select-session -t "$new_id"   # moves focus; starts the PTY
```

Close the current session only after its work and final report are complete:

```sh
acorn-ipc close-self
```

## Security model

- Unix socket files are created with mode `0600`. Windows named pipes use an
  owner-only DACL. In both cases, other local users are denied access.
- Every request carries the source session UUID and a random per-PTY
  capability. The server additionally obtains the peer PID from the kernel and
  requires it to be the PTY root or a live descendant. UUIDs or copied env
  values alone are not authentication.
- Target lookups are scoped to the source's project (`repo_path`).
  Cross-project requests surface a distinct `OutOfScope` error so the CLI
  can give an accurate diagnostic instead of a misleading "not found".
- `list-workspaces` is read-only but still requires an authenticated source
  session. The backend sends the source `repo_path` to the renderer and treats
  the response as project-scoped workspace metadata, not as permission to
  touch sessions in other projects.
- `kill-session` refuses to kill the source session itself. Self-close
  requires the separate, explicit `close-self` request and can only target the
  authenticated source session.

Every process deliberately launched inside a session PTY is inside that
session's authority boundary and inherits its capability. Do not run untrusted
repository commands in a session you do not want to grant sibling control.
Kernel/admin compromise, debugger injection, and code already executing
inside the PTY are outside this boundary; unrelated same-user processes
outside the PTY ancestry are rejected.

An older `acornd` generation kept alive because it still has PTYs may still
reject non-Control CLI Hello until takeover. The sidecar shipped with this
app generation does not.

## Wire protocol

JSON, newline-delimited, one request → one response per connection. Wire
version `2`. See `src-tauri/crates/acorn-ipc/src/proto.rs` for the canonical
types.

```jsonc
// Request
{
  "protocol_version": 2,
  "source_session_id": "…uuid…",
  "session_capability": "…uuid…",
  "request": { "kind": "send-keys", "target_session_id": "…", "data_b64": "…" }
}

// Response
{ "kind": "ack" }
// or
{ "kind": "error", "code": "out-of-scope", "message": "…" }
```

## Troubleshooting

| Symptom                                              | Likely cause                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `source session id is unset`                         | Running `acorn-ipc` outside an Acorn-managed terminal without `--source` |
| `connect: No such file or directory`                 | App not running, or socket path overridden                            |
| Exit 2 after `promote-self`                          | Source session missing, or capability/PID did not match               |
| Exit 4 even though both sessions look right          | Sessions belong to different `repo_path`s; check Sidebar grouping     |
| `read-buffer` returns `truncated` for short sessions | Bytes still in flight to xterm but cleared by `clear`/`reset` already |

## Limitations

- The CLI does not currently auto-install system-wide. The Settings-generated
  symlink command is Unix-only; Windows users can invoke the bundled CLI from
  an Acorn terminal, where its directory is already prepended to `PATH`.
- `send-keys` does not interpret tmux-style escapes (`C-c`, `Enter`); pass
  literal bytes via `--data` or pre-encoded base64 via `--raw-base64`.
- Audit logging is `tracing::info!`-level only; there is no on-disk audit
  file yet.
- Priming relies on env vars plus `acorn-ipc context`. The previous spawn-time
  CLI flag injection (Claude `--append-system-prompt`, `llm -s`) is dormant
  because Acorn no longer spawns the agent directly — the user does, from
  inside the selected shell. The flag-injection code remains and will activate
  again if that shell is ever set to a recognised agent binary.
