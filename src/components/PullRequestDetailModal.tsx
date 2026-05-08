import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessagesSquare,
  Minus,
  Plus,
  X,
  XCircle,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestDetailListing,
  PullRequestReview,
} from "../lib/types";
import { DiffSplitView } from "./DiffSplitView";
import { Modal, ModalHeader } from "./ui";

type DetailTab = "conversation" | "checks" | "files";

interface PullRequestDetailModalProps {
  /**
   * Set this to open the modal. PR identity travels in `repoPath` + `number`
   * so re-opening is a single state transition; clearing closes the modal.
   */
  open: { repoPath: string; number: number } | null;
  /**
   * Working directory passed to `DiffSplitView` so its "Open in editor"
   * context menu can resolve repo-relative paths to absolute ones.
   */
  cwd?: string;
  onClose: () => void;
}

export function PullRequestDetailModal({
  open,
  cwd,
  onClose,
}: PullRequestDetailModalProps) {
  const [listing, setListing] = useState<PullRequestDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("conversation");

  useDialogShortcuts(open !== null, {
    onCancel: onClose,
    onConfirm: onClose,
  });

  useEffect(() => {
    if (!open) {
      setListing(null);
      setError(null);
      setTab("conversation");
      return;
    }
    let cancelled = false;
    setListing(null);
    setError(null);
    api
      .getPullRequestDetail(open.repoPath, open.number)
      .then((result) => {
        if (cancelled) return;
        setListing(result);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Modal open={open !== null} onClose={onClose} variant="panel" size="5xl">
      {open ? (
        error ? (
          <ModalShell title={`#${open.number}`} onClose={onClose}>
            <div className="p-4 text-xs text-danger">{error}</div>
          </ModalShell>
        ) : !listing ? (
          <ModalShell title={`#${open.number}`} onClose={onClose}>
            <div className="flex h-full items-center justify-center text-xs text-fg-muted">
              Loading PR…
            </div>
          </ModalShell>
        ) : listing.kind === "not_github" ? (
          <ModalShell title={`#${open.number}`} onClose={onClose}>
            <div className="p-4 text-xs text-fg-muted">
              Origin remote is not a GitHub repository.
            </div>
          </ModalShell>
        ) : listing.kind === "no_access" ? (
          <ModalShell title={`#${open.number}`} onClose={onClose}>
            <div className="p-4 text-xs text-fg-muted">
              No logged-in <code className="font-mono">gh</code> account can
              access {listing.slug}.
            </div>
          </ModalShell>
        ) : (
          <DetailBody
            detail={listing.detail}
            account={listing.account}
            tab={tab}
            onTab={setTab}
            cwd={cwd}
            onClose={onClose}
          />
        )
      ) : null}
    </Modal>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <ModalHeader title={title} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </>
  );
}

function DetailBody({
  detail,
  account,
  tab,
  onTab,
  cwd,
  onClose,
}: {
  detail: PullRequestDetail;
  account: string;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  cwd?: string;
  onClose: () => void;
}) {
  const conversationCount = detail.comments.length + detail.reviews.length;
  const checkCounts = summarizeChecks(detail.checks);
  // Effective total ignores NEUTRAL / SKIPPED / CANCELLED — they carry no
  // pass/fail signal and shouldn't push a green PR into the "partial" bucket
  // just because some optional job was skipped.
  const effectiveChecks =
    checkCounts.passed + checkCounts.failed + checkCounts.pending;
  const allChecksPassed =
    effectiveChecks > 0 && checkCounts.passed === effectiveChecks;
  const allChecksFailed =
    effectiveChecks > 0 && checkCounts.failed === effectiveChecks;
  const checksPartial =
    effectiveChecks > 0 && !allChecksPassed && !allChecksFailed;
  const totalChecks = effectiveChecks;
  const fileCount = detail.diff.files.length;

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PrStateGlyph state={detail.state} isDraft={detail.is_draft} />
            <span className="font-mono text-xs text-fg-muted">
              #{detail.number}
            </span>
            <h3 className="truncate text-sm font-semibold tracking-tight text-fg">
              {detail.title}
            </h3>
          </div>
          <p className="mt-1 truncate text-[11px] text-fg-muted">
            <span className="font-mono">{detail.author}</span>
            <span className="opacity-50"> · </span>
            <span className="font-mono">
              {detail.head_branch} → {detail.base_branch}
            </span>
            <span className="opacity-50"> · </span>
            <span className="font-mono text-emerald-400">
              +{detail.additions}
            </span>
            <span className="opacity-50"> </span>
            <span className="font-mono text-rose-400">
              −{detail.deletions}
            </span>
            <span className="opacity-50"> · </span>
            <span>{detail.changed_files} files</span>
            <span className="opacity-50"> · </span>
            <span title={`Listed via gh account ${account}`}>@{account}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void openUrl(detail.url)}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            title="Open on GitHub"
          >
            <ExternalLink size={14} />
          </button>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {detail.body.trim().length > 0 ? (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border bg-bg-sidebar/40 px-4 py-3">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg">
            {detail.body}
          </pre>
        </div>
      ) : null}

      <nav className="flex shrink-0 border-b border-border">
        <DetailTabButton
          icon={<MessagesSquare size={13} />}
          label="Conversation"
          badge={conversationCount > 0 ? conversationCount : null}
          active={tab === "conversation"}
          onClick={() => onTab("conversation")}
        />
        <DetailTabButton
          icon={<CheckCircle2 size={13} />}
          label="Checks"
          badge={
            allChecksPassed ? (
              <Check size={11} strokeWidth={3} className="text-emerald-400" />
            ) : allChecksFailed ? (
              <X size={11} strokeWidth={3} className="text-rose-400" />
            ) : checksPartial ? (
              `${checkCounts.passed}/${totalChecks}`
            ) : null
          }
          active={tab === "checks"}
          onClick={() => onTab("checks")}
        />
        <DetailTabButton
          icon={<GitPullRequest size={13} />}
          label="Files"
          badge={fileCount > 0 ? fileCount : null}
          active={tab === "files"}
          onClick={() => onTab("files")}
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "conversation" ? (
          <ConversationPane
            comments={detail.comments}
            reviews={detail.reviews}
          />
        ) : tab === "checks" ? (
          <ChecksPane checks={detail.checks} />
        ) : (
          <DiffSplitView payload={detail.diff} cwd={cwd} />
        )}
      </div>
    </>
  );
}

interface DetailTabButtonProps {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  active: boolean;
  onClick: () => void;
}

function DetailTabButton({
  icon,
  label,
  badge,
  active,
  onClick,
}: DetailTabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs transition",
        active
          ? "text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent/30"
          : "text-fg-muted hover:text-fg",
      )}
    >
      {icon}
      {label}
      {badge != null && badge !== false ? (
        <span
          className={cn(
            "flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-medium tabular-nums",
            active ? "bg-accent/20 text-fg" : "bg-fg-muted/15 text-fg-muted",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

interface CheckCounts {
  passed: number;
  failed: number;
  pending: number;
}

function summarizeChecks(checks: PullRequestCheck[]): CheckCounts {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.status.toUpperCase() !== "COMPLETED") {
      pending += 1;
      continue;
    }
    switch ((c.conclusion ?? "").toUpperCase()) {
      case "SUCCESS":
        passed += 1;
        break;
      case "FAILURE":
      case "TIMED_OUT":
      case "ACTION_REQUIRED":
        failed += 1;
        break;
      default:
        // NEUTRAL, SKIPPED, CANCELLED carry no signal — excluded from
        // the effective total used by the badge.
        break;
    }
  }
  return { passed, failed, pending };
}

function PrStateGlyph({
  state,
  isDraft,
}: {
  state: string;
  isDraft: boolean;
}) {
  const upper = state.toUpperCase();
  if (isDraft) {
    return <GitPullRequestDraft size={14} className="text-fg-muted" />;
  }
  if (upper === "MERGED") {
    return <GitMerge size={14} className="text-purple-400" />;
  }
  if (upper === "CLOSED") {
    return <GitPullRequestClosed size={14} className="text-rose-400" />;
  }
  return <GitPullRequest size={14} className="text-emerald-400" />;
}

function ConversationPane({
  comments,
  reviews,
}: {
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
}) {
  // Merge into a single chronological timeline. Keep `kind` along for the
  // ride so we can render reviews with their verdict badge.
  type Entry =
    | { kind: "comment"; ts: string; comment: PullRequestComment }
    | { kind: "review"; ts: string; review: PullRequestReview };
  const entries: Entry[] = [
    ...comments.map<Entry>((c) => ({
      kind: "comment",
      ts: c.created_at,
      comment: c,
    })),
    ...reviews.map<Entry>((r) => ({
      kind: "review",
      ts: r.submitted_at,
      review: r,
    })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        No comments or reviews yet.
      </div>
    );
  }

  return (
    <ul className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-3">
      {entries.map((entry, i) =>
        entry.kind === "comment" ? (
          <CommentBlock key={`c-${i}`} comment={entry.comment} />
        ) : (
          <ReviewBlock key={`r-${i}`} review={entry.review} />
        ),
      )}
    </ul>
  );
}

function CommentBlock({ comment }: { comment: PullRequestComment }) {
  return (
    <li className="rounded border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] text-fg-muted">
        <span className="font-mono text-fg">{comment.author}</span>
        <span className="opacity-60">commented</span>
        <span className="font-mono opacity-60">
          {formatTimestamp(comment.created_at)}
        </span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg">
        {comment.body || <span className="text-fg-muted">(empty)</span>}
      </pre>
    </li>
  );
}

function ReviewBlock({ review }: { review: PullRequestReview }) {
  return (
    <li className="rounded border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10px] text-fg-muted">
        <span className="font-mono text-fg">{review.author}</span>
        <ReviewStateBadge state={review.state} />
        <span className="font-mono opacity-60">
          {formatTimestamp(review.submitted_at)}
        </span>
      </div>
      {review.body.trim().length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg">
          {review.body}
        </pre>
      ) : (
        <p className="text-[11px] text-fg-muted">
          (no review comment)
        </p>
      )}
    </li>
  );
}

function ReviewStateBadge({ state }: { state: string }) {
  const upper = state.toUpperCase();
  const tone =
    upper === "APPROVED"
      ? "bg-emerald-500/15 text-emerald-400"
      : upper === "CHANGES_REQUESTED"
        ? "bg-rose-500/15 text-rose-400"
        : upper === "DISMISSED"
          ? "bg-fg-muted/15 text-fg-muted line-through"
          : "bg-fg-muted/15 text-fg-muted";
  const label = upper.replace("_", " ").toLowerCase();
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  );
}

function ChecksPane({ checks }: { checks: PullRequestCheck[] }) {
  if (checks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        No checks reported.
      </div>
    );
  }
  return (
    <ul className="flex h-full flex-col overflow-y-auto text-xs">
      {checks.map((c, i) => (
        <li
          key={`${c.name}-${i}`}
          className="flex items-center gap-2 border-b border-border/40 px-3 py-2"
        >
          <CheckIcon status={c.status} conclusion={c.conclusion} />
          <span className="min-w-0 flex-1 truncate text-fg">
            {c.workflow_name ? (
              <span className="text-fg-muted">{c.workflow_name} / </span>
            ) : null}
            {c.name}
          </span>
          <CheckStatusLabel status={c.status} conclusion={c.conclusion} />
          {c.url ? (
            <button
              type="button"
              onClick={() => {
                if (c.url) void openUrl(c.url);
              }}
              className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
              title="Open run"
            >
              <ExternalLink size={11} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CheckIcon({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  if (status.toUpperCase() !== "COMPLETED") {
    return <Clock size={13} className="text-fg-muted animate-pulse" />;
  }
  switch (conclusion?.toUpperCase()) {
    case "SUCCESS":
      return <CheckCircle2 size={13} className="text-emerald-400" />;
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
      return <XCircle size={13} className="text-rose-400" />;
    case "CANCELLED":
      return <Minus size={13} className="text-fg-muted" />;
    case "NEUTRAL":
    case "SKIPPED":
      return <Circle size={13} className="text-fg-muted" />;
    default:
      return <Plus size={13} className="text-fg-muted" />;
  }
}

function CheckStatusLabel({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  const text =
    status.toUpperCase() === "COMPLETED"
      ? (conclusion ?? "completed").toLowerCase()
      : status.toLowerCase();
  return (
    <span className="shrink-0 font-mono text-[10px] text-fg-muted">{text}</span>
  );
}

function formatTimestamp(iso: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}
