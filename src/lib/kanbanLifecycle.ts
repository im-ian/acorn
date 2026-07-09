import type { PullRequestInfo, Session } from "./types";

/**
 * Lifecycle stage of a session on the workspace kanban. Unlike `SessionStatus`
 * (the agent's instantaneous state) a stage describes where the work item sits
 * in a left-to-right flow: Idle → Working → Waiting → Review → Done. Stages are
 * derived, never stored — see `deriveKanbanStage`.
 */
export type KanbanLifecycleStage =
  | "idle"
  | "working"
  | "waiting"
  | "review"
  | "done";

/** Column order for the board, left to right. Single source of truth. */
export const KANBAN_LIFECYCLE_STAGES: readonly KanbanLifecycleStage[] = [
  "idle",
  "working",
  "waiting",
  "review",
  "done",
];

/** A Working session with no live process for this long is flagged as stalled. */
export const KANBAN_STALL_THRESHOLD_MS = 5 * 60_000;

export interface KanbanStageContext {
  /** PR whose head branch matches the session branch, if any. */
  pr: PullRequestInfo | null;
  /** Whether the session worktree has uncommitted changes. */
  hasDiff: boolean;
  /** User pinned the card to Done via the card menu. */
  manualDone: boolean;
}

export const EMPTY_KANBAN_STAGE_CONTEXT: KanbanStageContext = {
  pr: null,
  hasDiff: false,
  manualDone: false,
};

function prStateUpper(pr: PullRequestInfo | null): string | null {
  return pr ? pr.state.toUpperCase() : null;
}

/**
 * Map a session plus its board context onto a lifecycle stage. Precedence
 * (first match wins):
 *
 * 1. manual done pin        → done
 * 2. PR merged/closed       → done
 * 3. agent running          → working
 * 4. turn done + dirty tree → review
 * 5. waiting/error          → waiting
 * 6. open PR                → review
 * 7. otherwise              → idle
 *
 * Running/waiting outrank the open-PR rule on purpose: a session that is
 * actively working (or blocked on the user) stays in its live column even
 * while its PR is open, and only settles into Review when the agent goes
 * quiet.
 */
export function deriveKanbanStage(
  session: Session,
  context: KanbanStageContext,
): KanbanLifecycleStage {
  if (context.manualDone) return "done";
  const prState = prStateUpper(context.pr);
  if (prState === "MERGED" || prState === "CLOSED") return "done";
  if (session.status === "working") return "working";
  if (session.status === "waiting_for_input" && context.hasDiff) {
    return "review";
  }
  if (session.status === "waiting_for_input" || session.status === "errored") {
    return "waiting";
  }
  if (prState === "OPEN") return "review";
  return "idle";
}

/** When a session entered its current stage. */
export interface KanbanStageDwell {
  stage: KanbanLifecycleStage;
  since: number;
}

/**
 * Advance the dwell map for one derivation pass. Sessions keep their `since`
 * while the stage is unchanged, restart it on a stage change, and drop out of
 * the map entirely when absent from `stages` (removed session or filtered
 * board). Returns a new map; never mutates `previous`.
 */
export function updateKanbanStageDwell(
  previous: ReadonlyMap<string, KanbanStageDwell>,
  stages: ReadonlyMap<string, KanbanLifecycleStage>,
  now: number,
): Map<string, KanbanStageDwell> {
  const next = new Map<string, KanbanStageDwell>();
  for (const [sessionId, stage] of stages) {
    const prior = previous.get(sessionId);
    next.set(
      sessionId,
      prior && prior.stage === stage ? prior : { stage, since: now },
    );
  }
  return next;
}

/**
 * A Working session that has stayed in that state without any observed live
 * process is likely stale. `updated_at` is intentionally ignored because
 * lightweight status polling does not bump persisted session recency.
 */
export function isKanbanSessionStalled(
  session: Session,
  stage: KanbanLifecycleStage,
  now: number,
): boolean {
  if (stage !== "working") return false;
  if ((session.active_processes ?? []).length > 0) return false;
  const statusStartedAt = Date.parse(session.status_started_at ?? "");
  if (!Number.isFinite(statusStartedAt)) return false;
  return now - statusStartedAt >= KANBAN_STALL_THRESHOLD_MS;
}

/**
 * Compact dwell label for cards: 45s, 12m, 3h, 2d. Sub-second (and clock-skew
 * negative) durations render as 0s.
 */
export function formatKanbanDwell(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
