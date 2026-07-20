import { type ReactNode } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { DiffSplitView } from "./DiffSplitView";
import { ResizeHandle } from "./ResizeHandle";
import type { DiffImageContext, DiffPayload } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import { Markdown, Modal, ModalHeader, Notice, SkeletonBlock } from "./ui";

interface DiffViewerModalProps {
  payload: DiffPayload | null;
  open?: boolean;
  loading?: boolean;
  error?: string | null;
  title: string;
  subtitle?: ReactNode;
  /** Right-side header actions (e.g. Copy SHA, Open on GitHub). */
  headerActions?: ReactNode;
  /**
   * Commit message body to show above the diff (renders markdown including
   * inline images). Hidden entirely when empty / undefined — the diff then
   * fills the whole viewer.
   */
  body?: string;
  /**
   * Working directory for resolving repo-relative diff paths to absolute paths
   * (used by the file context menu's "Open in editor" action). Typically the
   * active session's `worktree_path`. When omitted, the action is hidden.
   */
  cwd?: string;
  imageContext?: DiffImageContext;
  loadingLabel?: string;
  onClose: () => void;
}

export function DiffViewerModal({
  payload,
  open,
  loading = false,
  error = null,
  title,
  subtitle,
  headerActions,
  body,
  cwd,
  imageContext,
  loadingLabel,
  onClose,
}: DiffViewerModalProps) {
  const isOpen = open ?? payload !== null;
  // Read-only viewer: Enter dismisses just like Esc since there is no other
  // primary action.
  useDialogShortcuts(isOpen, {
    onCancel: onClose,
    onConfirm: onClose,
  });

  const hasBody = !!body && body.trim().length > 0;
  let content: ReactNode = null;
  if (payload && hasBody) {
    content = (
      <PanelGroup
        direction="vertical"
        autoSaveId="acorn:commit-viewer-body-diff"
        className="h-full"
      >
        <Panel id="body" order={1} defaultSize={25} minSize={8} maxSize={70}>
          <div className="acorn-selectable h-full overflow-y-auto rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 px-4 py-2">
            <Markdown content={body!} />
          </div>
        </Panel>
        <ResizeHandle direction="vertical" gap />
        <Panel id="diff" order={2} defaultSize={75} minSize={20}>
          <DiffSplitView
            payload={payload}
            cwd={cwd}
            imageContext={imageContext}
          />
        </Panel>
      </PanelGroup>
    );
  } else if (payload) {
    content = (
      <DiffSplitView
        payload={payload}
        cwd={cwd}
        imageContext={imageContext}
      />
    );
  } else if (error) {
    content = (
      <Notice tone="danger" density="compact">
        {error}
      </Notice>
    );
  } else if (loading) {
    content = <DiffViewerSkeleton label={loadingLabel} />;
  }

  return (
    <Modal open={isOpen} onClose={onClose} variant="panel" size="5xl">
      {isOpen ? (
        <>
          <ModalHeader
            title={title}
            subtitle={subtitle}
            actions={headerActions}
            onClose={onClose}
          />
          <div className="min-h-0 flex-1 overflow-hidden p-1.5">
            {content}
          </div>
        </>
      ) : null}
    </Modal>
  );
}

function DiffViewerSkeleton({ label }: { label?: string }) {
  return (
    <div
      className="flex h-full min-h-0"
      aria-busy="true"
      aria-label={label}
    >
      <aside className="flex w-64 shrink-0 flex-col gap-3 border-r border-border bg-bg-sidebar p-3">
        <SkeletonBlock className="h-3 w-24 bg-fg-muted/15" />
        <div className="space-y-2">
          {Array.from({ length: 9 }, (_, index) => (
            <div key={index} className="space-y-1.5">
              <SkeletonBlock className="h-3 bg-fg-muted/15" />
              <SkeletonBlock className="h-2 w-2/3" />
            </div>
          ))}
        </div>
      </aside>
      <section className="min-w-0 flex-1 space-y-4 overflow-hidden p-4">
        <div className="flex items-center justify-between">
          <SkeletonBlock className="h-3 w-52 bg-fg-muted/15" />
          <SkeletonBlock className="h-3 w-20" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 18 }, (_, index) => (
            <SkeletonBlock
              key={index}
              className="h-3"
              style={{
                width:
                  index % 7 === 0 ? "72%" : index % 5 === 0 ? "88%" : "100%",
              }}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
