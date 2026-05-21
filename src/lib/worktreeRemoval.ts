import type { Session } from "./types";

const ACORN_WORKTREE_BASENAME_RE = /^acorn-worktree-\d+(?:-\d+)?$/;

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function isNamedAcornWorktree(path: string): boolean {
  return ACORN_WORKTREE_BASENAME_RE.test(basename(path));
}

export function shouldOfferWorktreeRemoval(session: Session | null): boolean {
  if (!session) return false;
  if (session.isolated) return true;
  if (!session.in_worktree) return false;
  return (
    isNamedAcornWorktree(session.worktree_path) ||
    isNamedAcornWorktree(session.repo_path)
  );
}
