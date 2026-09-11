import { X } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";
import { isArchivedSession } from "../lib/sessionArchive";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { selectSessionsById, useAppStore } from "../store";
import { ChatPane } from "./ChatPane";
import { Button, IconButton, Modal } from "./ui";

const GraphSessionView = lazy(async () => {
  const module = await import("./GraphSessionView");
  return { default: module.GraphSessionView };
});

/**
 * Full-window preview for an archived session. Same expanded-shell shape as
 * the kanban terminal popover's maximize control, so panes / kanban / canvas
 * all see one overlay instead of hijacking a live pane.
 */
export function ArchivedSessionPreviewModal(): ReactElement | null {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const previewId = useAppStore((s) => s.archivedPreviewSessionId);
  const session = useAppStore((s) =>
    previewId ? (selectSessionsById(s).get(previewId) ?? null) : null,
  );
  const dismissArchivedPreview = useAppStore((s) => s.dismissArchivedPreview);
  const resumeSession = useAppStore((s) => s.resumeSession);
  const requestRemoveSession = useAppStore((s) => s.requestRemoveSession);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (previewId && !session) dismissArchivedPreview();
  }, [dismissArchivedPreview, previewId, session]);

  if (!previewId || !session || !isArchivedSession(session)) return null;

  const target = session;
  const isChat = session.mode === "chat";

  async function restore() {
    if (restoring) return;
    setRestoring(true);
    try {
      const resumed = await resumeSession(target.id);
      const error = useAppStore.getState().consumeError();
      if (!resumed || error) {
        showToast(`${t("toasts.session.resumeFailed")} ${error ?? ""}`.trim());
      }
    } finally {
      setRestoring(false);
    }
  }

  function remove() {
    dismissArchivedPreview();
    requestRemoveSession(target.id);
  }

  return (
    <Modal
      open
      onClose={dismissArchivedPreview}
      variant="panel"
      ariaLabel={t("pane.archivedRestore.ariaLabel")}
      className="max-w-[calc(100vw-1.5rem)]"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg">
            {session.name}
          </h2>
          <p className="truncate text-[11px] text-fg-muted">
            {session.branch}
            {session.worktree_path ? ` · ${session.worktree_path}` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="dangerGhost"
          size="xs"
          onClick={remove}
        >
          {t("pane.archivedRestore.remove")}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="xs"
          disabled={restoring}
          onClick={() => void restore()}
        >
          {restoring
            ? t("pane.archivedRestore.restoring")
            : t("pane.archivedRestore.restore")}
        </Button>
        <IconButton
          aria-label={t("dialogs.common.close")}
          onClick={dismissArchivedPreview}
          size="sm"
          surface="panel"
        >
          <X size={14} />
        </IconButton>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col bg-bg">
        {session.graph ? (
          <Suspense fallback={null}>
            <GraphSessionView session={session} isActive />
          </Suspense>
        ) : isChat ? (
          <ChatPane
            sessionId={session.id}
            isActive
            repoPath={session.worktree_path}
            session={session}
          />
        ) : (
          <div
            className="absolute inset-0"
            data-archived-preview-body={session.id}
            data-testid="archived-session-preview-terminal"
          />
        )}
      </div>
    </Modal>
  );
}
