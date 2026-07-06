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
  // `waiting_for_input` can also mean an approval/permission request. Status
  // polling marks transcript-level final answers as `turn_complete`; auto-close
  // only trusts that explicit reason.
  const waitingForInputAfterTurnComplete =
    session.status === "waiting_for_input" && statusReason === "turn_complete";
  // A hooked agent settles at waiting_for_input between turns, then collapses
  // to ready when its process exits; a non-hooked or fast exit can go straight
  // from working to ready. Treat an exit from either the working or resting
  // state as the run ending — but never the working→waiting_for_input turn
  // boundary itself, so an interactive session is not closed mid-work.
  const returnedReadyAfterRun =
    (previousStatus === "working" ||
      previousStatus === "waiting_for_input") &&
    session.status === "ready";

  return (
    enabled &&
    session.kind === "regular" &&
    statusSignalChanged &&
    (waitingForInputAfterTurnComplete || returnedReadyAfterRun) &&
    (hadActiveAgentSignal || activeAgentSignal)
  );
}

// Auto-close must only ever remove sessions that are still finished at the
// moment of removal; anything else (notably `working`) means a new turn
// started after the close was queued.
function isStillFinished(session: Session): boolean {
  return (
    (session.status === "waiting_for_input" &&
      (session.status_reason ?? null) === "turn_complete") ||
    session.status === "ready"
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
        // `working` in the same tick (a new turn), and removal kills the pty.
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
