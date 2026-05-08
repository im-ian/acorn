import { useEffect, useState } from "react";
import { GitMerge, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import { loadLastMergeMethod, saveLastMergeMethod } from "../lib/merge-prefs";
import {
  aiCommitProviderLabel,
  resolveAiCommitCommand,
  useSettings,
} from "../lib/settings";
import type { MergeMethod, PullRequestDetail } from "../lib/types";
import { Tooltip } from "./Tooltip";
import { Modal, ModalHeader, TextSwap } from "./ui";

const METHOD_OPTIONS: ReadonlyArray<{
  value: MergeMethod;
  label: string;
  hint: string;
}> = [
    {
      value: "squash",
      label: "Squash",
      hint: "Combine into one commit on the base branch.",
    },
    {
      value: "merge",
      label: "Merge",
      hint: "Create a merge commit preserving history.",
    },
    {
      value: "rebase",
      label: "Rebase",
      hint: "Replay commits onto the base branch.",
    },
  ];

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
  const settings = useSettings((s) => s.settings);
  const [method, setMethod] = useState<MergeMethod>(() => loadLastMergeMethod());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to a clean state every time the dialog opens against a new PR. The
  // method is loaded from prefs so the user's last choice persists across PRs.
  useEffect(() => {
    if (!open || !detail) return;
    setMethod(loadLastMergeMethod());
    setTitle(detail.title);
    setBody(detail.body);
    setError(null);
    setSubmitting(false);
    setGenerating(false);
  }, [open, detail]);

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
      if (result.title.trim()) setTitle(result.title);
      setBody(result.body);
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  const providerLabel = aiCommitProviderLabel(settings);
  const busy = submitting || generating;

  return (
    <Modal open={open} onClose={onClose} variant="dialog" size="lg">
      {detail ? (
        <>
          <ModalHeader
            title={`Merge #${detail.number}`}
            icon={<GitMerge size={16} className="text-emerald-400" />}
            variant="dialog"
            onClose={() => {
              if (!submitting) onClose();
            }}
          />

          <div className="space-y-4 px-4 py-3 text-xs text-fg">
            <div>
              <p className="mb-2 text-fg-muted">Merge method</p>
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
                    <div className="text-[11px] font-medium">{opt.label}</div>
                    <div className="mt-0.5 text-[10px] leading-snug text-fg-muted">
                      {opt.hint}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {acceptsMessage ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-fg-muted">Commit message</p>
                  {generating ? (
                    <button
                      key="gen-button-loading"
                      type="button"
                      disabled
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted opacity-60"
                    >
                      <Sparkles size={11} />
                      Generating…
                    </button>
                  ) : (
                    <Tooltip
                      label={`Generate via ${providerLabel}`}
                      side="top"
                    >
                      <button
                        key="gen-button-idle"
                        type="button"
                        onClick={() => void handleGenerate()}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
                      >
                        <Sparkles size={11} />
                        Generate with AI
                      </button>
                    </Tooltip>
                  )}
                </div>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Subject"
                  disabled={busy}
                  className="w-full rounded-md border border-border bg-bg-sidebar/60 px-2 py-1.5 text-[11px] text-fg outline-none transition focus:border-accent/60 disabled:opacity-60"
                />
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Body (optional)"
                  rows={6}
                  disabled={busy}
                  className="w-full resize-none rounded-md border border-border bg-bg-sidebar/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg outline-none transition focus:border-accent/60 disabled:opacity-60"
                />
              </div>
            ) : (
              <p className="rounded-md border border-border bg-bg-sidebar/40 px-3 py-2 text-[11px] text-fg-muted">
                Rebase replays the original commits onto the base branch — the
                commit messages are not customizable here.
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
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={busy}
              className="rounded-md bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <TextSwap>{submitting ? "Merging…" : "Merge"}</TextSwap>
            </button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
