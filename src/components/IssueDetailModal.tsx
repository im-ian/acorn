import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  CircleDot,
  CircleX,
  ExternalLink,
  MessageSquare,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import type {
  IssueComment,
  IssueDetail,
  IssueDetailListing,
  PullRequestLabel,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { AuthorTag } from "./AuthorTag";
import { Tooltip } from "./Tooltip";
import {
  Markdown,
  Modal,
  ModalHeader,
  RefreshButton,
  SkeletonBlock,
  SkeletonText,
} from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface IssueDetailModalProps {
  open: { repoPath: string; number: number } | null;
  onClose: () => void;
}

export function IssueDetailModal({ open, onClose }: IssueDetailModalProps) {
  const t = useTranslation();
  const [listing, setListing] = useState<IssueDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useDialogShortcuts(open !== null, { onCancel: onClose });

  useEffect(() => {
    if (!open) {
      setListing(null);
      setError(null);
      setReloadKey(0);
      setRefreshing(false);
      return;
    }
    setListing(null);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRefreshing(true);
    api
      .getIssueDetail(open.repoPath, open.number)
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reloadKey]);

  const handleRefresh = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  return (
    <Modal open={open !== null} onClose={onClose} variant="panel" size="3xl">
      {open ? (
        error ? (
          <IssueModalShell
            title={`#${open.number}`}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          >
            <div className="p-4 text-xs text-danger">{error}</div>
          </IssueModalShell>
        ) : !listing ? (
          <IssueDetailSkeleton
            number={open.number}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />
        ) : listing.kind === "not_github" ? (
          <IssueModalShell
            title={`#${open.number}`}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          >
            <div className="p-4 text-xs text-fg-muted">
              {dt(t, "dialogs.issueDetail.notGithub")}
            </div>
          </IssueModalShell>
        ) : listing.kind === "no_access" ? (
          <IssueModalShell
            title={`#${open.number}`}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          >
            <div className="p-4 text-xs text-fg-muted">
              {dt(t, "dialogs.issueDetail.noAccessPrefix")}{" "}
              <code className="font-mono">gh</code>{" "}
              {dt(t, "dialogs.issueDetail.noAccessSuffix")} {listing.slug}.
            </div>
          </IssueModalShell>
        ) : (
          <IssueDetailBody
            detail={listing.detail}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          />
        )
      ) : null}
    </Modal>
  );
}

function IssueModalShell({
  title,
  onClose,
  onRefresh,
  refreshing,
  children,
}: {
  title: string;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <ModalHeader
        title={title}
        actions={<RefreshButton onClick={onRefresh} loading={refreshing} size={14} />}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </>
  );
}

function IssueDetailBody({
  detail,
  onClose,
  onRefresh,
  refreshing,
}: {
  detail: IssueDetail;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const t = useTranslation();
  const created = toUnixSeconds(detail.created_at);
  const updated = toUnixSeconds(detail.updated_at);
  const subtitle = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <AuthorTag
        login={detail.author}
        size={16}
        nameClass="text-[11px] text-fg-muted"
      />
      <span className="opacity-50">·</span>
      <span>{dt(t, "dialogs.issueDetail.created")} {absoluteTime(created)}</span>
      <span className="opacity-50">·</span>
      <span>{dt(t, "dialogs.issueDetail.updated")} {absoluteTime(updated)}</span>
    </span>
  );

  return (
    <>
      <ModalHeader
        title={`#${detail.number} ${detail.title}`}
        subtitle={subtitle}
        icon={<IssueStateGlyph state={detail.state} reason={detail.state_reason} />}
        actions={
          <>
            <RefreshButton onClick={onRefresh} loading={refreshing} size={14} />
            <Tooltip
              label={dt(t, "dialogs.issueDetail.openOnGithub")}
              side="bottom"
            >
              <button
                type="button"
                onClick={() => void openUrl(detail.url)}
                className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
              >
                <ExternalLink size={14} />
              </button>
            </Tooltip>
          </>
        }
        onClose={onClose}
      />
      <div className="acorn-no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-4 py-3">
          <IssueMeta detail={detail} />
          {detail.body.trim().length > 0 ? (
            <section className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30 px-3 py-2">
              <Markdown content={detail.body} />
            </section>
          ) : (
            <div className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30 px-3 py-2 text-xs text-fg-muted">
              {dt(t, "dialogs.issueDetail.noBody")}
            </div>
          )}
          <section>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              <MessageSquare size={12} />
              {dt(t, "dialogs.issueDetail.comments")} ({detail.comments.length})
            </div>
            {detail.comments.length === 0 ? (
              <div className="rounded-[var(--acorn-pane-radius)] border border-border/60 px-3 py-2 text-xs text-fg-muted">
                {dt(t, "dialogs.issueDetail.noComments")}
              </div>
            ) : (
              <ul className="space-y-2">
                {detail.comments.map((comment, index) => (
                  <IssueCommentBlock
                    key={`${comment.created_at}:${comment.author}:${index}`}
                    comment={comment}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function IssueMeta({ detail }: { detail: IssueDetail }) {
  const t = useTranslation();
  const state = detail.state.toUpperCase();
  const reason = detail.state_reason?.toUpperCase() ?? null;
  const stateText =
    state === "OPEN"
      ? dt(t, "dialogs.issueDetail.stateOpen")
      : issueClosedReasonLabel(reason, t);
  const assignees = detail.assignees.join(", ");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
      <span
        className={cn(
          "rounded px-1.5 py-0.5 font-medium",
          state === "OPEN"
            ? "bg-emerald-500/10 text-emerald-300"
            : reason === "NOT_PLANNED"
              ? "bg-fg-muted/15 text-fg-muted"
              : "bg-purple-500/10 text-purple-300",
        )}
      >
        {stateText}
      </span>
      {detail.labels.map((label) => (
        <IssueLabelChip key={label.name} label={label} />
      ))}
      {detail.milestone ? (
        <>
          <span className="opacity-50">·</span>
          <span>
            {dt(t, "dialogs.issueDetail.milestone")} {detail.milestone}
          </span>
        </>
      ) : null}
      {assignees ? (
        <>
          <span className="opacity-50">·</span>
          <span>
            {dt(t, "dialogs.issueDetail.assignees")} {assignees}
          </span>
        </>
      ) : null}
    </div>
  );
}

function IssueCommentBlock({ comment }: { comment: IssueComment }) {
  const t = useTranslation();
  const created = toUnixSeconds(comment.created_at);
  const content =
    comment.body.trim().length > 0
      ? comment.body
      : dt(t, "dialogs.issueDetail.empty");
  return (
    <li className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[11px] text-fg-muted">
        <AuthorTag
          login={comment.author}
          avatarUrl={comment.author_avatar_url}
          size={18}
          nameClass="text-[11px] text-fg"
        />
        <span className="opacity-50">·</span>
        <span>{absoluteTime(created)}</span>
        {comment.url ? (
          <Tooltip
            label={dt(t, "dialogs.issueDetail.openCommentOnGithub")}
            side="top"
            className="ml-auto"
          >
            <button
              type="button"
              onClick={() => void openUrl(comment.url ?? "")}
              className="rounded p-0.5 text-fg-muted transition hover:bg-bg hover:text-fg"
            >
              <ExternalLink size={12} />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className="px-3 py-2">
        <Markdown content={content} />
      </div>
    </li>
  );
}

function IssueLabelChip({ label }: { label: PullRequestLabel }) {
  return (
    <Tooltip label={label.name} side="top">
      <span
        className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase"
        style={{
          backgroundColor: `#${label.color.replace(/^#/, "")}26`,
          color: `#${label.color.replace(/^#/, "")}`,
        }}
      >
        {label.name}
      </span>
    </Tooltip>
  );
}

function IssueStateGlyph({
  state,
  reason,
}: {
  state: string;
  reason: string | null;
}) {
  if (state.toUpperCase() === "OPEN") {
    return <CircleDot size={14} className="text-emerald-400" />;
  }
  if (reason?.toUpperCase() === "NOT_PLANNED") {
    return <CircleX size={14} className="text-fg-muted" />;
  }
  return <CircleCheck size={14} className="text-purple-400" />;
}

function issueClosedReasonLabel(
  reason: string | null,
  t: Translator,
): string {
  if (reason === "NOT_PLANNED") {
    return dt(t, "dialogs.issueDetail.stateNotPlanned");
  }
  return dt(t, "dialogs.issueDetail.stateCompleted");
}

function IssueDetailSkeleton({
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
      <ModalHeader
        title={`#${number}`}
        icon={<CircleDot size={14} className="text-fg-muted" />}
        actions={<RefreshButton onClick={onRefresh} loading={refreshing} size={14} />}
        onClose={onClose}
      />
      <div className="space-y-3 px-4 py-3">
        <SkeletonBlock className="h-3 w-36 bg-fg-muted/15" />
        <div className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30 p-3">
          <SkeletonText
            className="gap-2"
            lines={6}
            widths={Array.from(
              { length: 6 },
              (_, index) => `${42 + ((index * 17) % 45)}%`,
            )}
          />
        </div>
        <SkeletonBlock className="h-3 w-24 bg-fg-muted/15" />
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div
              key={index}
              className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30 p-3"
            >
              <SkeletonBlock className="mb-2 h-3 w-28 bg-fg-muted/15" />
              <SkeletonBlock className="h-3 w-4/5" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function toUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

function absoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}
