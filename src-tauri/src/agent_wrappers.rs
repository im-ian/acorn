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

# A Codex launched from inside an instrumented Codex process inherits the
# Acorn session environment. Let only the outer CLI own that terminal's
# lifecycle channel.
if [ -n "${ACORN_CODEX_WRAPPER_ACTIVE-}" ]; then
  unset CODEX_TUI_RECORD_SESSION CODEX_TUI_SESSION_LOG_PATH
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
  export ACORN_CODEX_WRAPPER_ACTIVE=1
  _acorn_codex_version=$("$REAL_BIN" --version 2>/dev/null |
    sed -n 's/^[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p' |
    sed -n '1p')
  export ACORN_CODEX_VERSION="${_acorn_codex_version:-unknown}"
  _acorn_codex_ts="$(date +%s 2>/dev/null || echo 0)"
  export ACORN_CODEX_LIFECYCLE_ID="$$_${_acorn_codex_ts}"

  _acorn_codex_notify_config="notify=[\"sh\",\"-c\",'exec \"\$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\" \"\$1\" legacy_completion',\"acorn-codex-notify\"]"
  _acorn_codex_prompt_config="hooks.UserPromptSubmit=[{hooks=[{type=\"command\",command='exec \"\$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\" \"\" native_prompt',timeout=2}]}]"
  _acorn_codex_stop_config="hooks.Stop=[{hooks=[{type=\"command\",command='exec \"\$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\" \"\" native_stop',timeout=2}]}]"
  _acorn_codex_permission_config="hooks.PermissionRequest=[{hooks=[{type=\"command\",command='exec \"\$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\" \"\" native_permission',timeout=2}]}]"
  _acorn_codex_tool_complete_config="hooks.PostToolUse=[{hooks=[{type=\"command\",command='exec \"\$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\" \"\" native_tool_complete',timeout=2}]}]"

  _acorn_codex_native_hooks=0
  if _acorn_codex_version_supported "$_acorn_codex_version" &&
     "$REAL_BIN" --enable hooks \
       -c "$_acorn_codex_prompt_config" \
       -c "$_acorn_codex_stop_config" \
       -c "$_acorn_codex_permission_config" \
       -c "$_acorn_codex_tool_complete_config" \
       features list >/dev/null 2>&1; then
    _acorn_codex_native_hooks=1
  fi

  _acorn_runtime_dir=""
  _acorn_runtime_dir=$(
    umask 077
    mktemp -d "${TMPDIR:-/tmp}/acorn-codex-watch.XXXXXX" 2>/dev/null
  ) || _acorn_runtime_dir=""
  _acorn_codex_owns_log=0
  if [ -z "${CODEX_TUI_SESSION_LOG_PATH-}" ] && [ -n "$_acorn_runtime_dir" ]; then
    export CODEX_TUI_SESSION_LOG_PATH="$_acorn_runtime_dir/session.jsonl"
    _acorn_codex_owns_log=1
  fi

  _acorn_log="${CODEX_TUI_SESSION_LOG_PATH-}"
  _acorn_notify="$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify"
  _acorn_fifo=""
  if [ -n "$_acorn_runtime_dir" ]; then
    _acorn_fifo="$_acorn_runtime_dir/events.fifo"
  fi
  ACORN_CODEX_TAIL_PID=""
  ACORN_CODEX_WATCHER_PID=""

  _acorn_cleanup_codex() {
    exec 9>&- 2>/dev/null || true
    if [ -n "$ACORN_CODEX_TAIL_PID" ]; then
      kill "$ACORN_CODEX_TAIL_PID" >/dev/null 2>&1 || true
      wait "$ACORN_CODEX_TAIL_PID" 2>/dev/null || true
      ACORN_CODEX_TAIL_PID=""
    fi
    if [ -n "$ACORN_CODEX_WATCHER_PID" ]; then
      wait "$ACORN_CODEX_WATCHER_PID" 2>/dev/null || true
      ACORN_CODEX_WATCHER_PID=""
    fi
    if [ -n "$_acorn_fifo" ]; then
      rm -f "$_acorn_fifo"
    fi
    if [ "$_acorn_codex_owns_log" = "1" ]; then
      rm -f "$CODEX_TUI_SESSION_LOG_PATH"
      _acorn_codex_owns_log=0
    fi
    if [ -n "$_acorn_runtime_dir" ]; then
      rmdir "$_acorn_runtime_dir" >/dev/null 2>&1 || true
      _acorn_runtime_dir=""
    fi
  }
  trap '_acorn_cleanup_codex; exit 129' 1
  trap '_acorn_cleanup_codex; exit 130' 2
  trap '_acorn_cleanup_codex; exit 143' 15

  _acorn_watch_log=0
  if [ -n "$_acorn_log" ] && [ -n "$_acorn_fifo" ]; then
    if [ "$_acorn_codex_owns_log" = "1" ]; then
      if (umask 077; : >"$_acorn_log") 2>/dev/null; then
        _acorn_watch_log=1
      fi
    else
      # A caller-provided recorder may not exist yet. `tail -F` follows it
      # after Codex creates the parent directory and file.
      _acorn_watch_log=1
    fi
  fi

  if [ "$_acorn_watch_log" = "1" ]; then
    export CODEX_TUI_RECORD_SESSION=1
    if (umask 077; mkfifo "$_acorn_fifo") && exec 9<>"$_acorn_fifo"; then
      (
        exec 9>&-
        exec tail -n 0 -F "$_acorn_log" >"$_acorn_fifo" 2>/dev/null
      ) &
      ACORN_CODEX_TAIL_PID=$!
      (
        exec 9>&-
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
            *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)
              printf '%s\n' "$_acorn_line" | "$_acorn_notify" "" jsonl_tool >/dev/null 2>&1 || true
              ;;
          esac
        done <"$_acorn_fifo"
      ) &
      ACORN_CODEX_WATCHER_PID=$!
      exec 9>&-
    else
      rm -f "$_acorn_fifo"
    fi
  fi

  if [ "$_acorn_codex_native_hooks" = "1" ]; then
    "$REAL_BIN" --enable hooks \
      -c "$_acorn_codex_notify_config" \
      -c "$_acorn_codex_prompt_config" \
      -c "$_acorn_codex_stop_config" \
      -c "$_acorn_codex_permission_config" \
      -c "$_acorn_codex_tool_complete_config" \
      "$@"
  else
    "$REAL_BIN" -c "$_acorn_codex_notify_config" "$@"
  fi
  ACORN_CODEX_STATUS=$?

  _acorn_cleanup_codex
  exit "$ACORN_CODEX_STATUS"
fi

exec "$REAL_BIN" "$@"
"#;

const CODEX_NOTIFY_BODY: &str = r#"#!/bin/sh
input="${1-}"
source="${2-}"
legacy_contract=0
case "$source" in
  native_prompt|native_stop|native_permission|native_tool_complete|jsonl_user|jsonl_task|jsonl_tool|jsonl_approval|legacy_completion) ;;
  ''|hook|turn|tool)
    legacy_contract=1
    source="${source:-hook}"
    ;;
  *) exit 0 ;;
esac
if [ -z "$input" ]; then
  input=$(cat 2>/dev/null || true)
fi
[ -n "$input" ] || exit 0

# Daemon-owned sessions can keep their wrapper process across app upgrades.
# Those processes call this shared helper with normalized events and no
# lifecycle header, so forward that limited contract through the generic API.
if [ "$legacy_contract" = "1" ]; then
  event="$input"
  case "$event" in
    start|stop|needs_input|error) ;;
    *)
      event=""
      hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
      case "$hook_event_name" in
        Start|UserPromptSubmit) event="start" ;;
        Stop|PermissionRequest) event="needs_input" ;;
        Error) event="error" ;;
      esac
      if [ -z "$event" ]; then
        codex_type=$(printf '%s\n' "$input" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
        case "$codex_type" in
          task_started) event="start" ;;
          agent-turn-complete|task_complete|turn_complete) event="needs_input" ;;
          exec_approval_request|apply_patch_approval_request|request_user_input) event="needs_input" ;;
        esac
      fi
      [ -n "$event" ] || exit 0
      ;;
  esac
fi

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
[ -n "$hook_url" ] || exit 0
[ -n "$hook_token" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

if [ "$legacy_contract" = "1" ]; then
  payload=$(printf '{"session_id":"%s","provider":"codex","event":"%s","source":"%s"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event" "$source")
  printf '%s' "$payload" | curl -sf --connect-timeout 1 --max-time 1 -X POST \
    -H 'Content-Type: application/json' \
    -H "X-Acorn-Agent-Hook-Token: $hook_token" \
    --data-binary @- \
    "$hook_url" >/dev/null 2>&1 || true
  exit 0
fi

[ -n "${ACORN_CODEX_LIFECYCLE_ID-}" ] || exit 0

printf '%s' "$input" | curl -sf --connect-timeout 1 --max-time 1 -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $hook_token" \
  -H 'X-Acorn-Agent-Hook-Provider: codex' \
  -H "X-Acorn-Agent-Hook-Session-Id: $ACORN_AGENT_HOOK_SESSION_ID" \
  -H "X-Acorn-Agent-Hook-Source: $source" \
  -H "X-Acorn-Codex-Lifecycle-Id: $ACORN_CODEX_LIFECYCLE_ID" \
  -H "X-Acorn-Codex-Version: ${ACORN_CODEX_VERSION-unknown}" \
  --data-binary @- \
  "$hook_url" >/dev/null 2>&1 || true
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

hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')

event=""
# Claude fires Stop at the end of every assistant turn — the agent is resting
# and awaiting the user's next prompt — so Stop maps to needs_input alongside
# the explicit Notification/PermissionRequest attention events. Ready is
# reserved for sessions with no pending conversation; the status poll derives
# it once the agent exits.
case "$hook_event_name" in
  SessionStart|UserPromptSubmit) event="start" ;;
  Stop|Notification|PermissionRequest) event="needs_input" ;;
  Error) event="error" ;;
esac
[ -n "$event" ] || exit 0

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
[ -n "$hook_url" ] || exit 0
[ -n "$hook_token" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

payload=$(printf '{"session_id":"%s","provider":"claude","event":"%s","source":"hook"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event")
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $hook_token" \
  -d "$payload" \
  "$hook_url" >/dev/null 2>&1 || true
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

_acorn_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

_acorn_latest_antigravity_transcript() {
  _acorn_root="${ANTIGRAVITY_DIR:-${GEMINI_DIR:-$HOME/.gemini}}"
  _acorn_latest=""
  _acorn_latest_mtime=0
  for _acorn_profile in antigravity antigravity-cli antigravity-ide; do
    _acorn_brain="$_acorn_root/$_acorn_profile/brain"
    [ -d "$_acorn_brain" ] || continue
    while IFS= read -r _acorn_path; do
      [ -f "$_acorn_path" ] || continue
      _acorn_file_mtime=$(_acorn_mtime "$_acorn_path")
      [ "$_acorn_file_mtime" -ge "$_acorn_start_ts" ] || continue
      if [ "$_acorn_file_mtime" -ge "$_acorn_latest_mtime" ]; then
        _acorn_latest="$_acorn_path"
        _acorn_latest_mtime="$_acorn_file_mtime"
      fi
    done <<EOF
$(find "$_acorn_brain" -type f -path '*/.system_generated/logs/transcript.jsonl' 2>/dev/null)
EOF
  done
  [ -n "$_acorn_latest" ] && printf '%s\n' "$_acorn_latest"
}

REAL_BIN=$(_acorn_find_real_binary agy)
if [ -z "$REAL_BIN" ]; then
  echo "Acorn: agy not found in PATH. Install Antigravity CLI and ensure it is available in your shell PATH." >&2
  exit 127
fi

# Hook channel is available when the endpoint file exists (rewritten by each
# app launch with the current server URL + token) or the spawn-time env pair
# is present. The session id has no file fallback — without it, events cannot
# be attributed to a session.
if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
   { [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ] ||
     { [ -n "${ACORN_AGENT_HOOK_URL-}" ] && [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ]; }; } &&
   [ -x "$ACORN_AGENT_WRAPPER_DIR/acorn-antigravity-notify" ]; then
  _acorn_start_ts=$(date +%s 2>/dev/null || echo 0)
  (
    _acorn_notify="$ACORN_AGENT_WRAPPER_DIR/acorn-antigravity-notify"
    _acorn_transcript=""
    _acorn_i=0
    while [ -z "$_acorn_transcript" ] && [ "$_acorn_i" -lt 400 ]; do
      _acorn_i=$((_acorn_i + 1))
      _acorn_transcript=$(_acorn_latest_antigravity_transcript)
      [ -n "$_acorn_transcript" ] || sleep 0.05
    done
    [ -n "$_acorn_transcript" ] || exit 0

    tail -n 0 -F "$_acorn_transcript" 2>/dev/null | while IFS= read -r _acorn_line; do
      case "$_acorn_line" in
        *'"type":"USER_INPUT"'*)
          "$_acorn_notify" start >/dev/null 2>&1 || true
          ;;
        *'"type":"PLANNER_RESPONSE"'*'"status":"DONE"'*)
          "$_acorn_notify" needs_input >/dev/null 2>&1 || true
          ;;
        *'"status":"ERROR"'*)
          "$_acorn_notify" error >/dev/null 2>&1 || true
          ;;
      esac
    done
  ) &
  ACORN_ANTIGRAVITY_WATCHER_PID=$!

  "$REAL_BIN" "$@"
  ACORN_ANTIGRAVITY_STATUS=$?

  "$ACORN_AGENT_WRAPPER_DIR/acorn-antigravity-notify" stop >/dev/null 2>&1 || true
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
if [ -z "$input" ]; then
  input=$(cat 2>/dev/null || true)
fi

event="$input"
case "$event" in
  start|stop|needs_input|error)
    ;;
  *)
    event=""
    hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hookEventName"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
    [ -n "$hook_event_name" ] || hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
    # SubagentStop fires when a Task subagent finishes mid-turn, so it
    # re-asserts Running rather than ending the turn. A completed main-agent
    # turn awaits the user, so Stop maps to needs_input; the literal "stop"
    # passthrough above stays reserved for process exit.
    case "$hook_event_name" in
      SessionStart|UserPromptSubmit|PreToolUse|SubagentStop) event="start" ;;
      Stop|Notification|PermissionRequest) event="needs_input" ;;
      Error) event="error" ;;
    esac
    [ -n "$event" ] || exit 0
    ;;
esac

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
[ -n "$hook_url" ] || exit 0
[ -n "$hook_token" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

payload=$(printf '{"session_id":"%s","provider":"antigravity","event":"%s","source":"hook"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event")
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $hook_token" \
  -d "$payload" \
  "$hook_url" >/dev/null 2>&1 || true
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
    use std::io::Write as _;
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
    fn codex_wrapper_notifications_for_tui_line(line: &str) -> String {
        codex_wrapper_notifications_for_tui_parts("", line)
    }

    #[cfg(unix)]
    fn codex_wrapper_notifications_for_tui_parts(prefix: &str, suffix: &str) -> String {
        let base = ScratchDir::new("codex-tui-event");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let capture_path = base.path().join("notifications.log");
        let session_log_path = base.path().join("session.jsonl");
        write_executable(
            &wrapper_dir.join("acorn-codex-notify"),
            "#!/bin/sh\ninput=\"$1\"\n[ -n \"$input\" ] || input=$(cat)\nprintf '%s\\n%s\\n' \"$2\" \"$input\" >> \"$ACORN_NOTIFY_CAPTURE\"\n",
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
  if [ "$_acorn_arg" = "features" ]; then
    exit 0
  fi
done
: > "$CODEX_TUI_SESSION_LOG_PATH"
sleep 0.5
printf '%s' "$ACORN_TEST_TUI_PREFIX" >> "$CODEX_TUI_SESSION_LOG_PATH"
sleep 0.2
printf '%s\n' "$ACORN_TEST_TUI_SUFFIX" >> "$CODEX_TUI_SESSION_LOG_PATH"
_acorn_i=0
while [ ! -s "$ACORN_NOTIFY_CAPTURE" ] && [ "$_acorn_i" -lt 150 ]; do
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
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_TEST_TUI_PREFIX", prefix)
            .env("ACORN_TEST_TUI_SUFFIX", suffix)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        let process_list = Command::new("ps")
            .args(["-axo", "command="])
            .output()
            .expect("list processes after wrapper exit");
        assert!(!String::from_utf8_lossy(&process_list.stdout)
            .contains(session_log_path.to_string_lossy().as_ref()));

        fs::read_to_string(capture_path).unwrap_or_default()
    }

    #[cfg(unix)]
    fn codex_wrapper_args_for_version(
        version: &str,
        probe_fails: bool,
        wrapper_active: bool,
    ) -> Vec<String> {
        let base = ScratchDir::new("codex-native-args");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let capture_path = base.path().join("args.log");
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
if [ "${1-}" = "--version" ]; then
  printf 'codex-cli %s\n' "$ACORN_TEST_CODEX_VERSION"
  exit 0
fi
if [ "$ACORN_TEST_CODEX_PROBE_FAIL" = "1" ]; then
  for arg in "$@"; do
    if [ "$arg" = "features" ]; then
      exit 1
    fi
  done
fi
printf '%s\n' "$@" > "$ACORN_ARGS_CAPTURE"
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", real_dir.display());
        let mut command = Command::new(wrapper_dir.join("codex"));
        command
            .arg("sentinel-user-arg")
            .env("PATH", path)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_TEST_CODEX_VERSION", version)
            .env(
                "ACORN_TEST_CODEX_PROBE_FAIL",
                if probe_fails { "1" } else { "0" },
            )
            .env("ACORN_ARGS_CAPTURE", &capture_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if wrapper_active {
            command.env("ACORN_CODEX_WRAPPER_ACTIVE", "1");
        }
        let status = command.status().unwrap();
        assert!(status.success());

        fs::read_to_string(capture_path)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[cfg(unix)]
    fn codex_native_notify_request(hook_event_name: &str, source: &str) -> String {
        let base = ScratchDir::new("codex-native-payload");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let fake_bin = base.path().join("fake-bin");
        fs::create_dir_all(&fake_bin).unwrap();

        let capture_path = base.path().join("payload.json");
        write_executable(
            &fake_bin.join("curl"),
            r#"#!/bin/sh
printf '%s\n' "$@" > "$ACORN_CURL_CAPTURE"
cat >> "$ACORN_CURL_CAPTURE"
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", fake_bin.display());
        let mut child = Command::new(wrapper_dir.join("acorn-codex-notify"))
            .arg("")
            .arg(source)
            .env("PATH", path)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_CODEX_LIFECYCLE_ID", "lifecycle-1")
            .env("ACORN_CODEX_VERSION", "0.144.4")
            .env("ACORN_CURL_CAPTURE", &capture_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        write!(
            child.stdin.take().unwrap(),
            r#"{{"session_id":"provider-session","turn_id":"turn-1","hook_event_name":"{hook_event_name}"}}"#
        )
        .unwrap();
        assert!(child.wait().unwrap().success());

        fs::read_to_string(capture_path).unwrap()
    }

    #[cfg(unix)]
    fn codex_legacy_notify_request(input: &str, source: Option<&str>) -> String {
        let base = ScratchDir::new("codex-legacy-payload");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let fake_bin = base.path().join("fake-bin");
        fs::create_dir_all(&fake_bin).unwrap();

        let capture_path = base.path().join("payload.json");
        write_executable(
            &fake_bin.join("curl"),
            r#"#!/bin/sh
printf '%s\n' "$@" > "$ACORN_CURL_CAPTURE"
cat >> "$ACORN_CURL_CAPTURE"
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", fake_bin.display());
        let mut command = Command::new(wrapper_dir.join("acorn-codex-notify"));
        command
            .arg(input)
            .env("PATH", path)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env(
                "ACORN_AGENT_HOOK_SESSION_ID",
                "00000000-0000-0000-0000-000000000001",
            )
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env_remove("ACORN_CODEX_LIFECYCLE_ID")
            .env("ACORN_CURL_CAPTURE", &capture_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(source) = source {
            command.arg(source);
        }
        assert!(command.status().unwrap().success());

        fs::read_to_string(capture_path).unwrap_or_default()
    }

    #[test]
    fn writes_codex_wrapper_and_notify_helper() {
        let base = ScratchDir::new("codex");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("codex")).unwrap();
        assert!(wrapper.contains("_acorn_wrapper_dir=\"${ACORN_AGENT_WRAPPER_DIR-}\""));
        assert!(wrapper.contains("_acorn_wrapper_dir=${0%/*}"));
        assert!(wrapper.contains("hooks.UserPromptSubmit="));
        assert!(wrapper.contains("hooks.Stop="));
        assert!(wrapper.contains("hooks.PermissionRequest="));
        assert!(wrapper.contains("hooks.PostToolUse="));
        assert!(!wrapper.contains("--enable codex_hooks"));
        assert!(wrapper.contains("notify=[\\\"sh\\\",\\\"-c\\\""));
        assert!(wrapper.contains("legacy_completion"));
        assert!(wrapper.contains("CODEX_TUI_RECORD_SESSION=1"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_URL"));
        assert!(wrapper.contains("\"$_acorn_notify\" \"\" jsonl_user"));
        assert!(wrapper.contains("\"$_acorn_notify\" \"\" jsonl_tool"));
        assert!(wrapper.contains("ACORN_CODEX_WRAPPER_ACTIVE"));

        let notify = fs::read_to_string(dir.join("acorn-codex-notify")).unwrap();
        assert!(notify.contains("X-Acorn-Agent-Hook-Provider: codex"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Source: $source"));
        assert!(notify.contains("X-Acorn-Codex-Lifecycle-Id: $ACORN_CODEX_LIFECYCLE_ID"));
        assert!(notify.contains("--data-binary @-"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
        assert!(notify.contains("--connect-timeout 1"));
        assert!(notify.contains("--max-time 1"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_injects_native_lifecycle_hooks_for_supported_versions() {
        let args = codex_wrapper_args_for_version("0.144.4", false, false);
        let user_arg = args
            .iter()
            .position(|arg| arg == "sentinel-user-arg")
            .unwrap();

        for (event, source) in [
            ("UserPromptSubmit", "native_prompt"),
            ("Stop", "native_stop"),
            ("PermissionRequest", "native_permission"),
            ("PostToolUse", "native_tool_complete"),
        ] {
            let hook_arg = args
                .iter()
                .position(|arg| arg.starts_with(&format!("hooks.{event}=")))
                .unwrap_or_else(|| panic!("missing native {event} hook in {args:?}"));
            assert!(hook_arg < user_arg, "Acorn hook must precede user args");
            assert!(args[hook_arg].contains("$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify"));
            assert!(args[hook_arg].contains(source));
        }

        assert!(args.iter().any(|arg| arg.starts_with("notify=")));
        assert!(!args
            .iter()
            .any(|arg| arg.starts_with("hooks.SessionStart=")));
        assert!(!args
            .iter()
            .any(|arg| arg == "--dangerously-bypass-hook-trust"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_keeps_legacy_fallback_for_unsupported_versions() {
        let args = codex_wrapper_args_for_version("0.134.9", false, false);

        assert!(args.iter().any(|arg| arg.starts_with("notify=")));
        assert!(!args.iter().any(|arg| arg.starts_with("hooks.")));
        assert!(!args.iter().any(|arg| arg == "--enable"));
        assert!(args.iter().any(|arg| arg == "sentinel-user-arg"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_keeps_legacy_fallback_when_native_config_probe_fails() {
        let args = codex_wrapper_args_for_version("0.144.4", true, false);

        assert!(args.iter().any(|arg| arg.starts_with("notify=")));
        assert!(!args.iter().any(|arg| arg.starts_with("hooks.")));
        assert!(!args.iter().any(|arg| arg == "--enable"));
        assert!(args.iter().any(|arg| arg == "sentinel-user-arg"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_native_hook_version_gate_covers_the_supported_boundary() {
        for version in ["0.135.0", "1.0.0"] {
            assert!(codex_wrapper_args_for_version(version, false, false)
                .iter()
                .any(|arg| arg.starts_with("hooks.UserPromptSubmit=")));
        }
        for version in ["0.134.99", "unknown"] {
            assert!(!codex_wrapper_args_for_version(version, false, false)
                .iter()
                .any(|arg| arg.starts_with("hooks.")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_native_hooks_forward_raw_payload_with_lifecycle_headers() {
        for (hook_event_name, expected_source) in [
            ("UserPromptSubmit", "native_prompt"),
            ("Stop", "native_stop"),
            ("PermissionRequest", "native_permission"),
            ("PostToolUse", "native_tool_complete"),
        ] {
            let request = codex_native_notify_request(hook_event_name, expected_source);
            assert!(request.contains("X-Acorn-Agent-Hook-Provider: codex"));
            assert!(request.contains(&format!("X-Acorn-Agent-Hook-Source: {expected_source}")));
            assert!(request.contains("X-Acorn-Codex-Lifecycle-Id: lifecycle-1"));
            assert!(request.contains("X-Acorn-Codex-Version: 0.144.4"));
            assert!(request.contains(&format!("\"hook_event_name\":\"{hook_event_name}\"")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_notify_keeps_daemon_sessions_on_the_generic_hook_contract() {
        let turn_start = codex_legacy_notify_request("start", Some("turn"));
        assert!(turn_start.contains(
            r#"{"session_id":"00000000-0000-0000-0000-000000000001","provider":"codex","event":"start","source":"turn"}"#
        ));
        assert!(!turn_start.contains("X-Acorn-Agent-Hook-Provider"));

        let stop = codex_legacy_notify_request(r#"{"hook_event_name":"Stop"}"#, None);
        assert!(stop.contains(
            r#"{"session_id":"00000000-0000-0000-0000-000000000001","provider":"codex","event":"needs_input","source":"hook"}"#
        ));
        assert!(!stop.contains("X-Acorn-Codex-Lifecycle-Id"));
    }

    #[cfg(unix)]
    #[test]
    fn nested_codex_invocation_skips_acorn_instrumentation() {
        let args = codex_wrapper_args_for_version("0.144.4", false, true);

        assert_eq!(args, vec!["sentinel-user-arg"]);
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_maps_current_tui_user_turn_to_turn_start() {
        let line = r#"{"ts":"2026-07-14T05:31:15.813Z","dir":"from_tui","kind":"op","payload":{"UserTurn":{"items":[{"type":"text","text":"Fix the bug."}]}}}"#;

        assert_eq!(
            codex_wrapper_notifications_for_tui_line(line),
            format!("jsonl_user\n{line}\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_preserves_tui_record_split_before_newline() {
        let line = r#"{"ts":"2026-07-14T05:31:15.813Z","dir":"from_tui","kind":"op","payload":{"UserTurn":{"items":[{"type":"text","text":"Fix the bug."}]}}}"#;
        let split_at = line.find("\"payload\"").expect("payload field") + 5;

        assert_eq!(
            codex_wrapper_notifications_for_tui_parts(&line[..split_at], &line[split_at..]),
            format!("jsonl_user\n{line}\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_watches_a_custom_recorder_created_after_launch() {
        let base = ScratchDir::new("codex-late-custom-recorder");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let capture_path = base.path().join("notifications.log");
        let session_log_path = base.path().join("created-by-codex/session.jsonl");
        let line = r#"{"dir":"from_tui","kind":"op","payload":{"UserTurn":{"items":[{"type":"text","text":"Fix the bug."}]}}}"#;
        write_executable(
            &wrapper_dir.join("acorn-codex-notify"),
            "#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"$ACORN_NOTIFY_CAPTURE\"\ncat >> \"$ACORN_NOTIFY_CAPTURE\"\n",
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
  if [ "$_acorn_arg" = "features" ]; then
    exit 0
  fi
done
mkdir -p "${CODEX_TUI_SESSION_LOG_PATH%/*}"
: > "$CODEX_TUI_SESSION_LOG_PATH"
sleep 0.3
printf '%s\n' "$ACORN_TEST_TUI_LINE" >> "$CODEX_TUI_SESSION_LOG_PATH"
_acorn_i=0
while [ ! -s "$ACORN_NOTIFY_CAPTURE" ] && [ "$_acorn_i" -lt 100 ]; do
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
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_TEST_TUI_LINE", line)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        assert!(status.success());
        assert_eq!(
            fs::read_to_string(capture_path).unwrap_or_default(),
            format!("jsonl_user\n{line}\n")
        );
    }

    #[cfg(unix)]
    #[test]
    fn codex_wrapper_keeps_recording_artifacts_owner_only() {
        use std::os::unix::fs::{FileTypeExt as _, PermissionsExt as _};

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
  if [ "$_acorn_arg" = "features" ]; then
    exit 0
  fi
done
printf '%s\n' "$CODEX_TUI_SESSION_LOG_PATH" > "$ACORN_LOG_PATH_CAPTURE"
while [ ! -e "$ACORN_TEST_RELEASE" ]; do
  sleep 0.02
done
"#,
        )
        .unwrap();

        let path = format!("{}:/usr/bin:/bin", real_dir.display());
        let mut child = Command::new("/bin/sh")
            .args(["-c", "umask 022; exec \"$1\" sentinel", "sh"])
            .arg(wrapper_dir.join("codex"))
            .env("PATH", path)
            .env("TMPDIR", &shared_tmp)
            .env("ACORN_AGENT_WRAPPER_DIR", &wrapper_dir)
            .env("ACORN_AGENT_HOOK_SESSION_ID", "session-1")
            .env("ACORN_AGENT_HOOK_URL", "http://127.0.0.1:1/agent-hook")
            .env("ACORN_AGENT_HOOK_TOKEN", "token-1")
            .env("ACORN_LOG_PATH_CAPTURE", &log_path_capture)
            .env("ACORN_TEST_RELEASE", &release_path)
            .env_remove("CODEX_TUI_SESSION_LOG_PATH")
            .env_remove("CODEX_TUI_RECORD_SESSION")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        let started = Instant::now();
        while !log_path_capture.is_file() {
            if started.elapsed() > Duration::from_secs(3) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Codex wrapper did not publish its recorder path");
            }
            thread::sleep(Duration::from_millis(20));
        }

        let session_log = PathBuf::from(
            fs::read_to_string(&log_path_capture)
                .unwrap()
                .trim(),
        );
        let runtime_dir = session_log.parent().expect("recorder has parent");
        let log_mode = fs::metadata(&session_log).unwrap().permissions().mode() & 0o777;
        let dir_mode = fs::metadata(runtime_dir).unwrap().permissions().mode() & 0o777;
        let fifo = fs::read_dir(runtime_dir)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_fifo()))
            .expect("watcher FIFO exists while Codex is running");
        let fifo_mode = fifo.metadata().unwrap().permissions().mode() & 0o777;

        fs::write(&release_path, b"release").unwrap();
        assert!(child.wait().unwrap().success());

        assert_eq!(dir_mode, 0o700, "recorder directory must be private");
        assert_eq!(log_mode, 0o600, "session JSONL must be owner-only");
        assert_eq!(fifo_mode, 0o600, "watcher FIFO must be owner-only");
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
        assert!(notify.contains("\"provider\":\"claude\""));
        assert!(notify.contains("SessionStart|UserPromptSubmit) event=\"start\""));
        assert!(!notify.contains("SubagentStop"));
        assert!(notify.contains("Stop|Notification|PermissionRequest) event=\"needs_input\""));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));

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

    #[test]
    fn claude_notify_maps_runtime_hook_events() {
        let base = ScratchDir::new("events");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let notify = fs::read_to_string(dir.join("acorn-claude-notify")).unwrap();
        assert!(notify.contains("SessionStart|UserPromptSubmit) event=\"start\""));
        assert!(!notify.contains("SubagentStop"));
        assert!(notify.contains("Stop|Notification|PermissionRequest) event=\"needs_input\""));
        assert!(notify.contains("Error) event=\"error\""));
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
        assert!(wrapper.contains(
            r#"*'"type":"PLANNER_RESPONSE"'*'"status":"DONE"'*)
          "$_acorn_notify" needs_input"#
        ));

        let notify = fs::read_to_string(dir.join("acorn-antigravity-notify")).unwrap();
        assert!(notify.contains("\"provider\":\"antigravity\""));
        assert!(notify.contains("hookEventName"));
        assert!(notify.contains("PermissionRequest"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
    }

    #[test]
    fn antigravity_notify_treats_subagent_stop_as_running() {
        let base = ScratchDir::new("agy-events");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let notify = fs::read_to_string(dir.join("acorn-antigravity-notify")).unwrap();
        // SubagentStop fires mid-turn, so it re-asserts Running; the
        // main-agent Stop ends the turn and awaits the user.
        assert!(notify.contains("SubagentStop) event=\"start\""));
        assert!(notify.contains("Stop|Notification|PermissionRequest) event=\"needs_input\""));
    }
}
