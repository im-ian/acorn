import { useState } from "react";
import { Loader2, Play, SquareTerminal } from "lucide-react";
import {
  findSessionsForGithubWork,
  launchGithubStartWork,
  type GithubStartWorkTarget,
} from "../lib/githubStartWork";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";

export function GithubStartWorkButton({
  repoPath,
  target,
  onStarted,
}: {
  repoPath: string;
  target: GithubStartWorkTarget;
  onStarted?: () => void;
}) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const sessions = useAppStore((s) => s.sessions);
  const openSessionSurface = useAppStore((s) => s.openSessionSurface);
  const [busy, setBusy] = useState(false);

  const existing =
    findSessionsForGithubWork(sessions, repoPath, target)[0] ?? null;
  const canStart =
    target.kind === "issue" || Boolean(target.headBranch?.trim());
  const label = existing
    ? t("rightPanel.menu.openSession")
    : t("rightPanel.menu.startWork");

  async function handleClick() {
    if (existing) {
      openSessionSurface(existing.id);
      onStarted?.();
      return;
    }
    if (!canStart || busy) return;
    setBusy(true);
    try {
      const result = await launchGithubStartWork(repoPath, target);
      if (!result.ok) {
        const message =
          result.error ?? t("rightPanel.errors.startWorkFailed");
        showToast(`${t("toasts.session.createFailed")} ${message}`);
        return;
      }
      onStarted?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={busy}
      disabled={!canStart || busy}
      onClick={() => void handleClick()}
      className="flex items-center gap-1 rounded-md bg-bg-elevated px-2.5 py-1 text-[11px] font-medium text-fg-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? (
        <Loader2 size={12} className="animate-spin" />
      ) : existing ? (
        <SquareTerminal size={12} />
      ) : (
        <Play size={12} />
      )}
      {label}
    </button>
  );
}
