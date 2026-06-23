import { useCallback, useEffect, useState } from "react";
import {
  CircleCheck,
  CircleDot,
  CircleX,
  ExternalLink,
  MessageSquare,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import type {
  IssueComment,
  IssueDetail,
  IssueDetailListing,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { AuthorTag } from "./AuthorTag";
import { GitHubLabelChip } from "./GitHubLabelChip";
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

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <IssueStateGlyph
              state={detail.state}
              reason={detail.state_reason}
            />
            <span
              className={`shrink-0 font-mono text-xs leading-5 ${issueNumberClassName(
                detail.state,
                detail.state_reason,
              )}`}
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
            <span>
              {dt(t, "dialogs.issueDetail.created")} {absoluteTime(created)}
            </span>
            <span className="opacity-50">·</span>
            <span>
              {dt(t, "dialogs.issueDetail.updated")} {absoluteTime(updated)}
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
              <div className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 px-4 py-5 text-center text-xs text-fg-muted">
                <MessageSquare
                  size={14}
                  className="mx-auto mb-2 text-fg-muted/70"
                />
                {dt(t, "dialogs.issueDetail.noComments")}
              </div>
            ) : (
              <ul className="space-y-3">
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
  const assignees = detail.assignees.join(", ");
  if (!detail.milestone && !assignees) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-muted">
      {detail.milestone ? (
        <span>
          {dt(t, "dialogs.issueDetail.milestone")} {detail.milestone}
        </span>
      ) : null}
      {assignees ? (
        <>
          {detail.milestone ? <span className="opacity-50">·</span> : null}
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
  const hasBody = comment.body.trim().length > 0;
  return (
    <li className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-bg-elevated/30 px-3 py-2">
        <div className="min-w-0 flex items-start gap-2">
          <AuthorTag
            login={comment.author}
            avatarUrl={comment.author_avatar_url}
            size={28}
            nameClass="text-[12.5px] font-semibold tracking-tight"
          />
          <div className="min-w-0 pt-0.5 text-[10.5px] leading-4 text-fg-muted">
            <div className="truncate">
              {dt(t, "dialogs.issueDetail.commented")}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 opacity-60">
                {dt(t, "dialogs.issueDetail.created")}
              </span>
              <span className="truncate font-mono opacity-75">
                {absoluteTime(created)}
              </span>
            </div>
          </div>
        </div>
        {comment.url ? (
          <Tooltip
            label={dt(t, "dialogs.issueDetail.openCommentOnGithub")}
            side="top"
            className="ml-auto"
          >
            <button
              type="button"
              onClick={() => void openUrl(comment.url ?? "")}
              className="rounded p-1 text-fg-muted transition hover:bg-bg hover:text-fg"
            >
              <ExternalLink size={12} />
            </button>
          </Tooltip>
        ) : null}
      </div>
      {hasBody ? (
        <div className="acorn-selectable">
          <Markdown content={comment.body} />
        </div>
      ) : (
        <p className="text-[11px] text-fg-muted">
          {dt(t, "dialogs.issueDetail.empty")}
        </p>
      )}
    </li>
  );
}

function IssueStateGlyph({
  state,
  reason,
  size = 14,
}: {
  state: string;
  reason: string | null;
  size?: number;
}) {
  if (state.toUpperCase() === "OPEN") {
    return <CircleDot size={size} className="text-emerald-400" />;
  }
  if (reason?.toUpperCase() === "NOT_PLANNED") {
    return <CircleX size={size} className="text-fg-muted" />;
  }
  return <CircleCheck size={size} className="text-accent" />;
}

function issueNumberClassName(
  state: string,
  reason: string | null,
): string {
  if (state.toUpperCase() === "OPEN") return "text-emerald-400";
  if (reason?.toUpperCase() === "NOT_PLANNED") return "text-fg-muted";
  return "text-accent";
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
