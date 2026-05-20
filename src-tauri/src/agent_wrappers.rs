use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const WRAPPER_DIR_NAME: &str = "agent-wrappers";
const CODEX_WRAPPER_NAME: &str = "codex";
const CODEX_NOTIFY_NAME: &str = "acorn-codex-notify";

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

  "$REAL_BIN" --enable codex_hooks -c "notify=[\"bash\",\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\"]" "$@"
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
    case "$hook_event_name" in
      Start|UserPromptSubmit) event="start" ;;
      Stop) event="stop" ;;
      PermissionRequest) event="needs_input" ;;
      Error) event="error" ;;
    esac
    if [ -z "$event" ]; then
      codex_type=$(printf '%s\n' "$input" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
      case "$codex_type" in
        task_started) event="start" ;;
        agent-turn-complete|task_complete) event="stop" ;;
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

pub fn ensure_agent_wrapper_dir() -> io::Result<PathBuf> {
    ensure_agent_wrapper_dir_at(&acorn_daemon::paths::data_dir()?)
}

fn ensure_agent_wrapper_dir_at(base: &Path) -> io::Result<PathBuf> {
    let dir = base.join(WRAPPER_DIR_NAME);
    fs::create_dir_all(&dir)?;
    write_executable(&dir.join(CODEX_WRAPPER_NAME), CODEX_WRAPPER_BODY)?;
    write_executable(&dir.join(CODEX_NOTIFY_NAME), CODEX_NOTIFY_BODY)?;
    Ok(dir)
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

    #[test]
    fn writes_codex_wrapper_and_notify_helper() {
        let base = ScratchDir::new("codex");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();

        let wrapper = fs::read_to_string(dir.join("codex")).unwrap();
        assert!(wrapper.contains("--enable codex_hooks"));
        assert!(wrapper
            .contains("notify=[\\\"bash\\\",\\\"$ACORN_AGENT_WRAPPER_DIR/acorn-codex-notify\\\"]"));
        assert!(wrapper.contains("CODEX_TUI_RECORD_SESSION=1"));
        assert!(wrapper.contains("ACORN_AGENT_HOOK_URL"));

        let notify = fs::read_to_string(dir.join("acorn-codex-notify")).unwrap();
        assert!(notify.contains("\"provider\":\"codex\""));
        assert!(notify.contains("agent-turn-complete|task_complete"));
        assert!(notify.contains("X-Acorn-Agent-Hook-Token"));
        assert!(notify.contains("ACORN_AGENT_HOOK_SESSION_ID"));
    }

    #[cfg(unix)]
    #[test]
    fn wrapper_files_are_executable() {
        let base = ScratchDir::new("mode");
        let dir = ensure_agent_wrapper_dir_at(base.path()).unwrap();
        let mode = fs::metadata(dir.join("codex"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }
}
