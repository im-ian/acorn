import type { Session, SessionKind } from "./types";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Pick a session name that doesn't collide with any name in `existing`.
 *
 * Isolated sessions follow a `{repo}-worktree-{n}` convention (n starts at 1)
 * because each one maps to a linked git worktree at
 * `.acorn/worktrees/<name>/`, and matching the directory grouping in the
 * sidebar makes "which worktree is this?" obvious. Control sessions get a
 * `control-` prefix so they sort into their own namespace. Regular sessions
 * use the bare repo basename and only get a numeric suffix on collision.
 *
 * The numeric suffix is purely a frontend-side hint — the Rust backend's
 * `create_unique_worktree` still re-suffixes on its own if the candidate
 * collides with an existing branch or worktree, so a stale state where the
 * frontend's `existing` snapshot lags reality still produces a valid result.
 */
export function suggestSessionName(
  repoPath: string,
  existing: Session[],
  kind: SessionKind = "regular",
  isolated: boolean = false,
): string {
  const taken = new Set(existing.map((s) => s.name));
  if (isolated) {
    const base = `${basename(repoPath)}-worktree`;
    let n = 1;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }
  const base =
    kind === "control"
      ? `control-${basename(repoPath)}`
      : basename(repoPath);
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}
