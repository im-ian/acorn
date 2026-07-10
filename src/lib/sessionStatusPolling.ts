import type { Session, SessionStatus } from "./types";

export const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 1000;
export const VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS = 5000;
export const STABLE_SESSION_STATUS_POLL_INTERVAL_MS = 30000;

type PollScheduleArgs = {
  sessions: Session[];
  activeSessionId: string | null;
  lastPolledAt: ReadonlyMap<string, number>;
  now: number;
};

type ImmediatePollArgs = Omit<PollScheduleArgs, "now"> & {
  includeVolatile?: boolean;
};

export function isVolatileSessionStatus(status: SessionStatus): boolean {
  return status === "working" || status === "waiting_for_input";
}

function isVolatileSession(
  session: Pick<Session, "status" | "agent_provider">,
): boolean {
  return (
    session.agent_provider != null || isVolatileSessionStatus(session.status)
  );
}

export function sessionStatusPollIntervalMs(
  session: Pick<Session, "id" | "status" | "agent_provider">,
  activeSessionId: string | null,
): number {
  if (session.id === activeSessionId) {
    return ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS;
  }
  if (isVolatileSession(session)) {
    return VOLATILE_SESSION_STATUS_POLL_INTERVAL_MS;
  }
  return STABLE_SESSION_STATUS_POLL_INTERVAL_MS;
}

export function selectDueSessionStatusPollIds({
  sessions,
  activeSessionId,
  lastPolledAt,
  now,
}: PollScheduleArgs): string[] {
  return sessions
    .filter((session) => {
      const last = lastPolledAt.get(session.id);
      if (last === undefined) return true;
      const interval = sessionStatusPollIntervalMs(session, activeSessionId);
      return now - last >= interval;
    })
    .map((session) => session.id);
}

export function selectImmediateSessionStatusPollIds({
  sessions,
  activeSessionId,
  lastPolledAt,
  includeVolatile = false,
}: ImmediatePollArgs): string[] {
  return sessions
    .filter(
      (session) =>
        session.id === activeSessionId ||
        !lastPolledAt.has(session.id) ||
        (includeVolatile && isVolatileSession(session)),
    )
    .map((session) => session.id);
}

export function nextSessionStatusPollDelayMs({
  sessions,
  activeSessionId,
  lastPolledAt,
  now,
}: PollScheduleArgs): number | null {
  if (sessions.length === 0) return null;

  let nextDelay = STABLE_SESSION_STATUS_POLL_INTERVAL_MS;
  for (const session of sessions) {
    const last = lastPolledAt.get(session.id);
    if (last === undefined) return 0;

    const interval = sessionStatusPollIntervalMs(session, activeSessionId);
    const remaining = Math.max(0, interval - (now - last));
    nextDelay = Math.min(nextDelay, remaining);
  }
  return nextDelay;
}
