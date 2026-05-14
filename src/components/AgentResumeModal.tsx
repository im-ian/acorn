import { Copy, History, Play } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import {
  api,
  type AgentKind,
  type ResumeCandidate,
} from "../lib/api";
import { useToasts } from "../lib/toasts";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";

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
   * `acknowledge*Resume` API itself; the host only needs to clear its
   * in-memory candidate slot.
   */
  onDismiss: () => void;
}

interface AgentCopy {
  resumeCommand: (uuid: string) => string;
  bodyParagraph: string;
  ariaLabelledBy: string;
}

const COPY: Record<AgentKind, AgentCopy> = {
  claude: {
    resumeCommand: (uuid) => `claude --resume ${uuid}`,
    bodyParagraph:
      "There's a Claude conversation that was in progress in this session. You can pick it up where you left off, or just close this dialog to start fresh.",
    ariaLabelledBy: "acorn-claude-resume-title",
  },
  codex: {
    resumeCommand: (uuid) => `codex resume ${uuid}`,
    bodyParagraph:
      "There's a Codex conversation that was in progress in this session. You can pick it up where you left off, or just close this dialog to start fresh.",
    ariaLabelledBy: "acorn-codex-resume-title",
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
  const showToast = useToasts((s) => s.show);
  const copy = COPY[agent];

  const lastActivityLabel = useMemo(
    () => formatRelativeTime(candidate?.lastActivityUnix ?? 0),
    [candidate?.lastActivityUnix],
  );

  if (!candidate) return null;

  const ack = () => {
    if (agent === "claude") {
      void api.acknowledgeClaudeResume(sessionId).catch(() => {});
    } else {
      void api.acknowledgeCodexResume(sessionId).catch(() => {});
    }
  };

  const handleResume = () => {
    // PTYs expect a carriage return (`\r`, what xterm sends when the
    // user presses Enter) to commit a line. Using `\n` lands as a
    // literal LF in zsh's line buffer instead of running the command.
    const cmd = `${copy.resumeCommand(candidate.uuid)}\r`;
    void api.ptyWrite(sessionId, cmd).catch((err: unknown) => {
      console.error("[AgentResumeModal] failed to write resume cmd", err);
    });
    // Deliberately do NOT ack here. Resume means "I want to keep
    // working in this conversation"; after the user exits the
    // resumed claude/codex run, the same JSONL UUID stays on disk
    // and the next cold boot should re-offer the modal so they can
    // pick it up again. Cancel and Copy still ack — those signal
    // "I'm done deciding about this UUID".
    onDismiss();
  };

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(candidate.uuid)
      .then(() => showToast("Session ID copied"))
      .catch(() => showToast("Failed to copy to clipboard"));
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
    const hint = `# ${copy.resumeCommand(candidate.uuid)}\r`;
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
        title="Resume previous conversation"
        subtitle={lastActivityLabel}
        titleId={copy.ariaLabelledBy}
        icon={
          <span className="self-start pt-0.5">
            <History size={14} className="text-accent" />
          </span>
        }
        variant="dialog"
        onClose={dismiss}
      />
      <div className="space-y-3 px-4 py-4 text-xs">
        <p className="text-fg-muted">{copy.bodyParagraph}</p>
        {candidate.preview ? (
          <blockquote className="border-l-2 border-border-emphasis bg-bg-elevated/60 px-3 py-2 italic text-fg-muted">
            “{candidate.preview}”
          </blockquote>
        ) : null}
        <div className="rounded border border-border bg-bg-elevated/60 px-2.5 py-1.5 font-mono text-[11px] text-fg-muted">
          {candidate.uuid}
        </div>
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={handleCancelWithHint}
          className="rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          <Copy size={12} />
          Copy ID
        </button>
        <button
          type="button"
          onClick={handleResume}
          className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90"
        >
          <Play size={12} />
          Resume
        </button>
      </footer>
    </Modal>
  );
}

function formatRelativeTime(unixSeconds: number): string {
  if (unixSeconds <= 0) return "Last activity unknown";
  const nowMs = Date.now();
  const thenMs = unixSeconds * 1000;
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `~${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `~${diffHr} hr ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(thenMs).toLocaleDateString();
}
