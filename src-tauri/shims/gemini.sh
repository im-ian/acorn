#!/bin/sh
# Acorn `gemini` shim. Prepended onto every Acorn-spawned PTY's PATH so
# that when the user runs `gemini` inside a terminal session, Acorn can
# slip in `--session-id $ACORN_RESUME_TOKEN`. That token is stable per
# Acorn session, making Gemini sessions traceable to the pane that spawned
# them.

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

REAL="$(command -v gemini 2>/dev/null || true)"
if [ -z "$REAL" ] || [ "$REAL" = "$0" ]; then
    echo "acorn shim: real 'gemini' not found on PATH" >&2
    exit 127
fi

if [ -n "$ACORN_RESUME_TOKEN" ]; then
    has_session_id=0
    for arg in "$@"; do
        case "$arg" in
            --session-id|--session-id=*|-r|--resume|--resume=*|--list-sessions|--delete-session|--delete-session=*) has_session_id=1; break ;;
        esac
    done
    if [ "$has_session_id" -eq 0 ]; then
        exec "$REAL" --session-id "$ACORN_RESUME_TOKEN" "$@"
    fi
fi

exec "$REAL" "$@"
