import { buildAgentResumeCommand } from "./agentProvider";
import { api, type AgentKind } from "./api";
import { isMissingPtyError } from "./ptyErrors";
import { isArchivedSession } from "./sessionArchive";
import { useAppStore } from "../store";

export type AgentResumeDispatchResult = "written" | "queued";

const autoResumeInFlight = new Map<
  string,
  Promise<AgentResumeDispatchResult>
>();
const autoResumeDone = new Set<string>();
// Bumped when a dispatch is forgotten while `pty_write` is still running,
// so that write cannot seal the key and skip the post-restore command.
const autoResumeEpoch = new Map<string, number>();

function invalidateInFlightAutoResume(keys: readonly string[]): void {
  for (const key of keys) {
    autoResumeEpoch.set(key, (autoResumeEpoch.get(key) ?? 0) + 1);
    autoResumeInFlight.delete(key);
  }
}

function autoResumeKey(
  sessionId: string,
  agent: AgentKind,
  uuid: string,
): string {
  return `${sessionId}:${agent}:${uuid}`;
}

/**
 * Send `<agent-resume-command> <uuid>` into the session PTY. A missing
 * handle is queued for the next spawn instead of failing — cold boot
 * paints the restored snapshot before `pty_spawn` returns.
 */
export async function dispatchAgentResumeCommand(input: {
  sessionId: string;
  agent: AgentKind;
  uuid: string;
}): Promise<AgentResumeDispatchResult> {
  const command = buildAgentResumeCommand(input.agent, input.uuid);
  try {
    // PTYs expect a carriage return (`\r`, what xterm sends when the
    // user presses Enter) to commit a line. Using `\n` lands as a
    // literal LF in zsh's line buffer instead of running the command.
    await api.ptyWrite(input.sessionId, `${command}\r`);
    return "written";
  } catch (writeError: unknown) {
    if (isMissingPtyError(writeError)) {
      useAppStore.getState().setPendingTerminalInput(input.sessionId, command, {
        agentProvider: input.agent,
      });
      return "queued";
    }
    throw writeError;
  }
}

/**
 * Auto-resume path used at launch. Coalesces overlapping calls for the
 * same session/agent/uuid so StrictMode remounts and dual probe effects
 * cannot dispatch the command twice. Failures are not remembered, so the
 * modal (or a later retry) can still send the command.
 */
export function autoResumeAgentConversation(input: {
  sessionId: string;
  agent: AgentKind;
  uuid: string;
}): Promise<AgentResumeDispatchResult | "skipped"> {
  const key = autoResumeKey(input.sessionId, input.agent, input.uuid);
  if (autoResumeDone.has(key)) return Promise.resolve("skipped");
  const existing = autoResumeInFlight.get(key);
  if (existing) return existing;
  const epoch = autoResumeEpoch.get(key) ?? 0;
  const pending = dispatchAgentResumeCommand(input)
    .then((result) => {
      if ((autoResumeEpoch.get(key) ?? 0) !== epoch) return result;
      autoResumeDone.add(key);
      return result;
    })
    .finally(() => {
      if (autoResumeInFlight.get(key) === pending) {
        autoResumeInFlight.delete(key);
      }
    });
  autoResumeInFlight.set(key, pending);
  return pending;
}

export function forgetCompletedAgentResumeAutoDispatch(): void {
  autoResumeDone.clear();
  invalidateInFlightAutoResume([...autoResumeInFlight.keys()]);
}

export function forgetCompletedAgentResumeAutoDispatchForSession(
  sessionId: string,
): void {
  const prefix = `${sessionId}:`;
  for (const key of [...autoResumeDone]) {
    if (key.startsWith(prefix)) autoResumeDone.delete(key);
  }
  invalidateInFlightAutoResume(
    [...autoResumeInFlight.keys()].filter((key) => key.startsWith(prefix)),
  );
}

/**
 * A successful restore is the only signal that re-opens an agent
 * conversation. Auto-resume clears the one-shot probe mark and holds
 * the id until that probe is issued. With auto-resume off, the id stays
 * probed so the modal does not open on restore.
 */
export function armResumeProbeAfterSuccessfulRestore(input: {
  sessionId: string;
  autoResumeEnabled: boolean;
  probedIds: Set<string>;
  pendingRestoreProbeIds: Set<string>;
}): void {
  if (input.autoResumeEnabled) {
    input.probedIds.delete(input.sessionId);
    input.pendingRestoreProbeIds.add(input.sessionId);
    forgetCompletedAgentResumeAutoDispatchForSession(input.sessionId);
    return;
  }
  input.probedIds.add(input.sessionId);
  input.pendingRestoreProbeIds.delete(input.sessionId);
}

/**
 * Archived rows and sessions waiting on a post-restore probe must not
 * be stamped probed. A stamp without an API call would swallow the
 * resume command.
 */
export function shouldStampResumeProbeSkip(input: {
  session: { id: string; archived_at?: string | null };
  pendingRestoreProbeIds: ReadonlySet<string>;
}): boolean {
  if (isArchivedSession(input.session)) return false;
  return !input.pendingRestoreProbeIds.has(input.session.id);
}

/**
 * A post-restore probe has to run while a stale `agent_provider` or
 * working status is still set. Archive already killed the PTY, and the
 * status poll is not guaranteed to restart and clear that flag.
 */
export function shouldProbeSessionForResume(input: {
  archived: boolean;
  alreadyProbed: boolean;
  pendingRestore: boolean;
  skipBecauseBusy: boolean;
}): boolean {
  if (input.archived || input.alreadyProbed) return false;
  if (input.pendingRestore) return true;
  return !input.skipBecauseBusy;
}

/**
 * A failed restore auto-resume keeps its retry candidate while the row
 * still looks busy. Clearing it on the next sessions update drops the
 * modal before that stale flag goes away.
 */
export function shouldRetainBusyResumeCandidate(input: {
  forcedRestore: boolean;
}): boolean {
  return input.forcedRestore;
}

/** In-flight restore probes still apply when the row looks busy. */
export function shouldAcceptResumeProbeResult(input: {
  archived: boolean;
  forcedRestoreProbe: boolean;
  skipBecauseBusy: boolean;
}): boolean {
  if (input.archived) return false;
  if (input.forcedRestoreProbe) return true;
  return !input.skipBecauseBusy;
}

export function resetAgentResumeAutoDispatchForTests(): void {
  autoResumeInFlight.clear();
  autoResumeDone.clear();
  autoResumeEpoch.clear();
}
