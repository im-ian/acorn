import { useEffect, useRef, useState } from "react";
import { GitMerge, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { loadLastMergeMethod, saveLastMergeMethod } from "../lib/merge-prefs";
import {
  aiCommitProviderLabel,
  resolveAiCommitCommand,
  useSettings,
} from "../lib/settings";
import type { MergeMethod, PullRequestDetail } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { Tooltip } from "./Tooltip";
import { Modal, ModalHeader, TextSwap } from "./ui";

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
  const settings = useSettings((s) => s.settings);
  const [method, setMethod] = useState<MergeMethod>(() => loadLastMergeMethod());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    epochRef.current += 1;
    setMethod(loadLastMergeMethod());
    setTitle(detail.title);
    setBody(detail.body);
    setError(null);
    setSubmitting(false);
    setGenerating(false);
  }, [open, detail]);

  // Close also bumps the epoch — a generate kicked off right before the
  // user dismissed the dialog must be invalidated even if they never
  // reopen, so its `setGenerating(false)` (and any error) doesn't leak
  // back into a future open.
  useEffect(() => {
    if (!open) {
      epochRef.current += 1;
    }
  }, [open]);

  useDialogShortcuts(open, {
    onCancel: () => {
      if (!submitting) onClose();
    },
    // Avoid Enter committing a destructive action when the user is composing
    // in the textarea — confirm only via the explicit button.
    onConfirm: () => { },
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
      );
      onMerged();
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

  async function handleGenerate() {
    if (!detail) return;
    const epoch = epochRef.current;
    setGenerating(true);
    setError(null);
    try {
      const { command, args } = resolveAiCommitCommand(settings);
      const result = await api.generatePrCommitMessage(
        repoPath,
        detail.number,
        method,
        command,
        args,
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

  return (
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
                    onClick={() => setMethod(opt.value)}
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
                  {generating ? (
                    <button
                      key="gen-button-loading"
                      type="button"
                      disabled
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted opacity-60"
                    >
                      <Sparkles size={11} />
                      {dt(t, "dialogs.mergePullRequest.generating")}
                    </button>
                  ) : (
                    <Tooltip
                      label={`${dt(t, "dialogs.mergePullRequest.generateVia")} ${providerLabel}`}
                      side="top"
                    >
                      <button
                        key="gen-button-idle"
                        type="button"
                        onClick={() => void handleGenerate()}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
                      >
                        <Sparkles size={11} />
                        {dt(t, "dialogs.mergePullRequest.generateWithAi")}
                      </button>
                    </Tooltip>
                  )}
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
              disabled={busy}
              className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <TextSwap>
                {submitting
                  ? dt(t, "dialogs.mergePullRequest.merging")
                  : dt(t, "dialogs.mergePullRequest.merge")}
              </TextSwap>
            </button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
