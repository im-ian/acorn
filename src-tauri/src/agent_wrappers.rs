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

const CODEX_WRAPPER_BODY: &str = r#"#!/bin/sh
_acorn_find_real_binary() {
  _acorn_name="$1"
  _acorn_old_ifs=$IFS
  IFS=:
  for _acorn_dir in $PATH; do
    [ -n "$_acorn_dir" ] || continue
    _acorn_dir=${_acorn_dir%/}
    case "$_acorn_dir" in
      "$ACORN_AGENT_WRAPPER_DIR") continue ;;
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

if [ -n "${ACORN_AGENT_HOOK_URL-}" ] &&
   [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ] &&
   [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
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
            "$_acorn_notify" start >/dev/null 2>&1 || true
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
              "$_acorn_notify" start >/dev/null 2>&1 || true
            fi
          else
            "$_acorn_notify" start >/dev/null 2>&1 || true
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
    # Codex's turn-completion events (Stop / agent-turn-complete / task_complete)
    # mean the agent finished the turn and is awaiting the user, so they map to
    # needs_input. Codex emits no "process exited" event here — that shows up as
    # the status poll observing an idle shell.
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
        agent-turn-complete|task_complete) event="needs_input" ;;
        exec_approval_request|apply_patch_approval_request|request_user_input) event="needs_input" ;;
      esac
    fi
    [ -n "$event" ] || exit 0
    ;;
esac

[ -n "${ACORN_AGENT_HOOK_URL-}" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_TOKEN-}" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

payload=$(printf '{"session_id":"%s","provider":"codex","event":"%s","source":"hook"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event")
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $ACORN_AGENT_HOOK_TOKEN" \
  -d "$payload" \
  "$ACORN_AGENT_HOOK_URL" >/dev/null 2>&1 || true
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
_acorn_find_real_binary() {
  _acorn_name="$1"
  _acorn_old_ifs=$IFS
  IFS=:
  for _acorn_dir in $PATH; do
    [ -n "$_acorn_dir" ] || continue
    _acorn_dir=${_acorn_dir%/}
    case "$_acorn_dir" in
      "$ACORN_AGENT_WRAPPER_DIR") continue ;;
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

if [ -n "${ACORN_AGENT_HOOK_URL-}" ] &&
   [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ] &&
   [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
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
# Claude fires Stop at the end of every assistant turn — it has finished
# responding and is awaiting the user's next prompt — so Stop maps to
# needs_input, matching the transcript classifier's end_turn semantics.
# SubagentStop fires mid-turn (a Task subagent finished) so it re-asserts
# Running. Claude has no "process exited" hook; that shows up as the status
# poll observing an idle shell.
case "$hook_event_name" in
  SessionStart|UserPromptSubmit|SubagentStop) event="start" ;;
  Stop|Notification|PermissionRequest) event="needs_input" ;;
  Error) event="error" ;;
esac
[ -n "$event" ] || exit 0

[ -n "${ACORN_AGENT_HOOK_URL-}" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_TOKEN-}" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

payload=$(printf '{"session_id":"%s","provider":"claude","event":"%s","source":"hook"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event")
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $ACORN_AGENT_HOOK_TOKEN" \
  -d "$payload" \
  "$ACORN_AGENT_HOOK_URL" >/dev/null 2>&1 || true
"#;

const ANTIGRAVITY_WRAPPER_BODY: &str = r#"#!/bin/sh
_acorn_find_real_binary() {
  _acorn_name="$1"
  _acorn_old_ifs=$IFS
  IFS=:
  for _acorn_dir in $PATH; do
    [ -n "$_acorn_dir" ] || continue
    _acorn_dir=${_acorn_dir%/}
    case "$_acorn_dir" in
      "$ACORN_AGENT_WRAPPER_DIR") continue ;;
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

if [ -n "${ACORN_AGENT_HOOK_URL-}" ] &&
   [ -n "${ACORN_AGENT_HOOK_TOKEN-}" ] &&
   [ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] &&
   [ -n "${ACORN_AGENT_WRAPPER_DIR-}" ] &&
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
    # re-asserts Running rather than ending the turn — only Stop is complete.
    case "$hook_event_name" in
      SessionStart|UserPromptSubmit|PreToolUse|SubagentStop) event="start" ;;
      Stop) event="stop" ;;
      Notification|PermissionRequest) event="needs_input" ;;
      Error) event="error" ;;
    esac
    [ -n "$event" ] || exit 0
    ;;
esac

[ -n "${ACORN_AGENT_HOOK_URL-}" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_TOKEN-}" ] || exit 0
[ -n "${ACORN_AGENT_HOOK_SESSION_ID-}" ] || exit 0

payload=$(printf '{"session_id":"%s","provider":"antigravity","event":"%s","source":"hook"}' "$ACORN_AGENT_HOOK_SESSION_ID" "$event")
curl -sf -X POST \
  -H 'Content-Type: application/json' \
  -H "X-Acorn-Agent-Hook-Token: $ACORN_AGENT_HOOK_TOKEN" \
  -d "$payload" \
  "$ACORN_AGENT_HOOK_URL" >/dev/null 2>&1 || true
"#;

pub fn ensure_agent_wrapper_dir() -> io::Result<PathBuf> {
    ensure_agent_wrapper_dir_at(&acorn_daemon::paths::data_dir()?)
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
    "SubagentStop": [{{"hooks":[{{"type":"command","command":"{cmd}"}}]}}],
    "Notification": [{{"hooks":[{{"type":"command","command":"{cmd}"}}]}}],
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

    #[test]
    fn writes_codex_wrapper_and_notify_helper() {
        let base = ScratchDir::new("codex");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("codex")).unwrap();
        assert!(wrapper.contains("--enable hooks"));
        assert!(!wrapper.contains("--enable codex_hooks"));
        assert!(wrapper
            .contains("notify=[\\\"bash\\\",\\\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\\\"]"));
        assert!(wrapper.contains("CODEX_TUI_RECORD_SESSION=1"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_URL"));

        let notify = fs::read_to_string(dir.join("acorn-codex-notify")).unwrap();
        assert!(notify.contains("\"provider\":\"codex\""));
        // Turn-completion events map to needs_input (awaiting the user), not a
        // per-turn "completed"; Codex emits no process-exit hook here.
        assert!(notify.contains("agent-turn-complete|task_complete) event=\"needs_input\""));
        assert!(notify.contains("Stop) event=\"needs_input\""));
        assert!(!notify.contains("event=\"stop\""));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
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
        // SubagentStop re-asserts Running (grouped with start); per-turn Stop
        // maps to needs_input (awaiting the user), and Claude emits no "stop"
        // (Completed) event at all — process exit is observed as idle.
        assert!(notify.contains("SessionStart|UserPromptSubmit|SubagentStop"));
        assert!(notify.contains("Stop|Notification|PermissionRequest) event=\"needs_input\""));
        assert!(!notify.contains("event=\"stop\""));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));

        let settings = fs::read_to_string(dir.join("acorn-claude-settings.json")).unwrap();
        let notify_path = dir.join("acorn-claude-notify").display().to_string();
        assert!(settings.contains("\"SessionStart\""));
        assert!(settings.contains("\"UserPromptSubmit\""));
        assert!(settings.contains("\"Stop\""));
        assert!(settings.contains("\"SubagentStop\""));
        assert!(settings.contains("\"Notification\""));
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
        for (claude_event, acorn_event) in [
            ("SessionStart", "start"),
            ("UserPromptSubmit", "start"),
            ("Stop", "needs_input"),
            ("SubagentStop", "start"),
            ("Notification", "needs_input"),
            ("PermissionRequest", "needs_input"),
            ("Error", "error"),
        ] {
            assert!(
                notify.contains(claude_event),
                "notify missing claude event {claude_event}"
            );
            assert!(
                notify.contains(&format!("event=\"{acorn_event}\"")),
                "notify missing acorn event mapping {acorn_event}"
            );
        }
    }

    #[test]
    fn writes_antigravity_wrapper_and_notify_helper() {
        let base = ScratchDir::new("antigravity");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("agy")).unwrap();
        assert!(wrapper.contains("_acorn_find_real_binary agy"));
        assert!(wrapper.contains(".system_generated/logs/transcript.jsonl"));
        assert!(wrapper.contains("ANTIGRAVITY_DIR"));
        assert!(wrapper.contains("GEMINI_DIR"));
        assert!(wrapper.contains("acorn-antigravity-notify"));
        assert!(wrapper.contains("PLANNER_RESPONSE"));
        assert!(wrapper.contains("USER_INPUT"));

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
        // SubagentStop fires mid-turn, so it re-asserts Running; only the
        // main-agent Stop ends the turn.
        assert!(notify.contains("SubagentStop) event=\"start\""));
        assert!(notify.contains("Stop) event=\"stop\""));
    }
}
