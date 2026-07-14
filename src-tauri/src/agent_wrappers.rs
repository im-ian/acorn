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

# Hook channel is available when the endpoint file exists (rewritten by each
# app launch with the current server URL + token) or the spawn-time env pair
# is present. The session id has no file fallback — without it, events cannot
# be attributed to a session.
if [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
   { [ -r "$ACORN_AGENT_WRAPPER_DIR/agent-hook-endpoint" ] ||
     { [ -n "${ACORN_AGENT_HOOK_URL-}" ] && [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ]; }; } &&
   [ -x "$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify" ]; then
  export CODEX_TUI_RECORD_SESSION=1
  if [ -z "${CODEX_TUI_SESSION_LOG_PATH-}" ]; then
    _acorn_codex_ts="$(date +%s 2>/dev/null || echo "$$")"
    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/acorn-codex-session-$$_${_acorn_codex_ts}.jsonl"
  fi

  (
    _acorn_log="$CODEX_TUI_SESSION_LOG_PATH"
    _acorn_notify="$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify"
    _acorn_last_turn_id=""
    _acorn_last_approval_id=""
    _acorn_last_exec_call_id=""
    _acorn_approval_fallback_seq=0

    _acorn_i=0
    while [ ! -f "$_acorn_log" ] && [ "$_acorn_i" -lt 200 ]; do
      _acorn_i=$((_acorn_i + 1))
      sleep 0.05
    done
    [ -f "$_acorn_log" ] || exit 0

    tail -n 0 -F "$_acorn_log" 2>/dev/null | while IFS= read -r _acorn_line; do
      case "$_acorn_line" in
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)
          _acorn_turn_id=$(printf '%s\n' "$_acorn_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_acorn_turn_id" ] || _acorn_turn_id="task_started"
          if [ "$_acorn_turn_id" != "$_acorn_last_turn_id" ]; then
            _acorn_last_turn_id="$_acorn_turn_id"
            "$_acorn_notify" start turn >/dev/null 2>&1 || true
          fi
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)
          _acorn_approval_id=$(printf '%s\n' "$_acorn_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_acorn_approval_id" ] || _acorn_approval_id=$(printf '%s\n' "$_acorn_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_acorn_approval_id" ] || _acorn_approval_id=$(printf '%s\n' "$_acorn_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          if [ -z "$_acorn_approval_id" ]; then
            _acorn_approval_fallback_seq=$((_acorn_approval_fallback_seq + 1))
            _acorn_approval_id="approval_request_${_acorn_approval_fallback_seq}"
          fi
          if [ "$_acorn_approval_id" != "$_acorn_last_approval_id" ]; then
            _acorn_last_approval_id="$_acorn_approval_id"
            "$_acorn_notify" needs_input >/dev/null 2>&1 || true
          fi
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)
          _acorn_exec_call_id=$(printf '%s\n' "$_acorn_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          if [ -n "$_acorn_exec_call_id" ]; then
            if [ "$_acorn_exec_call_id" != "$_acorn_last_exec_call_id" ]; then
              _acorn_last_exec_call_id="$_acorn_exec_call_id"
              "$_acorn_notify" start tool >/dev/null 2>&1 || true
            fi
          else
            "$_acorn_notify" start tool >/dev/null 2>&1 || true
          fi
          ;;
      esac
    done
  ) &
  ACORN_CODEX_WATCHER_PID=$!

  "$REAL_BIN" --enable hooks -c "notify=[\"bash\",\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"]" "$@"
  ACORN_CODEX_STATUS=$?

  if [ -n "${ACORN_CODEX_WATCHER_PID-}" ]; then
    kill "$ACORN_CODEX_WATCHER_PID" >/dev/null 2>&1 || true
    wait "$ACORN_CODEX_WATCHER_PID" 2>/dev/null || true
  fi
  exit "$ACORN_CODEX_STATUS"
fi

exec "$REAL_BIN" "$@"
"#;

const CODEX_NOTIFY_BODY: &str = r#"#!/bin/sh
input="${1-}"
source="${2-hook}"
case "$source" in
  hook|turn|tool) ;;
  *) source="hook" ;;
esac
if [ -z "$input" ]; then
  input=$(cat 2>/dev/null || true)
fi

event="$input"
case "$event" in
  start|stop|needs_input|error)
    ;;
  *)
    event=""
    hook_event_name=$(printf '%s\n' "$input" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
    # A completed turn leaves Codex resting and awaiting the user's next
    # instruction, so turn completion maps to needs_input like approval and
    # question events. Ready is reserved for sessions with no pending
    # conversation — the status poll derives it once the agent exits.
    case "$hook_event_name" in
      Start|UserPromptSubmit) event="start" ;;
      Stop) event="needs_input" ;;
      PermissionRequest) event="needs_input" ;;
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

payload=$(printf '{"session_id":"%s","provider":"codex","event":"%s","source":"%s"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event" "$source")
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $hook_token" \
  -d "$payload" \
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
            if started.elapsed() > Duration::from_secs(2) {
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

    fn codex_wrapper_notifications_for_tui_line(line: &str) -> String {
        let base = ScratchDir::new("codex-tui-event");
        let wrapper_dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let real_dir = base.path().join("real-bin");
        fs::create_dir_all(&real_dir).unwrap();

        let capture_path = base.path().join("notifications.log");
        let session_log_path = base.path().join("session.jsonl");
        write_executable(
            &wrapper_dir.join("acorn-codex-notify"),
            "#!/bin/sh\nprintf '%s %s\\n' \"$1\" \"$2\" >> \"$ACORN_NOTIFY_CAPTURE\"\n",
        )
        .unwrap();
        write_executable(
            &real_dir.join("codex"),
            r#"#!/bin/sh
: > "$CODEX_TUI_SESSION_LOG_PATH"
sleep 0.1
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
            .env("ACORN_NOTIFY_CAPTURE", &capture_path)
            .env("ACORN_TEST_TUI_LINE", line)
            .env("CODEX_TUI_SESSION_LOG_PATH", &session_log_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());

        fs::read_to_string(capture_path).unwrap_or_default()
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
        assert!(wrapper
            .contains("notify=[\\\"bash\\\",\\\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\\\"]"));
        assert!(wrapper.contains("CODEX_TUI_RECORD_SESSION=1"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_URL"));
        assert!(wrapper.contains("\"$_acorn_notify\" start turn"));
        assert!(wrapper.contains("\"$_acorn_notify\" start tool"));

        let notify = fs::read_to_string(dir.join("acorn-codex-notify")).unwrap();
        assert!(notify.contains("\"provider\":\"codex\""));
        assert!(notify.contains("source=\"${2-hook}\""));
        assert!(notify.contains("\"source\":\"%s\""));
        // A completed turn awaits the user's next instruction, so turn
        // completion maps to needs_input like approval and question events.
        assert!(notify
            .contains("agent-turn-complete|task_complete|turn_complete) event=\"needs_input\""));
        assert!(notify.contains("Stop) event=\"needs_input\""));
        assert!(notify.contains(
            "exec_approval_request|apply_patch_approval_request|request_user_input) event=\"needs_input\""
        ));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
    }

    #[test]
    fn codex_wrapper_maps_current_tui_user_turn_to_turn_start() {
        let line = r#"{"ts":"2026-07-14T05:31:15.813Z","dir":"from_tui","kind":"op","payload":{"UserTurn":{"items":[{"type":"text","text":"Fix the bug."}]}}}"#;

        assert_eq!(codex_wrapper_notifications_for_tui_line(line), "start turn\n");
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
