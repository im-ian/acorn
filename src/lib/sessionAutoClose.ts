import { useAppStore } from "../store";
import { hasActiveAgentSignal } from "./sessionAgentState";
import type { Session, SessionStatus, SessionStatusReason } from "./types";

export function shouldAutoCloseFinishedSession(
  session: Session,
  previousStatus: SessionStatus,
  enabled: boolean,
  hadActiveAgentSignal = false,
  previousStatusReason: SessionStatusReason | null = null,
): boolean {
  const statusReason = session.status_reason ?? null;
  const statusSignalChanged =
    previousStatus !== session.status || previousStatusReason !== statusReason;
  const activeAgentSignal = hasActiveAgentSignal(session);
  const completedByHook = session.status === "completed";
  // `needs_input` can also mean an approval/permission request. Status polling
  // marks transcript-level final answers as `turn_complete`; auto-close only
  // trusts that explicit reason.
  const needsInputAfterTurnComplete =
    session.status === "needs_input" && statusReason === "turn_complete";
  // Agent transcripts normally finish as needs_input, but a fast process exit
  // can collapse the next observed state to idle after the run.
  const returnedIdleAfterRun =
    previousStatus === "running" && session.status === "idle";

  return (
    enabled &&
    session.kind === "regular" &&
    statusSignalChanged &&
    (completedByHook || needsInputAfterTurnComplete || returnedIdleAfterRun) &&
    (hadActiveAgentSignal || activeAgentSignal)
  );
}

export function startSessionAutoCloseWatcher(): () => void {
  const lastStatus = new Map<string, SessionStatus>();
  const lastStatusReason = new Map<string, SessionStatusReason | null>();
  const lastActiveAgentSignal = new Map<string, boolean>();
  const closingIds = new Set<string>();
  for (const session of useAppStore.getState().sessions) {
    lastStatus.set(session.id, session.status);
    lastStatusReason.set(session.id, session.status_reason ?? null);
    lastActiveAgentSignal.set(session.id, hasActiveAgentSignal(session));
  }

  return useAppStore.subscribe((state) => {
    const sessions = state.sessions;

    for (const session of sessions) {
      const previousStatus = lastStatus.get(session.id);
      const previousStatusReason = lastStatusReason.get(session.id) ?? null;
      const previousHadActiveAgentSignal = Boolean(
        lastActiveAgentSignal.get(session.id),
      );
      const activeAgentSignal = hasActiveAgentSignal(session);
      lastStatus.set(session.id, session.status);
      lastStatusReason.set(session.id, session.status_reason ?? null);
      lastActiveAgentSignal.set(session.id, activeAgentSignal);
      if (
        previousStatus === undefined ||
        !shouldAutoCloseFinishedSession(
          session,
          previousStatus,
          Boolean(state.autoCloseSessionIds[session.id]),
          previousHadActiveAgentSignal,
          previousStatusReason,
        ) ||
        closingIds.has(session.id)
      ) {
        continue;
      }

      closingIds.add(session.id);
      queueMicrotask(() => {
        const latest = useAppStore.getState();
        const stillPresent = latest.sessions.some(
          (candidate) => candidate.id === session.id,
        );
        const stillEnabled = Boolean(latest.autoCloseSessionIds[session.id]);
        if (!stillEnabled || !stillPresent) {
          closingIds.delete(session.id);
          return;
        }
        void useAppStore
          .getState()
          .removeSession(session.id, false)
          .finally(() => {
            closingIds.delete(session.id);
          });
      });
    }

    const known = new Set(sessions.map((session) => session.id));
    for (const id of lastStatus.keys()) {
      if (!known.has(id)) lastStatus.delete(id);
    }
    for (const id of lastStatusReason.keys()) {
      if (!known.has(id)) lastStatusReason.delete(id);
    }
    for (const id of lastActiveAgentSignal.keys()) {
      if (!known.has(id)) lastActiveAgentSignal.delete(id);
    }
    for (const id of closingIds) {
      if (!known.has(id)) closingIds.delete(id);
    }
  });
}
