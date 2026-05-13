#!/bin/sh
# Acorn `claude` shim. Prepended onto every Acorn-spawned PTY's PATH so
# that Acorn can track which Claude JSONL transcript belongs to which
# Acorn session. The shim does NOT auto-resume — it lets the user (or
# Acorn's UI modal) decide via `claude --resume <id>`. On a fresh
# zero-flag invocation it snapshots `~/.claude/projects/<slug>/` before
# and after to capture the UUID of the new transcript, then writes it to
# `$ACORN_AGENT_STATE_DIR/claude.id`. That id is what the focus-time
# modal reads to offer "이전 대화 이어하기".
#
# Passthrough rules:
#   - explicit `--resume`, `--continue`, or `--session-id` from the user
#     wins — shim does not interfere with argv at all
#   - any flag/subcommand passes through; only the bare `claude` (or
#     `claude` with non-conflicting flags) gets the snapshot/capture
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

REAL="$(command -v claude 2>/dev/null || true)"
if [ -z "$REAL" ] || [ "$REAL" = "$0" ]; then
    echo "acorn shim: real 'claude' not found on PATH" >&2
    exit 127
fi

# Detect user-supplied flags that already pin a session id. In that case
# we do nothing — claude is fully in charge of which transcript it
# touches. We also skip when ACORN_AGENT_STATE_DIR is unset (e.g. a
# legacy session spawned before this shim landed).
for arg in "$@"; do
    case "$arg" in
        --resume|--resume=*|--continue|--session-id|--session-id=*)
            exec "$REAL" "$@"
            ;;
    esac
done

if [ -z "${ACORN_AGENT_STATE_DIR:-}" ]; then
    exec "$REAL" "$@"
fi

# Snapshot the projects-root tree of JSONL files before the run, so the
# post-run diff finds whichever fresh `<uuid>.jsonl` claude created. The
# transcript lives at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`;
# `<encoded-cwd>` shifts across claude versions so we scan the whole
# projects/ root for any new `*.jsonl`.
mkdir -p "$ACORN_AGENT_STATE_DIR" 2>/dev/null
PROJECTS_ROOT="${HOME}/.claude/projects"
BEFORE="$ACORN_AGENT_STATE_DIR/.claude-jsonls-before.$$"
ls -1 "$PROJECTS_ROOT"/*/*.jsonl 2>/dev/null | sort >"$BEFORE"

"$REAL" "$@"
rc=$?

NEW_PATH_FOUND=$(
    ls -1 "$PROJECTS_ROOT"/*/*.jsonl 2>/dev/null \
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
    UUID=${STEM%.jsonl}
    # Claude transcript filenames are bare UUIDs (8-4-4-4-12 hex).
    case "$UUID" in
        ????????-????-????-????-????????????)
            printf '%s\n' "$UUID" >"$ACORN_AGENT_STATE_DIR/claude.id"
            ;;
    esac
fi

exit $rc
