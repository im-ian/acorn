# Control sessions

> Status: early preview. The data model, hotkey, and `acorn-ipc` CLI ship in
> Acorn 1.0.9. Expect rough edges; expect the protocol to bump if the wire
> shape needs revision.
>
> **Platform support: macOS and Linux only.** The IPC transport is a Unix
> domain socket, so the `acorn-ipc` binary and the in-app server do not
> compile on Windows. Acorn itself runs on Windows; control sessions and
> everything in this document do not. See [Limitations](#limitations) for
> what porting would entail.

A **control session** is an ordinary Acorn terminal that has been marked with
`SessionKind::Control`. The mark gives the terminal — and any process running
inside it, including agents like Claude or Codex — permission to drive its
sibling sessions over a Unix-socket protocol called `acorn-ipc`.

The mental model is tmux's *control mode*: one pane acts as the dispatcher,
the others are workers. Acorn just leans on the system process tree instead
of multiplexing over a single PTY.

## Creating a control session

Three entry points:

- Hotkey: `⌘⌥⇧T` (mac) / `Ctrl+Alt+Shift+T` (others). Creates the session in
  whatever project is currently active.
- Sidebar: hover a project header → click the `Bot` icon.
- Command palette: `⌘P` → `New control session`.

The first time you create one, Acorn shows a one-time guide. You can re-open
it from Settings → Sessions → "Control sessions" or by clearing
`localStorage["acorn:control-guide-dismissed-v1"]`.

A control session shows a small `Bot` accessory icon next to its name in the
sidebar — that's the visual signal that this terminal can do more than a
regular shell.

## Agent priming

Sessions always spawn the user's `$SHELL`, so Acorn never invokes the
agent CLI directly — the user does, from inside the shell. The point of a
control session is that whichever agent the user launches inside it
should be able to orchestrate siblings *immediately*, not only after the
user has explained the protocol. Acorn ships that priming through two
layers that fire automatically every time a control-session PTY spawns:

1. **PTY environment.** Four pieces of state are injected into the
   control session's PTY before any user code runs:
   - `ACORN_SESSION_ID` — this session's UUID, so `acorn-ipc` knows who
     is asking.
   - `ACORN_IPC_SOCKET` — the canonical IPC socket path.
   - `ACORN_DAEMON_SOCKET` — the background daemon control socket path.
   - `PATH` — the directory containing the bundled `acorn-ipc` binary is
     prepended (de-duplicated), so the agent can invoke `acorn-ipc` by
     name without the user installing a shim. Regular sessions do not
     receive this prefix, keeping the IPC surface invisible outside
     control sessions.
2. **Worktree marker file.** A `.acorn-control.md` is written to the
   session's cwd on every spawn (overwritten each time so the substituted
   session id is current). Agents that read project docs (Claude Code,
   Codex, Gemini, Ollama, llm, …) find it; humans can `cat` it. Safe to
   commit-ignore. The marker is the primary cue the agent uses to learn
   the protocol — point the agent at it explicitly if it doesn't auto-
   ingest project docs on startup.

The primer text itself is generated server-side and lists the control
session id, socket paths, natural-language mapping for phrases like "new
session", the ownership rule for worker sessions, and every `acorn-ipc`
subcommand with copy-pasteable examples. Agents can also reload the same
text at any time with `acorn-ipc context`.

## The `acorn-ipc` CLI

When Acorn spawns a control session it injects these env vars into the PTY:

| Env var             | Source                            |
| ------------------- | --------------------------------- |
| `ACORN_SESSION_ID`  | The session's UUID                |
| `ACORN_IPC_SOCKET`  | Path to the in-app IPC socket     |
| `ACORN_DAEMON_SOCKET` | Path to the daemon control socket |

The `acorn-ipc` binary reads `ACORN_SESSION_ID` and `ACORN_IPC_SOCKET`, so
commands run straight from the shell without flags.

### Install

`acorn-ipc` ships inside the Acorn `.app` bundle (Tauri's `externalBin`
mechanism — see `src-tauri/tauri.conf.json`). Inside a control session
PTY there is **nothing to install**: the bundled binary's directory is
prepended to `PATH`, so `acorn-ipc list-sessions` works out of the box.

You only need a system-wide install when you want to call `acorn-ipc`
from **outside** a control session (debugging from your own shell, an
external script, a Makefile, …). In that case use the Settings shortcut
under Sessions → "Control sessions", which generates a single-line
`ln -sf` command pointing at the bundled binary. The Copy button lands
the command on your clipboard; paste it into a terminal and run it.

If you are building from source rather than installing a release, the
sidecar is staged for you when you run `tauri build`. For a dev loop:

```sh
pnpm run build:sidecar   # one-time; run again after IPC changes
pnpm run tauri dev
```

`pnpm run build:sidecar` shells out to `src-tauri/scripts/build-sidecar.sh`
which both compiles `acorn-ipc` *and* stages it at
`src-tauri/binaries/acorn-ipc-<target-triple>`, the path Tauri's
`externalBin` existence check requires before `tauri dev` / `tauri build`
will even start. Plain `cargo build --bin acorn-ipc` skips the staging
step, so the build fails with
`resource path 'binaries/acorn-ipc-...' doesn't exist`.

Settings → Sessions → "Control sessions" shows the resolved binary path
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
acorn-ipc context
acorn-ipc list-sessions
acorn-ipc new-session   <name> [--isolated] [--owner me|user]
acorn-ipc send-keys     -t <uuid> --data "ls" --enter [--allow-foreign]
acorn-ipc read-buffer   -t <uuid> [--max-bytes N] [--allow-foreign]
acorn-ipc select-session -t <uuid> [--allow-foreign]
acorn-ipc kill-session  -t <uuid> [--allow-foreign]
```

Add `--json` to any command to get machine-readable output. Each command
exits non-zero with a stable code on error:

| Exit | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 2    | Unauthorized — source session missing, not a control session, etc. |
| 3    | Target session not found                                           |
| 4    | Target session belongs to a different project                      |
| 5    | Invalid request shape / arguments                                  |
| 6    | Internal — PTY write failed, persistence failed, etc.              |
| 7    | Foreign session — target is user-owned or owned by another control |

### Ownership

Sessions created from the UI are owned by `user`. Sessions created through
`acorn-ipc new-session` are owned by the source control session by default
(`control:<ACORN_SESSION_ID>`), unless the caller passes `--owner user`.

`list-sessions` shows each session's owner and whether it is owned by the
current controller. By default, `send-keys`, `read-buffer`, `select-session`,
and `kill-session` only operate on sessions owned by the current controller
or on the source control session itself. Passing `--allow-foreign` is the
explicit escape hatch for a direct user request to touch a user-owned session
or a session owned by another control session.

### Examples

Send a command to every regular sibling and wait for output:

```sh
for id in $(acorn-ipc list-sessions --json | jq -r '.sessions[] | select(.owned_by_me and .kind == "regular") | .id'); do
  acorn-ipc send-keys -t "$id" --data "git status" --enter
  sleep 1
  acorn-ipc read-buffer -t "$id" --max-bytes 4096
  echo "---"
done
```

Spin up a fresh isolated worktree and focus it:

```sh
new_id=$(acorn-ipc new-session "patch-bot" --isolated)
acorn-ipc select-session -t "$new_id"
```

## Security model

- The socket file is created with mode `0600`, so only the user the Acorn
  app is running as can connect.
- Every request carries the source session's UUID. The server rejects any
  request whose source is missing, expired, or whose `SessionKind` is not
  `Control`.
- Target lookups are scoped to the source's project (`repo_path`).
  Cross-project requests surface a distinct `OutOfScope` error so the CLI
  can give an accurate diagnostic instead of a misleading "not found".
- `kill-session` refuses to kill the source control session itself, so a
  badly-written agent can't accidentally remove the only seat it has.

There is currently no inter-process whitelist beyond the env-var handshake.
If a control session leaks its `ACORN_SESSION_ID` to a child it does not
trust, that child can use it. Treat the env var like a credential.

## Wire protocol

JSON, newline-delimited, one request → one response per connection. Wire
version `1`. See `src-tauri/src/ipc/proto.rs` for the canonical types.

```jsonc
// Request
{
  "protocol_version": 1,
  "source_session_id": "…uuid…",
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
| `ACORN_SESSION_ID is unset`                          | Running `acorn-ipc` from a non-control session                        |
| `connect: No such file or directory`                 | App not running, or socket path overridden                            |
| Exit 2 inside a control session                      | Session was removed in the UI; env still pointing at a stale UUID     |
| Exit 4 even though both sessions look right          | Sessions belong to different `repo_path`s; check Sidebar grouping     |
| `read-buffer` returns `truncated` for short sessions | Bytes still in flight to xterm but cleared by `clear`/`reset` already |

## Limitations

- **macOS and Linux only.** Both `acorn-ipc` and the in-app server import
  `std::os::unix::net::{UnixListener, UnixStream}` directly (see
  `src-tauri/src/ipc/server.rs` and `src-tauri/src/bin/acorn-ipc.rs`), so the
  crate does not compile on Windows targets at all. Porting would mean
  abstracting the transport — e.g. via the `interprocess` crate, which
  unifies Unix domain sockets and Windows named pipes behind one API — and
  finding a Windows-equivalent permission model for the `chmod 0600` step
  (named-pipe SDDL ACLs). The PTY layer would also need an audit; nothing
  in this stack tests that path on Windows.
- The CLI does not currently auto-install. Use the Settings shortcut or
  symlink it manually.
- `send-keys` does not interpret tmux-style escapes (`C-c`, `Enter`); pass
  literal bytes via `--data` or pre-encoded base64 via `--raw-base64`.
- Audit logging is `tracing::info!`-level only; there is no on-disk audit
  file yet.
- Priming relies entirely on env vars + the `.acorn-control.md` marker
  file. The previous spawn-time CLI flag injection (Claude
  `--append-system-prompt`, `llm -s`) is dormant because Acorn no longer
  spawns the agent directly — the user does, from inside `$SHELL`. The
  flag-injection code remains and will activate again if `$SHELL` is
  ever set to a recognised agent binary.
