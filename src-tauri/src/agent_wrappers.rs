use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const WRAPPER_DIR_NAME: &str = "agent-wrappers";
const CODEX_WRAPPER_NAME: &str = "codex";
const CODEX_NOTIFY_NAME: &str = "acorn-codex-notify";
const CLAUDE_WRAPPER_NAME: &str = "claude";
const CLAUDE_NOTIFY_NAME: &str = "acorn-claude-notify";
const CLAUDE_SETTINGS_NAME: &str = "acorn-claude-settings.json";
const ANTIGRAVITY_WRAPPER_NAME: &str = "agy";
const ANTIGRAVITY_NOTIFY_NAME: &str = "acorn-antigravity-notify";
const HOOK_ENDPOINT_NAME: &str = "agent-hook-endpoint";
const HOOK_SPOOL_DIR_NAME: &str = "agent-hook-spool";

const CODEX_WRAPPER_BODY: &str = r#"#!/bin/sh
_acorn_wrapper_dir="${ACORN_AGENT_WRAPPER_DIR-}"
if [ -z "$_acorn_wrapper_dir" ]; then
  case "$0" in
    */*) _acorn_wrapper_dir=${0%/*} ;;
  esac
fi

_acorn_find_real_binary() {
  _acorn_name="$1"
  _acorn_old_ifs=$IFS
  IFS=:
  for _acorn_dir in $PATH; do
    [ -n "$_acorn_dir" ] || continue
    _acorn_dir=${_acorn_dir%/}
    case "$_acorn_dir" in
      "$_acorn_wrapper_dir") continue ;;
    esac
    if [ -x "$_acorn_dir/$_acorn_name" ] && [ ! -d "$_acorn_dir/$_acorn_name" ]; then
      IFS=$_acorn_old_ifs
      printf '%s\n' "$_acorn_dir/$_acorn_name"
      return 0
    fi
  done
  IFS=$_acorn_old_ifs
  return 1
}

REAL_BIN=$(_acorn_find_real_binary codex)
if [ -z "$REAL_BIN" ]; then
  echo "Acorn: codex not found in PATH. Install it and ensure it is available in your shell PATH." >&2
  exit 127
fi

# The PTY root marker is consumed by its first wrapper. Provider descendants
# keep the invocation token only as a nesting marker and cannot reuse the
# outer session's hook channel. A tokenless process with hook env is a provider
# that survived an app update; any new wrapper below it must also fail closed.
if [ "${ACORN_AGENT_INVOCATION_ROOT-}" = "1" ]; then
  if [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ] || [ -n "${ACORN_AGENT_INVOCATION_DEPTH-}" ]; then
    unset CODEX_TUI_RECORD_SESSION CODEX_TUI_SESSION_LOG_PATH ACORN_CODEX_NATIVE_HOOKS_ENABLED
  fi
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_INVOCATION_TOKEN ACORN_AGENT_INVOCATION_DEPTH
  if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ]; then
    _acorn_invocation_ts="$(date +%s 2>/dev/null || echo 0)"
    export ACORN_AGENT_INVOCATION_TOKEN="${ACORN_AGENT_HOOK_SESSION_ID}:$$:${_acorn_invocation_ts}"
    export ACORN_AGENT_INVOCATION_DEPTH=1
  fi
elif [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ]; then
  _acorn_invocation_depth="${ACORN_AGENT_INVOCATION_DEPTH-1}"
  case "$_acorn_invocation_depth" in
    ''|*[!0-9]*) _acorn_invocation_depth=1 ;;
  esac
  export ACORN_AGENT_INVOCATION_DEPTH=$((_acorn_invocation_depth + 1))
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_HOOK_SESSION_ID ACORN_AGENT_HOOK_URL ACORN_AGENT_HOOK_TOKEN ACORN_AGENT_HOOK_PROVIDER
  unset CODEX_TUI_RECORD_SESSION CODEX_TUI_SESSION_LOG_PATH ACORN_CODEX_NATIVE_HOOKS_ENABLED
  exec "$REAL_BIN" "$@"
elif [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ]; then
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_HOOK_SESSION_ID ACORN_AGENT_HOOK_URL ACORN_AGENT_HOOK_TOKEN ACORN_AGENT_HOOK_PROVIDER
  unset CODEX_TUI_RECORD_SESSION CODEX_TUI_SESSION_LOG_PATH ACORN_CODEX_NATIVE_HOOKS_ENABLED
  exec "$REAL_BIN" "$@"
fi

_acorn_codex_version_supported() {
  _acorn_version="$1"
  case "$_acorn_version" in
    ''|*[!0-9.]*) return 1 ;;
  esac
  _acorn_old_ifs=$IFS
  IFS=.
  set -- $_acorn_version
  IFS=$_acorn_old_ifs
  [ "$#" -eq 3 ] || return 1
  [ "$1" -gt 0 ] && return 0
  [ "$1" -eq 0 ] || return 1
  [ "$2" -gt 135 ] && return 0
  [ "$2" -eq 135 ] || return 1
  [ "$3" -ge 0 ]
}

# Hook channel is available when the endpoint file exists (rewritten by each
# app launch with the current server URL + token) or the spawn-time env pair
# is present. The session id has no file fallback — without it, events cannot
# be attributed to a session.
if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
   { [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ] ||
     { [ -n "${ACORN_AGENT_HOOK_URL-}" ] && [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ]; }; } &&
   [ -x "$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify" ]; then
  # Codex requires command hooks to carry their exact trusted fingerprint.
  # Keep this session-scoped: user/project config remains untouched, and the
  # legacy notify callback below remains available to older Codex releases.
  _acorn_codex_hooks='hooks={UserPromptSubmit=[{hooks=[{type="command",command="sh \"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"",timeout=5}]}],PreToolUse=[{hooks=[{type="command",command="sh \"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"",timeout=5}]}],PermissionRequest=[{hooks=[{type="command",command="sh \"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"",timeout=5}]}],PostToolUse=[{hooks=[{type="command",command="sh \"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"",timeout=5}]}],Stop=[{hooks=[{type="command",command="sh \"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"",timeout=5}]}],state={"/<session-flags>/config.toml:pre_tool_use:0:0"={enabled=true,trusted_hash="sha256:b7f07d6514fc12ca8e976ae4bd5b6e61ca13d61c174616789ab3b4464200b1d3"},"/<session-flags>/config.toml:permission_request:0:0"={enabled=true,trusted_hash="sha256:074c27d6eb1e0c1aad3e4fd979c6f80b6ffe5a00a9d2993c857850e7e55b2d64"},"/<session-flags>/config.toml:post_tool_use:0:0"={enabled=true,trusted_hash="sha256:ecd139e174de9a8d3cd7f9503b359587fade68c65f838bb0cddc785f438909cc"},"/<session-flags>/config.toml:user_prompt_submit:0:0"={enabled=true,trusted_hash="sha256:71869cae863c34d6bc113940040d9e5e3f0d6173e1f8ff50c77d2c479ecd70a1"},"/<session-flags>/config.toml:stop:0:0"={enabled=true,trusted_hash="sha256:9162891a8f1d1790bc6752f46c9ca2a7e8cc0c6440d496ba9331eecc20a16865"}}}'
  _acorn_codex_notify_config="notify=[\"bash\",\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"]"
  _acorn_codex_version=$("$REAL_BIN" --version 2>/dev/null |
    sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' |
    sed -n '1p')
  export ACORN_CODEX_VERSION="${_acorn_codex_version:-unknown}"
  _acorn_codex_ts="$(date +%s 2>/dev/null || echo 0)"
  export ACORN_CODEX_LIFECYCLE_ID="$$_${_acorn_codex_ts}"
  _acorn_codex_native_hooks=0
  if _acorn_codex_version_supported "$_acorn_codex_version" &&
     "$REAL_BIN" --enable hooks -c "$_acorn_codex_hooks" features list >/dev/null 2>&1; then
    _acorn_codex_native_hooks=1
  fi
  export ACORN_CODEX_NATIVE_HOOKS_ENABLED="$_acorn_codex_native_hooks"
  _acorn_run_codex() {
    if [ "$_acorn_codex_native_hooks" = "1" ]; then
      "$REAL_BIN" --enable hooks -c "$_acorn_codex_hooks" -c "$_acorn_codex_notify_config" "$@" 9>&-
    else
      "$REAL_BIN" -c "$_acorn_codex_notify_config" "$@" 9>&-
    fi
  }
  # A read/write FIFO descriptor is held only by this wrapper. The watcher
  # closes its inherited copy and blocks on the read end, so wrapper exit is
  # delivered by kernel EOF without a polling process.
  if ! _acorn_lifetime_dir=$(umask 077; mktemp -d "$ACORN_AGENT_WRAPPER_DIR/codex-session.XXXXXX"); then
    _acorn_run_codex "$@"
    exit $?
  fi
  chmod 700 "$_acorn_lifetime_dir" >/dev/null 2>&1 || true
  _acorn_codex_owns_log=0
  if [ -z "${CODEX_TUI_SESSION_LOG_PATH-}" ]; then
    export CODEX_TUI_SESSION_LOG_PATH="$_acorn_lifetime_dir/session.jsonl"
    if ! (umask 077; : > "$CODEX_TUI_SESSION_LOG_PATH"); then
      rm -rf "$_acorn_lifetime_dir"
      unset CODEX_TUI_SESSION_LOG_PATH
      _acorn_run_codex "$@"
      exit $?
    fi
    chmod 600 "$CODEX_TUI_SESSION_LOG_PATH" >/dev/null 2>&1 || true
    _acorn_codex_owns_log=1
  fi
  _acorn_lifetime_fifo="$_acorn_lifetime_dir/owner"
  if ! (umask 077; mkfifo "$_acorn_lifetime_fifo") ||
     ! chmod 600 "$_acorn_lifetime_fifo" ||
     ! exec 9<>"$_acorn_lifetime_fifo"; then
    rm -rf "$_acorn_lifetime_dir"
    if [ "$_acorn_codex_owns_log" = "1" ]; then
      unset CODEX_TUI_SESSION_LOG_PATH
    fi
    _acorn_run_codex "$@"
    exit $?
  fi
  export CODEX_TUI_RECORD_SESSION=1

  _acorn_codex_wrapper_pid=$$
  (
    _acorn_lifetime_dir="$_acorn_lifetime_dir"
    _acorn_lifetime_fifo="$_acorn_lifetime_fifo"
    exec 9>&-
    _acorn_wrapper_pid="$_acorn_codex_wrapper_pid"
    _acorn_log="$CODEX_TUI_SESSION_LOG_PATH"
    _acorn_notify="$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify"
    _acorn_watch_dir="$_acorn_lifetime_dir/watcher"
    if ! (umask 077; mkdir -m 700 "$_acorn_watch_dir"); then
      exit 0
    fi
    _acorn_watch_fifo="$_acorn_watch_dir/events"
    if ! (umask 077; mkfifo "$_acorn_watch_fifo") ||
       ! chmod 600 "$_acorn_watch_fifo"; then
      rmdir "$_acorn_watch_dir" >/dev/null 2>&1 || true
      exit 0
    fi
    _acorn_tail_pid=""
    _acorn_parent_guard_pid=""
    _acorn_cleanup_watcher() {
      if [ -n "$_acorn_parent_guard_pid" ]; then
        kill "$_acorn_parent_guard_pid" >/dev/null 2>&1 || true
        wait "$_acorn_parent_guard_pid" 2>/dev/null || true
        _acorn_parent_guard_pid=""
      fi
      if [ -n "$_acorn_tail_pid" ]; then
        kill "$_acorn_tail_pid" >/dev/null 2>&1 || true
        wait "$_acorn_tail_pid" 2>/dev/null || true
        _acorn_tail_pid=""
      fi
      rm -rf "$_acorn_watch_dir"
      rm -rf "$_acorn_lifetime_dir"
    }
    trap _acorn_cleanup_watcher EXIT
    trap 'exit 0' HUP INT TERM

    tail -n 0 -F "$_acorn_log" > "$_acorn_watch_fifo" 2>/dev/null &
    _acorn_tail_pid=$!
    (
      trap - EXIT HUP INT TERM
      IFS= read -r _acorn_lifetime_signal < "$_acorn_lifetime_fifo" || true
      kill "$_acorn_tail_pid" >/dev/null 2>&1 || true
    ) &
    _acorn_parent_guard_pid=$!
    while IFS= read -r _acorn_line; do
      case "$_acorn_line" in
        *'"dir":"from_tui"'*'"kind":"op"'*'"payload":{"UserTurn"'*)
          printf '%s\n' "$_acorn_line" | "$_acorn_notify" "" jsonl_user >/dev/null 2>&1 || true
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)
          printf '%s\n' "$_acorn_line" | "$_acorn_notify" "" jsonl_task >/dev/null 2>&1 || true
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)
          printf '%s\n' "$_acorn_line" | "$_acorn_notify" "" jsonl_approval >/dev/null 2>&1 || true
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*|\
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"patch_apply_begin"'*|\
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"mcp_tool_call_begin"'*|\
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"web_search_begin"'*)
          printf '%s\n' "$_acorn_line" | "$_acorn_notify" "" jsonl_tool >/dev/null 2>&1 || true
          ;;
      esac
    done < "$_acorn_watch_fifo"
  ) &
  ACORN_CODEX_WATCHER_PID=$!

  _acorn_run_codex "$@"
  ACORN_CODEX_STATUS=$?
  exec 9>&-

  if [ -n "${ACORN_CODEX_WATCHER_PID-}" ]; then
    # The watcher owns a `tail | while` pipeline. Stop its direct children
    # first so they cannot survive the wrapper as orphaned background jobs.
    pkill -TERM -P "$ACORN_CODEX_WATCHER_PID" >/dev/null 2>&1 || true
    kill "$ACORN_CODEX_WATCHER_PID" >/dev/null 2>&1 || true
    wait "$ACORN_CODEX_WATCHER_PID" 2>/dev/null || true
  fi
  rm -rf "$_acorn_lifetime_dir"
  exit "$ACORN_CODEX_STATUS"
fi

exec "$REAL_BIN" "$@"
"#;

const CODEX_NOTIFY_BODY: &str = r#"#!/bin/sh
raw_contract=0
if [ "$#" -eq 0 ]; then
  raw_contract=1
  source="native"
else
  source="${2-}"
  case "$source" in
    jsonl_user|jsonl_task|jsonl_tool|jsonl_approval|legacy_completion)
      raw_contract=1
      ;;
  esac
fi

input="${1-}"
if [ -z "$input" ]; then
  input=$(cat 2>/dev/null || true)
fi
[ -n "$input" ] || exit 0
compact_input=$(printf '%s\n' "$input" | tr '\r\n' '  ')
legacy_completion_type=$(printf '%s\n' "$compact_input" | grep -oE '(^|[,{])[[:space:]]*"type"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -n '1p' | grep -oE '"[^"]*"$' | tr -d '"')

tokenless_legacy_owner=0
if [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ]; then
  [ "${ACORN_AGENT_INVOCATION_DEPTH-}" = "1" ] || exit 0
else
  [ -z "${ACORN_AGENT_INVOCATION_DEPTH-}" ] || exit 0
  tokenless_legacy_owner=1
fi

# Codex's legacy notify callback supplies the raw completion payload as its
# first argument. Preserve it for Rust-side turn arbitration instead of
# flattening it into a status in this script.
if [ "$raw_contract" = "0" ]; then
  case "$legacy_completion_type" in
    agent-turn-complete|task_complete|turn_complete)
      raw_contract=1
      source="legacy_completion"
      ;;
  esac
fi

[ "$tokenless_legacy_owner" = "0" ] || [ "$source" = "legacy_completion" ] || exit 0

# Legacy completion is also emitted for nested Codex threads. Keep this cheap
# owner check in the transport layer when the payload carries thread identity,
# or when a tokenless helper has no invocation owner. Rust performs
# the lifecycle/turn check after transport validation.
if [ "$source" = "legacy_completion" ]; then
  case "$legacy_completion_type" in
    agent-turn-complete|task_complete|turn_complete) ;;
    *) exit 0 ;;
  esac
  legacy_thread_id=$(printf '%s\n' "$compact_input" | grep -oE '(^|[,{])[[:space:]]*"thread[-_]id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -n '1p' | grep -oE '"[^"]*"$' | tr -d '"')
  require_legacy_owner=0
  if [ "$legacy_completion_type" = "agent-turn-complete" ] ||
     [ "$tokenless_legacy_owner" = "1" ] ||
     [ -n "$legacy_thread_id" ]; then
    require_legacy_owner=1
  fi
  if [ "$require_legacy_owner" = "1" ]; then
    printf '%s\n' "$legacy_thread_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' || exit 0
    owner_thread_id=""
    if [ -n "${ACORN_AGENT_STATE_DIR-}" ] && [ -r "$ACORN_AGENT_STATE_DIR/codex.id" ]; then
      owner_thread_id=$(sed -n '1p' "$ACORN_AGENT_STATE_DIR/codex.id" 2>/dev/null | tr -d '\r\n')
    fi
    [ "$owner_thread_id" = "$legacy_thread_id" ] || exit 0
  fi
fi

# Spool this event when the POST fails: a wrapper-owned PTY outlives the
# app, and a dropped POST here is a lost lifecycle transition. Line 1 is
# the transport metadata the POST carried; the rest is the raw body. The
# app drains and replays this directory on its next boot.
_acorn_spool_event() {
  [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] || return 0
  _acorn_spool_dir="$ACORN_AGENT_WRAPPER_DIR/agent-hook-spool"
  (umask 077; mkdir -p "$_acorn_spool_dir") 2>/dev/null || return 0
  set -- "$_acorn_spool_dir"/*.json
  if [ "$#" -ge 512 ] && [ -e "$1" ]; then
    return 0
  fi
  _acorn_spool_tmp="$_acorn_spool_dir/.tmp-$$"
  {
    printf '%s\n' "$_acorn_spool_meta"
    printf '%s' "$_acorn_spool_body"
  } > "$_acorn_spool_tmp" 2>/dev/null || { rm -f "$_acorn_spool_tmp" 2>/dev/null; return 0; }
  chmod 600 "$_acorn_spool_tmp" 2>/dev/null || true
  mv "$_acorn_spool_tmp" "$_acorn_spool_dir/$(date +%s 2>/dev/null || echo 0)-$$.json" 2>/dev/null ||
    rm -f "$_acorn_spool_tmp" 2>/dev/null
}

# Resolve the current app instance at send time so daemon-owned terminals
# survive app restarts without retaining a stale port or token.
hook_url=""
hook_token=""
if [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] && [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ]; then
  hook_url=$(sed -n '1p' "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" 2>/dev/null || true)
  hook_token=$(sed -n '2p' "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" 2>/dev/null || true)
fi
if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
  hook_url="${ACORN_AGENT_HOOK_URL-}"
  hook_token="${ACORN_AGENT_HOOK_TOKEN-}"
fi
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

if [ "$raw_contract" = "1" ]; then
  _acorn_spool_meta=$(printf '{"provider":"codex","session_id":"%s","source":"%s","lifecycle_id":"%s","version":"%s","native_hooks_enabled":"%s"}' \
    "$ACORN_AGENT_HOOK_SESSION_ID" "$source" "${ACORN_CODEX_LIFECYCLE_ID-}" "${ACORN_CODEX_VERSION-unknown}" "${ACORN_CODEX_NATIVE_HOOKS_ENABLED-0}")
  _acorn_spool_body="$input"
  if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
    _acorn_spool_event
    exit 0
  fi
  printf '%s' "$input" | curl -sf --connect-timeout 1 --max-time 1 -X POST \
    -H 'Content-Type: application/json' \
    -H @/dev/fd/3 \
    -H 'X-Acorn-Agent-Hook-Provider: codex' \
    -H "X-Acorn-Agent-Hook-Session-Id: $ACORN_AGENT_HOOK_SESSION_ID" \
    -H "X-Acorn-Agent-Hook-Source: $source" \
    -H "X-Acorn-Codex-Lifecycle-Id: ${ACORN_CODEX_LIFECYCLE_ID-}" \
    -H "X-Acorn-Codex-Version: ${ACORN_CODEX_VERSION-unknown}" \
    -H "X-Acorn-Codex-Native-Hooks-Enabled: ${ACORN_CODEX_NATIVE_HOOKS_ENABLED-0}" \
    --data-binary @- \
    "$hook_url" 3<<EOF >/dev/null 2>&1 || _acorn_spool_event
X-Acorn-Agent-Hook-Token: $hook_token
EOF
  exit 0
fi

# Compatibility path for wrappers that survived an Acorn upgrade and still
# invoke this shared helper with Acorn's previous normalized contract.
event="$input"
case "$event" in
  start|stop|needs_input|error) ;;
  *) exit 0 ;;
esac
case "${source:-hook}" in
  hook|turn|tool|preview|legacy|transcript) ;;
  *) source="hook" ;;
esac
payload=$(printf '{"session_id":"%s","provider":"codex","event":"%s","source":"%s"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event" "${source:-hook}")
_acorn_spool_meta='{}'
_acorn_spool_body="$payload"
if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
  _acorn_spool_event
  exit 0
fi
printf '%s' "$payload" | curl -sf --connect-timeout 1 --max-time 1 -X POST \
  -H 'Content-Type: application/json' \
  -H @/dev/fd/3 \
  --data-binary @- \
  "$hook_url" 3<<EOF >/dev/null 2>&1 || _acorn_spool_event
X-Acorn-Agent-Hook-Token: $hook_token
EOF
"#;

// Claude Code wrapper.
//
// Claude Code does not expose a CLI flag to register hooks directly. The only
// runtime-only injection channel that does NOT require editing the user's
// `~/.claude/settings.json` (or any project-level `.claude/settings*.json`)
// is `--settings <file-or-json>`, which loads ADDITIONAL settings on top of
// the user's existing sources (merge semantics). We point that at an
// Acorn-owned JSON file under the wrapper dir whose `hooks` block registers
// `acorn-claude-notify` for the lifecycle events we care about. No write
// ever touches a path under the user's home `.claude/`.
const CLAUDE_WRAPPER_BODY: &str = r#"#!/bin/sh
_acorn_wrapper_dir="${ACORN_AGENT_WRAPPER_DIR-}"
if [ -z "$_acorn_wrapper_dir" ]; then
  case "$0" in
    */*) _acorn_wrapper_dir=${0%/*} ;;
  esac
fi

_acorn_find_real_binary() {
  _acorn_name="$1"
  _acorn_old_ifs=$IFS
  IFS=:
  for _acorn_dir in $PATH; do
    [ -n "$_acorn_dir" ] || continue
    _acorn_dir=${_acorn_dir%/}
    case "$_acorn_dir" in
      "$_acorn_wrapper_dir") continue ;;
    esac
    if [ -x "$_acorn_dir/$_acorn_name" ] && [ ! -d "$_acorn_dir/$_acorn_name" ]; then
      IFS=$_acorn_old_ifs
      printf '%s\n' "$_acorn_dir/$_acorn_name"
      return 0
    fi
  done
  IFS=$_acorn_old_ifs
  return 1
}

REAL_BIN=$(_acorn_find_real_binary claude)
if [ -z "$REAL_BIN" ]; then
  echo "Acorn: claude not found in PATH. Install it and ensure it is available in your shell PATH." >&2
  exit 127
fi

# The PTY root marker is consumed by its first wrapper. Provider descendants
# keep the invocation token only as a nesting marker and cannot reuse the
# outer session's hook channel. A tokenless process with hook env is a provider
# that survived an app update; any new wrapper below it must also fail closed.
if [ "${ACORN_AGENT_INVOCATION_ROOT-}" = "1" ]; then
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_INVOCATION_TOKEN ACORN_AGENT_INVOCATION_DEPTH
  if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ]; then
    _acorn_invocation_ts="$(date +%s 2>/dev/null || echo 0)"
    export ACORN_AGENT_INVOCATION_TOKEN="${ACORN_AGENT_HOOK_SESSION_ID}:$$:${_acorn_invocation_ts}"
    export ACORN_AGENT_INVOCATION_DEPTH=1
  fi
elif [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ]; then
  _acorn_invocation_depth="${ACORN_AGENT_INVOCATION_DEPTH-1}"
  case "$_acorn_invocation_depth" in
    ''|*[!0-9]*) _acorn_invocation_depth=1 ;;
  esac
  export ACORN_AGENT_INVOCATION_DEPTH=$((_acorn_invocation_depth + 1))
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_HOOK_SESSION_ID ACORN_AGENT_HOOK_URL ACORN_AGENT_HOOK_TOKEN ACORN_AGENT_HOOK_PROVIDER
  exec "$REAL_BIN" "$@"
elif [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ]; then
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_HOOK_SESSION_ID ACORN_AGENT_HOOK_URL ACORN_AGENT_HOOK_TOKEN ACORN_AGENT_HOOK_PROVIDER
  exec "$REAL_BIN" "$@"
fi

# Hook channel is available when the endpoint file exists (rewritten by each
# app launch with the current server URL + token) or the spawn-time env pair
# is present. The session id has no file fallback — without it, events cannot
# be attributed to a session.
if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
   { [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ] ||
     { [ -n "${ACORN_AGENT_HOOK_URL-}" ] && [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ]; }; } &&
   [ -f "$ACORN_AGENT_WRAPPER_DIR/acorn-claude-settings.json" ] &&
   [ -x "$ACORN_AGENT_WRAPPER_DIR/acorn-claude-notify" ]; then
  exec "$REAL_BIN" --settings "$ACORN_AGENT_WRAPPER_DIR/acorn-claude-settings.json" "$@"
fi

exec "$REAL_BIN" "$@"
"#;

const CLAUDE_NOTIFY_BODY: &str = r#"#!/bin/sh
input=$(cat 2>/dev/null || true)
[ -n "$input" ] || exit 0
compact_input=$(printf '%s\n' "$input" | tr '\r\n' '  ')

if [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ]; then
  [ "${ACORN_AGENT_INVOCATION_DEPTH-}" = "1" ] || exit 0
else
  [ -z "${ACORN_AGENT_INVOCATION_DEPTH-}" ] || exit 0
  legacy_session_id=$(printf '%s\n' "$compact_input" | grep -oE '(^|[,{])[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -n '1p' | grep -oE '"[^"]*"$' | tr -d '"')
  printf '%s\n' "$legacy_session_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' || exit 0
  legacy_owner_session_id=""
  if [ -n "${ACORN_AGENT_STATE_DIR-}" ] && [ -r "$ACORN_AGENT_STATE_DIR/claude.id" ]; then
    legacy_owner_session_id=$(sed -n '1p' "$ACORN_AGENT_STATE_DIR/claude.id" 2>/dev/null | tr -d '\r\n')
  fi
  [ "$legacy_owner_session_id" = "$legacy_session_id" ] || exit 0
fi

# Forward the raw hook payload with transport attribution. Rust owns
# structured classification, including subagent filtering and Stop handling.

# Spool this event when the POST fails: a wrapper-owned PTY outlives the
# app, and a dropped POST here is a lost lifecycle transition. Line 1 is
# the transport metadata the POST carried; the rest is the raw body. The
# app drains and replays this directory on its next boot.
_acorn_spool_event() {
  [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] || return 0
  _acorn_spool_dir="$ACORN_AGENT_WRAPPER_DIR/agent-hook-spool"
  (umask 077; mkdir -p "$_acorn_spool_dir") 2>/dev/null || return 0
  set -- "$_acorn_spool_dir"/*.json
  if [ "$#" -ge 512 ] && [ -e "$1" ]; then
    return 0
  fi
  _acorn_spool_tmp="$_acorn_spool_dir/.tmp-$$"
  {
    printf '%s\n' "$_acorn_spool_meta"
    printf '%s' "$_acorn_spool_body"
  } > "$_acorn_spool_tmp" 2>/dev/null || { rm -f "$_acorn_spool_tmp" 2>/dev/null; return 0; }
  chmod 600 "$_acorn_spool_tmp" 2>/dev/null || true
  mv "$_acorn_spool_tmp" "$_acorn_spool_dir/$(date +%s 2>/dev/null || echo 0)-$$.json" 2>/dev/null ||
    rm -f "$_acorn_spool_tmp" 2>/dev/null
}

# Resolve the hook endpoint at send time. Each app launch rewrites the
# endpoint file with that run's server URL + token (the hook server binds a
# fresh port and token per run), so an agent session that outlives an app
# restart keeps reaching the *current* server. The spawn-time env vars are
# only a fallback for when the file is missing.
hook_url=""
hook_token=""
if [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] && [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ]; then
  hook_url=$(sed -n '1p' "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" 2>/dev/null || true)
  hook_token=$(sed -n '2p' "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" 2>/dev/null || true)
fi
if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
  hook_url="${ACORN_AGENT_HOOK_URL-}"
  hook_token="${ACORN_AGENT_HOOK_TOKEN-}"
fi
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0
_acorn_spool_meta=$(printf '{"provider":"claude","session_id":"%s","source":"native"}' "$ACORN_AGENT_HOOK_SESSION_ID")
_acorn_spool_body="$input"
if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
  _acorn_spool_event
  exit 0
fi

printf '%s' "$input" | curl -sf --connect-timeout 1 --max-time 1 -X POST \
  -H 'Content-Type: application/json' \
  -H @/dev/fd/3 \
  -H 'X-Acorn-Agent-Hook-Provider: claude' \
  -H "X-Acorn-Agent-Hook-Session-Id: $ACORN_AGENT_HOOK_SESSION_ID" \
  -H 'X-Acorn-Agent-Hook-Source: native' \
  --data-binary @- \
  "$hook_url" 3<<EOF >/dev/null 2>&1 || _acorn_spool_event
X-Acorn-Agent-Hook-Token: $hook_token
EOF
"#;

const ANTIGRAVITY_WRAPPER_BODY: &str = r#"#!/bin/sh
_acorn_wrapper_dir="${ACORN_AGENT_WRAPPER_DIR-}"
if [ -z "$_acorn_wrapper_dir" ]; then
  case "$0" in
    */*) _acorn_wrapper_dir=${0%/*} ;;
  esac
fi

_acorn_find_real_binary() {
  _acorn_name="$1"
  _acorn_old_ifs=$IFS
  IFS=:
  for _acorn_dir in $PATH; do
    [ -n "$_acorn_dir" ] || continue
    _acorn_dir=${_acorn_dir%/}
    case "$_acorn_dir" in
      "$_acorn_wrapper_dir") continue ;;
    esac
    if [ -x "$_acorn_dir/$_acorn_name" ] && [ ! -d "$_acorn_dir/$_acorn_name" ]; then
      IFS=$_acorn_old_ifs
      printf '%s\n' "$_acorn_dir/$_acorn_name"
      return 0
    fi
  done
  IFS=$_acorn_old_ifs
  return 1
}

_acorn_antigravity_transcript_for_id() {
  _acorn_brain_id="$1"
  printf '%s\n' "$_acorn_brain_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' || return 1
  _acorn_root="${ANTIGRAVITY_DIR:-${GEMINI_DIR:-$HOME/.gemini}}"
  for _acorn_profile in antigravity antigravity-cli antigravity-ide; do
    _acorn_path="$_acorn_root/$_acorn_profile/brain/$_acorn_brain_id/.system_generated/logs/transcript.jsonl"
    if [ -f "$_acorn_path" ]; then
      printf '%s\n' "$_acorn_path"
      return 0
    fi
  done
  return 1
}

_acorn_watch_antigravity_transcript() {
  _acorn_transcript="$1"
  _acorn_brain_id="$2"
  _acorn_notify="$3"
  _acorn_watch_dir=$(mktemp -d "${TMPDIR:-/tmp}/acorn-antigravity-watcher.XXXXXX") || exit 0
  _acorn_watch_fifo="$_acorn_watch_dir/events"
  if ! mkfifo "$_acorn_watch_fifo"; then
    rmdir "$_acorn_watch_dir" >/dev/null 2>&1 || true
    exit 0
  fi
  _acorn_tail_pid=""
  _acorn_cleanup_transcript_tail() {
    if [ -n "$_acorn_tail_pid" ]; then
      kill "$_acorn_tail_pid" >/dev/null 2>&1 || true
      wait "$_acorn_tail_pid" 2>/dev/null || true
      _acorn_tail_pid=""
    fi
    rm -rf "$_acorn_watch_dir"
  }
  trap _acorn_cleanup_transcript_tail EXIT
  trap 'exit 0' HUP INT TERM

  tail -n 0 -F "$_acorn_transcript" > "$_acorn_watch_fifo" 2>/dev/null &
  _acorn_tail_pid=$!
  while IFS= read -r _acorn_line; do
    case "$_acorn_line" in
      *'"type":"USER_INPUT"'*)
        "$_acorn_notify" start "$_acorn_brain_id" >/dev/null 2>&1 || true
        ;;
      *'"type":"PLANNER_RESPONSE"'*'"status":"DONE"'*)
        if printf '%s\n' "$_acorn_line" | grep -qE '"tool_calls"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{'; then
          "$_acorn_notify" start "$_acorn_brain_id" >/dev/null 2>&1 || true
        else
          "$_acorn_notify" needs_input "$_acorn_brain_id" >/dev/null 2>&1 || true
        fi
        ;;
      *'"status":"ERROR"'*)
        "$_acorn_notify" error "$_acorn_brain_id" >/dev/null 2>&1 || true
        ;;
    esac
  done < "$_acorn_watch_fifo"
}

REAL_BIN=$(_acorn_find_real_binary agy)
if [ -z "$REAL_BIN" ]; then
  echo "Acorn: agy not found in PATH. Install Antigravity CLI and ensure it is available in your shell PATH." >&2
  exit 127
fi

# The PTY root marker is consumed by its first wrapper. Provider descendants
# keep the invocation token only as a nesting marker and cannot reuse the
# outer session's hook channel. A tokenless process with hook env is a provider
# that survived an app update; any new wrapper below it must also fail closed.
if [ "${ACORN_AGENT_INVOCATION_ROOT-}" = "1" ]; then
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_INVOCATION_TOKEN ACORN_AGENT_INVOCATION_DEPTH
  if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ]; then
    _acorn_invocation_ts="$(date +%s 2>/dev/null || echo 0)"
    export ACORN_AGENT_INVOCATION_TOKEN="${ACORN_AGENT_HOOK_SESSION_ID}:$$:${_acorn_invocation_ts}"
    export ACORN_AGENT_INVOCATION_DEPTH=1
  fi
elif [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ]; then
  _acorn_invocation_depth="${ACORN_AGENT_INVOCATION_DEPTH-1}"
  case "$_acorn_invocation_depth" in
    ''|*[!0-9]*) _acorn_invocation_depth=1 ;;
  esac
  export ACORN_AGENT_INVOCATION_DEPTH=$((_acorn_invocation_depth + 1))
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_HOOK_SESSION_ID ACORN_AGENT_HOOK_URL ACORN_AGENT_HOOK_TOKEN ACORN_AGENT_HOOK_PROVIDER
  exec "$REAL_BIN" "$@"
elif [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ]; then
  unset ACORN_AGENT_INVOCATION_ROOT ACORN_AGENT_HOOK_SESSION_ID ACORN_AGENT_HOOK_URL ACORN_AGENT_HOOK_TOKEN ACORN_AGENT_HOOK_PROVIDER
  exec "$REAL_BIN" "$@"
fi

# Hook channel is available when the endpoint file exists (rewritten by each
# app launch with the current server URL + token) or the spawn-time env pair
# is present. The session id has no file fallback — without it, events cannot
# be attributed to a session.
if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
   [ -n "${ACORN_AGENT_STATE_DIR-}" ] &&
   { [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ] ||
     { [ -n "${ACORN_AGENT_HOOK_URL-}" ] && [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ]; }; } &&
   [ -x "$ACORN_AGENT_WRAPPER_DIR/acorn-antigravity-notify" ]; then
  _acorn_antigravity_wrapper_pid=$$
  (
    _acorn_wrapper_pid="$_acorn_antigravity_wrapper_pid"
    _acorn_notify="$ACORN_AGENT_WRAPPER_DIR/acorn-antigravity-notify"
    _acorn_marker="$ACORN_AGENT_STATE_DIR/antigravity.id"
    _acorn_owner_brain_id=""
    _acorn_owner_watcher_pid=""
    _acorn_stop_owner_watcher() {
      if [ -n "$_acorn_owner_watcher_pid" ]; then
        kill "$_acorn_owner_watcher_pid" >/dev/null 2>&1 || true
        wait "$_acorn_owner_watcher_pid" 2>/dev/null || true
        _acorn_owner_watcher_pid=""
      fi
    }
    _acorn_cleanup_owner_watcher() {
      _acorn_stop_owner_watcher
    }
    trap _acorn_cleanup_owner_watcher EXIT
    trap 'exit 0' HUP INT TERM

    while :; do
      kill -0 "$_acorn_wrapper_pid" 2>/dev/null || exit 0
      _acorn_next_brain_id=""
      if [ -r "$_acorn_marker" ]; then
        _acorn_next_brain_id=$(sed -n '1p' "$_acorn_marker" 2>/dev/null | tr -d '\r\n')
      fi
      if ! printf '%s\n' "$_acorn_next_brain_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$'; then
        _acorn_next_brain_id=""
      fi

      if [ "$_acorn_next_brain_id" != "$_acorn_owner_brain_id" ]; then
        _acorn_stop_owner_watcher
        _acorn_owner_brain_id="$_acorn_next_brain_id"
      fi

      if [ -n "$_acorn_owner_watcher_pid" ] && ! kill -0 "$_acorn_owner_watcher_pid" 2>/dev/null; then
        wait "$_acorn_owner_watcher_pid" 2>/dev/null || true
        _acorn_owner_watcher_pid=""
      fi
      if [ -n "$_acorn_owner_brain_id" ] && [ -z "$_acorn_owner_watcher_pid" ]; then
        _acorn_transcript=$(_acorn_antigravity_transcript_for_id "$_acorn_owner_brain_id" 2>/dev/null || true)
        if [ -n "$_acorn_transcript" ]; then
          _acorn_watch_antigravity_transcript \
            "$_acorn_transcript" \
            "$_acorn_owner_brain_id" \
            "$_acorn_notify" &
          _acorn_owner_watcher_pid=$!
        fi
      fi
      # The authoritative Rust owner scan updates this marker on a two-second
      # cadence. Half-second polling keeps /new handoff responsive without
      # spawning shell helpers continuously while an agent sits idle.
      sleep 0.5
    done
  ) &
  ACORN_ANTIGRAVITY_WATCHER_PID=$!

  "$REAL_BIN" "$@"
  ACORN_ANTIGRAVITY_STATUS=$?

  if [ -n "${ACORN_ANTIGRAVITY_WATCHER_PID-}" ]; then
    kill "$ACORN_ANTIGRAVITY_WATCHER_PID" >/dev/null 2>&1 || true
    wait "$ACORN_ANTIGRAVITY_WATCHER_PID" 2>/dev/null || true
  fi
  exit "$ACORN_ANTIGRAVITY_STATUS"
fi

exec "$REAL_BIN" "$@"
"#;

const ANTIGRAVITY_NOTIFY_BODY: &str = r#"#!/bin/sh
input="${1-}"
completion_brain_id="${2-}"
if [ -z "$input" ]; then
  input=$(cat 2>/dev/null || true)
fi
compact_input=$(printf '%s\n' "$input" | tr '\r\n' '  ')

if [ -n "${ACORN_AGENT_INVOCATION_TOKEN-}" ]; then
  [ "${ACORN_AGENT_INVOCATION_DEPTH-}" = "1" ] || exit 0
else
  [ -z "${ACORN_AGENT_INVOCATION_DEPTH-}" ] || exit 0
  legacy_payload_brain_id=$(printf '%s\n' "$compact_input" | grep -oE '(^|[,{])[[:space:]]*"conversationId"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -n '1p' | grep -oE '"[^"]*"$' | tr -d '"')
  legacy_brain_id="$completion_brain_id"
  if [ -n "$legacy_payload_brain_id" ]; then
    [ -z "$legacy_brain_id" ] || [ "$legacy_brain_id" = "$legacy_payload_brain_id" ] || exit 0
    legacy_brain_id="$legacy_payload_brain_id"
  fi
  printf '%s\n' "$legacy_brain_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' || exit 0
  legacy_owner_brain_id=""
  if [ -n "${ACORN_AGENT_STATE_DIR-}" ] && [ -r "$ACORN_AGENT_STATE_DIR/antigravity.id" ]; then
    legacy_owner_brain_id=$(sed -n '1p' "$ACORN_AGENT_STATE_DIR/antigravity.id" 2>/dev/null | tr -d '\r\n')
  fi
  [ "$legacy_owner_brain_id" = "$legacy_brain_id" ] || exit 0
fi

# A native hook inherits the top-level wrapper token even when AGY fires it
# inside a child conversation. Once the cwd-bound owner marker exists, only
# that exact conversation may transition the aggregate Acorn session. Missing
# markers remain accepted during initial synchronous startup; the transcript
# owner watcher supplies the eventual binding.
payload_brain_id=$(printf '%s\n' "$compact_input" | grep -oE '(^|[,{])[[:space:]]*"conversationId"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -n '1p' | grep -oE '"[^"]*"$' | tr -d '"')
if [ -n "$payload_brain_id" ]; then
  printf '%s\n' "$payload_brain_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' || exit 0
  if [ -n "${ACORN_AGENT_STATE_DIR-}" ] && [ -r "$ACORN_AGENT_STATE_DIR/antigravity.id" ]; then
    bound_brain_id=$(sed -n '1p' "$ACORN_AGENT_STATE_DIR/antigravity.id" 2>/dev/null | tr -d '\r\n')
    if printf '%s\n' "$bound_brain_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$'; then
      [ "$bound_brain_id" = "$payload_brain_id" ] || exit 0
    fi
  fi
fi

source="hook"
event="$input"
case "$event" in
  start|error)
    source="transcript"
    ;;
  stop|needs_input)
    source="transcript"
    printf '%s\n' "$completion_brain_id" | grep -Eq '^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$' || exit 0

    owner_brain_id=""
    if [ -n "${ACORN_AGENT_STATE_DIR-}" ] && [ -r "$ACORN_AGENT_STATE_DIR/antigravity.id" ]; then
      owner_brain_id=$(sed -n '1p' "$ACORN_AGENT_STATE_DIR/antigravity.id" 2>/dev/null | tr -d '\r\n')
    fi
    [ "$owner_brain_id" = "$completion_brain_id" ] || exit 0
    ;;
  *)
    event=""
    hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hookEventName"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
    [ -n "$hook_event_name" ] || hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
    if [ -z "$hook_event_name" ]; then
      if printf '%s\n' "$compact_input" | grep -qE '(^|[,{])[[:space:]]*"fullyIdle"[[:space:]]*:[[:space:]]*(true|false)([[:space:]]*[,}]|$)'; then
        hook_event_name="Stop"
      fi
    fi
    # SubagentStop and any Stop not carrying literal fullyIdle=true are pauses
    # inside the owner turn. They emit nothing so a concurrent permission or
    # input request stays visible. The field-boundary regex ignores escaped
    # decoy text.
    case "$hook_event_name" in
      SessionStart|UserPromptSubmit|PreToolUse) event="start" ;;
      SubagentStop) event="" ;;
      Stop)
        if printf '%s\n' "$compact_input" | grep -qE '(^|[,{])[[:space:]]*"fullyIdle"[[:space:]]*:[[:space:]]*true([[:space:]]*[,}]|$)'; then
          event="needs_input"
        else
          # Preserve Working or a concurrent attention request; a non-idle or
          # malformed Stop is a pause, not a new turn boundary.
          event=""
        fi
        ;;
      Notification|PermissionRequest) event="needs_input" ;;
      Error) event="error" ;;
    esac
    [ -n "$event" ] || exit 0
    ;;
esac

# Spool this event when the POST fails: a wrapper-owned PTY outlives the
# app, and a dropped POST here is a lost lifecycle transition. Line 1 is
# the transport metadata the POST carried; the rest is the raw body. The
# app drains and replays this directory on its next boot.
_acorn_spool_event() {
  [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] || return 0
  _acorn_spool_dir="$ACORN_AGENT_WRAPPER_DIR/agent-hook-spool"
  (umask 077; mkdir -p "$_acorn_spool_dir") 2>/dev/null || return 0
  set -- "$_acorn_spool_dir"/*.json
  if [ "$#" -ge 512 ] && [ -e "$1" ]; then
    return 0
  fi
  _acorn_spool_tmp="$_acorn_spool_dir/.tmp-$$"
  {
    printf '%s\n' "$_acorn_spool_meta"
    printf '%s' "$_acorn_spool_body"
  } > "$_acorn_spool_tmp" 2>/dev/null || { rm -f "$_acorn_spool_tmp" 2>/dev/null; return 0; }
  chmod 600 "$_acorn_spool_tmp" 2>/dev/null || true
  mv "$_acorn_spool_tmp" "$_acorn_spool_dir/$(date +%s 2>/dev/null || echo 0)-$$.json" 2>/dev/null ||
    rm -f "$_acorn_spool_tmp" 2>/dev/null
}

# Resolve the hook endpoint at send time. Each app launch rewrites the
# endpoint file with that run's server URL + token (the hook server binds a
# fresh port and token per run), so an agent session that outlives an app
# restart keeps reaching the *current* server. The spawn-time env vars are
# only a fallback for when the file is missing.
hook_url=""
hook_token=""
if [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] && [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ]; then
  hook_url=$(sed -n '1p' "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" 2>/dev/null || true)
  hook_token=$(sed -n '2p' "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" 2>/dev/null || true)
fi
if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
  hook_url="${ACORN_AGENT_HOOK_URL-}"
  hook_token="${ACORN_AGENT_HOOK_TOKEN-}"
fi
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

payload=$(printf '{"session_id":"%s","provider":"antigravity","event":"%s","source":"%s"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event" "$source")
_acorn_spool_meta='{}'
_acorn_spool_body="$payload"
if [ -z "$hook_url" ] || [ -z "$hook_token" ]; then
  _acorn_spool_event
  exit 0
fi
printf '%s' "$payload" | curl -sf --connect-timeout 1 --max-time 1 -X POST \
  -H 'Content-Type: application/json' \
  -H @/dev/fd/3 \
  --data-binary @- \
  "$hook_url" 3<<EOF >/dev/null 2>&1 || _acorn_spool_event
X-Acorn-Agent-Hook-Token: $hook_token
EOF
"#;

pub fn ensure_agent_wrapper_dir() -> io::Result<PathBuf> {
    ensure_agent_wrapper_dir_at(&acorn_daemon::paths::data_dir()?)
}

/// Publish the hook server's current URL + token where the notify scripts
/// resolve them at send time. The hook server binds a fresh ephemeral port
/// and token on every app launch, but agent PTYs (daemon-managed ones
/// especially) outlive the app — their spawn-time `ACORN_AGENT_HOOK_URL`/
/// `ACORN_AGENT_HOOK_TOKEN` env goes stale on the first restart and every
/// event they emit afterwards would hit a dead port. Routing each POST
/// through this file keeps surviving sessions attached to the current
/// server. Two lines: URL, then token, trailing newline.
pub fn write_agent_hook_endpoint(url: &str, token: &str) -> io::Result<PathBuf> {
    let dir = ensure_agent_wrapper_dir()?;
    write_agent_hook_endpoint_at(&dir, url, token)
}

fn write_agent_hook_endpoint_at(dir: &Path, url: &str, token: &str) -> io::Result<PathBuf> {
    let path = dir.join(HOOK_ENDPOINT_NAME);
    let tmp = dir.join(format!("{HOOK_ENDPOINT_NAME}.tmp"));
    fs::write(&tmp, format!("{url}\n{token}\n"))?;
    // The token authorizes status-event POSTs for any session id; keep it
    // owner-readable only, like an SSH key. Set perms before the rename so
    // the file is never observable in a looser mode.
    #[cfg(unix)]
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    // Atomic rename — a notify script reading mid-publish sees either the
    // previous endpoint or the new one, never a torn file.
    fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Directory where the notify scripts spool hook events they could not
/// deliver (no app instance listening). Drained through
/// `agent_hooks::replay_spooled_hook_events` on the next app boot.
pub fn agent_hook_spool_dir() -> io::Result<PathBuf> {
    Ok(ensure_agent_wrapper_dir()?.join(HOOK_SPOOL_DIR_NAME))
}

/// Best-effort removal of a stale endpoint file. Called when this run has no
/// hook server: a leftover file from a previous run would otherwise win over
/// the env fallback in the notify scripts and swallow events silently.
pub fn remove_agent_hook_endpoint() {
    if let Ok(base) = acorn_daemon::paths::data_dir() {
        let _ = fs::remove_file(base.join(WRAPPER_DIR_NAME).join(HOOK_ENDPOINT_NAME));
    }
}

fn ensure_agent_wrapper_dir_at(base: &Path) -> io::Result<PathBuf> {
    let dir = base.join(WRAPPER_DIR_NAME);
    fs::create_dir_all(&dir)?;
    write_executable(&dir.join(CODEX_WRAPPER_NAME), CODEX_WRAPPER_BODY)?;
    write_executable(&dir.join(CODEX_NOTIFY_NAME), CODEX_NOTIFY_BODY)?;
    write_executable(&dir.join(CLAUDE_WRAPPER_NAME), CLAUDE_WRAPPER_BODY)?;
    write_executable(&dir.join(CLAUDE_NOTIFY_NAME), CLAUDE_NOTIFY_BODY)?;
    write_executable(
        &dir.join(ANTIGRAVITY_WRAPPER_NAME),
        ANTIGRAVITY_WRAPPER_BODY,
    )?;
    write_executable(&dir.join(ANTIGRAVITY_NOTIFY_NAME), ANTIGRAVITY_NOTIFY_BODY)?;
    write_claude_settings(&dir)?;
    Ok(dir)
}

fn write_claude_settings(dir: &Path) -> io::Result<()> {
    let notify_path = dir.join(CLAUDE_NOTIFY_NAME);
    let command = format!("bash {}", shell_quote(&notify_path.display().to_string()));
    let escaped = json_escape(&command);
    let body = format!(
        r#"{{
  "hooks": {{
    "SessionStart": [{{"hooks":[{{"type":"command","command":"{cmd}"}}]}}],
    "UserPromptSubmit": [{{"hooks":[{{"type":"command","command":"{cmd}"}}]}}],
    "Stop": [{{"hooks":[{{"type":"command","command":"{cmd}"}}]}}],
    "Notification": [{{"matcher":"permission_prompt|elicitation_dialog|agent_needs_input","hooks":[{{"type":"command","command":"{cmd}"}}]}}],
    "PermissionRequest": [{{"matcher":"*","hooks":[{{"type":"command","command":"{cmd}"}}]}}]
  }}
}}
"#,
        cmd = escaped
    );
    fs::write(dir.join(CLAUDE_SETTINGS_NAME), body)
}

fn shell_quote(input: &str) -> String {
    format!("'{}'", input.replace('\'', r"'\''"))
}

fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn write_executable(path: &Path, body: &str) -> io::Result<()> {
    fs::write(path, body)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};

    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(tag: &str) -> Self {
            let path = PathBuf::from("/tmp").join(format!(
                "acorn-agent-wrapper-{tag}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn shell_quote_for_test(input: &str) -> String {
        format!("'{}'", input.replace('\'', r"'\''"))
    }

    #[cfg(unix)]
    fn install_tail_probe(real_dir: &Path) -> &'static str {
        let real_tail = ["/usr/bin/tail", "/bin/tail"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .expect("tail binary must exist on unix");
        write_executable(
            &real_dir.join("tail"),
            r#"#!/bin/sh
printf '%s\n' "$$" > "$ACORN_TEST_TAIL_PID"
if [ -n "${ACORN_TEST_TAIL_PARENT_PID-}" ]; then
  printf '%s\n' "$PPID" > "$ACORN_TEST_TAIL_PARENT_PID"
fi
if [ "${1-}" = "-n" ] && [ "${2-}" = "0" ]; then
  shift 2
  set -- -n +1 "$@"
fi
exec "$ACORN_TEST_REAL_TAIL" "$@"
"#,
        )
        .unwrap();
        real_tail
    }

    #[cfg(unix)]
    fn tail_process_survived_wrapper(tail_pid_path: &Path) -> bool {
        let tail_pid = fs::read_to_string(tail_pid_path)
            .unwrap()
            .trim()
            .to_string();
        let mut tail_alive = true;
        for _ in 0..20 {
            tail_alive = Command::new("kill")
                .args(["-0", &tail_pid])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !tail_alive {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        if tail_alive {
            let _ = Command::new("kill").arg(&tail_pid).status();
        }
        tail_alive
    }

    #[cfg(unix)]
    fn process_is_alive(pid: &str) -> bool {
        Command::new("kill")
            .args(["-0", pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(unix)]
    fn wrapper_watcher_survives_direct_termination(provider: &str) -> (bool, bool) {
        let base = ScratchDir::new(&format!("{provider}-direct-termination"));
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let state_dir = base.path().join("agent-state");
        let gemini_dir = base.path().join("gemini");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&state_dir).unwrap();

        let tail_pid_path = base.path().join("tail.pid");
        let tail_parent_pid_path = base.path().join("tail-parent.pid");
        let real_pid_path = base.path().join("real.pid");
        let real_tail = install_tail_probe(&real_dir);
        let owner_id = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        let session_log_path = base.path().join("session.jsonl");
        let transcript = gemini_dir
            .join("antigravity-cli")
            .join("brain")
            .join(owner_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");

        match provider {
            CODEX_WRAPPER_NAME => {
                write_executable(
                    &real_dir.join(provider),
                    r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
: > "$CODEX_TUI_SESSION_LOG_PATH"
printf '%s\n' "$$" > "$ACORN_TEST_REAL_PID"
while :; do sleep 1; done
"#,
                )
                .unwrap();
            }
            ANTIGRAVITY_WRAPPER_NAME => {
                fs::create_dir_all(transcript.parent().unwrap()).unwrap();
                fs::write(&transcript, "").unwrap();
                fs::write(state_dir.join("antigravity.id"), format!("{owner_id}\n")).unwrap();
                write_executable(
                    &real_dir.join(provider),
                    r#"#!/bin/sh
printf '%s\n' "$$" > "$ACORN_TEST_REAL_PID"
while :; do sleep 1; done
"#,
                )
                .unwrap();
            }
            _ => panic!("unsupported watcher provider: {provider}"),
        }

        let mut wrapper = Command::new(wrapper_dir.join(provider));
        wrapper
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_TEST_REAL_TAIL", real_tail)
            .env("ACORN_TEST_TAIL_PID", &tail_pid_path)
            .env("ACORN_TEST_TAIL_PARENT_PID", &tail_parent_pid_path)
            .env("ACORN_TEST_REAL_PID", &real_pid_path)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .env("GEMINI_DIR", &gemini_dir)
            .env_remove("ANTIGRAVITY_DIR")
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let mut wrapper = wrapper.spawn().unwrap();

        let started = Instant::now();
        while (!tail_pid_path.exists() || !tail_parent_pid_path.exists() || !real_pid_path.exists())
            && started.elapsed() < Duration::from_secs(5)
        {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(tail_pid_path.exists(), "{provider} tail did not start");
        assert!(
            tail_parent_pid_path.exists(),
            "{provider} watcher pid was not captured"
        );
        assert!(
            real_pid_path.exists(),
            "{provider} real process did not start"
        );

        Command::new("kill")
            .args(["-TERM", &wrapper.id().to_string()])
            .status()
            .unwrap();
        let stopped = Instant::now();
        while wrapper.try_wait().unwrap().is_none() && stopped.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(25));
        }
        let _ = wrapper.kill();
        let _ = wrapper.wait();

        let tail_pid = fs::read_to_string(&tail_pid_path)
            .unwrap()
            .trim()
            .to_string();
        let tail_parent_pid = fs::read_to_string(&tail_parent_pid_path)
            .unwrap()
            .trim()
            .to_string();
        let stopped = Instant::now();
        while (process_is_alive(&tail_pid) || process_is_alive(&tail_parent_pid))
            && stopped.elapsed() < Duration::from_secs(2)
        {
            thread::sleep(Duration::from_millis(25));
        }
        let tail_alive = process_is_alive(&tail_pid);
        let watcher_alive = process_is_alive(&tail_parent_pid);

        for pid in [
            tail_pid,
            tail_parent_pid,
            fs::read_to_string(real_pid_path)
                .unwrap()
                .trim()
                .to_string(),
        ] {
            let _ = Command::new("kill")
                .arg("-KILL")
                .arg(pid)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }

        (tail_alive, watcher_alive)
    }

    #[cfg(unix)]
    fn codex_parent_guard_short_sleep_count() -> usize {
        let base = ScratchDir::new("codex-parent-guard-churn");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let session_log_path = base.path().join("session.jsonl");
        let tail_pid_path = base.path().join("tail.pid");
        let sleep_log_path = base.path().join("sleep.log");
        let real_tail = install_tail_probe(&real_dir);
        let real_sleep = ["/bin/sleep", "/usr/bin/sleep"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .expect("sleep binary must exist on unix");

        write_executable(
            &real_dir.join("sleep"),
            r#"#!/bin/sh
printf '%s\n' "${1-}" >> "$ACORN_TEST_SLEEP_LOG"
exec "$ACORN_TEST_REAL_SLEEP" "$@"
"#,
        )
        .unwrap();
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
: > "$CODEX_TUI_SESSION_LOG_PATH"
_acorn_i=0
while [ ! -s "$ACORN_TEST_TAIL_PID" ] && [ "$_acorn_i" -lt 100 ]; do
  _acorn_i=$((_acorn_i + 1))
  "$ACORN_TEST_REAL_SLEEP" 0.01
done
[ -s "$ACORN_TEST_TAIL_PID" ] || exit 1
"$ACORN_TEST_REAL_SLEEP" 0.45
"#,
        )
        .unwrap();

        let status = Command::new(wrapper_dir.join(CODEX_WRAPPER_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_TEST_REAL_TAIL", real_tail)
            .env("ACORN_TEST_TAIL_PID", &tail_pid_path)
            .env("ACORN_TEST_REAL_SLEEP", real_sleep)
            .env("ACORN_TEST_SLEEP_LOG", &sleep_log_path)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "codex wrapper failed with {status}");
        assert!(
            !tail_process_survived_wrapper(&tail_pid_path),
            "the churn probe left its transcript tail alive"
        );

        fs::read_to_string(sleep_log_path)
            .unwrap_or_default()
            .lines()
            .filter(|duration| *duration == "0.1")
            .count()
    }

    fn run_wrapper_with_timeout(
        program: impl AsRef<std::ffi::OsStr>,
        path: &str,
        wrapper_env: Option<&Path>,
    ) -> io::Result<std::process::Output> {
        let mut command = Command::new(program);
        command
            .arg("sentinel")
            .env("PATH", path)
            .env_remove("ACORN_AGENT_HOOK_SESSION_ID")
            .env_remove("ACORN_AGENT_HOOK_URL")
            .env_remove("ACORN_AGENT_HOOK_TOKEN")
            .env_remove("CODEX_TUI_SESSION_LOG_PATH")
            .env_remove("CODEX_TUI_RECORD_SESSION")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(wrapper_env) = wrapper_env {
            command.env("ACORN_AGENT_WRAPPER_DIR", wrapper_env);
        } else {
            command.env_remove("ACORN_AGENT_WRAPPER_DIR");
        }
        let mut child = command.spawn()?;

        let started = Instant::now();
        loop {
            if child.try_wait()?.is_some() {
                return child.wait_with_output();
            }
            if started.elapsed() > Duration::from_secs(5) {
                child.kill()?;
                let _ = child.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "wrapper did not resolve the real binary",
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    enum WrapperInvocationContext {
        Root,
        RootWithInheritedOwner,
        Nested,
        LegacyInherited,
    }

    #[cfg(unix)]
    fn run_hooked_wrapper_for_invocation_ownership(
        provider: &str,
        context: WrapperInvocationContext,
    ) -> std::process::Output {
        let base = ScratchDir::new(&format!("{provider}-invocation-owner"));
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let state_dir = base.path().join("agent-state");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&state_dir).unwrap();

        let real_wrapper = if provider == CODEX_WRAPPER_NAME {
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
printf 'hook_session=%s\n' "${ACORN_AGENT_HOOK_SESSION_ID-}"
printf 'hook_url=%s\n' "${ACORN_AGENT_HOOK_URL-}"
printf 'hook_token=%s\n' "${ACORN_AGENT_HOOK_TOKEN-}"
printf 'invocation_token=%s\n' "${ACORN_AGENT_INVOCATION_TOKEN-}"
printf 'invocation_depth=%s\n' "${ACORN_AGENT_INVOCATION_DEPTH-}"
printf 'invocation_root=%s\n' "${ACORN_AGENT_INVOCATION_ROOT-}"
for arg in "$@"; do
  printf 'arg=%s\n' "$arg"
done
"#
        } else {
            r#"#!/bin/sh
printf 'hook_session=%s\n' "${ACORN_AGENT_HOOK_SESSION_ID-}"
printf 'hook_url=%s\n' "${ACORN_AGENT_HOOK_URL-}"
printf 'hook_token=%s\n' "${ACORN_AGENT_HOOK_TOKEN-}"
printf 'invocation_token=%s\n' "${ACORN_AGENT_INVOCATION_TOKEN-}"
printf 'invocation_depth=%s\n' "${ACORN_AGENT_INVOCATION_DEPTH-}"
printf 'invocation_root=%s\n' "${ACORN_AGENT_INVOCATION_ROOT-}"
for arg in "$@"; do
  printf 'arg=%s\n' "$arg"
done
"#
        };
        write_executable(&real_dir.join(provider), real_wrapper).unwrap();

        let mut command = Command::new(wrapper_dir.join(provider));
        command
            .arg("sentinel")
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "hook-token-1")
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .env_remove("ACORN_AGENT_INVOCATION_ROOT")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        match context {
            WrapperInvocationContext::Root => {
                command.env("ACORN_AGENT_INVOCATION_ROOT", "1");
            }
            WrapperInvocationContext::RootWithInheritedOwner => {
                command
                    .env("ACORN_AGENT_INVOCATION_ROOT", "1")
                    .env("ACORN_AGENT_INVOCATION_TOKEN", "inherited-invocation")
                    .env("ACORN_AGENT_INVOCATION_DEPTH", "7");
            }
            WrapperInvocationContext::Nested => {
                command
                    .env("ACORN_AGENT_INVOCATION_TOKEN", "outer-invocation")
                    .env("ACORN_AGENT_INVOCATION_DEPTH", "1");
            }
            WrapperInvocationContext::LegacyInherited => {}
        }

        command.output().unwrap()
    }

    #[cfg(unix)]
    fn codex_wrapper_notifications_for_tui_line(line: &str) -> (String, bool) {
        let base = ScratchDir::new("codex-tui-event");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        write_agent_hook_endpoint_at(&wrapper_dir, "http://127.0.0.1:1/agent-hook", "token-1")
            .unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let capture_path = base.path().join("notifications.log");
        let session_log_path = base.path().join("session.jsonl");
        let tail_pid_path = base.path().join("tail.pid");
        let real_tail = install_tail_probe(&real_dir);
        write_executable(
            &wrapper_dir.join("acorn-codex-notify"),
            "#!/bin/sh\ninput=\"${1-}\"\n[ -n \"$input\" ] || input=$(cat)\nprintf '%s\\t%s\\n' \"${2-}\" \"$input\" >> \"$ACORN_NOTIFY_CAPTURE\"\n",
        )
        .unwrap();
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
: > "$CODEX_TUI_SESSION_LOG_PATH"
_acorn_i=0
while [ ! -s "$ACORN_TEST_TAIL_PID" ] && [ "$_acorn_i" -lt 100 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.05
done
[ -s "$ACORN_TEST_TAIL_PID" ] || exit 1
printf '%s\n' "$ACORN_TEST_TUI_LINE" >> "$CODEX_TUI_SESSION_LOG_PATH"
_acorn_i=0
while [ ! -s "$ACORN_NOTIFY_CAPTURE" ] && [ "$_acorn_i" -lt 50 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.02
done
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", real_dir.display());
        let status = Command::new(wrapper_dir.join("codex"))
            .env("PATH", path)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_TEST_TUI_LINE", line)
            .env("ACORN_TEST_REAL_TAIL", real_tail)
            .env("ACORN_TEST_TAIL_PID", &tail_pid_path)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        (
            fs::read_to_string(capture_path).unwrap_or_default(),
            tail_process_survived_wrapper(&tail_pid_path),
        )
    }

    #[cfg(unix)]
    fn codex_notify_post_for_payload(payload: &str, owner_thread_id: Option<&str>) -> String {
        codex_notify_post_for_payload_with_owner_update(payload, owner_thread_id, None)
    }

    #[cfg(unix)]
    fn codex_notify_post_transport_metadata(
        payload: &str,
        owner_thread_id: Option<&str>,
    ) -> (String, String, String) {
        codex_notify_post_for_payload_with_context(payload, owner_thread_id, None)
    }

    #[cfg(unix)]
    fn codex_notify_post_for_payload_with_owner_update(
        payload: &str,
        owner_thread_id: Option<&str>,
        owner_update: Option<&str>,
    ) -> String {
        codex_notify_post_for_payload_with_context(payload, owner_thread_id, owner_update).0
    }

    #[cfg(unix)]
    fn codex_notify_post_for_payload_with_context(
        payload: &str,
        owner_thread_id: Option<&str>,
        owner_update: Option<&str>,
    ) -> (String, String, String) {
        let base = ScratchDir::new("codex-notify-event");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let fake_bin = base.path().join("fake-bin");
        let state_dir = base.path().join("agent-state");
        fs::create_dir_all(&fake_bin).unwrap();
        fs::create_dir_all(&state_dir).unwrap();

        let capture_path = base.path().join("curl.log");
        let source_capture_path = base.path().join("curl-source.log");
        let native_hooks_capture_path = base.path().join("curl-native-hooks.log");
        write_executable(
            &fake_bin.join("curl"),
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-H" ]; then
    shift
    case "${1-}" in
      "X-Acorn-Agent-Hook-Source: "*)
        printf '%s' "${1#X-Acorn-Agent-Hook-Source: }" > "$ACORN_NOTIFY_SOURCE_CAPTURE"
        ;;
      "X-Acorn-Codex-Native-Hooks-Enabled: "*)
        printf '%s' "${1#X-Acorn-Codex-Native-Hooks-Enabled: }" > "$ACORN_NOTIFY_NATIVE_HOOKS_CAPTURE"
        ;;
    esac
  fi
  if [ "$1" = "-d" ]; then
    shift
    printf '%s\n' "$1" > "$ACORN_NOTIFY_CAPTURE"
    exit 0
  fi
  if [ "$1" = "--data-binary" ]; then
    shift
    [ "${1-}" = "@-" ] || exit 1
    cat > "$ACORN_NOTIFY_CAPTURE"
    exit 0
  fi
  shift
done
exit 1
"#,
        )
        .unwrap();
        if let Some(owner_thread_id) = owner_thread_id {
            fs::write(state_dir.join("codex.id"), format!("{owner_thread_id}\n")).unwrap();
        }
        let mut command = Command::new(wrapper_dir.join(CODEX_NOTIFY_NAME));
        command
            .arg(payload)
            .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("ACORN_AGENT_INVOCATION_TOKEN", "owner-invocation")
            .env("ACORN_AGENT_INVOCATION_DEPTH", "1")
            .env("ACORN_CODEX_LIFECYCLE_ID", "lifecycle-1")
            .env("ACORN_CODEX_VERSION", "0.144.4")
            .env("ACORN_CODEX_NATIVE_HOOKS_ENABLED", "1")
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_NOTIFY_SOURCE_CAPTURE", &source_capture_path)
            .env(
                "ACORN_NOTIFY_NATIVE_HOOKS_CAPTURE",
                &native_hooks_capture_path,
            );
        let output = command.output().unwrap();
        if let Some(owner_thread_id) = owner_update {
            fs::write(state_dir.join("codex.id"), format!("{owner_thread_id}\n")).unwrap();
        }
        assert!(
            output.status.success(),
            "notify helper failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        (
            fs::read_to_string(capture_path).unwrap_or_default(),
            fs::read_to_string(source_capture_path).unwrap_or_default(),
            fs::read_to_string(native_hooks_capture_path).unwrap_or_default(),
        )
    }

    #[cfg(unix)]
    fn notify_event_for_stdin(script_name: &str, payload: &str) -> Option<String> {
        notify_event_for_input(script_name, &[], payload, None)
    }

    #[cfg(unix)]
    fn notify_event_for_args_with_owner(
        script_name: &str,
        args: &[&str],
        marker_name: &str,
        owner_id: Option<&str>,
    ) -> Option<String> {
        notify_event_for_input(
            script_name,
            args,
            "",
            owner_id.map(|owner_id| (marker_name, owner_id)),
        )
    }

    #[cfg(unix)]
    fn notify_source_for_args_with_owner(
        script_name: &str,
        args: &[&str],
        marker_name: &str,
        owner_id: Option<&str>,
    ) -> Option<String> {
        notify_payload_for_input(
            script_name,
            args,
            "",
            owner_id.map(|owner_id| (marker_name, owner_id)),
        )?
        .get("source")?
        .as_str()
        .map(str::to_string)
    }

    #[cfg(unix)]
    fn notify_event_for_input(
        script_name: &str,
        args: &[&str],
        payload: &str,
        owner_marker: Option<(&str, &str)>,
    ) -> Option<String> {
        notify_payload_for_input(script_name, args, payload, owner_marker)?
            .get("event")?
            .as_str()
            .map(str::to_string)
    }

    #[cfg(unix)]
    fn notify_payload_for_input(
        script_name: &str,
        args: &[&str],
        payload: &str,
        owner_marker: Option<(&str, &str)>,
    ) -> Option<serde_json::Value> {
        notify_payload_for_input_with_invocation(
            script_name,
            args,
            payload,
            owner_marker,
            Some(("owner-invocation", "1")),
        )
    }

    #[cfg(unix)]
    fn notify_payload_for_input_with_invocation(
        script_name: &str,
        args: &[&str],
        payload: &str,
        owner_marker: Option<(&str, &str)>,
        invocation: Option<(&str, &str)>,
    ) -> Option<serde_json::Value> {
        use std::io::Write as _;

        let base = ScratchDir::new("stdin-notify-event");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let fake_bin = base.path().join("fake-bin");
        let state_dir = base.path().join("agent-state");
        fs::create_dir_all(&fake_bin).unwrap();
        fs::create_dir_all(&state_dir).unwrap();

        if let Some((marker_name, owner_id)) = owner_marker {
            fs::write(state_dir.join(marker_name), format!("{owner_id}\n")).unwrap();
        }

        let capture_path = base.path().join("curl.log");
        write_executable(
            &fake_bin.join("curl"),
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then
    shift
    printf '%s\n' "$1" > "$ACORN_NOTIFY_CAPTURE"
    exit 0
  fi
  if [ "$1" = "--data-binary" ]; then
    shift
    [ "${1-}" = "@-" ] || exit 1
    cat > "$ACORN_NOTIFY_CAPTURE"
    exit 0
  fi
  shift
done
exit 1
"#,
        )
        .unwrap();

        let mut command = Command::new(wrapper_dir.join(script_name));
        command
            .args(args)
            .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_CODEX_LIFECYCLE_ID", "lifecycle-1")
            .env("ACORN_CODEX_VERSION", "0.144.4")
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        if let Some((token, depth)) = invocation {
            command
                .env("ACORN_AGENT_INVOCATION_TOKEN", token)
                .env("ACORN_AGENT_INVOCATION_DEPTH", depth);
        }
        let mut child = command.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "notify helper failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let body = fs::read_to_string(capture_path).ok()?;
        serde_json::from_str::<serde_json::Value>(&body).ok()
    }

    #[cfg(unix)]
    fn antigravity_wrapper_notifications_for_turn(
        planner_with_tools: &str,
        final_planner: &str,
    ) -> (String, bool) {
        const OWNER_ID: &str = "019e4818-7c15-4e60-9b3b-898a1c7803d6";

        let base = ScratchDir::new("antigravity-turn");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let state_dir = base.path().join("agent-state");
        let gemini_dir = base.path().join("gemini");
        let transcript = gemini_dir
            .join("antigravity-cli")
            .join("brain")
            .join(OWNER_ID)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&state_dir).unwrap();
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        fs::write(state_dir.join("antigravity.id"), format!("{OWNER_ID}\n")).unwrap();

        let capture_path = base.path().join("notifications.log");
        let tail_pid_path = base.path().join("tail.pid");
        let real_tail = install_tail_probe(&real_dir);
        write_executable(
            &wrapper_dir.join(ANTIGRAVITY_NOTIFY_NAME),
            "#!/bin/sh\nprintf '%s %s\\n' \"$1\" \"$2\" >> \"$ACORN_NOTIFY_CAPTURE\"\n",
        )
        .unwrap();
        write_executable(
            &real_dir.join("agy"),
            r#"#!/bin/sh
: > "$ACORN_TEST_AGY_TRANSCRIPT"
_acorn_i=0
while [ ! -s "$ACORN_TEST_TAIL_PID" ] && [ "$_acorn_i" -lt 100 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.05
done
[ -s "$ACORN_TEST_TAIL_PID" ] || exit 1
printf '%s\n' "$ACORN_TEST_AGY_USER_LINE" >> "$ACORN_TEST_AGY_TRANSCRIPT"
printf '%s\n' "$ACORN_TEST_AGY_PLANNER_WITH_TOOLS" >> "$ACORN_TEST_AGY_TRANSCRIPT"
printf '%s\n' "$ACORN_TEST_AGY_FINAL_PLANNER" >> "$ACORN_TEST_AGY_TRANSCRIPT"
_acorn_i=0
while [ "$(wc -l < "$ACORN_NOTIFY_CAPTURE" 2>/dev/null || echo 0)" -lt 3 ] && [ "$_acorn_i" -lt 100 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.05
done
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", real_dir.display());
        let status = Command::new(wrapper_dir.join(ANTIGRAVITY_WRAPPER_NAME))
            .env("PATH", path)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_TEST_AGY_TRANSCRIPT", &transcript)
            .env("ACORN_TEST_REAL_TAIL", real_tail)
            .env("ACORN_TEST_TAIL_PID", &tail_pid_path)
            .env(
                "ACORN_TEST_AGY_USER_LINE",
                r#"{"type":"USER_INPUT","status":"DONE"}"#,
            )
            .env("ACORN_TEST_AGY_PLANNER_WITH_TOOLS", planner_with_tools)
            .env("ACORN_TEST_AGY_FINAL_PLANNER", final_planner)
            .env("GEMINI_DIR", &gemini_dir)
            .env_remove("ANTIGRAVITY_DIR")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "agy wrapper failed with {status}");

        (
            fs::read_to_string(capture_path).unwrap_or_default(),
            tail_process_survived_wrapper(&tail_pid_path),
        )
    }

    #[cfg(unix)]
    fn antigravity_wrapper_notifications_across_owner_rotation() -> (String, bool) {
        const FIRST_ID: &str = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        const SECOND_ID: &str = "019f631f-0bfc-76f1-9c1d-334be74958ca";

        let base = ScratchDir::new("antigravity-owner-rotation");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let state_dir = base.path().join("agent-state");
        let gemini_dir = base.path().join("gemini");
        let transcript_for = |id: &str| {
            gemini_dir
                .join("antigravity-cli")
                .join("brain")
                .join(id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl")
        };
        let first_transcript = transcript_for(FIRST_ID);
        let second_transcript = transcript_for(SECOND_ID);
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&state_dir).unwrap();
        fs::create_dir_all(first_transcript.parent().unwrap()).unwrap();
        fs::create_dir_all(second_transcript.parent().unwrap()).unwrap();
        fs::write(state_dir.join("antigravity.id"), format!("{FIRST_ID}\n")).unwrap();

        let capture_path = base.path().join("notifications.log");
        let tail_pid_path = base.path().join("tail.pid");
        let real_tail = install_tail_probe(&real_dir);
        write_executable(
            &wrapper_dir.join(ANTIGRAVITY_NOTIFY_NAME),
            "#!/bin/sh\nprintf '%s %s\\n' \"$1\" \"$2\" >> \"$ACORN_NOTIFY_CAPTURE\"\n",
        )
        .unwrap();
        write_executable(
            &real_dir.join("agy"),
            r#"#!/bin/sh
: > "$ACORN_TEST_AGY_FIRST_TRANSCRIPT"
: > "$ACORN_TEST_AGY_SECOND_TRANSCRIPT"
_acorn_i=0
while [ ! -s "$ACORN_TEST_TAIL_PID" ] && [ "$_acorn_i" -lt 100 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.05
done
[ -s "$ACORN_TEST_TAIL_PID" ] || exit 1

# The second brain is newer and active, but it is not this Acorn session's
# owner yet. Its completion must not leak into the first owner's status.
printf '%s\n' '{"type":"PLANNER_RESPONSE","status":"DONE","content":"decoy"}' >> "$ACORN_TEST_AGY_SECOND_TRANSCRIPT"
printf '%s\n' '{"type":"USER_INPUT","status":"DONE"}' >> "$ACORN_TEST_AGY_FIRST_TRANSCRIPT"
printf '%s\n' '{"type":"PLANNER_RESPONSE","status":"DONE","content":"first"}' >> "$ACORN_TEST_AGY_FIRST_TRANSCRIPT"

_acorn_i=0
while [ "$(wc -l < "$ACORN_NOTIFY_CAPTURE" 2>/dev/null || echo 0)" -lt 2 ] && [ "$_acorn_i" -lt 40 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.05
done

# Clear the pre-binding decoy before making the second conversation the owner.
# A watcher that incorrectly selected host-wide newest already emitted it;
# the owner-bound watcher has never attached to this file.
: > "$ACORN_TEST_AGY_SECOND_TRANSCRIPT"
printf '%s\n' "$ACORN_TEST_AGY_SECOND_ID" > "$ACORN_AGENT_STATE_DIR/antigravity.id"
sleep 0.7
printf '%s\n' '{"type":"USER_INPUT","status":"DONE"}' >> "$ACORN_TEST_AGY_SECOND_TRANSCRIPT"
printf '%s\n' '{"type":"PLANNER_RESPONSE","status":"DONE","content":"second"}' >> "$ACORN_TEST_AGY_SECOND_TRANSCRIPT"

_acorn_i=0
while [ "$(wc -l < "$ACORN_NOTIFY_CAPTURE" 2>/dev/null || echo 0)" -lt 4 ] && [ "$_acorn_i" -lt 40 ]; do
  _acorn_i=$((_acorn_i + 1))
  sleep 0.05
done
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", real_dir.display());
        let status = Command::new(wrapper_dir.join(ANTIGRAVITY_WRAPPER_NAME))
            .env("PATH", path)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_AGENT_STATE_DIR", &state_dir)
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_TEST_AGY_FIRST_TRANSCRIPT", &first_transcript)
            .env("ACORN_TEST_AGY_SECOND_TRANSCRIPT", &second_transcript)
            .env("ACORN_TEST_AGY_SECOND_ID", SECOND_ID)
            .env("ACORN_TEST_REAL_TAIL", real_tail)
            .env("ACORN_TEST_TAIL_PID", &tail_pid_path)
            .env("GEMINI_DIR", &gemini_dir)
            .env_remove("ANTIGRAVITY_DIR")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "agy wrapper failed with {status}");

        (
            fs::read_to_string(capture_path).unwrap_or_default(),
            tail_process_survived_wrapper(&tail_pid_path),
        )
    }

    #[cfg(unix)]
    fn codex_wrapper_args_for_version(version: &str, probe_fails: bool) -> Vec<String> {
        let base = ScratchDir::new("codex-native-capability");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let capture_path = base.path().join("args.log");
        let session_log_path = base.path().join("session.jsonl");
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli %s\n' "$ACORN_TEST_CODEX_VERSION"
  exit 0
fi
for _acorn_arg in "$@"; do
  if [ "$_acorn_arg" = "features" ]; then
    [ "$ACORN_TEST_CODEX_PROBE_FAIL" = "1" ] && exit 1
    exit 0
  fi
done
printf '%s\n' "$@" > "$ACORN_ARGS_CAPTURE"
"#,
        )
        .unwrap();

        let status = Command::new(wrapper_dir.join(CODEX_WRAPPER_NAME))
            .arg("sentinel-user-arg")
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_TEST_CODEX_VERSION", version)
            .env(
                "ACORN_TEST_CODEX_PROBE_FAIL",
                if probe_fails { "1" } else { "0" },
            )
            .env("ACORN_ARGS_CAPTURE", &capture_path)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        fs::read_to_string(capture_path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_gates_native_hooks_by_version_and_capability() {
        let supported = codex_wrapper_args_for_version("0.144.4", false);
        assert!(supported.iter().any(|arg| arg == "--enable"));
        assert!(supported.iter().any(|arg| arg == "hooks"));
        assert!(supported.iter().any(|arg| arg.starts_with("hooks={")));
        assert!(supported.iter().any(|arg| arg == "sentinel-user-arg"));

        for (version, probe_fails) in [("0.134.9", false), ("0.144.4", true)] {
            let fallback = codex_wrapper_args_for_version(version, probe_fails);
            assert!(fallback.iter().any(|arg| arg.starts_with("notify=")));
            assert!(!fallback.iter().any(|arg| arg == "--enable"));
            assert!(!fallback.iter().any(|arg| arg.starts_with("hooks={")));
            assert!(fallback.iter().any(|arg| arg == "sentinel-user-arg"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_native_hook_version_gate_covers_the_supported_boundary() {
        for version in ["0.135.0", "1.0.0"] {
            assert!(codex_wrapper_args_for_version(version, false)
                .iter()
                .any(|arg| arg == "--enable"));
        }
        for version in ["0.134.99", "unknown"] {
            assert!(!codex_wrapper_args_for_version(version, false)
                .iter()
                .any(|arg| arg == "--enable"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn nested_codex_clears_the_outer_integration_environment() {
        let base = ScratchDir::new("nested-codex-recorder");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();
        write_executable(
            &real_dir.join("codex"),
            "#!/bin/sh\nprintf 'record=%s\\nlog=%s\\nnative_hooks=%s\\n' \"${CODEX_TUI_RECORD_SESSION-}\" \"${CODEX_TUI_SESSION_LOG_PATH-}\" \"${ACORN_CODEX_NATIVE_HOOKS_ENABLED-}\"\n",
        )
        .unwrap();

        let output = Command::new(wrapper_dir.join(CODEX_WRAPPER_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_TOKEN", "outer-owner")
            .env("ACORN_AGENT_INVOCATION_DEPTH", "1")
            .env("CODEX_TUI_RECORD_SESSION", "1")
            .env("CODEX_TUI_SESSION_LOG_PATH", "/tmp/outer-codex.jsonl")
            .env("ACORN_CODEX_NATIVE_HOOKS_ENABLED", "1")
            .env_remove("ACORN_AGENT_INVOCATION_ROOT")
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            "record=\nlog=\nnative_hooks=\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_keeps_owned_recording_artifacts_private_and_cleans_them() {
        use std::os::unix::fs::PermissionsExt as _;

        let base = ScratchDir::new("codex-recording-permissions");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let shared_tmp = base.path().join("shared-tmp");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&shared_tmp).unwrap();
        fs::set_permissions(&shared_tmp, fs::Permissions::from_mode(0o755)).unwrap();

        let log_path_capture = base.path().join("log-path");
        let release_path = base.path().join("release-codex");
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
: > "$CODEX_TUI_SESSION_LOG_PATH"
printf '%s\n' "$CODEX_TUI_SESSION_LOG_PATH" > "$ACORN_LOG_PATH_CAPTURE"
while [ ! -e "$ACORN_TEST_RELEASE" ]; do
  sleep 0.02
done
"#,
        )
        .unwrap();

        let mut child = Command::new("/bin/sh")
            .args(["-c", "umask 022; exec \"$1\" sentinel", "sh"])
            .arg(wrapper_dir.join(CODEX_WRAPPER_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("TMPDIR", &shared_tmp)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_LOG_PATH_CAPTURE", &log_path_capture)
            .env("ACORN_TEST_RELEASE", &release_path)
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .env_remove("CODEX_TUI_SESSION_LOG_PATH")
            .env_remove("CODEX_TUI_RECORD_SESSION")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let started = Instant::now();
        while !log_path_capture.is_file() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("Codex wrapper exited before publishing its recorder path: {status}");
            }
            if started.elapsed() > Duration::from_secs(10) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Codex wrapper did not publish its recorder path");
            }
            thread::sleep(Duration::from_millis(20));
        }

        let session_log = PathBuf::from(fs::read_to_string(&log_path_capture).unwrap().trim());
        let runtime_dir = session_log
            .parent()
            .expect("recorder has parent")
            .to_path_buf();
        let log_mode = fs::metadata(&session_log).unwrap().permissions().mode() & 0o777;
        let dir_mode = fs::metadata(&runtime_dir).unwrap().permissions().mode() & 0o777;

        assert_ne!(
            runtime_dir, shared_tmp,
            "recorder must not live in shared temp"
        );
        assert_eq!(dir_mode, 0o700, "recorder directory must be private");
        assert_eq!(log_mode, 0o600, "session JSONL must be owner-only");

        fs::write(&release_path, b"release").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(
            !runtime_dir.exists(),
            "owned recorder directory must be removed after Codex exits"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_clears_owned_recorder_when_fifo_setup_fails() {
        let base = ScratchDir::new("codex-recorder-fifo-failure");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let shared_tmp = base.path().join("shared-tmp");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&shared_tmp).unwrap();

        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
printf 'record=%s\nlog=%s\n' "${CODEX_TUI_RECORD_SESSION-}" "${CODEX_TUI_SESSION_LOG_PATH-}"
"#,
        )
        .unwrap();
        write_executable(&real_dir.join("mkfifo"), "#!/bin/sh\nexit 1\n").unwrap();

        let output = Command::new(wrapper_dir.join(CODEX_WRAPPER_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("TMPDIR", &shared_tmp)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .env_remove("CODEX_TUI_SESSION_LOG_PATH")
            .env_remove("CODEX_TUI_RECORD_SESSION")
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "record=\nlog=\n");
        assert!(fs::read_dir(&shared_tmp).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_cleans_runtime_dir_when_watcher_init_fails() {
        let base = ScratchDir::new("codex-watcher-init-failure");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let shared_tmp = base.path().join("shared-tmp");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&shared_tmp).unwrap();

        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
/bin/sleep 0.3
"#,
        )
        .unwrap();
        write_executable(&real_dir.join("mkdir"), "#!/bin/sh\nexit 1\n").unwrap();

        let status = Command::new(wrapper_dir.join(CODEX_WRAPPER_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", real_dir.display()))
            .env("TMPDIR", &shared_tmp)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env_remove("ACORN_AGENT_INVOCATION_TOKEN")
            .env_remove("ACORN_AGENT_INVOCATION_DEPTH")
            .env_remove("CODEX_TUI_SESSION_LOG_PATH")
            .env_remove("CODEX_TUI_RECORD_SESSION")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        assert!(status.success());
        assert!(
            fs::read_dir(&shared_tmp).unwrap().next().is_none(),
            "watcher initialization failure leaked its private runtime directory"
        );
    }

    #[test]
    fn writes_codex_wrapper_and_notify_helper() {
        let base = ScratchDir::new("codex");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("codex")).unwrap();
        assert!(wrapper.contains("_acorn_wrapper_dir=\"${ACORN_AGENT_WRAPPER_DIR-}\""));
        assert!(wrapper.contains("_acorn_wrapper_dir=${0%/*}"));
        assert!(wrapper.contains("--enable hooks"));
        assert!(!wrapper.contains("--enable codex_hooks"));
        assert!(wrapper.contains("UserPromptSubmit"));
        assert!(wrapper.contains("PreToolUse"));
        assert!(wrapper.contains("PermissionRequest"));
        assert!(wrapper.contains("PostToolUse"));
        assert!(wrapper.contains("Stop"));
        assert!(wrapper.contains("trusted_hash"));
        assert!(wrapper.contains(
            "post_tool_use:0:0\"={enabled=true,trusted_hash=\"sha256:ecd139e174de9a8d3cd7f9503b359587fade68c65f838bb0cddc785f438909cc\"}"
        ));
        assert!(wrapper.contains("/<session-flags>/config.toml"));
        assert!(!wrapper.contains("SubagentStop"));
        assert!(!wrapper.contains("dangerously-bypass-hook-trust"));
        assert!(wrapper
            .contains("notify=[\\\"bash\\\",\\\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\\\"]"));
        assert!(wrapper.contains("CODEX_TUI_RECORD_SESSION=1"));
        assert!(wrapper
            .contains("export ACORN_CODEX_NATIVE_HOOKS_ENABLED=\"$_acorn_codex_native_hooks\""));
        assert!(wrapper.contains(
            "unset CODEX_TUI_RECORD_SESSION CODEX_TUI_SESSION_LOG_PATH ACORN_CODEX_NATIVE_HOOKS_ENABLED"
        ));
        assert!(wrapper.contains("mktemp -d \"$ACORN_AGENT_WRAPPER_DIR/codex-session.XXXXXX\""));
        assert!(!wrapper.contains("${TMPDIR:-/tmp}/acorn-codex-session"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_URL"));
        assert!(wrapper.contains("\"$_acorn_notify\" \"\" jsonl_user"));
        assert!(wrapper.contains("\"$_acorn_notify\" \"\" jsonl_task"));
        assert!(wrapper.contains("\"$_acorn_notify\" \"\" jsonl_approval"));
        assert!(wrapper.contains("\"$_acorn_notify\" \"\" jsonl_tool"));
        assert!(wrapper.contains("kind\":\"codex_event"));
        assert!(!wrapper.contains("ACORN_CODEX_NATIVE_ACTIVE_FILE"));

        let notify = fs::read_to_string(dir.join("acorn-codex-notify")).unwrap();
        assert!(notify.contains("\"provider\":\"codex\""));
        assert!(notify.contains("source=\"native\""));
        assert!(
            notify.contains("jsonl_user|jsonl_task|jsonl_tool|jsonl_approval|legacy_completion")
        );
        assert!(notify.contains("\"source\":\"%s\""));
        assert!(notify.contains("agent-turn-complete|task_complete|turn_complete"));
        assert!(notify.contains("owner_thread_id"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Provider: codex"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Source: $source"));
        assert!(notify.contains("X-Acorn-Codex-Lifecycle-Id"));
        assert!(notify.contains("X-Acorn-Codex-Native-Hooks-Enabled"));
        assert!(notify.contains("--data-binary @-"));
        assert!(!notify.contains("ACORN_CODEX_NATIVE_ACTIVE_FILE"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_maps_current_tui_user_turn_to_turn_start() {
        let line = r#"{"ts":"2026-07-14T05:31:15.813Z","dir":"from_tui","kind":"op","payload":{"UserTurn":{"items":[{"type":"text","text":"Fix the bug."}]}}}"#;
        let (notifications, tail_alive) = codex_wrapper_notifications_for_tui_line(line);

        assert_eq!(notifications, format!("jsonl_user\t{line}\n"));
        assert!(
            !tail_alive,
            "the transcript tail must exit with the wrapper"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_forwards_fallback_observations_without_shell_arbitration() {
        for (line, source) in [
            (
                r#"{"dir":"to_tui","kind":"codex_event","msg":{"type":"task_started","turn_id":"turn-1"}}"#,
                "jsonl_task",
            ),
            (
                r#"{"dir":"to_tui","kind":"codex_event","msg":{"type":"exec_approval_request","turn_id":"turn-1"}}"#,
                "jsonl_approval",
            ),
            (
                r#"{"dir":"to_tui","kind":"codex_event","msg":{"type":"exec_command_begin","turn_id":"turn-1","call_id":"call-1"}}"#,
                "jsonl_tool",
            ),
        ] {
            let (notifications, _) = codex_wrapper_notifications_for_tui_line(line);
            assert_eq!(notifications, format!("{source}\t{line}\n"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_reports_all_provider_tool_begin_events_as_activity() {
        for event_type in [
            "exec_command_begin",
            "patch_apply_begin",
            "mcp_tool_call_begin",
            "web_search_begin",
        ] {
            let line = format!(
                r#"{{"dir":"to_tui","kind":"codex_event","msg":{{"type":"{event_type}","turn_id":"turn-1","call_id":"call-1"}}}}"#
            );
            let (notifications, _) = codex_wrapper_notifications_for_tui_line(&line);
            assert_eq!(
                notifications,
                format!("jsonl_tool\t{line}\n"),
                "{event_type}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_native_hooks_forward_raw_payloads_for_rust_validation() {
        let turn_id = "019f6338-6250-7303-88a6-a7add31dba1d";
        let owner_fields = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": turn_id,
            "agent_id": null,
            "agent_type": null,
        });

        for hook_event_name in [
            "UserPromptSubmit",
            "PreToolUse",
            "PermissionRequest",
            "PostToolUse",
        ] {
            let mut payload = owner_fields.clone();
            payload["hook_event_name"] = hook_event_name.into();
            let posted =
                notify_payload_for_input(CODEX_NOTIFY_NAME, &[], &payload.to_string(), None)
                    .unwrap_or_else(|| panic!("{hook_event_name} did not post"));
            assert_eq!(posted["turn_id"], turn_id, "{hook_event_name}");
            assert_eq!(posted["hook_event_name"], hook_event_name);
            assert!(posted["agent_id"].is_null());
            assert!(posted["agent_type"].is_null());
        }

        let stop = serde_json::json!({
            "session_id": "019f6338-6021-77d0-9120-54428d3e2a42",
            "turn_id": turn_id,
            "hook_event_name": "Stop",
        });
        let posted = notify_payload_for_input(CODEX_NOTIFY_NAME, &[], &stop.to_string(), None)
            .expect("main Stop posts");
        assert_eq!(posted["hook_event_name"], "Stop");
        assert_eq!(posted["turn_id"], turn_id);

        let mut child = owner_fields;
        child["hook_event_name"] = "PermissionRequest".into();
        child["agent_id"] = "019f6322-41e5-7882-a99a-d186dff6739c".into();
        child["agent_type"] = "worker".into();
        let posted = notify_payload_for_input(CODEX_NOTIFY_NAME, &[], &child.to_string(), None)
            .expect("raw child payload reaches the Rust ownership validator");
        assert_eq!(posted["agent_type"], "worker");
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_ignores_nested_thread_completion() {
        let payload = r#"{"type":"agent-turn-complete","thread-id":"019f6322-41e5-7882-a99a-d186dff6739c","turn-id":"turn-1"}"#;

        assert_eq!(
            codex_notify_post_for_payload(payload, Some("019f631f-0bfc-76f1-9c1d-334be74958ca"),),
            "",
            "a child thread must not mark its parent Acorn session as waiting"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_accepts_owner_thread_completion() {
        let owner = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let decoy = "019f6322-41e5-7882-a99a-d186dff6739c";
        let payload = format!(
            r#"{{"type":"agent-turn-complete","thread-id":"{owner}","turn-id":"turn-1","input-messages":["literal \"thread-id\":\"{decoy}\""]}}"#
        );

        let post = codex_notify_post_for_payload(&payload, Some(owner));
        assert_eq!(
            post, payload,
            "the owner completion must reach Rust with its exact turn identity"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_forwards_scalar_legacy_completions_with_raw_source() {
        for event_type in ["task_complete", "turn_complete"] {
            let payload = format!(r#"{{"type":"{event_type}","turn_id":"turn-1"}}"#);
            let (post, source, native_hooks_enabled) =
                codex_notify_post_transport_metadata(&payload, None);

            assert_eq!(post, payload, "{event_type} must retain its turn identity");
            assert_eq!(source, "legacy_completion", "{event_type}");
            assert_eq!(native_hooks_enabled, "1", "{event_type}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_scalar_completion_checks_thread_identity_when_present() {
        let owner = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let child = "019f6322-41e5-7882-a99a-d186dff6739c";
        let payload =
            format!(r#"{{"type":"task_complete","thread_id":"{child}","turn_id":"turn-1"}}"#);

        assert_eq!(
            codex_notify_post_for_payload(&payload, Some(owner)),
            "",
            "a scalar child completion must not transition its parent session"
        );
    }

    #[cfg(unix)]
    #[test]
    fn tokenless_codex_scalar_completion_requires_bound_thread_identity() {
        let owner = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let unscoped = r#"{"type":"turn_complete","turn_id":"turn-1"}"#;
        assert_eq!(
            notify_payload_for_input_with_invocation(
                CODEX_NOTIFY_NAME,
                &[unscoped],
                "",
                Some(("codex.id", owner)),
                None,
            ),
            None,
            "a tokenless scalar completion without owner identity must fail closed"
        );

        let scoped =
            format!(r#"{{"type":"turn_complete","thread_id":"{owner}","turn_id":"turn-1"}}"#);
        let posted = notify_payload_for_input_with_invocation(
            CODEX_NOTIFY_NAME,
            &[&scoped],
            "",
            Some(("codex.id", owner)),
            None,
        )
        .expect("a matching tokenless owner completion is safe to forward");
        assert_eq!(posted["type"], "turn_complete");
        assert_eq!(posted["turn_id"], "turn-1");
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_drops_completion_when_owner_binding_is_delayed() {
        let owner = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let stale = "019f6322-41e5-7882-a99a-d186dff6739c";
        let payload =
            format!(r#"{{"type":"agent-turn-complete","thread-id":"{owner}","turn-id":"turn-1"}}"#);

        let post =
            codex_notify_post_for_payload_with_owner_update(&payload, Some(stale), Some(owner));
        assert_eq!(
            post, "",
            "a delayed completion could overwrite a newer turn start and must fail closed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_ignores_completion_without_owner_binding() {
        let payload = r#"{"type":"agent-turn-complete","thread-id":"019f631f-0bfc-76f1-9c1d-334be74958ca","turn-id":"turn-1"}"#;

        assert_eq!(
            codex_notify_post_for_payload(payload, None),
            "",
            "completion must fail closed until Acorn knows the session owner"
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_keeps_explicit_needs_input_without_owner_binding() {
        let posted = notify_payload_for_input(CODEX_NOTIFY_NAME, &["needs_input"], "", None)
            .expect("an explicit legacy attention event posts without a native boundary");

        assert_eq!(posted["event"], "needs_input");
        assert_eq!(posted["source"], "hook");
        let preview = notify_payload_for_input(CODEX_NOTIFY_NAME, &["start", "turn"], "", None)
            .expect("a surviving watcher start remains a compatibility preview");
        assert_eq!(preview["event"], "start");
        assert_eq!(preview["source"], "turn");
    }

    #[cfg(unix)]
    #[test]
    fn top_level_wrappers_create_one_provider_independent_invocation_owner() {
        for provider in [
            CODEX_WRAPPER_NAME,
            CLAUDE_WRAPPER_NAME,
            ANTIGRAVITY_WRAPPER_NAME,
        ] {
            let output = run_hooked_wrapper_for_invocation_ownership(
                provider,
                WrapperInvocationContext::Root,
            );
            assert!(
                output.status.success(),
                "{provider} wrapper failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                stdout.contains("invocation_depth=1\n"),
                "{provider} did not mark its top-level invocation: {stdout}"
            );
            let token = stdout
                .lines()
                .find_map(|line| line.strip_prefix("invocation_token="))
                .unwrap_or_default();
            assert!(
                !token.is_empty(),
                "{provider} did not create an invocation token: {stdout}"
            );
            assert_eq!(
                stdout.matches("invocation_token=").count(),
                1,
                "{provider} must expose exactly one invocation owner: {stdout}"
            );
            assert!(
                stdout.contains("invocation_root=\n"),
                "{provider} leaked the one-shot PTY root marker: {stdout}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn nested_wrappers_disable_outer_acorn_hook_attribution_across_providers() {
        for provider in [
            CODEX_WRAPPER_NAME,
            CLAUDE_WRAPPER_NAME,
            ANTIGRAVITY_WRAPPER_NAME,
        ] {
            let output = run_hooked_wrapper_for_invocation_ownership(
                provider,
                WrapperInvocationContext::Nested,
            );
            assert!(
                output.status.success(),
                "nested {provider} wrapper failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(stdout.contains("hook_session=\n"), "{provider}: {stdout}");
            assert!(stdout.contains("hook_url=\n"), "{provider}: {stdout}");
            assert!(stdout.contains("hook_token=\n"), "{provider}: {stdout}");
            assert!(
                stdout.contains("invocation_token=outer-invocation\n"),
                "{provider} replaced the first wrapper's owner token: {stdout}"
            );
            assert!(
                stdout.contains("invocation_depth=2\n"),
                "{provider} did not mark itself nested: {stdout}"
            );
            assert!(
                !stdout.contains("arg=--settings\n") && !stdout.contains("arg=--enable\n"),
                "nested {provider} installed Acorn hooks: {stdout}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn fresh_pty_root_replaces_an_inherited_invocation_owner() {
        for provider in [
            CODEX_WRAPPER_NAME,
            CLAUDE_WRAPPER_NAME,
            ANTIGRAVITY_WRAPPER_NAME,
        ] {
            let output = run_hooked_wrapper_for_invocation_ownership(
                provider,
                WrapperInvocationContext::RootWithInheritedOwner,
            );
            assert!(
                output.status.success(),
                "{provider} wrapper failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                stdout.contains("hook_session=session-1\n"),
                "{provider}: {stdout}"
            );
            assert!(
                stdout.contains("invocation_depth=1\n"),
                "{provider}: {stdout}"
            );
            assert!(
                !stdout.contains("invocation_token=inherited-invocation\n"),
                "{provider} reused an ancestor's owner token: {stdout}",
            );
            assert!(
                stdout.contains("arg=--enable\n")
                    || stdout.contains("arg=--settings\n")
                    || provider == ANTIGRAVITY_WRAPPER_NAME,
                "fresh {provider} root did not install its Acorn integration: {stdout}",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn wrappers_treat_tokenless_hook_env_as_a_legacy_owner_child() {
        for provider in [
            CODEX_WRAPPER_NAME,
            CLAUDE_WRAPPER_NAME,
            ANTIGRAVITY_WRAPPER_NAME,
        ] {
            let output = run_hooked_wrapper_for_invocation_ownership(
                provider,
                WrapperInvocationContext::LegacyInherited,
            );
            assert!(
                output.status.success(),
                "legacy nested {provider} wrapper failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(stdout.contains("hook_session=\n"), "{provider}: {stdout}");
            assert!(stdout.contains("hook_url=\n"), "{provider}: {stdout}");
            assert!(stdout.contains("hook_token=\n"), "{provider}: {stdout}");
            assert!(
                stdout.contains("invocation_token=\n")
                    && stdout.contains("invocation_depth=\n")
                    && stdout.contains("invocation_root=\n"),
                "{provider} promoted a child of a pre-update owner: {stdout}"
            );
            assert!(
                !stdout.contains("arg=--settings\n") && !stdout.contains("arg=--enable\n"),
                "legacy nested {provider} installed Acorn hooks: {stdout}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn notify_helpers_accept_only_the_top_level_invocation_owner() {
        let cases = [
            (CODEX_NOTIFY_NAME, vec!["needs_input"], ""),
            (
                CLAUDE_NOTIFY_NAME,
                vec![],
                r#"{"hook_event_name":"PermissionRequest"}"#,
            ),
            (
                ANTIGRAVITY_NOTIFY_NAME,
                vec![],
                r#"{"hookEventName":"PermissionRequest"}"#,
            ),
        ];

        for (script, args, payload) in cases {
            assert_eq!(
                notify_payload_for_input_with_invocation(script, &args, payload, None, None),
                None,
                "{script} accepted a hook without wrapper ownership",
            );
            assert_eq!(
                notify_payload_for_input_with_invocation(
                    script,
                    &args,
                    payload,
                    None,
                    Some(("outer-invocation", "2")),
                ),
                None,
                "{script} accepted a nested invocation hook",
            );
            assert!(
                notify_payload_for_input_with_invocation(
                    script,
                    &args,
                    payload,
                    None,
                    Some(("owner-invocation", "1")),
                )
                .is_some(),
                "{script} rejected its top-level invocation hook",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn tokenless_pre_update_helpers_require_the_bound_provider_owner_id() {
        let owner = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        let other = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let codex_completion =
            format!(r#"{{"type":"agent-turn-complete","thread-id":"{owner}","turn-id":"turn-1"}}"#);
        let claude_stop = format!(
            r#"{{"hook_event_name":"Stop","session_id":"{owner}","background_tasks":[],"session_crons":[]}}"#
        );
        let antigravity_stop =
            format!(r#"{{"hookEventName":"Stop","conversationId":"{owner}","fullyIdle":true}}"#);

        for (script, args, payload, marker_name) in [
            (
                CODEX_NOTIFY_NAME,
                vec![codex_completion.as_str()],
                "",
                "codex.id",
            ),
            (
                CLAUDE_NOTIFY_NAME,
                vec![],
                claude_stop.as_str(),
                "claude.id",
            ),
            (
                ANTIGRAVITY_NOTIFY_NAME,
                vec![],
                antigravity_stop.as_str(),
                "antigravity.id",
            ),
            (
                ANTIGRAVITY_NOTIFY_NAME,
                vec!["needs_input", owner],
                "",
                "antigravity.id",
            ),
        ] {
            assert!(
                notify_payload_for_input_with_invocation(
                    script,
                    &args,
                    payload,
                    Some((marker_name, owner)),
                    None,
                )
                .is_some(),
                "{script} rejected a surviving pre-update owner hook",
            );
            assert_eq!(
                notify_payload_for_input_with_invocation(
                    script,
                    &args,
                    payload,
                    Some((marker_name, other)),
                    None,
                ),
                None,
                "{script} accepted a tokenless hook from a non-owner",
            );
            assert_eq!(
                notify_payload_for_input_with_invocation(script, &args, payload, None, None),
                None,
                "{script} accepted a tokenless hook without an owner marker",
            );
        }

        assert_eq!(
            notify_payload_for_input_with_invocation(
                CODEX_NOTIFY_NAME,
                &["start", "turn"],
                "",
                Some(("codex.id", owner)),
                None,
            ),
            None,
            "a tokenless Codex watcher start has no thread id and must fail closed",
        );
        assert_eq!(
            notify_payload_for_input_with_invocation(
                CLAUDE_NOTIFY_NAME,
                &[],
                r#"{"hook_event_name":"PermissionRequest"}"#,
                Some(("claude.id", owner)),
                None,
            ),
            None,
            "a tokenless Claude hook without session_id must fail closed",
        );
        assert_eq!(
            notify_payload_for_input_with_invocation(
                ANTIGRAVITY_NOTIFY_NAME,
                &[],
                r#"{"hookEventName":"PermissionRequest"}"#,
                Some(("antigravity.id", owner)),
                None,
            ),
            None,
            "a tokenless Antigravity hook without conversationId must fail closed",
        );
    }

    #[cfg(unix)]
    #[test]
    fn watcher_processes_exit_when_their_wrapper_is_terminated_directly() {
        let outcomes = [CODEX_WRAPPER_NAME, ANTIGRAVITY_WRAPPER_NAME].map(|provider| {
            (
                provider,
                wrapper_watcher_survives_direct_termination(provider),
            )
        });
        assert_eq!(
            outcomes,
            [
                (CODEX_WRAPPER_NAME, (false, false)),
                (ANTIGRAVITY_WRAPPER_NAME, (false, false)),
            ],
            "direct wrapper termination must not orphan a watcher or tail",
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_parent_guard_does_not_spawn_polling_sleep_processes() {
        assert_eq!(
            codex_parent_guard_short_sleep_count(),
            0,
            "the parent-liveness guard must block on a lifetime signal instead of polling",
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_uses_and_cleans_up_a_private_session_log() {
        let base = ScratchDir::new("codex-private-log");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        let public_tmp = base.path().join("public-tmp");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&public_tmp).unwrap();
        let capture = base.path().join("capture.txt");
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli 0.144.4\n'
  exit 0
fi
for _acorn_arg in "$@"; do
  [ "$_acorn_arg" = "features" ] && exit 0
done
_acorn_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}
printf '%s\n' "$CODEX_TUI_SESSION_LOG_PATH" > "$ACORN_TEST_CAPTURE"
_acorn_mode "$CODEX_TUI_SESSION_LOG_PATH" >> "$ACORN_TEST_CAPTURE"
_acorn_mode "${CODEX_TUI_SESSION_LOG_PATH%/*}" >> "$ACORN_TEST_CAPTURE"
printf '{}\n' >> "$CODEX_TUI_SESSION_LOG_PATH"
"#,
        )
        .unwrap();

        let path = format!(
            "{}:{}:/usr/bin:/bin",
            wrapper_dir.display(),
            real_dir.display()
        );
        let output = Command::new(wrapper_dir.join("codex"))
            .env("PATH", path)
            .env("TMPDIR", &public_tmp)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:9/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "test-token")
            .env("ACORN_AGENT_INVOCATION_ROOT", "1")
            .env("ACORN_TEST_CAPTURE", &capture)
            .env_remove("CODEX_TUI_SESSION_LOG_PATH")
            .output()
            .expect("run Codex wrapper");

        assert!(
            output.status.success(),
            "wrapper failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let captured = fs::read_to_string(&capture).expect("read capture");
        let mut lines = captured.lines();
        let log_path = PathBuf::from(lines.next().expect("captured log path"));
        assert!(log_path.starts_with(&wrapper_dir));
        assert!(!log_path.starts_with(&public_tmp));
        assert_eq!(lines.next(), Some("600"));
        assert_eq!(lines.next(), Some("700"));
        assert!(!log_path.exists(), "generated log should be removed");
        assert!(
            !log_path.parent().expect("log parent").exists(),
            "generated private directory should be removed"
        );
    }

    #[test]
    fn wrappers_skip_their_own_dir_when_wrapper_env_is_absent() {
        let base = ScratchDir::new("self-skip");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        for name in ["claude", "codex", "agy"] {
            write_executable(
                &real_dir.join(name),
                &format!("#!/bin/sh\nprintf 'real-{name}:%s\\n' \"$1\"\n"),
            )
            .unwrap();

            let path = format!("{}:{}", wrapper_dir.display(), real_dir.display());
            let output = run_wrapper_with_timeout(name, &path, None)
                .unwrap_or_else(|err| panic!("{name} wrapper failed to find real binary: {err}"));
            assert!(
                output.status.success(),
                "{name} wrapper exited unsuccessfully: stderr={}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                format!("real-{name}:sentinel\n")
            );
        }
    }

    #[test]
    fn wrappers_still_skip_env_wrapper_dir_when_present() {
        let base = ScratchDir::new("env-skip");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        for name in ["claude", "codex", "agy"] {
            write_executable(
                &real_dir.join(name),
                &format!("#!/bin/sh\nprintf 'real-{name}:%s\\n' \"$1\"\n"),
            )
            .unwrap();

            let path = format!("{}:{}", wrapper_dir.display(), real_dir.display());
            let output =
                run_wrapper_with_timeout(name, &path, Some(&wrapper_dir)).unwrap_or_else(|err| {
                    panic!("{name} wrapper failed with ACORN_AGENT_WRAPPER_DIR set: {err}")
                });
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8_lossy(&output.stdout),
                format!("real-{name}:sentinel\n")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn wrapper_files_are_executable() {
        let base = ScratchDir::new("mode");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        for name in [
            "codex",
            "claude",
            "agy",
            "acorn-codex-notify",
            "acorn-claude-notify",
            "acorn-antigravity-notify",
        ] {
            let mode = fs::metadata(dir.join(name)).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "{name} not executable");
        }
    }

    #[test]
    fn writes_claude_wrapper_notify_and_settings() {
        let base = ScratchDir::new("claude");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("claude")).unwrap();
        assert!(wrapper.contains("_acorn_wrapper_dir=\"${ACORN_AGENT_WRAPPER_DIR-}\""));
        assert!(wrapper.contains("_acorn_wrapper_dir=${0%/*}"));
        assert!(wrapper.contains("_acorn_find_real_binary claude"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_URL"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_TOKEN"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_SESSION_ID"));
        assert!(
            wrapper.contains("--settings \"$ACORN_AGENT_WRAPPER_DIR/acorn-claude-settings.json\"")
        );
        assert!(wrapper.contains("exec \"$REAL_BIN\" \"$@\""));

        let notify = fs::read_to_string(dir.join("acorn-claude-notify")).unwrap();
        assert!(notify.contains("X-Acorn-Agent-Hook-Provider: claude"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Session-Id: $ACORN_AGENT_HOOK_SESSION_ID"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Source: native"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("--data-binary @-"));
        // The notify helper is transport-only; classification belongs to the
        // structured Rust adapter.
        assert!(!notify.contains("hook_event_name"));
        assert!(!notify.contains("agent_id"));
        assert!(!notify.contains("background_tasks"));

        let settings = fs::read_to_string(dir.join("acorn-claude-settings.json")).unwrap();
        let notify_path = dir.join("acorn-claude-notify").display().to_string();
        assert!(settings.contains("\"SessionStart\""));
        assert!(settings.contains("\"UserPromptSubmit\""));
        assert!(!settings.contains("\"PostToolUse\""));
        assert!(!settings.contains("\"PostToolUseFailure\""));
        assert!(settings.contains("\"Stop\""));
        assert!(!settings.contains("\"SubagentStop\""));
        assert!(settings.contains("\"Notification\""));
        assert!(settings
            .contains("\"matcher\":\"permission_prompt|elicitation_dialog|agent_needs_input\""));
        assert!(settings.contains("\"PermissionRequest\""));
        assert!(
            settings.contains(&format!(
                "\"command\":\"{}\"",
                json_escape(&format!("bash {}", shell_quote_for_test(&notify_path)))
            )),
            "settings missing absolute notify command: {settings}"
        );
    }

    #[test]
    fn claude_settings_shell_quotes_notify_command_with_spaces() {
        let base = ScratchDir::new("claude space");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let settings = fs::read_to_string(dir.join("acorn-claude-settings.json")).unwrap();
        let notify_path = dir.join("acorn-claude-notify").display().to_string();
        assert!(
            settings.contains(&format!(
                "\"command\":\"{}\"",
                json_escape(&format!("bash {}", shell_quote_for_test(&notify_path)))
            )),
            "settings must shell-quote the notify command path: {settings}"
        );
    }

    #[test]
    fn claude_wrapper_does_not_mutate_user_config() {
        let base = ScratchDir::new("safety");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("claude")).unwrap();
        let notify = fs::read_to_string(dir.join("acorn-claude-notify")).unwrap();
        let settings = fs::read_to_string(dir.join("acorn-claude-settings.json")).unwrap();

        for (label, body) in [
            ("wrapper", &wrapper),
            ("notify", &notify),
            ("settings", &settings),
        ] {
            for forbidden in [
                "~/.claude",
                "$HOME/.claude",
                ".claude/settings.json",
                ".claude/settings.local.json",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "{label} body must not reference user config path {forbidden}"
                );
            }
            for forbidden_cmd in [
                " > ~/.claude",
                "tee ~/.claude",
                "cp ~/.claude",
                "mv ~/.claude",
            ] {
                assert!(
                    !body.contains(forbidden_cmd),
                    "{label} body must not mutate user config via {forbidden_cmd}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn claude_notify_forwards_raw_payload_for_owner_invocations() {
        // Owner payloads reach the Rust adapter unchanged apart from
        // insignificant trailing JSON whitespace.
        let payload = serde_json::json!({
            "hook_event_name": "Stop",
            "session_id": "019e4818-7c15-4e60-9b3b-898a1c7803d6",
            "agent_id": "019f6338-6250-7303-88a6-a7add31dba1d",
            "background_tasks": [{"id": "agent-1", "status": "running"}],
        });
        let posted = notify_payload_for_input(CLAUDE_NOTIFY_NAME, &[], &payload.to_string(), None)
            .expect("an owner invocation must forward the payload");
        assert_eq!(posted, payload);
    }

    #[cfg(unix)]
    #[test]
    fn claude_notify_gates_nested_and_legacy_invocations() {
        let stop =
            r#"{"hook_event_name":"Stop","session_id":"019e4818-7c15-4e60-9b3b-898a1c7803d6"}"#;

        // A top-level hook posts without waiting for the asynchronous
        // claude.id marker.
        assert!(notify_payload_for_input(CLAUDE_NOTIFY_NAME, &[], stop, None).is_some());

        // A nested wrapper stays silent even with a matching conversation
        // marker — depth gating happens before any payload inspection.
        assert_eq!(
            notify_payload_for_input_with_invocation(
                CLAUDE_NOTIFY_NAME,
                &[],
                stop,
                Some(("claude.id", "019e4818-7c15-4e60-9b3b-898a1c7803d6")),
                Some(("outer-invocation", "2")),
            ),
            None,
            "a matching conversation marker cannot authorize a nested wrapper",
        );

        // A tokenless legacy owner (provider that survived an app update)
        // posts only when the payload conversation matches its marker.
        assert!(notify_payload_for_input_with_invocation(
            CLAUDE_NOTIFY_NAME,
            &[],
            stop,
            Some(("claude.id", "019e4818-7c15-4e60-9b3b-898a1c7803d6")),
            None,
        )
        .is_some());
        assert_eq!(
            notify_payload_for_input_with_invocation(
                CLAUDE_NOTIFY_NAME,
                &[],
                stop,
                Some(("claude.id", "11111111-2222-4333-8444-555555555555")),
                None,
            ),
            None,
            "a mismatched legacy owner marker must fail closed",
        );
    }

    // Classifier behavior lives in `agent_hooks::tests`; wrapper tests cover
    // transport and invocation attribution only.

    #[test]
    fn notify_scripts_spool_undeliverable_events() {
        let base = ScratchDir::new("spool-content");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        for name in [
            "acorn-claude-notify",
            "acorn-codex-notify",
            "acorn-antigravity-notify",
        ] {
            let notify = fs::read_to_string(dir.join(name)).unwrap();
            assert!(
                notify.contains("agent-hook-spool"),
                "{name} must spool undeliverable events"
            );
            assert!(
                notify.contains("|| _acorn_spool_event"),
                "{name} must spool on POST failure"
            );
        }
    }

    #[cfg(unix)]
    fn run_claude_notify_with_curl(curl_body: &str, payload: &str) -> (ScratchDir, PathBuf) {
        use std::io::Write as _;

        let base = ScratchDir::new("spool-run");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let fake_bin = base.path().join("fake-bin");
        fs::create_dir_all(&fake_bin).unwrap();
        write_executable(&fake_bin.join("curl"), curl_body).unwrap();

        let mut child = Command::new(wrapper_dir.join(CLAUDE_NOTIFY_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env(
                "ACORN_AGENT_HOOK_SESSION_ID",
                "11111111-2222-4333-8444-555555555555",
            )
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_TOKEN", "owner-invocation")
            .env("ACORN_AGENT_INVOCATION_DEPTH", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "notify failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let spool_dir = wrapper_dir.join("agent-hook-spool");
        (base, spool_dir)
    }

    #[cfg(unix)]
    #[test]
    fn claude_notify_spools_event_when_post_fails() {
        let payload =
            r#"{"hook_event_name":"Stop","session_id":"019e4818-7c15-4e60-9b3b-898a1c7803d6"}"#;
        let (_scratch, spool_dir) = run_claude_notify_with_curl("#!/bin/sh\nexit 7\n", payload);

        let files: Vec<PathBuf> = fs::read_dir(&spool_dir)
            .expect("spool dir must exist after a failed POST")
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        assert_eq!(files.len(), 1, "exactly one event must be spooled");
        let content = fs::read_to_string(&files[0]).unwrap();
        let (meta, body) = content.split_once('\n').expect("meta line + body");
        let meta: serde_json::Value = serde_json::from_str(meta).expect("meta must be JSON");
        assert_eq!(meta["provider"], "claude");
        assert_eq!(meta["session_id"], "11111111-2222-4333-8444-555555555555");
        assert_eq!(meta["source"], "native");
        assert_eq!(body, payload, "the raw payload must be preserved verbatim");
    }

    #[cfg(unix)]
    #[test]
    fn claude_notify_does_not_spool_on_successful_post() {
        let payload = r#"{"hook_event_name":"Stop"}"#;
        let (_scratch, spool_dir) =
            run_claude_notify_with_curl("#!/bin/sh\ncat >/dev/null\nexit 0\n", payload);

        let spooled = fs::read_dir(&spool_dir)
            .map(|entries| entries.flatten().count())
            .unwrap_or(0);
        assert_eq!(spooled, 0, "a delivered event must not be spooled");
    }

    #[cfg(unix)]
    #[test]
    fn claude_notify_spool_respects_file_cap() {
        let payload = r#"{"hook_event_name":"Stop"}"#;
        let base = ScratchDir::new("spool-cap");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let spool_dir = wrapper_dir.join("agent-hook-spool");
        fs::create_dir_all(&spool_dir).unwrap();
        for index in 0..512 {
            fs::write(spool_dir.join(format!("1700000000-{index}.json")), "{}\n{}").unwrap();
        }
        let fake_bin = base.path().join("fake-bin");
        fs::create_dir_all(&fake_bin).unwrap();
        write_executable(&fake_bin.join("curl"), "#!/bin/sh\nexit 7\n").unwrap();

        use std::io::Write as _;
        let mut child = Command::new(wrapper_dir.join(CLAUDE_NOTIFY_NAME))
            .env("PATH", format!("{}:/usr/bin:/bin", fake_bin.display()))
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env(
                "ACORN_AGENT_HOOK_SESSION_ID",
                "11111111-2222-4333-8444-555555555555",
            )
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_AGENT_INVOCATION_TOKEN", "owner-invocation")
            .env("ACORN_AGENT_INVOCATION_DEPTH", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        assert!(child.wait_with_output().unwrap().status.success());

        let count = fs::read_dir(&spool_dir).unwrap().flatten().count();
        assert_eq!(count, 512, "a full spool must drop the event, not grow");
    }

    #[test]
    fn writes_hook_endpoint_file_atomically_with_owner_only_perms() {
        let base = ScratchDir::new("endpoint");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let path = write_agent_hook_endpoint_at(&dir, "http://127.0.0.1:12345/agent-hook", "tok-1")
            .unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "http://127.0.0.1:12345/agent-hook\ntok-1\n"
        );
        #[cfg(unix)]
        {
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "endpoint file must be 0600");
        }

        // A relaunch overwrites with the new run's endpoint.
        write_agent_hook_endpoint_at(&dir, "http://127.0.0.1:54321/agent-hook", "tok-2").unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "http://127.0.0.1:54321/agent-hook\ntok-2\n"
        );
        assert!(
            !dir.join(format!("{HOOK_ENDPOINT_NAME}.tmp")).exists(),
            "publish must not leave the temp file behind"
        );
    }

    #[test]
    fn notify_scripts_resolve_endpoint_file_before_env() {
        let base = ScratchDir::new("endpoint-notify");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        for name in [
            "acorn-claude-notify",
            "acorn-codex-notify",
            "acorn-antigravity-notify",
        ] {
            let notify = fs::read_to_string(dir.join(name)).unwrap();
            assert!(
                notify.contains("$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint"),
                "{name} must read the endpoint file"
            );
            // The POST goes to the resolved values, not the spawn-time env —
            // stale env from before an app restart must not win over the file.
            assert!(
                notify.contains("\"$hook_url\""),
                "{name} must POST to the resolved url"
            );
            assert!(
                notify.contains("X-Acorn-Agent-Hook-Token: $hook_token"),
                "{name} must send the resolved token"
            );
            // Env fallback stays for the no-file case.
            assert!(notify.contains("hook_url=\"${ACORN_AGENT_HOOK_URL-}\""));
            assert!(notify.contains("hook_token=\"${ACORN_AGENT_HOOK_TOKEN-}\""));
        }
    }

    #[cfg(unix)]
    #[test]
    fn notify_scripts_stream_hook_token_to_curl_header_fd() {
        use std::io::Write;
        use std::process::Stdio;

        const HOOK_URL: &str = "http://127.0.0.1:12345/agent-hook";
        const HOOK_TOKEN: &str = "sentinel-hook-token-never-in-argv";

        let base = ScratchDir::new("notify-token-stdin");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        write_agent_hook_endpoint_at(&dir, HOOK_URL, HOOK_TOKEN).unwrap();

        let fake_bin = base.path().join("fake-bin");
        fs::create_dir_all(&fake_bin).unwrap();
        write_executable(
            &fake_bin.join("curl"),
            r#"#!/bin/sh
printf '%s\n' "$@" > "$ACORN_TEST_CURL_ARGV"
cat <&3 > "$ACORN_TEST_CURL_STDIN"
cat >/dev/null
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", fake_bin.display());
        for (name, arg, input) in [
            ("acorn-codex-notify", Some("start"), ""),
            (
                "acorn-claude-notify",
                None,
                r#"{"hook_event_name":"SessionStart"}"#,
            ),
            ("acorn-antigravity-notify", Some("start"), ""),
        ] {
            let argv_capture = base.path().join(format!("{name}.argv"));
            let stdin_capture = base.path().join(format!("{name}.stdin"));
            let mut command = Command::new(dir.join(name));
            command
                .env("PATH", &path)
                .env("ACORN_AGENT_WRAPPER_DIR", &dir)
                .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
                .env("ACORN_AGENT_INVOCATION_TOKEN", "owner-invocation")
                .env("ACORN_AGENT_INVOCATION_DEPTH", "1")
                .env("ACORN_TEST_CURL_ARGV", &argv_capture)
                .env("ACORN_TEST_CURL_STDIN", &stdin_capture)
                .env_remove("ACORN_AGENT_HOOK_URL")
                .env_remove("ACORN_AGENT_HOOK_TOKEN")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(arg) = arg {
                command.arg(arg);
            }

            let mut child = command.spawn().expect("run notify script");
            child
                .stdin
                .take()
                .expect("notify stdin")
                .write_all(input.as_bytes())
                .expect("write notify input");
            let output = child.wait_with_output().expect("wait for notify script");
            assert!(
                output.status.success(),
                "{name} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );

            let argv = fs::read_to_string(&argv_capture).expect("read curl argv");
            let header_stream =
                fs::read_to_string(&stdin_capture).expect("read curl header stream");
            assert!(
                !argv.contains(HOOK_TOKEN),
                "{name} exposed the hook token in curl argv: {argv}"
            );
            assert!(
                argv.lines().any(|arg| arg == "@/dev/fd/3"),
                "{name} must ask curl to read the secret header from a descriptor: {argv}"
            );
            assert_eq!(
                header_stream,
                format!("X-Acorn-Agent-Hook-Token: {HOOK_TOKEN}\n"),
                "{name} must stream the token header to curl without argv exposure"
            );
        }
    }

    #[test]
    fn wrappers_activate_hooks_on_endpoint_file_without_env_pair() {
        let base = ScratchDir::new("endpoint-gate");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        for name in ["claude", "codex", "agy"] {
            let wrapper = fs::read_to_string(dir.join(name)).unwrap();
            assert!(
                wrapper.contains("[ -r \"$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint\" ] ||"),
                "{name} wrapper must accept the endpoint file as a hook channel"
            );
            // Session id has no file fallback — it stays a hard requirement.
            assert!(wrapper.contains("[ -n \"${ACORN_AGENT_HOOK_SESSION_ID-}\" ] &&"));
        }
    }

    #[test]
    fn writes_antigravity_wrapper_and_notify_helper() {
        let base = ScratchDir::new("antigravity");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("agy")).unwrap();
        assert!(wrapper.contains("_acorn_wrapper_dir=\"${ACORN_AGENT_WRAPPER_DIR-}\""));
        assert!(wrapper.contains("_acorn_wrapper_dir=${0%/*}"));
        assert!(wrapper.contains("_acorn_find_real_binary agy"));
        assert!(wrapper.contains(".system_generated/logs/transcript.jsonl"));
        assert!(wrapper.contains("ANTIGRAVITY_DIR"));
        assert!(wrapper.contains("GEMINI_DIR"));
        assert!(wrapper.contains("acorn-antigravity-notify"));
        assert!(wrapper.contains("PLANNER_RESPONSE"));
        assert!(wrapper.contains("USER_INPUT"));
        assert!(
            wrapper.contains(r#"grep -qE '"tool_calls"[[:space:]]*:[[:space:]]*\[[[:space:]]*\{'"#)
        );

        let notify = fs::read_to_string(dir.join("acorn-antigravity-notify")).unwrap();
        assert!(notify.contains("\"provider\":\"antigravity\""));
        assert!(notify.contains("hookEventName"));
        assert!(notify.contains("PermissionRequest"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_wrapper_keeps_working_for_planner_tool_calls() {
        const OWNER_ID: &str = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        let (notifications, tail_alive) = antigravity_wrapper_notifications_for_turn(
            r#"{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"invoke_subagent","args":{}}]}"#,
            r#"{"type":"PLANNER_RESPONSE","status":"DONE","content":"finished"}"#,
        );

        assert_eq!(
            notifications,
            format!("start {OWNER_ID}\nstart {OWNER_ID}\nneeds_input {OWNER_ID}\n"),
            "an intermediate planner response must keep the parent turn working"
        );
        assert!(
            !tail_alive,
            "the transcript tail must exit with the wrapper"
        );
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_wrapper_follows_the_bound_owner_across_new_conversations() {
        const FIRST_ID: &str = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        const SECOND_ID: &str = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let (notifications, tail_alive) = antigravity_wrapper_notifications_across_owner_rotation();

        assert_eq!(
            notifications,
            format!(
                "start {FIRST_ID}\nneeds_input {FIRST_ID}\nstart {SECOND_ID}\nneeds_input {SECOND_ID}\n"
            ),
            "a newer unbound brain must be ignored until the owner marker rotates",
        );
        assert!(
            !tail_alive,
            "the reattached transcript tail must exit with the wrapper"
        );
    }

    #[test]
    fn antigravity_subagent_stop_emits_no_transition() {
        let base = ScratchDir::new("agy-events");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let notify = fs::read_to_string(dir.join("acorn-antigravity-notify")).unwrap();
        assert!(!notify.contains("SubagentStop) event=\"start\""));
        assert!(notify.contains("Notification|PermissionRequest) event=\"needs_input\""));
        assert_eq!(
            notify_event_for_stdin(
                ANTIGRAVITY_NOTIFY_NAME,
                r#"{"hookEventName":"SubagentStop","fullyIdle":false}"#,
            ),
            None,
            "subagent completion must preserve a concurrent attention request",
        );
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_non_idle_stop_emits_no_transition() {
        let owner = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        for payload in [
            serde_json::json!({
                "executionNum": 1,
                "terminationReason": "model_stop",
                "fullyIdle": false,
                "conversationId": owner,
            }),
            serde_json::json!({
                "hook_event_name": "Stop",
                "fullyIdle": false,
                "conversationId": owner,
                "background": {"kind": "subagent"},
            }),
        ] {
            let pretty = serde_json::to_string_pretty(&payload).unwrap();
            assert_eq!(
                notify_event_for_stdin(ANTIGRAVITY_NOTIFY_NAME, &pretty),
                None,
                "{pretty}",
            );
        }

        for payload in [
            serde_json::json!({
                "hookEventName": "Stop",
                "conversationId": owner,
            }),
            serde_json::json!({
                "hookEventName": "Stop",
                "fullyIdle": null,
                "conversationId": owner,
            }),
            serde_json::json!({
                "hookEventName": "Stop",
                "fullyIdle": "true",
                "conversationId": owner,
            }),
        ] {
            let body = payload.to_string();
            assert_eq!(
                notify_event_for_stdin(ANTIGRAVITY_NOTIFY_NAME, &body),
                None,
                "only a literal fullyIdle=true may complete the owner: {body}",
            );
        }

        for payload in [
            serde_json::json!({
                "hookEventName": "Stop",
                "fullyIdle": true,
                "conversationId": owner,
            }),
            serde_json::json!({
                "executionNum": 2,
                "terminationReason": "model_stop",
                "fullyIdle": true,
                "conversationId": owner,
            }),
            serde_json::json!({
                "hookEventName": "Stop",
                "fullyIdle": true,
                "conversationId": owner,
                "message": "decoy: \"fullyIdle\":false",
            }),
        ] {
            let body = payload.to_string();
            assert_eq!(
                notify_event_for_stdin(ANTIGRAVITY_NOTIFY_NAME, &body).as_deref(),
                Some("needs_input"),
                "{body}",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_native_stop_uses_synchronous_wrapper_ownership() {
        let owner = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        let child = "019f631f-0bfc-76f1-9c1d-334be74958ca";
        let stop = |conversation_id: Option<&str>| {
            let mut payload = serde_json::json!({
                "hookEventName": "Stop",
                "fullyIdle": true,
            });
            if let Some(conversation_id) = conversation_id {
                payload["conversationId"] = conversation_id.into();
            }
            payload.to_string()
        };

        assert_eq!(
            notify_event_for_stdin(ANTIGRAVITY_NOTIFY_NAME, &stop(Some(owner))).as_deref(),
            Some("needs_input"),
            "a top-level hook must not wait for the asynchronous antigravity.id marker",
        );
        assert_eq!(
            notify_event_for_stdin(ANTIGRAVITY_NOTIFY_NAME, &stop(None)).as_deref(),
            Some("needs_input"),
            "the wrapper invocation proves ownership even without a conversation id",
        );
        assert_eq!(
            notify_payload_for_input_with_invocation(
                ANTIGRAVITY_NOTIFY_NAME,
                &[],
                &stop(Some(owner)),
                Some(("antigravity.id", owner)),
                Some(("outer-invocation", "2")),
            ),
            None,
            "a matching conversation marker cannot authorize a nested wrapper",
        );
        assert_eq!(
            notify_payload_for_input_with_invocation(
                ANTIGRAVITY_NOTIFY_NAME,
                &[],
                &stop(Some(child)),
                Some(("antigravity.id", owner)),
                Some(("owner-invocation", "1")),
            ),
            None,
            "a child conversation Stop cannot transition the bound owner session",
        );
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_transcript_completion_requires_owner_brain() {
        let owner = "019e4818-7c15-4e60-9b3b-898a1c7803d6";
        let nested = "019f631f-0bfc-76f1-9c1d-334be74958ca";

        for event in ["needs_input", "stop"] {
            assert_eq!(
                notify_event_for_args_with_owner(
                    ANTIGRAVITY_NOTIFY_NAME,
                    &[event, owner],
                    "antigravity.id",
                    Some(owner),
                )
                .as_deref(),
                Some(event),
            );
            assert_eq!(
                notify_source_for_args_with_owner(
                    ANTIGRAVITY_NOTIFY_NAME,
                    &[event, owner],
                    "antigravity.id",
                    Some(owner),
                )
                .as_deref(),
                Some("transcript"),
            );
            assert_eq!(
                notify_event_for_args_with_owner(
                    ANTIGRAVITY_NOTIFY_NAME,
                    &[event, nested],
                    "antigravity.id",
                    Some(owner),
                ),
                None,
            );
            assert_eq!(
                notify_event_for_args_with_owner(
                    ANTIGRAVITY_NOTIFY_NAME,
                    &[event],
                    "antigravity.id",
                    Some(owner),
                ),
                None,
                "transcript completion without a brain id must fail closed",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_explicit_attention_events_do_not_require_owner_binding() {
        for payload in [
            serde_json::json!({"hookEventName": "PermissionRequest"}),
            serde_json::json!({
                "hookEventName": "Notification",
                "notificationType": "agent_needs_input",
            }),
        ] {
            assert_eq!(
                notify_event_for_stdin(ANTIGRAVITY_NOTIFY_NAME, &payload.to_string()).as_deref(),
                Some("needs_input"),
            );
        }
    }
}
