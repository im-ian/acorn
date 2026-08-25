import { Copy, History, Play } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { api, type AgentKind, type ResumeCandidate } from "../lib/api";
import { buildAgentResumeCommand } from "../lib/agentProvider";
import type { TranslationKey, Translator } from "../lib/i18n";
import { isMissingPtyError } from "../lib/ptyErrors";
import { useToasts } from "../lib/toasts";
import { writeClipboardText } from "../lib/clipboardText";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import {
  Button,
  CodeValue,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
} from "./ui";

interface AgentResumeModalProps {
  /** Session whose previous agent conversation is being offered. */
  sessionId: string;
  /** Which agent the candidate belongs to. Drives copy + resume command. */
  agent: AgentKind;
  /** Candidate metadata to render; `null` hides the modal. */
  candidate: ResumeCandidate | null;
  /**
   * Invoked once the selected action's required writes have completed, so the
   * host can drop the candidate from its in-memory state. A failed action
   * keeps the modal open with the reason instead.
   */
  onDismiss: () => void;
}

interface AgentCopy {
  bodyKey: DialogTranslationKey;
  ariaLabelledBy: string;
}

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const COPY: Record<AgentKind, AgentCopy> = {
  claude: {
    bodyKey: "dialogs.agentResume.bodyClaude",
    ariaLabelledBy: "acorn-claude-resume-title",
  },
  codex: {
    bodyKey: "dialogs.agentResume.bodyCodex",
    ariaLabelledBy: "acorn-codex-resume-title",
  },
  antigravity: {
    bodyKey: "dialogs.agentResume.bodyAntigravity",
    ariaLabelledBy: "acorn-antigravity-resume-title",
  },
  grok: {
    bodyKey: "dialogs.agentResume.bodyGrok",
    ariaLabelledBy: "acorn-grok-resume-title",
  },
};

/**
 * Renders the focus-time "Resume previous conversation" modal. Three
 * actions, each of which closes the modal only once its required writes
 * have landed — a failure that closed the modal anyway would drop the
 * candidate from memory while the acknowledgement never reached disk, so
 * the same UUID would silently pop again on the next focus event:
 *
 * - **Resume** — sends `<agent-resume-command> <uuid>\r` into the PTY.
 *   The agent's own resume flag (claude: `--resume`, codex: `resume`
 *   subcommand) takes it from there.
 * - **Copy ID** — copies the UUID, then acknowledges the candidate.
 * - **Cancel** — types one `#`-prefixed shell-comment line into the
 *   PTY so the user can still see (and later copy) the resume command
 *   if they change their mind, then acknowledges the candidate. The hint
 *   is best-effort; the acknowledgement is not.
 */
export function AgentResumeModal({
  sessionId,
  agent,
  candidate,
  onDismiss,
}: AgentResumeModalProps): ReactElement | null {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const copy = COPY[agent];

  const [busy, setBusy] = useState<"resume" | "copy" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lastActivityLabel = useMemo(
    () => formatRelativeTime(candidate?.lastActivityUnix ?? 0, t),
    [candidate?.lastActivityUnix, t],
  );
  const lastUserMessage = candidate?.lastUserMessage?.trim() || null;
  const lastAgentMessage =
    candidate?.lastAgentMessage?.trim() || candidate?.preview?.trim() || null;

  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [agent, candidate?.uuid, sessionId]);

  if (!candidate) return null;

  const acknowledge = async (): Promise<boolean> => {
    try {
      await api.acknowledgeAgentResume(agent, sessionId);
      return true;
    } catch (ackError: unknown) {
      console.warn(
        `[AgentResumeModal] failed to acknowledge ${agent} candidate for ${sessionId}`,
        ackError,
      );
      setError(
        `${dt(t, "dialogs.agentResume.ackFailed")} ${errorMessage(ackError)}`,
      );
      return false;
    }
  };

  const handleResume = async () => {
    if (busy) return;
    setBusy("resume");
    setError(null);
    // PTYs expect a carriage return (`\r`, what xterm sends when the
    // user presses Enter) to commit a line. Using `\n` lands as a
    // literal LF in zsh's line buffer instead of running the command.
    const command = buildAgentResumeCommand(agent, candidate.uuid);
    try {
      await api.ptyWrite(sessionId, `${command}\r`);
    } catch (writeError: unknown) {
      // Cold boot paints the restored snapshot before `pty_spawn`
      // returns, so Resume can land with no live handle. Queue for
      // the in-flight or next spawn instead of failing the click.
      if (isMissingPtyError(writeError)) {
        useAppStore.getState().setPendingTerminalInput(sessionId, command, {
          agentProvider: agent,
        });
        onDismiss();
        return;
      }
      setError(
        `${dt(t, "dialogs.agentResume.resumeFailed")} ${errorMessage(writeError)}`,
      );
      setBusy(null);
      return;
    }
    // Deliberately do NOT ack here. Resume means "I want to keep
    // working in this conversation"; after the user exits the
    // resumed agent run, the same JSONL UUID stays on disk
    // and the next cold boot should re-offer the modal so they can
    // pick it up again. Cancel and Copy still ack — those signal
    // "I'm done deciding about this UUID".
    onDismiss();
  };

  const handleCopy = async () => {
    if (busy) return;
    setBusy("copy");
    setError(null);
    try {
      await writeClipboardText(candidate.uuid);
    } catch (copyError: unknown) {
      setError(
        `${dt(t, "dialogs.agentResume.copyFailed")} ${errorMessage(copyError)}`,
      );
      setBusy(null);
      return;
    }
    if (!(await acknowledge())) {
      setBusy(null);
      return;
    }
    showToast(dt(t, "dialogs.agentResume.sessionIdCopied"));
    onDismiss();
  };

  // Backdrop click / Esc takes the same path as Cancel (without the
  // shell-comment hint write): the user explicitly closed the modal
  // without choosing Resume, so we ack and stop offering it.
  const dismiss = async () => {
    if (busy) return;
    setBusy("dismiss");
    setError(null);
    if (await acknowledge()) {
      onDismiss();
      return;
    }
    setBusy(null);
  };

  const handleCancelWithHint = async () => {
    if (busy) return;
    setBusy("dismiss");
    setError(null);
    // Single `#`-prefixed line so the shell skips it (it's a comment),
    // but the user can hit Up-arrow to recall the command, remove the
    // `#`, and run it. Multi-line hints would need bracketed-paste
    // escapes to keep zle from collapsing the two `\r`s into one
    // input row; a single line dodges that entire problem.
    const hint = `# ${buildAgentResumeCommand(agent, candidate.uuid)}\r`;
    try {
      await api.ptyWrite(sessionId, hint);
    } catch (writeError: unknown) {
      // The hint is a convenience. The user's dismiss intent still has to
      // clear the durable acknowledgement below, so only toast here.
      showToast(
        `${dt(t, "dialogs.agentResume.hintFailed")} ${errorMessage(writeError)}`,
      );
    }
    if (await acknowledge()) {
      onDismiss();
      return;
    }
    setBusy(null);
  };

  return (
    <Modal
      open={true}
      onClose={() => void dismiss()}
      variant="dialog"
      size="md"
      ariaLabelledBy={copy.ariaLabelledBy}
    >
      <ModalHeader
        title={dt(t, "dialogs.agentResume.title")}
        subtitle={lastActivityLabel}
        titleId={copy.ariaLabelledBy}
        icon={<History size={14} className="text-accent" />}
        variant="dialog"
        onClose={() => void dismiss()}
      />
      <div className="space-y-3 px-4 py-4 text-xs">
        <p className="text-fg-muted">{dt(t, copy.bodyKey)}</p>
        {lastUserMessage || lastAgentMessage ? (
          <div className="space-y-2 border-l-2 border-border-emphasis bg-bg-elevated/60 px-3 py-2 text-fg-muted">
            {lastUserMessage ? (
              <ConversationPreviewLine
                label={dt(t, "dialogs.agentResume.lastUser")}
                text={lastUserMessage}
              />
            ) : null}
            {lastAgentMessage ? (
              <ConversationPreviewLine
                label={dt(t, "dialogs.agentResume.lastAgent")}
                text={lastAgentMessage}
              />
            ) : null}
          </div>
        ) : null}
        <CodeValue surface="elevated" tone="muted">
          {candidate.uuid}
        </CodeValue>
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
      <ModalFooter>
        <Button
          onClick={() => void handleCancelWithHint()}
          disabled={busy !== null}
          surface="panel"
        >
          {dt(t, "dialogs.common.cancel")}
        </Button>
        <Button
          onClick={() => void handleCopy()}
          disabled={busy !== null}
          surface="panel"
        >
          <Copy size={12} />
          {dt(t, "dialogs.agentResume.copyId")}
        </Button>
        <Button
          onClick={() => void handleResume()}
          disabled={busy !== null}
          variant="primary"
        >
          <Play size={12} />
          {dt(t, "dialogs.agentResume.resume")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function ConversationPreviewLine({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase text-fg-muted/70">
        {label}
      </div>
      <div className="line-clamp-2 leading-4 text-fg-muted">{text}</div>
    </div>
  );
}

function formatRelativeTime(unixSeconds: number, t: Translator): string {
  if (unixSeconds <= 0) return dt(t, "dialogs.agentResume.lastActivityUnknown");
  const nowMs = Date.now();
  const thenMs = unixSeconds * 1000;
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return dt(t, "dialogs.agentResume.justNow");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `~${diffMin} ${dt(t, "dialogs.agentResume.minutesAgo")}`;
  }
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return `~${diffHr} ${dt(t, "dialogs.agentResume.hoursAgo")}`;
  }
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) {
    return `${diffDay} ${
      diffDay === 1
        ? dt(t, "dialogs.agentResume.dayAgo")
        : dt(t, "dialogs.agentResume.daysAgo")
    }`;
  }
  return new Date(thenMs).toLocaleDateString();
}
