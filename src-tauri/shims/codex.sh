#!/bin/sh
# Acorn `codex` shim. Codex has no deterministic create-or-resume
# flag (unlike claude's `--session-id <uuid>`); it auto-mints a
# session UUID and writes it into the filename of a rollout-*.jsonl
# under $CODEX_HOME/sessions/. The shim captures that UUID on first
# zero-arg run so subsequent zero-arg invocations can deterministically
# resume the same conversation via `codex resume <uuid>`, even after
# Acorn (or the user's shell) restarts.
#
# Storage: `$ACORN_AGENT_STATE_DIR/codex.id` (per Acorn session).
# Non-default invocations (`codex resume`, `codex exec`, `codex --help`,
# etc.) passthrough untouched.
#
# POSIX shell builtins + `command`/`exec`/`mkdir`/`ls`/`awk`/`rm` only.
# `awk` is the one non-builtin; it ships in every macOS/Linux base.

case "$0" in
    */*) SHIM_DIR=${0%/*} ;;
    *) SHIM_DIR=. ;;
esac

NEW_PATH=""
old_ifs="$IFS"
IFS=':'
for entry in $PATH; do
    [ -z "$entry" ] && continue
    [ "$entry" = "$SHIM_DIR" ] && continue
    if [ -z "$NEW_PATH" ]; then
        NEW_PATH="$entry"
    else
        NEW_PATH="$NEW_PATH:$entry"
    fi
done
IFS="$old_ifs"
PATH="$NEW_PATH"
export PATH

REAL="$(command -v codex 2>/dev/null || true)"
if [ -z "$REAL" ] || [ "$REAL" = "$0" ]; then
    echo "acorn shim: real 'codex' not found on PATH" >&2
    exit 127
fi

# Passthrough for anything that isn't the bare `codex` invocation.
if [ $# -gt 0 ] || [ -z "${ACORN_AGENT_STATE_DIR:-}" ]; then
    exec "$REAL" "$@"
fi

ID_FILE="$ACORN_AGENT_STATE_DIR/codex.id"

if [ -s "$ID_FILE" ]; then
    # `read` is a POSIX builtin so we do not require `cat` on PATH.
    SID=""
    while IFS= read -r line; do
        [ -n "$line" ] && SID="$line" && break
    done <"$ID_FILE"
    if [ -n "$SID" ]; then
        exec "$REAL" resume "$SID"
    fi
fi

# First zero-arg run: snapshot existing rollout files, run codex,
# then diff to find the newly created file and capture its UUID.
mkdir -p "$ACORN_AGENT_STATE_DIR" 2>/dev/null
SESSIONS_ROOT="${CODEX_HOME:-$HOME/.codex}/sessions"
BEFORE="$ACORN_AGENT_STATE_DIR/.codex-rollouts-before.$$"
ls -1 "$SESSIONS_ROOT"/*/*/*/rollout-*.jsonl 2>/dev/null | sort >"$BEFORE"

"$REAL"
rc=$?

NEW_PATH_FOUND=$(
    ls -1 "$SESSIONS_ROOT"/*/*/*/rollout-*.jsonl 2>/dev/null \
        | sort \
        | awk -v before="$BEFORE" '
            BEGIN { while ((getline line < before) > 0) seen[line]=1 }
            !($0 in seen) { last=$0 }
            END { print last }
          '
)
rm -f "$BEFORE"

if [ -n "$NEW_PATH_FOUND" ]; then
    STEM=${NEW_PATH_FOUND##*/}
    STEM=${STEM%.jsonl}
    # Codex names rollouts `rollout-<ISO timestamp>-<UUID>` and the
    # UUID is always the trailing 36 chars (8-4-4-4-12 hex).
    UUID=$(printf '%s' "$STEM" | awk '{n=length($0); if (n>=36) print substr($0, n-35, 36)}')
    case "$UUID" in
        ????????-????-????-????-????????????)
            printf '%s\n' "$UUID" >"$ID_FILE"
            ;;
    esac
fi

exit $rc
