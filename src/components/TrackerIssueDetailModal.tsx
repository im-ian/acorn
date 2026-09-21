import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, MessageSquare, X } from "lucide-react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import { openExternalUrlWithFeedback } from "../lib/externalOpener";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import type {
  TrackerComment,
  TrackerDetailListing,
  TrackerIssueDetail,
  TrackerProvider,
} from "../lib/types";
import { GitHubCommentComposer } from "./GitHubCommentComposer";
import { GitHubLabelChip } from "./GitHubLabelChip";
import { Tooltip } from "./Tooltip";
import {
  Markdown,
  Modal,
  ModalHeader,
  RefreshButton,
  Select,
} from "./ui";

type DetailKey = Extract<TranslationKey, `dialogs.trackerIssueDetail.${string}`>;

function dt(t: Translator, key: DetailKey): string {
  return t(key);
}

function toUnixSeconds(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function absoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

export interface TrackerIssueDetailOpen {
  provider: TrackerProvider;
  repoPath: string;
  id: string;
  identifier: string;
}

export function TrackerIssueDetailModal({
  open,
  onClose,
  onMutated,
}: {
  open: TrackerIssueDetailOpen | null;
  onClose: () => void;
  onMutated?: () => void;
}) {
  const t = useTranslation();
  const [listing, setListing] = useState<TrackerDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");

  useDialogShortcuts(open !== null, { onCancel: onClose });

  useEffect(() => {
    if (!open) {
      setListing(null);
      setError(null);
      setReloadKey(0);
      setRefreshing(false);
      setCommentDraft("");
      return;
    }
    setListing(null);
    setError(null);
    setCommentDraft("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRefreshing(true);
    const request =
      open.provider === "linear"
        ? api.getLinearIssue(open.repoPath, open.id)
        : api.getJiraIssue(open.repoPath, open.id);
    request
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

  const handleSubmitComment = useCallback(
    async (body: string) => {
      if (!open) return;
      if (open.provider === "linear") {
        await api.addLinearComment(open.repoPath, open.id, body);
      } else {
        await api.addJiraComment(open.repoPath, open.id, body);
      }
      setCommentDraft("");
      setReloadKey((key) => key + 1);
      onMutated?.();
    },
    [open, onMutated],
  );

  return (
    <Modal open={open !== null} onClose={onClose} variant="panel" size="3xl">
      {open ? (
        error ? (
          <Shell
            title={open.identifier}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          >
            <div className="p-4 text-xs text-danger">{error}</div>
          </Shell>
        ) : !listing ? (
          <Shell
            title={open.identifier}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          >
            <div className="p-4 text-xs text-fg-muted">
              {dt(t, "dialogs.trackerIssueDetail.loading")}
            </div>
          </Shell>
        ) : listing.kind !== "ok" ? (
          <Shell
            title={open.identifier}
            onClose={onClose}
            onRefresh={handleRefresh}
            refreshing={refreshing}
          >
            <div className="p-4 text-xs text-fg-muted">
              {listing.kind === "needs_auth"
                ? dt(t, "dialogs.trackerIssueDetail.needsAuth")
                : listing.kind === "needs_mapping"
                  ? dt(t, "dialogs.trackerIssueDetail.needsMapping")
                  : listing.message}
            </div>
          </Shell>
        ) : (
          <DetailBody
            provider={open.provider}
            repoPath={open.repoPath}
            detail={listing.detail}
            commentDraft={commentDraft}
            onCommentDraftChange={setCommentDraft}
            onClose={onClose}
            onRefresh={handleRefresh}
            onMutated={onMutated}
            refreshing={refreshing}
            onSubmitComment={handleSubmitComment}
          />
        )
      ) : null}
    </Modal>
  );
}

function IssueStateControl({
  provider,
  canChangeState,
  disabled,
  currentStateId,
  currentStateName,
  availableStates,
  onChange,
}: {
  provider: TrackerProvider;
  canChangeState: boolean;
  disabled: boolean;
  currentStateId: string;
  currentStateName: string;
  availableStates: NonNullable<TrackerIssueDetail["available_states"]>;
  onChange: (value: string) => void;
}) {
  const t = useTranslation();
  const stateSelect =
    availableStates.length > 0 ? (
      <Select
        value={currentStateId || availableStates[0]?.id}
        onValueChange={onChange}
        disabled={!canChangeState || disabled}
        options={availableStates.map((state) => ({
          value: state.id,
          label: state.name,
        }))}
        aria-label={dt(t, "dialogs.trackerIssueDetail.changeState")}
        className="h-7 w-40"
      />
    ) : (
      <span>{currentStateName}</span>
    );
  if (canChangeState) return stateSelect;
  return (
    <Tooltip
      label={
        provider === "linear"
          ? dt(t, "dialogs.trackerIssueDetail.writePermissionLinear")
          : dt(t, "dialogs.trackerIssueDetail.writePermissionJira")
      }
      side="top"
      delay={200}
      className="inline-flex"
    >
      <span className="inline-flex">{stateSelect}</span>
    </Tooltip>
  );
}

function Shell({
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

function DetailBody({
  provider,
  repoPath,
  detail,
  commentDraft,
  onCommentDraftChange,
  onClose,
  onRefresh,
  onMutated,
  refreshing,
  onSubmitComment,
}: {
  provider: TrackerProvider;
  repoPath: string;
  detail: TrackerIssueDetail;
  commentDraft: string;
  onCommentDraftChange: (body: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  onMutated?: () => void;
  refreshing: boolean;
  onSubmitComment: (body: string) => Promise<void>;
}) {
  const t = useTranslation();
  const [stateSaving, setStateSaving] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);
  const created = toUnixSeconds(detail.created_at);
  const updated = toUnixSeconds(detail.updated_at);
  const availableStates = detail.available_states ?? [];
  const currentStateId = detail.state_id ?? "";
  const canChangeState = detail.can_change_state === true;

  useEffect(() => {
    setStateError(null);
    setStateSaving(false);
  }, [detail.id, detail.state_id]);

  async function handleStateChange(nextId: string) {
    if (!canChangeState || !nextId || nextId === currentStateId || stateSaving) {
      return;
    }
    setStateSaving(true);
    setStateError(null);
    try {
      if (provider === "linear") {
        await api.setLinearIssueState(repoPath, detail.id, nextId);
      } else {
        await api.setJiraIssueState(repoPath, detail.id, nextId);
      }
      onRefresh();
      onMutated?.();
    } catch (error) {
      setStateError(String(error));
    } finally {
      setStateSaving(false);
    }
  }
  const openLabel =
    provider === "linear"
      ? dt(t, "dialogs.trackerIssueDetail.openInLinear")
      : dt(t, "dialogs.trackerIssueDetail.openInJira");
  const comments = useMemo(
    () =>
      [...detail.comments].sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      ),
    [detail.comments],
  );

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`shrink-0 font-mono text-xs leading-5 ${
                detail.state_type === "completed" || detail.state_type === "canceled"
                  ? "text-purple-400"
                  : "text-emerald-400"
              }`}
            >
              {detail.identifier}
            </span>
            <Tooltip label={detail.title} side="bottom" multiline className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-semibold leading-5 tracking-tight text-fg">
                {detail.title}
              </h3>
            </Tooltip>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-muted">
            <span>{detail.author}</span>
            <span className="opacity-50">·</span>
            <IssueStateControl
              provider={provider}
              canChangeState={canChangeState}
              disabled={stateSaving || refreshing}
              currentStateId={currentStateId}
              currentStateName={detail.state}
              availableStates={availableStates}
              onChange={(value) => void handleStateChange(value)}
            />
            {stateError ? (
              <span className="text-danger">{stateError}</span>
            ) : null}
            <span className="opacity-50">·</span>
            <span>
              {dt(t, "dialogs.trackerIssueDetail.created")} {absoluteTime(created)}
            </span>
            <span className="opacity-50">·</span>
            <span>
              {dt(t, "dialogs.trackerIssueDetail.updated")} {absoluteTime(updated)}
            </span>
            {detail.labels.map((label) => (
              <GitHubLabelChip key={label.name} label={label} />
            ))}
          </div>
          {detail.assignees.length > 0 ? (
            <div className="mt-1 text-[11px] text-fg-muted">
              {dt(t, "dialogs.trackerIssueDetail.assignees")}{" "}
              {detail.assignees.join(", ")}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <RefreshButton onClick={onRefresh} loading={refreshing} size={14} />
          <Tooltip label={openLabel} side="bottom">
            <button
              type="button"
              onClick={() => void openExternalUrlWithFeedback(detail.url)}
              className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <ExternalLink size={14} />
            </button>
          </Tooltip>
          <Tooltip label={dt(t, "dialogs.trackerIssueDetail.close")} side="bottom">
            <button
              type="button"
              aria-label={dt(t, "dialogs.trackerIssueDetail.close")}
              onClick={onClose}
              className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="acorn-no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-4 py-3">
          {detail.body.trim().length > 0 ? (
            <section className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30 px-3 py-2">
              <Markdown content={detail.body} softBreaks />
            </section>
          ) : (
            <div className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-elevated/30 px-3 py-2 text-xs text-fg-muted">
              {dt(t, "dialogs.trackerIssueDetail.noBody")}
            </div>
          )}
          <section>
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
              <MessageSquare size={12} />
              <span>
                {`${dt(t, "dialogs.trackerIssueDetail.comments")} (${comments.length})`}
              </span>
            </div>
            {comments.length === 0 ? (
              <div className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 px-4 py-5 text-center text-xs text-fg-muted">
                {dt(t, "dialogs.trackerIssueDetail.noComments")}
              </div>
            ) : (
              <ul className="space-y-3">
                {comments.map((comment) => (
                  <CommentBlock key={comment.id} comment={comment} />
                ))}
              </ul>
            )}
            <GitHubCommentComposer
              body={commentDraft}
              onBodyChange={onCommentDraftChange}
              ariaLabel={dt(t, "dialogs.trackerIssueDetail.commentAriaLabel")}
              placeholder={dt(t, "dialogs.trackerIssueDetail.commentPlaceholder")}
              writeLabel={dt(t, "dialogs.trackerIssueDetail.commentWrite")}
              previewLabel={dt(t, "dialogs.trackerIssueDetail.commentPreview")}
              previewEmptyLabel={dt(
                t,
                "dialogs.trackerIssueDetail.commentPreviewEmpty",
              )}
              submitLabel={dt(t, "dialogs.trackerIssueDetail.commentSubmit")}
              submittingLabel={dt(
                t,
                "dialogs.trackerIssueDetail.commentSubmitting",
              )}
              errorPrefix={dt(t, "dialogs.trackerIssueDetail.commentFailed")}
              onSubmit={onSubmitComment}
              className="mt-3 rounded-[var(--acorn-pane-radius)] border border-border"
            />
          </section>
        </div>
      </div>
    </>
  );
}

function CommentBlock({ comment }: { comment: TrackerComment }) {
  const created = toUnixSeconds(comment.created_at);
  return (
    <li className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2 text-[11px] text-fg-muted">
        <span className="font-medium text-fg">{comment.author}</span>
        <span className="font-mono">{absoluteTime(created)}</span>
      </div>
      {comment.body.trim() ? (
        <Markdown content={comment.body} softBreaks />
      ) : (
        <p className="text-xs text-fg-muted">(empty)</p>
      )}
    </li>
  );
}
