import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
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
import { ClosePullRequestDialog } from "./ClosePullRequestDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffSplitView } from "./DiffSplitView";
import { MergePullRequestDialog } from "./MergePullRequestDialog";
import { Tooltip } from "./Tooltip";
import { Markdown, Modal, ModalHeader, RefreshButton } from "./ui";

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
  /**
   * Notifies the parent that the PR's lifecycle changed (merged/closed) so
   * the surrounding list can refetch.
   */
  onMutated?: () => void;
}

export function PullRequestDetailModal({
  open,
  cwd,
  onClose,
  onMutated,
}: PullRequestDetailModalProps) {
  const [listing, setListing] = useState<PullRequestDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("conversation");
  // Bumped by the refresh button. Triggers a background refetch that keeps
  // the current listing visible while it resolves.
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);

  useDialogShortcuts(open !== null, {
    onCancel: onClose,
    onConfirm: onClose,
  });

  // Hard-clear stale data whenever the modal closes or switches PR.
  useEffect(() => {
    if (!open) {
      setListing(null);
      setError(null);
      setTab("conversation");
      setRefreshing(false);
      setReloadKey(0);
      setMergeDialogOpen(false);
      setCloseDialogOpen(false);
      return;
    }
    setListing(null);
    setError(null);
  }, [open]);

  // Fetch on open and on every refresh bump.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRefreshing(true);
    api
      .getPullRequestDetail(open.repoPath, open.number)
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        setRefreshing(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  const handleRefresh = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const handleMutated = useCallback(() => {
    setReloadKey((k) => k + 1);
    onMutated?.();
  }, [onMutated]);

  const detail =
    listing && listing.kind === "ok" ? listing.detail : null;

  return (
    <>
    <Modal open={open !== null} onClose={onClose} variant="panel" size="5xl">
      {open ? (
        error ? (
          <ModalShell title={`#${open.number}`} onClose={onClose}>
            <div className="p-4 text-xs text-danger">{error}</div>
          </ModalShell>
        ) : !listing ? (
          <DetailSkeleton
            number={open.number}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />
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
            onRefresh={handleRefresh}
            refreshing={refreshing}
            onOpenMerge={() => setMergeDialogOpen(true)}
            onOpenClose={() => setCloseDialogOpen(true)}
          />
        )
      ) : null}
    </Modal>
    {open && detail ? (
      <>
        <MergePullRequestDialog
          open={mergeDialogOpen}
          repoPath={open.repoPath}
          detail={detail}
          onClose={() => setMergeDialogOpen(false)}
          onMerged={() => {
            setMergeDialogOpen(false);
            handleMutated();
          }}
        />
        <ClosePullRequestDialog
          open={closeDialogOpen}
          repoPath={open.repoPath}
          detail={detail}
          onClose={() => setCloseDialogOpen(false)}
          onClosed={() => {
            setCloseDialogOpen(false);
            handleMutated();
          }}
        />
      </>
    ) : null}
    </>
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
  onRefresh,
  refreshing,
  onOpenMerge,
  onOpenClose,
}: {
  detail: PullRequestDetail;
  account: string;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  cwd?: string;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenMerge: () => void;
  onOpenClose: () => void;
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
            <AuthorTag
              login={detail.author}
              size={16}
              nameClass="text-[11px] text-fg-muted"
            />
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
            <Tooltip label={`Listed via gh account ${account}`} side="bottom">
              <span>@{account}</span>
            </Tooltip>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {detail.state.toUpperCase() === "OPEN" ? (
            <>
              <MergeActionButton
                mergeable={detail.mergeable}
                onClick={onOpenMerge}
              />
              <button
                type="button"
                onClick={onOpenClose}
                className="rounded-md bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/25"
              >
                Close
              </button>
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            </>
          ) : null}
          <RefreshButton onClick={onRefresh} loading={refreshing} size={14} />
          <Tooltip label="Open on GitHub" side="bottom">
            <button
              type="button"
              onClick={() => void openUrl(detail.url)}
              className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <ExternalLink size={14} />
            </button>
          </Tooltip>
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
        <ResizableBody>
          <Markdown content={detail.body} />
        </ResizableBody>
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
              <Check size={11} strokeWidth={3} className="text-emerald-300" />
            ) : allChecksFailed ? (
              <X size={11} strokeWidth={3} className="text-rose-300" />
            ) : checksPartial ? (
              `${checkCounts.passed}/${totalChecks}`
            ) : null
          }
          badgeTone={
            allChecksPassed
              ? "success"
              : allChecksFailed
                ? "danger"
                : "default"
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

/**
 * Loading placeholder that mirrors `DetailBody`'s layout — header line,
 * meta line, body block, tab nav, and a stack of comment cards — so the
 * modal doesn't reflow when real data lands. Refresh + close stay live
 * during the fetch.
 */
function DetailSkeleton({
  number,
  onClose,
  onRefresh,
  refreshing,
}: {
  number: number;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-fg-muted/20" />
            <span className="font-mono text-xs text-fg-muted">#{number}</span>
            <span className="h-3.5 w-[55%] animate-pulse rounded bg-fg-muted/15" />
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="h-2.5 w-16 shrink-0 animate-pulse rounded bg-fg-muted/10" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <span className="h-2.5 w-40 shrink-0 animate-pulse rounded bg-fg-muted/10" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <span className="h-2.5 w-8 shrink-0 animate-pulse rounded bg-fg-muted/10" />
            <span className="h-2.5 w-8 shrink-0 animate-pulse rounded bg-fg-muted/10" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <span className="h-2.5 w-14 shrink-0 animate-pulse rounded bg-fg-muted/10" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <span className="h-2.5 w-16 shrink-0 animate-pulse rounded bg-fg-muted/10" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RefreshButton onClick={onRefresh} loading={refreshing} size={14} />
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

      <div
        className="shrink-0 overflow-hidden border-b border-border bg-bg-sidebar/40 px-4 py-3"
        style={{ height: BODY_HEIGHT_DEFAULT }}
      >
        <div className="flex flex-col gap-2">
          <span className="h-3 w-[85%] animate-pulse rounded bg-fg-muted/10" />
          <span className="h-3 w-[72%] animate-pulse rounded bg-fg-muted/10" />
          <span className="h-3 w-[40%] animate-pulse rounded bg-fg-muted/10" />
          <span className="mt-2 h-3 w-[60%] animate-pulse rounded bg-fg-muted/10" />
          <span className="h-3 w-[78%] animate-pulse rounded bg-fg-muted/10" />
          <span className="h-3 w-[35%] animate-pulse rounded bg-fg-muted/10" />
        </div>
      </div>
      <div
        aria-hidden
        className="h-1.5 shrink-0 border-b border-border bg-bg-sidebar/40"
      />

      <nav className="flex shrink-0 border-b border-border">
        {[
          { icon: <MessagesSquare size={13} />, w: "w-20" },
          { icon: <CheckCircle2 size={13} />, w: "w-12" },
          { icon: <GitPullRequest size={13} />, w: "w-10" },
        ].map((tab, i) => (
          <div
            key={i}
            className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs text-fg-muted/60"
          >
            {tab.icon}
            <span
              className={cn("h-2.5 animate-pulse rounded bg-fg-muted/15", tab.w)}
            />
          </div>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ul className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-3">
          {[
            { titleW: "w-24", bodyWidths: ["95%", "82%", "60%"] },
            { titleW: "w-32", bodyWidths: ["70%", "45%"] },
            { titleW: "w-20", bodyWidths: ["88%", "76%", "52%", "30%"] },
          ].map((row, i) => (
            <li
              key={i}
              className="rounded border border-border bg-bg-sidebar/40 p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <span className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-fg-muted/15" />
                <span
                  className={cn(
                    "h-3 animate-pulse rounded bg-fg-muted/15",
                    row.titleW,
                  )}
                />
                <span className="h-2.5 w-14 animate-pulse rounded bg-fg-muted/10" />
                <span className="h-2.5 w-20 animate-pulse rounded bg-fg-muted/10" />
              </div>
              <div className="flex flex-col gap-1.5">
                {row.bodyWidths.map((w, j) => (
                  <span
                    key={j}
                    className="h-3 animate-pulse rounded bg-fg-muted/10"
                    style={{ width: w }}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

type BadgeTone = "default" | "success" | "danger";

interface DetailTabButtonProps {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  badgeTone?: BadgeTone;
  active: boolean;
  onClick: () => void;
}

function DetailTabButton({
  icon,
  label,
  badge,
  badgeTone = "default",
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
            badgeTone === "danger"
              ? "bg-rose-500/20 text-rose-300"
              : badgeTone === "success"
                ? "bg-emerald-500/20 text-emerald-300"
                : active
                  ? "bg-accent/20 text-fg"
                  : "bg-fg-muted/15 text-fg-muted",
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

function MergeActionButton({
  mergeable,
  onClick,
}: {
  mergeable: string | null;
  onClick: () => void;
}) {
  const upper = mergeable?.toUpperCase() ?? null;
  const ready = upper === "MERGEABLE";
  const conflicting = upper === "CONFLICTING";
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={!ready}
      className={cn(
        "rounded-md px-2.5 py-1 text-[11px] font-medium transition",
        ready
          ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
          : "cursor-not-allowed bg-bg-elevated text-fg-muted opacity-70",
      )}
    >
      Merge
    </button>
  );
  if (ready) {
    return button;
  }
  const title = conflicting
    ? "Cannot merge — conflicting branch"
    : "Merge readiness still being determined…";
  return (
    <Tooltip label={title} side="bottom">
      {button}
    </Tooltip>
  );
}

const BODY_HEIGHT_STORAGE_KEY = "acorn:pr-detail-body-height";
const BODY_HEIGHT_DEFAULT = 192;
const BODY_HEIGHT_MIN = 64;
const BODY_HEIGHT_MAX = 600;

function readStoredBodyHeight(): number {
  if (typeof window === "undefined") return BODY_HEIGHT_DEFAULT;
  try {
    const raw = window.localStorage.getItem(BODY_HEIGHT_STORAGE_KEY);
    if (!raw) return BODY_HEIGHT_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return BODY_HEIGHT_DEFAULT;
    return Math.min(BODY_HEIGHT_MAX, Math.max(BODY_HEIGHT_MIN, n));
  } catch {
    return BODY_HEIGHT_DEFAULT;
  }
}

function ResizableBody({ children }: { children: React.ReactNode }) {
  const [height, setHeight] = useState<number>(() => readStoredBodyHeight());
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(BODY_HEIGHT_STORAGE_KEY, String(height));
    } catch {
      // ignore — non-persistent height is fine
    }
  }, [height]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: height };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [height],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      BODY_HEIGHT_MAX,
      Math.max(BODY_HEIGHT_MIN, drag.startH + (e.clientY - drag.startY)),
    );
    setHeight(next);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return (
    <>
      <div
        className="acorn-selectable shrink-0 overflow-y-auto border-b border-border bg-bg-sidebar/40 px-4 py-3"
        style={{ height }}
      >
        {children}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize PR body"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setHeight(BODY_HEIGHT_DEFAULT)}
        title="Drag to resize · double-click to reset"
        className="group relative flex h-1.5 shrink-0 cursor-row-resize items-center justify-center border-b border-border bg-bg-sidebar/40 transition hover:bg-accent/30"
      >
        <span className="h-0.5 w-8 rounded-full bg-fg-muted/0 transition group-hover:bg-fg-muted/40" />
      </div>
    </>
  );
}

function PrStateGlyph({
  state,
  isDraft,
}: {
  state: string;
  isDraft: boolean;
}) {
  const upper = state.toUpperCase();
  if (upper === "MERGED") {
    return <GitMerge size={14} className="text-purple-400" />;
  }
  if (upper === "CLOSED") {
    return <GitPullRequestClosed size={14} className="text-rose-400" />;
  }
  if (isDraft) {
    return <GitPullRequestDraft size={14} className="text-fg-muted" />;
  }
  return <GitPullRequest size={14} className="text-emerald-400" />;
}

type ConversationSort = "oldest" | "newest";

const CONVERSATION_SORT_STORAGE_KEY = "acorn:pr-conversation-sort";

function readStoredSort(): ConversationSort {
  if (typeof window === "undefined") return "oldest";
  try {
    const raw = window.localStorage.getItem(CONVERSATION_SORT_STORAGE_KEY);
    return raw === "newest" ? "newest" : "oldest";
  } catch {
    return "oldest";
  }
}

function ConversationPane({
  comments,
  reviews,
}: {
  comments: PullRequestComment[];
  reviews: PullRequestReview[];
}) {
  const [sort, setSort] = useState<ConversationSort>(() => readStoredSort());

  useEffect(() => {
    try {
      window.localStorage.setItem(CONVERSATION_SORT_STORAGE_KEY, sort);
    } catch {
      // non-persistent preference is fine
    }
  }, [sort]);

  // Merge into a single chronological timeline. Keep `kind` along for the
  // ride so we can render reviews with their verdict badge.
  type Entry =
    | { kind: "comment"; ts: string; comment: PullRequestComment }
    | { kind: "review"; ts: string; review: PullRequestReview };
  const entries: Entry[] = useMemo(() => {
    const merged: Entry[] = [
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
    ];
    merged.sort((a, b) =>
      sort === "newest" ? b.ts.localeCompare(a.ts) : a.ts.localeCompare(b.ts),
    );
    return merged;
  }, [comments, reviews, sort]);

  const toolbar = (
    <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1.5">
      <SortToggle value={sort} onChange={setSort} />
    </div>
  );

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="flex flex-1 items-center justify-center text-xs text-fg-muted">
          No comments or reviews yet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <ul className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {entries.map((entry, i) =>
          entry.kind === "comment" ? (
            <CommentBlock key={`c-${i}`} comment={entry.comment} />
          ) : (
            <ReviewBlock key={`r-${i}`} review={entry.review} />
          ),
        )}
      </ul>
    </div>
  );
}

function SortToggle({
  value,
  onChange,
}: {
  value: ConversationSort;
  onChange: (next: ConversationSort) => void;
}) {
  const isOldest = value === "oldest";
  const label = isOldest ? "Oldest first" : "Newest first";
  const Icon = isOldest ? ArrowDownNarrowWide : ArrowUpNarrowWide;
  return (
    <Tooltip label="Toggle sort order" side="bottom">
      <button
        type="button"
        onClick={() => onChange(isOldest ? "newest" : "oldest")}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
      >
        <Icon size={12} />
        {label}
      </button>
    </Tooltip>
  );
}

function CommentBlock({ comment }: { comment: PullRequestComment }) {
  return (
    <li className="rounded border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10.5px] text-fg-muted">
        <AuthorTag
          login={comment.author}
          size={28}
          nameClass="text-[12.5px] font-semibold tracking-tight"
        />
        <span className="opacity-60">commented</span>
        <span className="font-mono opacity-60">
          {formatTimestamp(comment.created_at)}
        </span>
      </div>
      {comment.body.trim().length > 0 ? (
        <div className="acorn-selectable">
          <Markdown content={comment.body} />
        </div>
      ) : (
        <p className="text-[11px] text-fg-muted">(empty)</p>
      )}
    </li>
  );
}

function ReviewBlock({ review }: { review: PullRequestReview }) {
  return (
    <li className="rounded border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10.5px] text-fg-muted">
        <AuthorTag
          login={review.author}
          size={28}
          nameClass="text-[12.5px] font-semibold tracking-tight"
        />
        <ReviewStateBadge state={review.state} />
        <span className="font-mono opacity-60">
          {formatTimestamp(review.submitted_at)}
        </span>
      </div>
      {review.body.trim().length > 0 ? (
        <div className="acorn-selectable">
          <Markdown content={review.body} />
        </div>
      ) : (
        <p className="text-[11px] text-fg-muted">
          (no review comment)
        </p>
      )}
    </li>
  );
}

/**
 * Inline 18px GitHub avatar. Uses the public `github.com/{login}.png`
 * endpoint — no API token needed and it works for `[bot]` accounts when
 * the `[bot]` suffix is stripped. Falls back invisibly via `alt=""` on
 * load failure so the timeline stays clean.
 */
function AuthorAvatar({
  login,
  size = 24,
  className,
}: {
  login: string;
  size?: number;
  className?: string;
}) {
  const slug = login.replace(/\[bot\]$/, "");
  if (!slug) return null;
  const pixelSize = Math.max(40, size * 2);
  return (
    <img
      src={`https://github.com/${encodeURIComponent(slug)}.png?size=${pixelSize}`}
      alt=""
      title={login}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: size, height: size }}
      className={cn(
        "shrink-0 rounded-full bg-bg-elevated align-middle",
        className,
      )}
    />
  );
}

/**
 * Avatar + login pair with a right-click context menu offering "Open
 * GitHub profile". Used in the modal header and in each conversation
 * block. Strips the `[bot]` suffix when building the profile URL so it
 * resolves for bot accounts like `dependabot[bot]`.
 */
function AuthorTag({
  login,
  size = 24,
  nameClass,
  avatarOnly = false,
}: {
  login: string;
  size?: number;
  nameClass?: string;
  /** When true, render only the avatar (no inline username text). */
  avatarOnly?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const slug = login.replace(/\[bot\]$/, "");
  const profileUrl = slug ? `https://github.com/${slug}` : null;

  const items: ContextMenuItem[] = profileUrl
    ? [
        {
          label: "Open GitHub profile",
          icon: <ExternalLink size={12} />,
          onClick: () => void openUrl(profileUrl),
        },
      ]
    : [];

  return (
    <>
      <span
        onContextMenu={(e) => {
          if (!profileUrl) return;
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className="inline-flex shrink-0 items-center gap-1.5 align-middle"
      >
        <AuthorAvatar login={login} size={size} />
        {avatarOnly ? null : (
          <span className={cn("font-mono text-fg", nameClass)}>{login}</span>
        )}
      </span>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
      />
    </>
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
            <Tooltip label="Open run" side="top">
              <button
                type="button"
                onClick={() => {
                  if (c.url) void openUrl(c.url);
                }}
                className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
              >
                <ExternalLink size={11} />
              </button>
            </Tooltip>
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
  const raw =
    status.toUpperCase() === "COMPLETED"
      ? (conclusion ?? "completed")
      : status;
  const text = raw.toLowerCase().replace(/_/g, " ");
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
