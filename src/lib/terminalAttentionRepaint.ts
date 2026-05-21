import type { SessionStatus } from "./types";

const ATTENTION_STATUSES = new Set<SessionStatus>([
  "needs_input",
  "failed",
  "completed",
]);

export function shouldRepaintTerminalForStatusTransition(
  previous: SessionStatus | null,
  next: SessionStatus | null,
): boolean {
  return previous === "running" && next !== null && ATTENTION_STATUSES.has(next);
}

export interface TranscriptAdvanceRepaintInput {
  activeSessionId: string;
  eventSessionId: string | null;
  isActive: boolean;
}

export function shouldRepaintTerminalForTranscriptAdvance({
  activeSessionId,
  eventSessionId,
  isActive,
}: TranscriptAdvanceRepaintInput): boolean {
  return isActive && eventSessionId === activeSessionId;
}
