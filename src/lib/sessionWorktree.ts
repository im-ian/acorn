import type { Session } from "./types";

export function hasRecordedWorktree(session: Session): boolean {
  return session.isolated || session.in_worktree;
}
