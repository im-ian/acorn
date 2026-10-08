import { buildAgentResumeCommand } from "./agentProvider";
import type { Session, SessionAgentProvider } from "./types";
import { useAppStore } from "../store";

/**
 * One-shot resume pass carried across the daemon-update reload.
 *
 * The update flow in `DaemonUpdateModal` shuts the old daemon down
 * (killing every PTY) and reloads the webview, so the pass is stashed
 * in `localStorage` — the only state that survives the reload — and
 * applied once at the next boot by queueing each session's
 * `<agent> --resume <uuid>` through `setPendingTerminalInput`.
 * Mounted terminals respawn-and-drain immediately; background sessions
 * drain on their next focus, matching the staged-rev restart promise.
 */

const STORAGE_KEY = "acorn:daemon-update-resume";

export interface DaemonUpdateResumeEntry {
  sessionId: string;
  agent: SessionAgentProvider;
  uuid: string;
}

function resumeCommandFor(
  agent: SessionAgentProvider,
  uuid: string,
): string | null {
  try {
    return buildAgentResumeCommand(agent, uuid);
  } catch {
    // Provider without resume support (or an unknown provider from a
    // stale stash) — nothing to queue for this session.
    return null;
  }
}

/**
 * Sessions whose agent conversation can be re-entered after the daemon
 * restart kills their shells: a paired transcript id plus a provider
 * that supports resume. Archived and chat-mode sessions have no PTY to
 * revive.
 */
export function collectDaemonUpdateResumeEntries(
  sessions: Session[],
): DaemonUpdateResumeEntry[] {
  const entries: DaemonUpdateResumeEntry[] = [];
  for (const session of sessions) {
    if (session.archived_at) continue;
    if (session.mode === "chat") continue;
    const agent = session.agent_transcript_provider ?? session.agent_provider;
    const uuid = session.agent_transcript_id;
    if (!agent || !uuid) continue;
    if (resumeCommandFor(agent, uuid) === null) continue;
    entries.push({ sessionId: session.id, agent, uuid });
  }
  return entries;
}

/** Persist the pass for the post-reload boot. Returns the entry count. */
export function stashDaemonUpdateResumePass(sessions: Session[]): number {
  const entries = collectDaemonUpdateResumeEntries(sessions);
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch (err) {
    console.warn("[daemonUpdateResume] stash failed", err);
    return 0;
  }
  return entries.length;
}

/**
 * Drop a stashed pass that will not be followed by a reload (the
 * daemon shutdown failed). Leaving it behind would type resume
 * commands into live agent TUIs at some later boot.
 */
export function clearDaemonUpdateResumePass(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best effort — same storage that failed the stash.
  }
}

function isResumeEntry(value: unknown): value is DaemonUpdateResumeEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.sessionId === "string" &&
    typeof entry.agent === "string" &&
    typeof entry.uuid === "string"
  );
}

/**
 * Queue each entry's resume command for its session's next PTY spawn.
 * Only call for sessions whose shell is (about to be) dead — a queued
 * command drains into a live PTY immediately. Returns how many were
 * queued.
 */
export function queueDaemonUpdateResumeEntries(
  entries: DaemonUpdateResumeEntry[],
): number {
  let queued = 0;
  for (const entry of entries) {
    const command = resumeCommandFor(entry.agent, entry.uuid);
    if (command === null) continue;
    useAppStore.getState().setPendingTerminalInput(entry.sessionId, command, {
      agentProvider: entry.agent,
    });
    queued += 1;
  }
  return queued;
}

/**
 * Consume the stashed pass: queue each surviving session's resume
 * command for its next PTY spawn. Idempotent per stash — the key is
 * removed before queueing. Returns how many sessions were queued.
 */
export function applyDaemonUpdateResumePass(sessions: Session[]): number {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;
  let entries: DaemonUpdateResumeEntry[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return 0;
    entries = parsed.filter(isResumeEntry);
  } catch {
    return 0;
  }
  const liveSessionIds = new Set(
    sessions
      .filter((session) => !session.archived_at)
      .map((session) => session.id),
  );
  return queueDaemonUpdateResumeEntries(
    entries.filter((entry) => liveSessionIds.has(entry.sessionId)),
  );
}
