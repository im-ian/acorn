import { Copy, History, Play } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { api, type ClaudeResumeCandidate } from "../lib/api";
import { useToasts } from "../lib/toasts";
import { Modal } from "./ui/Modal";
import { ModalHeader } from "./ui/ModalHeader";

interface ClaudeResumeModalProps {
  /** Session whose previous claude conversation is being offered. */
  sessionId: string;
  /** Candidate metadata to render; `null` hides the modal. */
  candidate: ClaudeResumeCandidate | null;
  /**
   * Invoked after any modal action (or backdrop dismiss) so the host can
   * drop the candidate from its state. The host should also call
   * `api.acknowledgeClaudeResume` — passed in so it can be mocked from
   * tests without going through the real Tauri bridge.
   */
  onDismiss: () => void;
}

const RESUME_COMMAND_PREFIX = "claude --resume";

/**
 * Renders the focus-time "이전 Claude 대화 이어하기" modal. Three actions,
 * all of which acknowledge the candidate (so the same UUID does not
 * re-pop on the next focus event):
 *
 * - **이어하기** — types `claude --resume <uuid>\n` into the PTY. Claude's
 *   native `--resume` handles the rest; the shim stays out of the way.
 * - **ID 복사** — copies the UUID to clipboard with a toast.
 * - **취소** — types two `#`-prefixed shell-comment lines into the PTY
 *   so the user can still see (and later copy) the resume command if
 *   they change their mind. `#` lines are inert if Enter is mashed.
 */
export function ClaudeResumeModal({
  sessionId,
  candidate,
  onDismiss,
}: ClaudeResumeModalProps): ReactElement | null {
  const showToast = useToasts((s) => s.show);

  const lastActivityLabel = useMemo(
    () => formatRelativeTime(candidate?.lastActivityUnix ?? 0),
    [candidate?.lastActivityUnix],
  );

  if (!candidate) return null;

  const dismiss = () => {
    onDismiss();
    void api.acknowledgeClaudeResume(sessionId).catch(() => {});
  };

  const handleResume = () => {
    const cmd = `${RESUME_COMMAND_PREFIX} ${candidate.uuid}\n`;
    void api.ptyWrite(sessionId, cmd).catch((err: unknown) => {
      console.error("[ClaudeResumeModal] failed to write resume cmd", err);
    });
    dismiss();
  };

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(candidate.uuid)
      .then(() => showToast("세션 ID 복사됨"))
      .catch(() => showToast("클립보드 복사 실패"));
    dismiss();
  };

  const handleCancelWithHint = () => {
    const hint =
      `# 이전 Claude 대화 ID: ${candidate.uuid}\n` +
      `# 이어가려면: ${RESUME_COMMAND_PREFIX} ${candidate.uuid}\n`;
    void api.ptyWrite(sessionId, hint).catch((err: unknown) => {
      console.error("[ClaudeResumeModal] failed to write cancel hint", err);
    });
    dismiss();
  };

  return (
    <Modal
      open={true}
      onClose={dismiss}
      variant="dialog"
      size="md"
      ariaLabelledBy="acorn-claude-resume-title"
    >
      <ModalHeader
        title="이전 대화 이어하기"
        subtitle={lastActivityLabel}
        titleId="acorn-claude-resume-title"
        icon={<History size={14} className="text-accent" />}
        variant="dialog"
        onClose={dismiss}
      />
      <div className="space-y-3 px-4 py-4 text-xs">
        <p className="text-fg-muted">
          이 세션에서 진행 중이었던 Claude 대화가 있어요. 같은 대화로 이어갈
          수 있고, 새로 시작하려면 그냥 닫으세요.
        </p>
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
          취소
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          <Copy size={12} />
          ID 복사
        </button>
        <button
          type="button"
          onClick={handleResume}
          className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition hover:bg-accent/90"
        >
          <Play size={12} />
          이어하기
        </button>
      </footer>
    </Modal>
  );
}

function formatRelativeTime(unixSeconds: number): string {
  if (unixSeconds <= 0) return "활동 시각 알 수 없음";
  const nowMs = Date.now();
  const thenMs = unixSeconds * 1000;
  const diffSec = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (diffSec < 60) return "방금 전";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `약 ${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `약 ${diffHr}시간 전`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}일 전`;
  return new Date(thenMs).toLocaleDateString();
}
