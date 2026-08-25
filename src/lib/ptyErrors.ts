/**
 * True when a PTY write/resize/kill failed because this session has no live
 * PTY handle yet — in-process manager miss (`no pty for session <id>`) or
 * daemon registry miss (`no pty for <id>`). Resume can queue for the next
 * spawn in that window; other failures should stay visible.
 */
export function isMissingPtyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no pty for(?: session)? /i.test(message);
}
