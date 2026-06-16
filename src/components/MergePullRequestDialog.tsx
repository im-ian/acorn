import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  GitMerge,
  MessageSquareText,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { loadLastMergeMethod, saveLastMergeMethod } from "../lib/merge-prefs";
import { STANDARD_PR_GENERATION_PROMPT } from "../lib/project-settings";
import {
  aiCommitProviderLabel,
  resolveAiCommitRequest,
  useSettings,
} from "../lib/settings";
import { useToasts } from "../lib/toasts";
import type {
  MergeMethod,
  PullRequestCheck,
  PullRequestDetail,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { ProjectSettingsModal } from "./ProjectSettingsModal";
import { Tooltip } from "./Tooltip";
import { Modal, ModalHeader } from "./ui";

const METHOD_OPTIONS: ReadonlyArray<{
  value: MergeMethod;
  labelKey: DialogTranslationKey;
  hintKey: DialogTranslationKey;
}> = [
  {
    value: "squash",
    labelKey: "dialogs.mergePullRequest.methodSquash",
    hintKey: "dialogs.mergePullRequest.methodSquashHint",
  },
  {
    value: "merge",
    labelKey: "dialogs.mergePullRequest.methodMerge",
    hintKey: "dialogs.mergePullRequest.methodMergeHint",
  },
  {
    value: "rebase",
    labelKey: "dialogs.mergePullRequest.methodRebase",
    hintKey: "dialogs.mergePullRequest.methodRebaseHint",
  },
];

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function defaultPromptForMethod(method: MergeMethod): string {
  switch (method) {
    case "squash":
    case "merge":
    case "rebase":
      return STANDARD_PR_GENERATION_PROMPT;
  }
}

function projectNameFromRepoPath(repoPath: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || repoPath;
}

interface ChecksBlock {
  blocked: boolean;
  failed: number;
  pending: number;
}

function summarizeBlockingChecks(checks: PullRequestCheck[]): ChecksBlock {
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.status.toUpperCase() !== "COMPLETED") {
      pending += 1;
      continue;
    }
    switch ((c.conclusion ?? "").toUpperCase()) {
      case "FAILURE":
      case "TIMED_OUT":
      case "ACTION_REQUIRED":
        failed += 1;
        break;
      default:
        break;
    }
  }
  return { blocked: failed > 0 || pending > 0, failed, pending };
}

function formatCount(template: string, count: number): string {
  return template.replace("{count}", String(count));
}

interface MergePullRequestDialogProps {
  open: boolean;
  repoPath: string;
  detail: PullRequestDetail | null;
  onClose: () => void;
  onMerged: () => void;
}

export function MergePullRequestDialog({
  open,
  repoPath,
  detail,
  onClose,
  onMerged,
}: MergePullRequestDialogProps) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const settings = useSettings((s) => s.settings);
  const [method, setMethod] = useState<MergeMethod>(() => loadLastMergeMethod());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [prompt, setPrompt] = useState(() => defaultPromptForMethod(method));
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminMerge, setAdminMerge] = useState(false);

  const checksBlock = useMemo<ChecksBlock>(
    () => summarizeBlockingChecks(detail?.checks ?? []),
    [detail?.checks],
  );

  // Monotonic counter that bumps on every open/close so in-flight AI
  // generation calls can detect that the dialog was reset under them. The
  // Tauri invoke itself can't be aborted, so we instead drop the result
  // when the captured epoch no longer matches `epochRef.current` — without
  // this, closing the dialog mid-generate and reopening it would let the
  // original response silently overwrite the freshly-reset commit message.
  const epochRef = useRef(0);

  // Reset to a clean state every time the dialog opens against a new PR. The
  // method is loaded from prefs so the user's last choice persists across PRs.
  useEffect(() => {
    if (!open || !detail) return;
    let cancelled = false;
    epochRef.current += 1;
    const nextMethod = loadLastMergeMethod();
    setMethod(nextMethod);
    setTitle(detail.title);
    setBody(detail.body);
    setPrompt(defaultPromptForMethod(nextMethod));
    setProjectSettingsOpen(false);
    setError(null);
    setSubmitting(false);
    setGenerating(false);
    setAdminMerge(false);
    void api
      .getProjectSettings(repoPath)
      .then((record) => {
        if (cancelled) return;
        const savedPrompt = record.settings.pull_requests.generation_prompt;
        if (savedPrompt) {
          setPrompt(savedPrompt);
        }
      })
      .catch(() => {
        // Project settings are optional; generation still works with defaults.
      });
    return () => {
      cancelled = true;
    };
  }, [open, detail, repoPath]);

  // Close also bumps the epoch — a generate kicked off right before the
  // user dismissed the dialog must be invalidated even if they never
  // reopen, so its `setGenerating(false)` (and any error) doesn't leak
  // back into a future open.
  useEffect(() => {
    if (!open) {
      epochRef.current += 1;
      setProjectSettingsOpen(false);
    }
  }, [open]);

  useDialogShortcuts(open, {
    onCancel: () => {
      if (!submitting) onClose();
    },
    // Avoid Enter committing a destructive action when the user is composing
    // in the textarea — confirm only via the explicit button.
    onConfirm: () => {},
  });

  const acceptsMessage = method === "squash" || method === "merge";

  async function handleMerge() {
    if (!detail) return;
    setSubmitting(true);
    setError(null);
    try {
      saveLastMergeMethod(method);
      await api.mergePullRequest(
        repoPath,
        detail.number,
        method,
        acceptsMessage ? title : null,
        acceptsMessage ? body : null,
        checksBlock.blocked && adminMerge,
      );
      onMerged();
    } catch (e) {
      const message = String(e);
      setError(message);
      showToast(`${t("toasts.pullRequests.mergeFailed")} ${message}`);
      setSubmitting(false);
    }
  }

  async function handleGenerate() {
    if (!detail) return;
    const epoch = epochRef.current;
    setGenerating(true);
    setError(null);
    try {
      const ai = resolveAiCommitRequest(settings);
      const result = await api.generatePrCommitMessage(
        repoPath,
        detail.number,
        method,
        ai,
        prompt,
      );
      // Dialog was closed (or reopened against another PR) while the
      // CLI was running — drop the result so it doesn't clobber whatever
      // the dialog is currently showing.
      if (epoch !== epochRef.current) return;
      if (result.title.trim()) setTitle(result.title);
      setBody(result.body);
    } catch (e) {
      if (epoch !== epochRef.current) return;
      setError(String(e));
    } finally {
      if (epoch === epochRef.current) setGenerating(false);
    }
  }

  const providerLabel = aiCommitProviderLabel(settings);
  const busy = submitting || generating;
  const mergeBlocked = checksBlock.blocked && !adminMerge;

  function handleMethodSelect(nextMethod: MergeMethod) {
    setMethod(nextMethod);
  }

  async function reloadProjectPrompt() {
    try {
      const record = await api.getProjectSettings(repoPath);
      setPrompt(
        record.settings.pull_requests.generation_prompt ??
          defaultPromptForMethod(method),
      );
    } catch {
      // Project settings are optional; keep the current prompt fallback.
    }
  }

  return (
    <>
      <Modal open={open} onClose={onClose} variant="dialog" size="lg">
        {detail ? (
          <>
            <ModalHeader
              title={`${dt(t, "dialogs.mergePullRequest.titlePrefix")} #${detail.number}`}
              icon={<GitMerge size={16} className="text-emerald-400" />}
              variant="dialog"
              onClose={() => {
                if (!submitting) onClose();
              }}
            />

          <div className="space-y-4 px-4 py-3 text-xs text-fg">
            <div>
              <p className="mb-2 text-fg-muted">
                {dt(t, "dialogs.mergePullRequest.mergeMethod")}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {METHOD_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleMethodSelect(opt.value)}
                    className={cn(
                      "rounded-md border px-2.5 py-2 text-left transition",
                      method === opt.value
                        ? "border-accent/60 bg-accent/15 text-fg"
                        : "border-border bg-bg-sidebar/40 text-fg-muted hover:text-fg",
                    )}
                    disabled={busy}
                  >
                    <div className="text-[11px] font-medium">
                      {dt(t, opt.labelKey)}
                    </div>
                    <div className="mt-0.5 text-[10px] leading-snug text-fg-muted">
                      {dt(t, opt.hintKey)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {acceptsMessage ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-fg-muted">
                    {dt(t, "dialogs.mergePullRequest.commitMessage")}
                  </p>
                  <div className="flex items-center gap-1">
                    <Tooltip
                      label={`${dt(t, "dialogs.mergePullRequest.generateVia")} ${providerLabel}`}
                      side="top"
                    >
                      <button
                        type="button"
                        onClick={() => void handleGenerate()}
                        disabled={generating}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                      >
                        <Sparkles size={11} />
                        {generating
                          ? dt(t, "dialogs.mergePullRequest.generating")
                          : dt(t, "dialogs.mergePullRequest.generateWithAi")}
                      </button>
                    </Tooltip>
                    <Tooltip
                      label={dt(
                        t,
                        "dialogs.mergePullRequest.goToProjectSettings",
                      )}
                      side="top"
                    >
                      <button
                        type="button"
                        aria-label={dt(
                          t,
                          "dialogs.mergePullRequest.goToProjectSettings",
                        )}
                        onClick={() => setProjectSettingsOpen(true)}
                        disabled={busy}
                        className="flex size-6 items-center justify-center rounded-md border border-border bg-bg-sidebar/60 text-fg-muted transition hover:border-accent/50 hover:bg-bg-elevated hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <MessageSquareText size={13} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={dt(t, "dialogs.mergePullRequest.subjectPlaceholder")}
                  disabled={busy}
                  className="w-full rounded-md border border-border bg-bg-sidebar/60 px-2 py-1.5 text-[11px] text-fg outline-none transition focus:border-accent/60 disabled:opacity-60"
                />
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={dt(t, "dialogs.mergePullRequest.bodyPlaceholder")}
                  rows={6}
                  disabled={busy}
                  className="w-full resize-none rounded-md border border-border bg-bg-sidebar/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg outline-none transition focus:border-accent/60 disabled:opacity-60"
                />
              </div>
            ) : (
              <p className="rounded-md border border-border bg-bg-sidebar/40 px-3 py-2 text-[11px] text-fg-muted">
                {dt(t, "dialogs.mergePullRequest.rebaseMessageLocked")}
              </p>
            )}

            {checksBlock.blocked ? (
              <div className="space-y-2 rounded-md border border-warning/45 bg-warning/10 px-3 py-2 text-[11px] text-fg">
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    size={12}
                    className="mt-0.5 shrink-0 text-warning"
                  />
                  <div className="space-y-0.5">
                    {checksBlock.failed > 0 ? (
                      <p>
                        {formatCount(
                          dt(t, "dialogs.mergePullRequest.checksFailing"),
                          checksBlock.failed,
                        )}
                      </p>
                    ) : null}
                    {checksBlock.pending > 0 ? (
                      <p>
                        {formatCount(
                          dt(t, "dialogs.mergePullRequest.checksPending"),
                          checksBlock.pending,
                        )}
                      </p>
                    ) : null}
                    <p className="text-fg-muted">
                      {dt(t, "dialogs.mergePullRequest.checksBlocking")}
                    </p>
                  </div>
                </div>
                <label className="flex cursor-pointer items-start gap-2 rounded border border-warning/40 bg-bg-sidebar/70 px-2 py-1.5 text-fg transition hover:bg-warning/15">
                  <input
                    type="checkbox"
                    checked={adminMerge}
                    onChange={(e) => setAdminMerge(e.target.checked)}
                    disabled={busy}
                    className="mt-0.5 h-3 w-3 cursor-pointer accent-warning"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1 font-medium">
                      <ShieldAlert size={11} className="text-warning" />
                      {dt(t, "dialogs.mergePullRequest.adminMerge")}
                    </span>
                    <span className="text-[10px] leading-snug text-fg-muted">
                      {dt(t, "dialogs.mergePullRequest.adminMergeHint")}
                    </span>
                  </span>
                </label>
              </div>
            ) : null}

            {error ? (
              <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dt(t, "dialogs.common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={busy || mergeBlocked}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
                checksBlock.blocked && adminMerge
                  ? "bg-amber-500/25 text-amber-100 hover:bg-amber-500/35"
                  : "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30",
              )}
            >
              {submitting
                ? dt(t, "dialogs.mergePullRequest.merging")
                : dt(t, "dialogs.mergePullRequest.merge")}
            </button>
          </footer>
          </>
        ) : null}
      </Modal>
      <ProjectSettingsModal
        project={
          projectSettingsOpen
            ? { name: projectNameFromRepoPath(repoPath), repoPath }
            : null
        }
        initialTab="pullRequests"
        onClose={() => {
          setProjectSettingsOpen(false);
          void reloadProjectPrompt();
        }}
      />
    </>
  );
}
