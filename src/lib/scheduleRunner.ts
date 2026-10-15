import {
  buildAgentOneshotCommand,
  buildAgentStartCommand,
  isSessionAgentProvider,
} from "./agentProviderRegistry";
import { api } from "./api";
import { joinPath } from "./pathUtils";
import { isScheduleRunning } from "./scheduleRunStatus";
import { dueScheduleSlotMs } from "./scheduleTrigger";
import { useSettings } from "./settings";
import type {
  ProjectSchedule,
  ScheduleRun,
  Session,
  SessionAgentProvider,
  SessionNotification,
} from "./types";
import { useAppStore } from "../store";

export const SCHEDULE_TICK_MS = 60_000;
export const SCHEDULES_CHANGED_EVENT = "acorn:schedules-changed";
/**
 * How often an open board re-reads a schedule while one of its runs is still
 * going. Nothing announces the agent writing its summary — that happens in the
 * PTY, minutes after the launch — so the only way RUNNING turns into SUCCESS on
 * its own is to look again.
 */
export const SCHEDULE_RUN_POLL_MS = 5_000;
/**
 * How long a background run's hidden session is allowed to live once it stops
 * looking active. Backstop for an agent that died without writing its summary —
 * without it those sessions pile up where the user cannot see or remove them.
 */
export const BACKGROUND_RUN_REAP_AFTER_MS = 6 * 60 * 60 * 1_000;

/**
 * `.acorn/` is Acorn's own ignored directory inside a project, so a summary
 * written there needs no approval to leave the repository and never shows up
 * as an untracked file.
 */
export const SCHEDULE_SUMMARY_DIR = ".acorn/schedule-summaries";

export function notifySchedulesChanged(): void {
  window.dispatchEvent(new CustomEvent(SCHEDULES_CHANGED_EVENT));
}

export function scheduleSummaryPath(repoPath: string, runId: string): string {
  return joinPath(repoPath, `${SCHEDULE_SUMMARY_DIR}/${runId}.md`);
}

export function scheduleRunSessionName(
  schedule: ProjectSchedule,
  nowMs: number,
): string {
  const at = new Date(nowMs);
  const stamp = `${String(at.getMonth() + 1).padStart(2, "0")}/${String(
    at.getDate(),
  ).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(
    at.getMinutes(),
  ).padStart(2, "0")}`;
  return `${schedule.name} · ${stamp}`;
}

/**
 * The schedule's prompt plus the instruction that produces the run's work
 * summary. Nobody watches a scheduled run, so the report it leaves behind is
 * the whole point — and asking for named sections is what lets the board
 * render it as a report instead of a wall of text.
 *
 * Kept to a single line on purpose: the command is typed into a PTY, where a
 * newline is Enter, so the shape is described in prose rather than shown as a
 * template.
 */
export function buildScheduleRunPrompt(
  prompt: string,
  summaryPath: string,
): string {
  return [
    prompt.trim(),
    `When you are done, write your work summary to ${summaryPath} (create the directory if needed) as Markdown with three sections: "## Result" holding one sentence on the outcome, "## Details" holding bullets for what you checked or changed, and "## Follow-up" holding bullets for anything a person should act on (or a single bullet reading "none").`,
  ].join(" ");
}

export function buildScheduleRunCommand(
  schedule: ProjectSchedule,
  agentProvider: SessionAgentProvider,
  summaryPath: string,
): string {
  const prompt = buildScheduleRunPrompt(schedule.prompt, summaryPath);
  return schedule.mode === "oneshot"
    ? buildAgentOneshotCommand(agentProvider, prompt)
    : buildAgentStartCommand(agentProvider, prompt);
}

/**
 * Geometry for a shell nobody renders. The PTY still needs a size, and 120x40
 * keeps agent CLIs from wrapping their output into a narrow default.
 */
const HEADLESS_PTY_COLS = 120;
const HEADLESS_PTY_ROWS = 40;

/**
 * Start a run with no tab and no mounted terminal.
 *
 * `createSession` on the store focuses what it creates and `reconcileWorkspace`
 * hands every session a tab, so a background run goes around both: it creates
 * the row through the api, marks it background *before* the refresh that would
 * place it, then drives the PTY itself the way `Terminal` normally would.
 *
 * The daemon is a hard requirement rather than a preference. An in-process PTY
 * is owned by the `Terminal` that spawned it, and there is no terminal here —
 * only `acornd` keeps the shell alive, across app restarts included.
 */
async function launchBackgroundRun(
  repoPath: string,
  command: string,
  sessionName: string,
  agentProvider: SessionAgentProvider,
): Promise<Session> {
  const daemon = await api.daemonStatus();
  if (!daemon.enabled) {
    throw new Error(
      "background schedules need the acornd daemon, which is off in Settings → Background sessions",
    );
  }
  const created = await api.createSession(
    sessionName,
    repoPath,
    false,
    "regular",
    agentProvider,
  );
  const store = useAppStore.getState();
  store.markSessionBackground(created.id);
  await store.refreshSessions();
  await api.ptySpawn(
    created.id,
    created.worktree_path,
    HEADLESS_PTY_COLS,
    HEADLESS_PTY_ROWS,
  );
  // `Terminal` would type this for us once its PTY came up. A trailing newline
  // is Enter, which is what actually runs the command.
  await api.ptyWrite(created.id, `${command}\n`);
  await api.flushPtyWrite(created.id);
  return created;
}

/**
 * Launch one run and record the attempt. The record lands even when the launch
 * fails, because `last_run_at` is what moves the schedule past this slot — skip
 * it and a broken schedule re-fires on every tick.
 */
export async function launchScheduleRun(
  repoPath: string,
  schedule: ProjectSchedule,
  nowMs = Date.now(),
  /**
   * The slot being consumed, when the scheduler is firing. Omitted for a
   * manual run so pressing "Run now" never moves the schedule.
   */
  slotMs: number | null = null,
): Promise<void> {
  const selected = useSettings.getState().settings.agents.selected;
  const agentProvider = isSessionAgentProvider(selected) ? selected : null;
  // The run id is minted here, not by the store, so the prompt can name the
  // summary file for a run that does not exist on disk yet.
  const runId = crypto.randomUUID();
  const summaryPath = scheduleSummaryPath(repoPath, runId);
  const slotAt = slotMs === null ? null : new Date(slotMs).toISOString();
  let sessionId: string | null = null;
  let worktreePath: string | null = null;
  let error: string | null = null;

  // Nobody is watching a scheduled run, so a session with no agent to hand the
  // prompt to would sit there as a bare shell. Record the reason instead.
  if (!agentProvider) {
    await api.recordProjectScheduleRun(repoPath, schedule.id, {
      id: runId,
      slotAt,
      sessionId: null,
      worktreePath: null,
      summaryPath: null,
      error: "no terminal agent is selected in Settings → Agents",
    });
    notifySchedulesChanged();
    return;
  }

  const command = buildScheduleRunCommand(schedule, agentProvider, summaryPath);
  const sessionName = scheduleRunSessionName(schedule, nowMs);

  // Claim the slot before launching. `last_run_at` is what the due check
  // measures from, so recording only after the launch leaves a window where a
  // second caller — the next tick, a reload that re-runs the startup tick, or
  // "Run now" — still sees the schedule as due and fires it again.
  await api.recordProjectScheduleRun(repoPath, schedule.id, {
    id: runId,
    slotAt,
    sessionId: null,
    worktreePath: null,
    summaryPath,
    error: null,
  });
  // Announce the claim, not just the result: creating the session and spawning
  // its PTY takes seconds, and an open board should show the run as soon as it
  // starts rather than once it is already underway.
  notifySchedulesChanged();

  try {
    if (schedule.background) {
      const created = await launchBackgroundRun(
        repoPath,
        command,
        sessionName,
        agentProvider,
      );
      sessionId = created.id;
      worktreePath = created.worktree_path;
    } else {
      const created = await useAppStore.getState().createSession(
        sessionName,
        repoPath,
        // Scheduled checks read the project as it stands, so they run in the
        // project root rather than minting a worktree branch per run.
        false,
        "regular",
        agentProvider,
        true,
        "terminal",
      );
      const storeError = useAppStore.getState().consumeError();
      if (!created || storeError) {
        error = storeError ?? "failed to create the scheduled session";
      } else {
        sessionId = created.id;
        worktreePath = created.worktree_path;
        useAppStore
          .getState()
          .setPendingTerminalInput(created.id, command, {
            agentProvider,
            adoptWorktreeOnExit: false,
          });
      }
    }
  } catch (cause) {
    error = String(cause);
  }

  await api.updateProjectScheduleRun(repoPath, schedule.id, runId, {
    sessionId,
    worktreePath,
    error,
  });
  notifySchedulesChanged();
}

/**
 * Hidden sessions whose background run is over, so the tick can remove them.
 *
 * A background run is one-shot: the agent answers, exits, and leaves an idle
 * shell in a session the workspace never shows. The summary file is the
 * deliverable, so once it has landed the session is spent — and because it is
 * hidden, nobody can clean it up by hand. Only sessions still flagged
 * background are returned, so one the user revealed is never reaped out from
 * under them.
 */
export function backgroundRunsToReap(
  schedules: readonly ProjectSchedule[],
  liveSessionIds: ReadonlySet<string>,
  backgroundSessionIds: Record<string, true>,
  nowMs: number,
): string[] {
  const reap: string[] = [];
  for (const schedule of schedules) {
    if (!schedule.background) continue;
    for (const run of schedule.runs) {
      const sessionId = run.session_id;
      if (!sessionId) continue;
      if (!liveSessionIds.has(sessionId)) continue;
      if (!backgroundSessionIds[sessionId]) continue;
      const startedAt = Date.parse(run.started_at);
      const expired =
        Number.isFinite(startedAt) &&
        nowMs - startedAt > BACKGROUND_RUN_REAP_AFTER_MS;
      if (run.summary_ready || run.error || expired) reap.push(sessionId);
    }
  }
  return reap;
}

/**
 * Inbox entry for a background run that just ended.
 *
 * The run's session is reaped the moment it finishes, so the notification has
 * to name the *schedule* and route to its board — pointing at the session would
 * be a dead link by the time anyone clicks it. `errored` keeps the danger
 * styling the inbox already has for failures.
 */
export function buildScheduleRunNotification(input: {
  repoPath: string;
  projectName: string;
  schedule: ProjectSchedule;
  run: ScheduleRun;
  createdAt: string;
  seq: number;
}): SessionNotification {
  const failed = Boolean(input.run.error);
  return {
    id: `${input.createdAt}:${input.seq}:${input.schedule.id}:${input.run.id}`,
    sessionId: input.run.session_id ?? "",
    scheduleId: input.schedule.id,
    kind: failed ? "errored" : "schedule_done",
    status: failed ? "errored" : "ready",
    previousStatus: "working",
    // The inbox renders this as the entry's title, which is the whole point of
    // the request: say which job this was.
    sessionName: input.schedule.name,
    projectName: input.projectName,
    repoPath: input.repoPath,
    createdAt: input.createdAt,
  };
}

let scheduleNotificationSeq = 0;

let ticking = false;

/**
 * One tick: launch every due schedule across the registered projects. Runs are
 * launched one at a time — several sessions spawning in the same instant is
 * harder on the machine than a few seconds of stagger.
 */
export async function runDueSchedules(nowMs = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const repoPaths = useAppStore
      .getState()
      .projects.map((project) => project.repo_path);
    for (const repoPath of repoPaths) {
      let schedules: ProjectSchedule[] = [];
      try {
        schedules = await api.listProjectSchedules(repoPath);
      } catch (cause) {
        console.debug("[schedules] list failed", repoPath, cause);
        continue;
      }
      const liveSessionIds = new Set(
        useAppStore.getState().sessions.map((session) => session.id),
      );
      for (const schedule of schedules) {
        const slotMs = dueScheduleSlotMs(schedule, nowMs);
        if (slotMs === null) continue;
        if (isScheduleRunning(schedule, liveSessionIds)) {
          // Leave the cursor where it is: the next tick re-reads the *latest*
          // due slot, so the moment this run ends the schedule fires once and
          // is back in step. Advancing it here would drop the check instead.
          console.debug(
            "[schedules] slot skipped, previous run still going",
            schedule.id,
          );
          continue;
        }
        try {
          await launchScheduleRun(repoPath, schedule, nowMs, slotMs);
        } catch (cause) {
          console.warn("[schedules] run failed", schedule.id, cause);
        }
      }
      await reapFinishedBackgroundSessions(repoPath, nowMs);
    }
  } finally {
    ticking = false;
  }
}

async function reapFinishedBackgroundSessions(
  repoPath: string,
  nowMs: number,
): Promise<void> {
  // Re-read rather than reuse the pre-launch listing: a run launched moments
  // ago is in there now, and its summary state may have changed.
  let schedules: ProjectSchedule[] = [];
  try {
    schedules = await api.listProjectSchedules(repoPath);
  } catch {
    return;
  }
  // Read the store *after* the await. A run this tick just launched has only
  // reached `sessions` and `backgroundSessionIds` by now, and a snapshot taken
  // before the listing would be missing it.
  const store = useAppStore.getState();
  const reap = backgroundRunsToReap(
    schedules,
    new Set(store.sessions.map((session) => session.id)),
    store.backgroundSessionIds,
    nowMs,
  );
  for (const sessionId of reap) {
    try {
      // The schedule's own throwaway session, and its report already survives
      // it on disk. `false` keeps the worktree, which a background run never
      // created in the first place.
      await useAppStore.getState().removeSession(sessionId, false);
    } catch (cause) {
      console.debug("[schedules] reap failed", sessionId, cause);
      continue;
    }
    // Only after the session is actually gone, so a failed removal retries on
    // the next tick instead of notifying twice.
    announceFinishedRun(repoPath, schedules, sessionId);
  }
}

function announceFinishedRun(
  repoPath: string,
  schedules: readonly ProjectSchedule[],
  sessionId: string,
): void {
  for (const schedule of schedules) {
    const run = schedule.runs.find((item) => item.session_id === sessionId);
    if (!run) continue;
    const store = useAppStore.getState();
    const project = store.projects.find(
      (candidate) => candidate.repo_path === repoPath,
    );
    scheduleNotificationSeq += 1;
    store.addSessionNotification(
      buildScheduleRunNotification({
        repoPath,
        projectName: project?.name ?? repoPath,
        schedule,
        run,
        createdAt: new Date().toISOString(),
        seq: scheduleNotificationSeq,
      }),
    );
    return;
  }
}
