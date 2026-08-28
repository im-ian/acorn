import { buildAgentResumeCommand } from "./agentProvider";
import { api, type AgentKind } from "./api";
import { isMissingPtyError } from "./ptyErrors";
import { useAppStore } from "../store";

export type AgentResumeDispatchResult = "written" | "queued";

const autoResumeInFlight = new Map<
  string,
  Promise<AgentResumeDispatchResult>
>();
const autoResumeDone = new Set<string>();

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
  const pending = dispatchAgentResumeCommand(input)
    .then((result) => {
      autoResumeDone.add(key);
      return result;
    })
    .finally(() => {
      autoResumeInFlight.delete(key);
    });
  autoResumeInFlight.set(key, pending);
  return pending;
}

export function forgetCompletedAgentResumeAutoDispatch(): void {
  autoResumeDone.clear();
}

export function resetAgentResumeAutoDispatchForTests(): void {
  autoResumeInFlight.clear();
  autoResumeDone.clear();
}
