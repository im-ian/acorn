# Hook Env Injection Plan

## Goal

Add an optional, provider-aware hook environment path for Acorn agent sessions so
Claude/Codex-style CLIs can report lifecycle events back to Acorn directly.

The target product behavior is:

1. Acorn starts a local hook endpoint.
2. Agent PTYs receive session-scoped hook env vars.
3. Provider-specific hook config or notify commands call back into Acorn.
4. Acorn uses hook events as the first-class status signal.
5. Existing transcript/process polling remains the fallback.

This plan is intentionally scoped to hook env injection and the minimum event
plumbing needed to prove it. Broader provider expansion can follow later.

## Current Acorn Surface

| Area | Files | Notes |
| --- | --- | --- |
| PTY env layering | `src-tauri/src/pty_env.rs` | Shared env policy for in-process and daemon PTY spawn. Caller-supplied env wins. |
| PTY spawn env assembly | `src-tauri/src/commands.rs` | Stamps `ACORN_RESUME_TOKEN`, `ACORN_AGENT_STATE_DIR`, `ACORN_DATA_DIR`, shell init env, and control-session IPC env. |
| Control session IPC env | `src-tauri/src/commands.rs` | Only control sessions currently get `ACORN_SESSION_ID`, `ACORN_IPC_SOCKET`, `ACORN_DAEMON_SOCKET`, and bundled CLI PATH. |
| Daemon spawn bridge | `src-tauri/src/daemon_commands.rs`, `src-tauri/src/daemon_bridge.rs`, `src-tauri/crates/acorn-daemon/src/protocol.rs` | SpawnSpec already carries an `env` map, so hook env can ride existing spawn payloads. |
| Session provider typing | `src/lib/types.ts`, `src-tauri/crates/acorn-session/src/session.rs` | Provider enum is currently Claude/Codex only. |
| Status detection | `src/store.ts`, `src-tauri/src/commands.rs`, `src-tauri/crates/acorn-session/src/status.rs` | Current status is inferred by polling live processes/transcripts. Keep this as fallback. |

## Reference Design From Emdash

Emdash uses this shape:

| Piece | Emdash file | Pattern to copy conceptually |
| --- | --- | --- |
| Hook server | `/tmp/acorn-emdash/src/main/core/agent-hooks/hook-server.ts` | Local HTTP server on `127.0.0.1`, random port, per-app token, small request body cap. |
| Hook env | `/tmp/acorn-emdash/src/main/core/pty/pty-env.ts` | Injects `EMDASH_HOOK_PORT`, `EMDASH_PTY_ID`, `EMDASH_HOOK_TOKEN` into agent PTYs. |
| Provider support flag | `/tmp/acorn-emdash/src/shared/agent-provider-registry.ts` | Provider definitions include `supportsHooks`. |
| Config writer | `/tmp/acorn-emdash/src/main/core/agent-hooks/hook-config.ts` | Writes/merges provider hook config for Claude/Codex/etc. |
| Fallback classifier | `/tmp/acorn-emdash/src/main/core/agent-hooks/classifier-wiring.ts` | Uses output classification only when hooks are unavailable. |

Do not copy the Electron/Node implementation directly. Acorn should keep the
Tauri/Rust boundary and reuse its existing PTY env and status machinery.

## Proposed Acorn Design

### Env Vars

Use Acorn names, not Emdash names:

| Env var | Meaning |
| --- | --- |
| `ACORN_AGENT_HOOK_URL` | Full local callback URL, e.g. `http://127.0.0.1:<port>/agent-hook`. |
| `ACORN_AGENT_HOOK_TOKEN` | Opaque token required in a request header or payload. |
| `ACORN_AGENT_HOOK_SESSION_ID` | Acorn session UUID. |
| `ACORN_AGENT_HOOK_PROVIDER` | `claude` or `codex`. |

Prefer a full URL over separate host/port vars so provider config snippets stay
simple and future path changes do not require another env contract.

### Event Shape

Start with a minimal event payload:

```json
{
  "session_id": "uuid",
  "provider": "codex",
  "event": "start|stop|needs_input|error",
  "message": "optional short message",
  "source": "hook"
}
```

Keep the Rust type small. Avoid storing raw provider payloads until there is a
clear UI use case.

### Hook Server

Implement a small Rust listener owned by app state.

Recommended module:

```text
src-tauri/src/agent_hooks.rs
```

Responsibilities:

1. Bind `127.0.0.1:0`.
2. Generate a random token at app startup.
3. Expose `hook_url()` and `token()` to PTY spawn code.
4. Accept only local POST requests.
5. Reject missing/invalid token.
6. Parse event payload.
7. Update session status or emit a frontend event.

Keep the first implementation synchronous/simple. A tiny HTTP parser is enough,
but using an existing dependency is acceptable if the repo already carries one
that fits Tauri/Rust without large churn.

### Env Injection Point

Do not put hook-specific logic in `pty_env::apply_layered_env`; that function is
the generic layering policy. Instead, assemble hook env in the caller env map
before calling the existing PTY spawn path.

Likely location:

```text
src-tauri/src/commands.rs
```

Near the existing session-specific env stamping:

- `ACORN_RESUME_TOKEN`
- `ACORN_AGENT_STATE_DIR`
- `ACORN_DATA_DIR`
- shell init env
- control-session IPC env

Add a provider/session check before PTY spawn:

```rust
if let Some(provider) = session.agent_provider {
    if hooks_enabled_for(provider) {
        effective_env.entry("ACORN_AGENT_HOOK_URL".into()).or_insert(...);
        effective_env.entry("ACORN_AGENT_HOOK_TOKEN".into()).or_insert(...);
        effective_env.entry("ACORN_AGENT_HOOK_SESSION_ID".into()).or_insert(session.id.to_string());
        effective_env.entry("ACORN_AGENT_HOOK_PROVIDER".into()).or_insert(provider.as_str().into());
    }
}
```

Use `entry(...).or_insert...` so explicit caller env still wins, matching current
env layering conventions.

### Provider Detection

Initial hook env injection can be gated on `session.agent_provider`, but note the
current value is often learned after process/transcript detection. For the first
slice, support only sessions whose provider is already known at spawn or is
explicitly launched through an agent resume/fork path.

Follow-up options:

1. Add provider to session creation or pending terminal input when launching
   Claude/Codex from Acorn UI.
2. Infer provider from initial command and stamp hook env when command is queued.
3. Keep hook env always present for regular sessions but only activate provider
   config when an agent actually reads it.

For reviewability, prefer option 1 as a follow-up unless this PR already touches
session creation heavily.

### Provider Hook Config

Keep config writing separate from env injection.

Recommended second module:

```text
src-tauri/src/agent_hook_config.rs
```

Initial target:

| Provider | Config target | Notes |
| --- | --- | --- |
| Claude | `.claude/settings.local.json` under worktree | Must merge existing hooks and add `.gitignore` entry only if user setting allows. |
| Codex | `~/.codex/hooks.json` or current Codex hook file | User-home config is higher risk; preserve user entries and add Acorn marker. |

For the first implementation, it is acceptable to add hook env injection without
auto-writing provider configs. In that case document that a manual provider hook
can POST to `ACORN_AGENT_HOOK_URL`.

## Suggested Implementation Slices

### Slice 1: Rust Hook Server + Env Injection

1. Add `agent_hooks` module and app-state handle.
2. Start it during app init, similar to IPC server lifecycle.
3. Add hook url/token accessors to `AppState`.
4. Stamp `ACORN_AGENT_HOOK_*` env vars in PTY spawn for known Claude/Codex
   sessions.
5. Add unit tests for env stamping.

Deliverable: a spawned agent session can run `env | grep ACORN_AGENT_HOOK` and
see session-scoped values.

### Slice 2: Hook Event Handling

1. Define hook event struct.
2. Accept local POST with token validation.
3. Map events to `SessionStatus`:
   - `start` -> `running`
   - `needs_input` -> `needs_input`
   - `stop` -> `completed`
   - `error` -> `failed`
4. Persist/update session status through the same store path used by existing
   status commands.
5. Add tests for token rejection and valid event mapping.

Deliverable: a manual curl from inside the session updates the Acorn sidebar
status quickly.

### Slice 3: Provider Config Writer

1. Add Claude hook config writer.
2. Add Codex hook config writer only after confirming current Codex hook schema.
3. Preserve user config entries.
4. Mark Acorn-managed hook entries with a stable marker.
5. Add tests for merge behavior and non-destructive updates.

Deliverable: launching a supported provider can emit lifecycle events without
manual hook setup.

### Slice 4: Fallback Policy

1. Keep existing transcript/process polling.
2. Treat hook events as fresher than polling for a short TTL.
3. If no hook event arrives, current polling remains authoritative.
4. Add logging so false/missing hook events can be diagnosed.

Deliverable: hook support improves latency but cannot make status worse when
provider hooks fail.

## Test Plan

Run focused tests first:

```sh
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml pty_env
cargo test --manifest-path src-tauri/Cargo.toml agent_hook
cargo test --manifest-path src-tauri/Cargo.toml ipc
```

Then run broader verification if Slice 1 or 2 touches app state/session status:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test
```

Manual smoke:

1. Start Acorn.
2. Create a new Claude/Codex session.
3. Run:

   ```sh
   env | grep '^ACORN_AGENT_HOOK_'
   ```

4. POST a manual event from that session:

   ```sh
   curl -sf -X POST \
     -H "Content-Type: application/json" \
     -H "X-Acorn-Agent-Hook-Token: $ACORN_AGENT_HOOK_TOKEN" \
     -d "{\"session_id\":\"$ACORN_AGENT_HOOK_SESSION_ID\",\"provider\":\"$ACORN_AGENT_HOOK_PROVIDER\",\"event\":\"needs_input\"}" \
     "$ACORN_AGENT_HOOK_URL"
   ```

5. Confirm the session status changes to `needs_input`.

## Risks

| Risk | Mitigation |
| --- | --- |
| User config corruption | Keep env injection separate from config writing; marker and preserve user entries when writing config. |
| Token leak in terminal | Hook token is local-only but visible to child processes. Treat it as session-scoped and rotate on app restart. |
| Incorrect status from stale hook | Validate session id and provider; ignore events for unknown sessions. |
| Hook server unavailable | Existing polling remains fallback. |
| Provider schema drift | Start with env injection/manual curl before automatic config writers. |

## Handoff Prompt

Use this prompt for the worker session:

```text
Implement Slice 1 from docs/HOOK_ENV_INJECTION_PLAN.md.

Scope:
- Add the minimal Rust hook server/app-state plumbing needed to expose a local hook URL and token.
- Inject ACORN_AGENT_HOOK_URL, ACORN_AGENT_HOOK_TOKEN, ACORN_AGENT_HOOK_SESSION_ID, and ACORN_AGENT_HOOK_PROVIDER into known Claude/Codex agent PTY sessions.
- Do not auto-write Claude/Codex config files yet.
- Keep existing transcript/process polling unchanged.
- Add focused tests for env stamping and hook server token/url behavior.

Before editing, inspect current dirty files and do not overwrite unrelated changes.
Report changed files and exact test commands/results.
```
