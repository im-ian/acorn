#!/bin/sh
# Acorn `claude` shim. Prepended onto every Acorn-spawned PTY's PATH so
# that when the user runs `claude` inside a terminal session, Acorn can
# slip in `--session-id $ACORN_RESUME_TOKEN`. That token is stable per
# Acorn session, so claude's JSONL conversation file is reachable again
# across Acorn restarts.
#
# The shim strips its own directory from PATH before resolving the real
# binary, otherwise `command -v claude` would resolve back to us. We
# deliberately use only POSIX shell builtins + `command`/`exec` so the
# shim does not depend on `dirname`, `cd`, `pwd`, or any other utility
# being on PATH.

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

REAL="$(command -v claude 2>/dev/null || true)"
if [ -z "$REAL" ] || [ "$REAL" = "$0" ]; then
    echo "acorn shim: real 'claude' not found on PATH" >&2
    exit 127
fi

if [ -n "$ACORN_RESUME_TOKEN" ]; then
    has_session_id=0
    has_name=0
    for arg in "$@"; do
        case "$arg" in
            --session-id|--session-id=*|-r|--resume|--resume=*|-c|--continue) has_session_id=1 ;;
            -n|--name|--name=*) has_name=1 ;;
        esac
    done
    if [ "$has_session_id" -eq 0 ] && [ "$has_name" -eq 0 ]; then
        exec "$REAL" --session-id "$ACORN_RESUME_TOKEN" --name "acorn-$ACORN_RESUME_TOKEN" "$@"
    fi
    if [ "$has_session_id" -eq 0 ]; then
        exec "$REAL" --session-id "$ACORN_RESUME_TOKEN" "$@"
    fi
fi

exec "$REAL" "$@"
