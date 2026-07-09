import { Copy, History, Play } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { api, type AgentKind, type ResumeCandidate } from "../lib/api";
import { buildAgentResumeCommand } from "../lib/agentProvider";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { Button, CodeValue, Modal, ModalFooter, ModalHeader } from "./ui";

interface AgentResumeModalProps {
  /** Session whose previous agent conversation is being offered. */
  sessionId: string;
  /** Which agent the candidate belongs to. Drives copy + resume command. */
  agent: AgentKind;
  /** Candidate metadata to render; `null` hides the modal. */
  candidate: ResumeCandidate | null;
  /**
   * Invoked after any modal action (or backdrop dismiss) so the host can
   * drop the candidate from its state. The modal also calls the matching
   * `acknowledgeAgentResume` API itself; the host only needs to clear its
   * in-memory candidate slot.
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
};

/**
 * Renders the focus-time "Resume previous conversation" modal. Three
 * actions, all of which acknowledge the candidate so the same UUID does
 * not re-pop on the next focus event:
 *
 * - **Resume** — sends `<agent-resume-command> <uuid>\r` into the PTY.
 *   The agent's own resume flag (claude: `--resume`, codex: `resume`
 *   subcommand) takes it from there.
 * - **Copy ID** — copies the UUID to clipboard with a toast.
 * - **Cancel** — types two `#`-prefixed shell-comment lines into the
 *   PTY so the user can still see (and later copy) the resume command
 *   if they change their mind. `#` lines are inert if Enter is mashed.
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

  const lastActivityLabel = useMemo(
    () => formatRelativeTime(candidate?.lastActivityUnix ?? 0, t),
    [candidate?.lastActivityUnix, t],
  );
  const lastUserMessage = candidate?.lastUserMessage?.trim() || null;
  const lastAgentMessage =
    candidate?.lastAgentMessage?.trim() || candidate?.preview?.trim() || null;

  if (!candidate) return null;

  const ack = () => {
    void api.acknowledgeAgentResume(agent, sessionId).catch(() => {});
  };

  const handleResume = () => {
    // PTYs expect a carriage return (`\r`, what xterm sends when the
    // user presses Enter) to commit a line. Using `\n` lands as a
    // literal LF in zsh's line buffer instead of running the command.
    const cmd = `${buildAgentResumeCommand(agent, candidate.uuid)}\r`;
    void api.ptyWrite(sessionId, cmd).catch((err: unknown) => {
      console.error("[AgentResumeModal] failed to write resume cmd", err);
    });
    // Deliberately do NOT ack here. Resume means "I want to keep
    // working in this conversation"; after the user exits the
    // resumed agent run, the same JSONL UUID stays on disk
    // and the next cold boot should re-offer the modal so they can
    // pick it up again. Cancel and Copy still ack — those signal
    // "I'm done deciding about this UUID".
    onDismiss();
  };

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(candidate.uuid)
      .then(() => showToast(dt(t, "dialogs.agentResume.sessionIdCopied")))
      .catch(() => showToast(dt(t, "dialogs.agentResume.copyFailed")));
    onDismiss();
    ack();
  };

  // Backdrop click / Esc takes the same path as Cancel (without the
  // shell-comment hint write): the user explicitly closed the modal
  // without choosing Resume, so we ack and stop offering it.
  const dismiss = () => {
    onDismiss();
    ack();
  };

  const handleCancelWithHint = () => {
    // Single `#`-prefixed line so the shell skips it (it's a comment),
    // but the user can hit Up-arrow to recall the command, remove the
    // `#`, and run it. Multi-line hints would need bracketed-paste
    // escapes to keep zle from collapsing the two `\r`s into one
    // input row; a single line dodges that entire problem.
    const hint = `# ${buildAgentResumeCommand(agent, candidate.uuid)}\r`;
    void api.ptyWrite(sessionId, hint).catch((err: unknown) => {
      console.error("[AgentResumeModal] failed to write cancel hint", err);
    });
    onDismiss();
    ack();
  };

  return (
    <Modal
      open={true}
      onClose={dismiss}
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
        onClose={dismiss}
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
      </div>
      <ModalFooter>
        <Button
          onClick={handleCancelWithHint}
          surface="panel"
        >
          {dt(t, "dialogs.common.cancel")}
        </Button>
        <Button
          onClick={handleCopy}
          surface="panel"
        >
          <Copy size={12} />
          {dt(t, "dialogs.agentResume.copyId")}
        </Button>
        <Button
          onClick={handleResume}
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
