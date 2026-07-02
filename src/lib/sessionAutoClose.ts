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
  // A hooked agent settles at needs_input between turns, then collapses to idle
  // when its process exits; a non-hooked or fast exit can go straight from
  // running to idle. Treat an exit from either the working (running) or resting
  // (needs_input) state as the run ending — but never the running→needs_input
  // turn boundary itself, so an interactive session is not closed mid-work.
  const returnedIdleAfterRun =
    (previousStatus === "running" || previousStatus === "needs_input") &&
    session.status === "idle";

  return (
    enabled &&
    session.kind === "regular" &&
    statusSignalChanged &&
    (completedByHook || needsInputAfterTurnComplete || returnedIdleAfterRun) &&
    (hadActiveAgentSignal || activeAgentSignal)
  );
}

// Auto-close must only ever remove sessions that are still finished at the
// moment of removal; anything else (notably `running`) means a new turn
// started after the close was queued.
function isStillFinished(session: Session): boolean {
  return (
    session.status === "completed" ||
    (session.status === "needs_input" &&
      (session.status_reason ?? null) === "turn_complete") ||
    session.status === "idle"
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
        const latestSession = latest.sessions.find(
          (candidate) => candidate.id === session.id,
        );
        const stillEnabled = Boolean(latest.autoCloseSessionIds[session.id]);
        // Re-validate against the freshest state: the status can flip back to
        // `running` in the same tick (a new turn), and removal kills the pty.
        if (!stillEnabled || !latestSession || !isStillFinished(latestSession)) {
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
