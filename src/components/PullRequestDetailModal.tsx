import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  Copy,
  ExternalLink,
  GitCommit,
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
import { Panel, PanelGroup } from "react-resizable-panels";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { useToasts } from "../lib/toasts";
import { ResizeHandle } from "./ResizeHandle";
import type {
  DiffPayload,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestDetailListing,
  PullRequestReview,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { AuthorTag, buildProfileMenuItems } from "./AuthorTag";
import { ClosePullRequestDialog } from "./ClosePullRequestDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffSplitView } from "./DiffSplitView";
import { GitHubLabelChip } from "./GitHubLabelChip";
import { MergePullRequestDialog } from "./MergePullRequestDialog";
import { Tooltip } from "./Tooltip";
import {
  ListBox,
  ListEmptyState,
  ListRow,
  ListRowButton,
  Markdown,
  Modal,
  ModalHeader,
  RefreshButton,
  SegmentedControl,
  SkeletonBlock,
  SkeletonCircle,
  SkeletonText,
  StatusBadge,
  type StatusTone,
} from "./ui";

type DetailTab = "conversation" | "commits" | "checks" | "files";
type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function useLiveUnixSeconds(enabled: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled) return;
    setNow(Math.floor(Date.now() / 1000));
    const handle = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1_000);
    return () => window.clearInterval(handle);
  }, [enabled]);
  return now;
}

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
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const [listing, setListing] = useState<PullRequestDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("conversation");
  // Bumped by the refresh button. Triggers a background refetch that keeps
  // the current listing visible while it resolves.
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  // Optimistic body override while a task-list checkbox toggle is in flight
  // (or after one succeeds, until the next fetch overwrites it). Keyed by
  // PR identity so a stale override never bleeds into a different PR.
  const [bodyOverride, setBodyOverride] = useState<{
    key: string;
    body: string;
  } | null>(null);
  const [bodySaveError, setBodySaveError] = useState<string | null>(null);
  const bodyWriteSeqRef = useRef(0);

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
      setBodyOverride(null);
      setBodySaveError(null);
      return;
    }
    setListing(null);
    setError(null);
    setBodyOverride(null);
    setBodySaveError(null);
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
        setError(null);
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

  const detail = listing && listing.kind === "ok" ? listing.detail : null;
  const hasRunningChecks =
    detail?.checks.some((check) => check.status.toUpperCase() !== "COMPLETED") ??
    false;

  useEffect(() => {
    if (!open || !hasRunningChecks) return;
    let cancelled = false;
    const handle = window.setInterval(() => {
      void api
        .getPullRequestDetail(open.repoPath, open.number)
        .then((result) => {
          if (!cancelled) {
            setListing(result);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            console.debug("[PullRequestDetailModal] polling failed", e);
          }
        });
    }, refreshIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [open, hasRunningChecks, refreshIntervalMs]);

  const handleRefresh = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const handleMutated = useCallback(() => {
    setReloadKey((k) => k + 1);
    onMutated?.();
  }, [onMutated]);

  const prKey = open ? `${open.repoPath}#${open.number}` : null;
  // Whenever a fresh detail arrives, the canonical body wins unless we have
  // an unsynced override from a click that happened mid-fetch. The override
  // is cleared opportunistically when it matches the server again.
  useEffect(() => {
    if (!detail || !prKey) return;
    setBodyOverride((prev) => {
      if (!prev || prev.key !== prKey) return null;
      if (prev.body === detail.body) return null;
      return prev;
    });
  }, [detail, prKey]);

  const displayBody = useMemo(() => {
    if (!detail || !prKey) return null;
    if (bodyOverride && bodyOverride.key === prKey) return bodyOverride.body;
    return detail.body;
  }, [detail, bodyOverride, prKey]);

  const handleTaskToggle = useCallback(
    (index: number, checked: boolean) => {
      if (!open || !detail || !prKey) return;
      const current =
        bodyOverride && bodyOverride.key === prKey
          ? bodyOverride.body
          : detail.body;
      const next = toggleTaskMarker(current, index, checked);
      if (next === null || next === current) return;
      const seq = ++bodyWriteSeqRef.current;
      setBodyOverride({ key: prKey, body: next });
      setBodySaveError(null);
      api
        .updatePullRequestBody(open.repoPath, open.number, next)
        .then(() => {
          if (seq !== bodyWriteSeqRef.current) return;
          setReloadKey((k) => k + 1);
        })
        .catch((e) => {
          if (seq !== bodyWriteSeqRef.current) return;
          const message = String(e);
          setBodyOverride(null);
          setBodySaveError(message);
          showToast(`${t("toasts.pullRequests.bodyUpdateFailed")} ${message}`);
        });
    },
    [open, detail, prKey, bodyOverride, showToast, t],
  );

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
              {dt(t, "dialogs.pullRequestDetail.notGithub")}
            </div>
          </ModalShell>
        ) : listing.kind === "no_access" ? (
          <ModalShell title={`#${open.number}`} onClose={onClose}>
            <div className="p-4 text-xs text-fg-muted">
              {dt(t, "dialogs.pullRequestDetail.noAccessPrefix")}{" "}
              <code className="font-mono">gh</code>{" "}
              {dt(t, "dialogs.pullRequestDetail.noAccessSuffix")}{" "}
              {listing.slug}.
            </div>
          </ModalShell>
        ) : (
          <DetailBody
            detail={listing.detail}
            body={displayBody ?? listing.detail.body}
            onTaskToggle={handleTaskToggle}
            bodySaveError={bodySaveError}
            tab={tab}
            onTab={setTab}
            repoPath={open.repoPath}
            cwd={cwd}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            diffReloadKey={reloadKey}
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
  body,
  onTaskToggle,
  bodySaveError,
  tab,
  onTab,
  repoPath,
  cwd,
  onClose,
  onRefresh,
  refreshing,
  diffReloadKey,
  onOpenMerge,
  onOpenClose,
}: {
  detail: PullRequestDetail;
  /** Optimistically-overridden body (or `detail.body` if no edit is pending). */
  body: string;
  onTaskToggle: (index: number, checked: boolean) => void;
  bodySaveError: string | null;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;
  repoPath: string;
  cwd?: string;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  diffReloadKey: number;
  onOpenMerge: () => void;
  onOpenClose: () => void;
}) {
  const t = useTranslation();
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
  const fileCount = detail.changed_files;
  const commitCount = detail.commits.length;
  const hasBody = body.trim().length > 0;

  const mainSection = (
    <>
      <SegmentedControl
        activeId={tab}
        items={[
          {
            id: "conversation",
            icon: <MessagesSquare size={13} />,
            label: dt(t, "dialogs.pullRequestDetail.tabConversation"),
            badge: conversationCount > 0 ? conversationCount : null,
          },
          {
            id: "commits",
            icon: <GitCommit size={13} />,
            label: dt(t, "dialogs.pullRequestDetail.tabCommits"),
            badge: commitCount > 0 ? commitCount : null,
          },
          {
            id: "checks",
            icon: <CheckCircle2 size={13} />,
            label: dt(t, "dialogs.pullRequestDetail.tabChecks"),
            badge: allChecksPassed ? (
              <Check size={11} strokeWidth={3} />
            ) : allChecksFailed ? (
              <X size={11} strokeWidth={3} />
            ) : checksPartial ? (
              `${checkCounts.passed}/${totalChecks}`
            ) : null,
            badgeTone: allChecksPassed
              ? "success"
              : allChecksFailed
                ? "danger"
                : "neutral",
          },
          {
            id: "files",
            icon: <GitPullRequest size={13} />,
            label: dt(t, "dialogs.pullRequestDetail.tabFiles"),
            badge: fileCount > 0 ? fileCount : null,
          },
        ]}
        onChange={onTab}
        ariaLabel="Pull request detail tabs"
        className="shrink-0 border-b border-border px-1.5 py-1"
      />

      <div className="min-h-0 flex-1 overflow-hidden p-1.5">
        {tab === "conversation" ? (
          <ConversationPane
            comments={detail.comments}
            reviews={detail.reviews}
          />
        ) : tab === "commits" ? (
          <CommitsPane
            commits={detail.commits}
            prUrl={detail.url}
            repoPath={repoPath}
            cwd={cwd}
          />
        ) : tab === "checks" ? (
          <ChecksPane checks={detail.checks} />
        ) : (
          <PullRequestFilesPane
            active={tab === "files"}
            repoPath={repoPath}
            number={detail.number}
            cwd={cwd}
            reloadKey={diffReloadKey}
          />
        )}
      </div>
    </>
  );

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <PrStateGlyph state={detail.state} isDraft={detail.is_draft} />
            <span
              className={cn(
                "shrink-0 font-mono text-xs leading-5",
                detail.is_draft && detail.state.toUpperCase() === "OPEN"
                  ? "text-fg-muted"
                  : detail.state.toUpperCase() === "OPEN"
                    ? "text-emerald-400"
                    : detail.state.toUpperCase() === "MERGED"
                      ? "text-purple-400"
                      : "text-rose-400",
              )}
            >
              #{detail.number}
            </span>
            <Tooltip
              label={detail.title}
              side="bottom"
              multiline
              className="min-w-0 flex-1"
            >
              <h3 className="truncate text-sm font-semibold leading-5 tracking-tight text-fg">
                {detail.title}
              </h3>
            </Tooltip>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-muted">
            <AuthorTag
              login={detail.author}
              size={16}
              nameClass="text-[11px] text-fg-muted"
            />
            <span className="opacity-50">·</span>
            <span className="font-mono">
              {detail.head_branch} → {detail.base_branch}
            </span>
            <span className="opacity-50">·</span>
            <span className="font-mono text-emerald-400">
              +{detail.additions}
            </span>
            <span className="font-mono text-rose-400">
              −{detail.deletions}
            </span>
            <span className="opacity-50">·</span>
            <span>
              {detail.changed_files} {dt(t, "dialogs.pullRequestDetail.files")}
            </span>
            {detail.labels.length > 0 ? (
              <>
                <span className="opacity-50">·</span>
                {detail.labels.map((label) => (
                  <GitHubLabelChip key={label.name} label={label} />
                ))}
              </>
            ) : null}
          </div>
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
                {dt(t, "dialogs.common.close")}
              </button>
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            </>
          ) : null}
          <RefreshButton onClick={onRefresh} loading={refreshing} size={14} />
          <Tooltip label={dt(t, "dialogs.pullRequestDetail.openOnGithub")} side="bottom">
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
            aria-label={dt(t, "dialogs.common.close")}
            onClick={onClose}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {hasBody ? (
        <PanelGroup
          direction="vertical"
          autoSaveId="acorn:pr-detail-body-main"
          className="min-h-0 flex-1"
        >
          <Panel id="pr-body" order={1} defaultSize={22} minSize={10} maxSize={60}>
            <div className="acorn-selectable h-full overflow-y-auto bg-bg-sidebar/40 px-4 py-3">
              <Markdown content={body} onTaskToggle={onTaskToggle} />
              {bodySaveError ? (
                <p className="mt-2 text-[10.5px] text-danger">
                  {dt(t, "dialogs.pullRequestDetail.checkboxSaveFailed")}{" "}
                  {bodySaveError}
                </p>
              ) : null}
            </div>
          </Panel>
          <ResizeHandle direction="vertical" gap />
          <Panel id="pr-main" order={2} defaultSize={78} minSize={30}>
            <div className="flex h-full min-h-0 flex-col">{mainSection}</div>
          </Panel>
        </PanelGroup>
      ) : (
        mainSection
      )}
    </>
  );
}

function PullRequestFilesPane({
  active,
  repoPath,
  number,
  cwd,
  reloadKey,
}: {
  active: boolean;
  repoPath: string;
  number: number;
  cwd?: string;
  reloadKey: number;
}) {
  const t = useTranslation();
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setError(null);
    setLoading(false);
    loadedKeyRef.current = null;
  }, [repoPath, number]);

  useEffect(() => {
    if (!active) return;
    const requestKey = `${repoPath}#${number}:${reloadKey}`;
    if (loadedKeyRef.current === requestKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getPullRequestDiff(repoPath, number)
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "ok") {
          loadedKeyRef.current = requestKey;
          setDiff(result.diff);
          setError(null);
        } else if (result.kind === "not_github") {
          setDiff(null);
          setError(dt(t, "dialogs.pullRequestDetail.notGithub"));
        } else {
          setDiff(null);
          setError(
            `${dt(t, "dialogs.pullRequestDetail.noAccessPrefix")} gh ${dt(
              t,
              "dialogs.pullRequestDetail.noAccessSuffix",
            )} ${result.slug}.`,
          );
        }
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, repoPath, number, reloadKey, t]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-danger">
        {error}
      </div>
    );
  }
  if (loading && !diff) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        {dt(t, "dialogs.pullRequestDetail.loadingDiff")}
      </div>
    );
  }
  if (!diff) {
    return null;
  }
  if (diff.files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        {t("diffView.noChanges")}
      </div>
    );
  }
  return <DiffSplitView payload={diff} cwd={cwd} />;
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
  const t = useTranslation();
  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="h-3.5 w-3.5 shrink-0 bg-fg-muted/20" />
            <span className="font-mono text-xs text-fg-muted">#{number}</span>
            <SkeletonBlock className="h-3.5 w-[55%] bg-fg-muted/15" />
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <SkeletonBlock className="h-2.5 w-16 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-40 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-8 shrink-0" />
            <SkeletonBlock className="h-2.5 w-8 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-14 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-16 shrink-0" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RefreshButton onClick={onRefresh} loading={refreshing} size={14} />
          <button
            type="button"
            aria-label={dt(t, "dialogs.common.close")}
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
          <SkeletonText
            className="gap-2"
            lines={3}
            widths={["85%", "72%", "40%"]}
          />
          <SkeletonText
            className="mt-2 gap-2"
            lines={3}
            widths={["60%", "78%", "35%"]}
          />
        </div>
      </div>
      <div
        aria-hidden
        className="h-1.5 shrink-0 border-b border-border bg-bg-sidebar/40"
      />

      <nav className="flex shrink-0 gap-0.5 border-b border-border px-1.5 py-1">
        {[
          { icon: <MessagesSquare size={13} />, w: "w-20" },
          { icon: <GitCommit size={13} />, w: "w-14" },
          { icon: <CheckCircle2 size={13} />, w: "w-12" },
          { icon: <GitPullRequest size={13} />, w: "w-10" },
        ].map((tab, i) => (
          <div
            key={i}
            className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs text-fg-muted/60"
          >
            {tab.icon}
            <SkeletonBlock className={cn("h-2.5 bg-fg-muted/15", tab.w)} />
          </div>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1.5">
          <div className="flex items-center gap-1 px-1.5 py-0.5">
            <SkeletonBlock className="h-3 w-3 shrink-0 rounded-sm bg-fg-muted/15" />
            <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/15" />
          </div>
        </div>
        <ul className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {[
            { titleW: "w-24", bodyWidths: ["95%", "82%", "60%"] },
            { titleW: "w-32", bodyWidths: ["70%", "45%"] },
            { titleW: "w-20", bodyWidths: ["88%", "76%", "52%", "30%"] },
          ].map((row, i) => (
            <li
              key={i}
              className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <SkeletonCircle className="h-7 w-7 shrink-0 bg-fg-muted/15" />
                <SkeletonBlock
                  className={cn("h-3 bg-fg-muted/15", row.titleW)}
                />
                <SkeletonBlock className="h-2.5 w-14" />
                <SkeletonBlock className="h-2.5 w-20" />
              </div>
              <SkeletonText
                lines={row.bodyWidths.length}
                widths={row.bodyWidths}
              />
            </li>
          ))}
        </ul>
      </div>
    </>
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
  const t = useTranslation();
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
      {dt(t, "dialogs.pullRequestDetail.merge")}
    </button>
  );
  if (ready) {
    return button;
  }
  const title = conflicting
    ? dt(t, "dialogs.pullRequestDetail.cannotMergeConflicting")
    : dt(t, "dialogs.pullRequestDetail.mergeReadinessPending");
  return (
    <Tooltip label={title} side="bottom">
      {button}
    </Tooltip>
  );
}

const BODY_HEIGHT_DEFAULT = 192;

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
  const t = useTranslation();
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
          {dt(t, "dialogs.pullRequestDetail.noComments")}
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
  const t = useTranslation();
  const label = isOldest
    ? dt(t, "dialogs.pullRequestDetail.oldestFirst")
    : dt(t, "dialogs.pullRequestDetail.newestFirst");
  const Icon = isOldest ? ArrowDownNarrowWide : ArrowUpNarrowWide;
  return (
    <Tooltip label={dt(t, "dialogs.pullRequestDetail.toggleSortOrder")} side="bottom">
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
  const t = useTranslation();
  return (
    <li className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10.5px] text-fg-muted">
        <AuthorTag
          login={comment.author}
          avatarUrl={comment.author_avatar_url}
          size={28}
          nameClass="text-[12.5px] font-semibold tracking-tight"
        />
        <span className="opacity-60">
          {dt(t, "dialogs.pullRequestDetail.commented")}
        </span>
        <span className="font-mono opacity-60">
          {formatTimestamp(comment.created_at)}
        </span>
      </div>
      {comment.body.trim().length > 0 ? (
        <div className="acorn-selectable">
          <Markdown content={comment.body} />
        </div>
      ) : (
        <p className="text-[11px] text-fg-muted">
          {dt(t, "dialogs.pullRequestDetail.empty")}
        </p>
      )}
    </li>
  );
}

function ReviewBlock({ review }: { review: PullRequestReview }) {
  const t = useTranslation();
  return (
    <li className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-[10.5px] text-fg-muted">
        <AuthorTag
          login={review.author}
          avatarUrl={review.author_avatar_url}
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
          {dt(t, "dialogs.pullRequestDetail.noReviewComment")}
        </p>
      )}
    </li>
  );
}

function ReviewStateBadge({ state }: { state: string }) {
  const t = useTranslation();
  const upper = state.toUpperCase();
  const tone: StatusTone =
    upper === "APPROVED"
      ? "success"
      : upper === "CHANGES_REQUESTED"
        ? "danger"
        : "neutral";
  const label =
    upper === "APPROVED"
      ? dt(t, "dialogs.pullRequestDetail.reviewApproved")
      : upper === "CHANGES_REQUESTED"
        ? dt(t, "dialogs.pullRequestDetail.reviewChangesRequested")
        : upper === "DISMISSED"
          ? dt(t, "dialogs.pullRequestDetail.reviewDismissed")
          : upper.replace("_", " ").toLowerCase();
  return (
    <StatusBadge
      tone={tone}
      size="xs"
      className={cn(
        "uppercase tracking-wide",
        upper === "DISMISSED" && "line-through",
      )}
    >
      {label}
    </StatusBadge>
  );
}

function CommitsPane({
  commits,
  prUrl,
  repoPath,
  cwd,
}: {
  commits: PullRequestCommit[];
  prUrl: string;
  repoPath: string;
  cwd?: string;
}) {
  const t = useTranslation();
  // gh returns commits in chronological order (oldest first); flip so the
  // newest commit lands at the top of the list and is the default selection.
  const orderedCommits = useMemo(() => commits.slice().reverse(), [commits]);
  const [selectedOid, setSelectedOid] = useState<string | null>(
    orderedCommits[0]?.oid ?? null,
  );

  // Re-select first commit whenever the list identity changes (PR switch /
  // refresh adds new commits). Compare by joined oid list to avoid resetting
  // on every render.
  const oidsKey = useMemo(
    () => orderedCommits.map((c) => c.oid).join(","),
    [orderedCommits],
  );
  useEffect(() => {
    if (orderedCommits.length === 0) {
      setSelectedOid(null);
      return;
    }
    setSelectedOid((cur) =>
      cur && orderedCommits.some((c) => c.oid === cur)
        ? cur
        : orderedCommits[0].oid,
    );
  }, [oidsKey, orderedCommits]);

  if (orderedCommits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        {dt(t, "dialogs.pullRequestDetail.noCommits")}
      </div>
    );
  }

  const selected =
    orderedCommits.find((c) => c.oid === selectedOid) ?? null;

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="acorn:pr-commits-split"
      className="h-full min-h-0"
    >
      <Panel id="list" order={1} defaultSize={28} minSize={18} maxSize={50}>
        <aside className="flex h-full flex-col overflow-y-auto rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar text-xs">
          <ListBox layout="flex" text="none">
            {orderedCommits.map((c) => (
              <CommitListItem
                key={c.oid}
                commit={c}
                prUrl={prUrl}
                selected={c.oid === selectedOid}
                onSelect={() => setSelectedOid(c.oid)}
              />
            ))}
          </ListBox>
        </aside>
      </Panel>
      <ResizeHandle gap />
      <Panel id="detail" order={2} defaultSize={72} minSize={40}>
        <div className="flex h-full min-w-0 flex-col">
          {selected ? (
            <CommitDetailView
              commit={selected}
              prUrl={prUrl}
              repoPath={repoPath}
              cwd={cwd}
            />
          ) : null}
        </div>
      </Panel>
    </PanelGroup>
  );
}

function CommitListItem({
  commit,
  prUrl,
  selected,
  onSelect,
}: {
  commit: PullRequestCommit;
  prUrl: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const primaryAuthor = commit.authors[0];
  const commitUrl = buildCommitUrl(prUrl, commit.oid);
  const profileItems = buildProfileMenuItems(
    primaryAuthor?.login,
    t("ui.openGitHubProfile"),
  );

  const items: ContextMenuItem[] = [
    ...(commitUrl
      ? [
          {
            label: dt(t, "dialogs.pullRequestDetail.viewOnGithub"),
            icon: <ExternalLink size={12} />,
            onClick: () => void openUrl(commitUrl),
          },
        ]
      : []),
    ...profileItems,
    ...((commitUrl || profileItems.length > 0)
      ? [{ type: "separator" as const }]
      : []),
    {
      label: dt(t, "dialogs.pullRequestDetail.copySha"),
      icon: <Copy size={12} />,
      onClick: () => void navigator.clipboard.writeText(commit.oid),
    },
  ];

  return (
    <li>
      <ListRowButton
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        selected={selected}
        selectedClassName="bg-bg-elevated text-fg"
        surface="subtle"
        className={cn("block", !selected && "text-fg-muted hover:text-fg")}
      >
        <Tooltip
          label={commit.message_headline || dt(t, "dialogs.pullRequestDetail.noMessage")}
          side="right"
          multiline
          className="min-w-0 w-full"
        >
          <div className="w-full truncate text-[12px] font-medium text-fg">
            {commit.message_headline || dt(t, "dialogs.pullRequestDetail.noMessage")}
          </div>
        </Tooltip>
        <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-fg-muted">
          {primaryAuthor ? (
            <AuthorTag
              login={primaryAuthor.login}
              fallbackName={primaryAuthor.name || dt(t, "dialogs.pullRequestDetail.unknown")}
              size={14}
              nameClass="text-[10.5px] text-fg-muted"
            />
          ) : null}
          <span className="opacity-50">·</span>
          <span className="font-mono opacity-70">
            {formatRelativeTime(commit.committed_date, t)}
          </span>
        </div>
      </ListRowButton>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={items}
        onClose={() => setMenu(null)}
      />
    </li>
  );
}

function CommitDetailView({
  commit,
  prUrl,
  repoPath,
  cwd,
}: {
  commit: PullRequestCommit;
  prUrl: string;
  repoPath: string;
  cwd?: string;
}) {
  const t = useTranslation();
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const shortOid = commit.oid.slice(0, 7);
  const commitUrl = buildCommitUrl(prUrl, commit.oid);
  const hasBody = commit.message_body.trim().length > 0;
  const primaryAuthor = commit.authors[0];

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    setLoading(true);
    api
      .getPullRequestCommitDiff(repoPath, commit.oid)
      .then((payload) => {
        if (cancelled) return;
        setDiff(payload);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, commit.oid]);

  const diffSection = (
    <div className="h-full min-h-0 overflow-hidden">
      {error ? (
        <div className="flex h-full items-center justify-center px-4 text-center text-xs text-danger">
          {error}
        </div>
      ) : loading || !diff ? (
        <div className="flex h-full items-center justify-center text-xs text-fg-muted">
          {dt(t, "dialogs.pullRequestDetail.loadingDiff")}
        </div>
      ) : diff.files.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-fg-muted">
          {dt(t, "dialogs.pullRequestDetail.noFileChanges")}
        </div>
      ) : (
        <DiffSplitView payload={diff} cwd={cwd} />
      )}
    </div>
  );

  const summaryBody = (
    <div className="acorn-selectable border-t border-border/60 px-4 py-3">
      <Markdown content={commit.message_body} />
    </div>
  );

  const commitHeader = (
    <header className="flex shrink-0 items-start gap-2 px-4 py-2.5">
      <GitCommit size={14} className="mt-[3px] shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <Tooltip
          label={commit.message_headline || dt(t, "dialogs.pullRequestDetail.noMessage")}
          side="bottom"
          multiline
          className="min-w-0 w-full"
        >
          <div className="w-full truncate text-[13px] font-semibold tracking-tight text-fg">
            {commit.message_headline || dt(t, "dialogs.pullRequestDetail.noMessage")}
          </div>
        </Tooltip>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
          {primaryAuthor ? (
            <AuthorTag
              login={primaryAuthor.login}
              fallbackName={primaryAuthor.name || dt(t, "dialogs.pullRequestDetail.unknown")}
              size={16}
              nameClass="text-[11px] text-fg-muted"
            />
          ) : null}
          {commit.authors.length > 1 ? (
            <span className="opacity-70">+{commit.authors.length - 1}</span>
          ) : null}
          <span className="opacity-50">·</span>
          <span className="font-mono opacity-70">
            {formatTimestamp(commit.committed_date)}
          </span>
        </div>
      </div>
      <Tooltip label={dt(t, "dialogs.pullRequestDetail.copySha")} side="bottom">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(commit.oid);
          }}
          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
        >
          {shortOid}
        </button>
      </Tooltip>
      {commitUrl ? (
        <Tooltip
          label={dt(t, "dialogs.pullRequestDetail.openCommitOnGithub")}
          side="bottom"
        >
          <button
            type="button"
            onClick={() => void openUrl(commitUrl)}
            className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <ExternalLink size={12} />
          </button>
        </Tooltip>
      ) : null}
    </header>
  );

  // Header + summary live in one card; the diff is a separate card below.
  const infoCard = (
    <div className="flex h-full flex-col overflow-y-auto rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40">
      {commitHeader}
      {hasBody ? summaryBody : null}
    </div>
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      {hasBody ? (
        <PanelGroup
          direction="vertical"
          autoSaveId="acorn:pr-commit-body-diff"
          className="h-full"
        >
          <Panel id="info" order={1} defaultSize={24} minSize={12} maxSize={70}>
            {infoCard}
          </Panel>
          <ResizeHandle direction="vertical" gap />
          <Panel id="diff" order={2} defaultSize={76} minSize={20}>
            {diffSection}
          </Panel>
        </PanelGroup>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-1.5">
          <div className="shrink-0">{infoCard}</div>
          <div className="min-h-0 flex-1">{diffSection}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact "23h" / "2d" / "May 4" — keeps the commit list narrow. Falls back
 * to the raw string when parsing fails.
 */
function formatRelativeTime(iso: string, t: Translator): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return dt(t, "dialogs.pullRequestDetail.now");
  if (min < 60) return `${min}${dt(t, "dialogs.pullRequestDetail.minuteAbbrev")}`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}${dt(t, "dialogs.pullRequestDetail.hourAbbrev")}`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}${dt(t, "dialogs.pullRequestDetail.dayAbbrev")}`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * `detail.url` is the PR URL (`.../pull/N`). Rewrite to the standalone
 * commit page (`.../commit/{sha}`); returns null when the PR URL is empty
 * or unrecognized so the link button can be skipped instead of opening a
 * broken target.
 */
function buildCommitUrl(prUrl: string, oid: string): string | null {
  if (!prUrl || !oid) return null;
  const m = prUrl.match(/^(.*)\/pull\/\d+(?:\/.*)?$/);
  if (!m) return null;
  return `${m[1]}/commit/${oid}`;
}

function ChecksPane({ checks }: { checks: PullRequestCheck[] }) {
  const t = useTranslation();
  const nowUnix = useLiveUnixSeconds(
    checks.some(
      (check) =>
        check.status.toUpperCase() !== "COMPLETED" && !!check.started_at,
    ),
  );
  if (checks.length === 0) {
    return (
      <ListEmptyState>{dt(t, "dialogs.pullRequestDetail.noChecks")}</ListEmptyState>
    );
  }
  return (
    <ListBox layout="flex" className="h-full overflow-y-auto">
      {checks.map((c, i) => (
        <CheckRow key={`${c.name}-${i}`} check={c} nowUnix={nowUnix} />
      ))}
    </ListBox>
  );
}

function CheckRow({
  check,
  nowUnix,
}: {
  check: PullRequestCheck;
  nowUnix: number;
}) {
  const t = useTranslation();
  const duration = formatCheckDuration(check, t, nowUnix);
  return (
    <ListRow className="flex items-center gap-2">
      <CheckIcon status={check.status} conclusion={check.conclusion} />
      <span className="min-w-0 flex-1 truncate text-fg">
        {check.workflow_name ? (
          <span className="text-fg-muted">{check.workflow_name} / </span>
        ) : null}
        {check.name}
      </span>
      {duration ? (
        <span className="shrink-0 font-mono text-[10px] text-fg-muted">
          {duration}
        </span>
      ) : null}
      <CheckStatusLabel status={check.status} conclusion={check.conclusion} />
      {check.url ? (
        <Tooltip label={dt(t, "dialogs.pullRequestDetail.openRun")} side="top">
          <button
            type="button"
            onClick={() => {
              if (check.url) void openUrl(check.url);
            }}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <ExternalLink size={11} />
          </button>
        </Tooltip>
      ) : null}
    </ListRow>
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
  const t = useTranslation();
  const completed = status.toUpperCase() === "COMPLETED";
  const raw =
    completed
      ? (conclusion ?? "completed")
      : status;
  const normalized = raw.toUpperCase();
  const text =
    normalized === "SUCCESS"
      ? dt(t, "dialogs.pullRequestDetail.checkSuccess")
      : normalized === "FAILURE"
        ? dt(t, "dialogs.pullRequestDetail.checkFailure")
        : normalized === "TIMED_OUT"
          ? dt(t, "dialogs.pullRequestDetail.checkTimedOut")
          : normalized === "ACTION_REQUIRED"
            ? dt(t, "dialogs.pullRequestDetail.checkActionRequired")
            : normalized === "CANCELLED"
              ? dt(t, "dialogs.pullRequestDetail.checkCancelled")
              : normalized === "NEUTRAL"
                ? dt(t, "dialogs.pullRequestDetail.checkNeutral")
                : normalized === "SKIPPED"
                  ? dt(t, "dialogs.pullRequestDetail.checkSkipped")
                  : normalized === "COMPLETED"
                    ? dt(t, "dialogs.pullRequestDetail.checkCompleted")
                    : raw.toLowerCase().replace(/_/g, " ");
  return (
    <StatusBadge
      tone={checkStatusTone(normalized, completed)}
      size="xs"
      pulse={!completed}
      className="font-mono"
    >
      {text}
    </StatusBadge>
  );
}

function checkStatusTone(normalized: string, completed: boolean): StatusTone {
  if (!completed) return "neutral";
  switch (normalized) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
      return "danger";
    default:
      return "neutral";
  }
}

function formatCheckDuration(
  check: PullRequestCheck,
  t: Translator,
  nowUnix = Math.floor(Date.now() / 1000),
): string {
  if (!check.started_at) return "";
  const start = toUnixSeconds(check.started_at);
  if (start <= 0) return "";
  const completed = check.status.toUpperCase() === "COMPLETED";
  const end = completed && check.completed_at ? toUnixSeconds(check.completed_at) : nowUnix;
  return formatDurationSeconds(Math.max(0, end - start), t);
}

function formatDurationSeconds(seconds: number, t: Translator): string {
  if (seconds < 60) {
    return t("rightPanel.duration.seconds").replace("{count}", String(seconds));
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) {
    return rem === 0
      ? t("rightPanel.duration.minutes").replace("{count}", String(minutes))
      : t("rightPanel.duration.minutesSeconds")
          .replace("{minutes}", String(minutes))
          .replace("{seconds}", String(rem));
  }
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem === 0
    ? t("rightPanel.duration.hours").replace("{count}", String(hours))
    : t("rightPanel.duration.hoursMinutes")
        .replace("{hours}", String(hours))
        .replace("{minutes}", String(minRem));
}

function toUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

/**
 * Toggle the Nth GFM task-list marker in `body` to the requested state.
 * Returns the new body, or `null` if the index is out of range.
 *
 * Walks line-by-line so fenced code blocks (which may contain literal
 * `- [ ]` text) don't get counted. Matches the same list markers GFM
 * accepts: `-`, `*`, `+`, `1.`, `1)`.
 */
export function toggleTaskMarker(
  body: string,
  index: number,
  checked: boolean,
): string | null {
  const lineRe = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])/;
  const fenceRe = /^[ \t]{0,3}(```+|~~~+)/;
  let inFence = false;
  let pos = 0;
  let n = 0;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceRe.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const m = lineRe.exec(line);
      if (m) {
        if (n === index) {
          const bracketStart = pos + m[1].length;
          return (
            body.slice(0, bracketStart) +
            `[${checked ? "x" : " "}]` +
            body.slice(bracketStart + 3)
          );
        }
        n++;
      }
    }
    pos += line.length + 1;
  }
  return null;
}

function formatTimestamp(iso: string): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}
