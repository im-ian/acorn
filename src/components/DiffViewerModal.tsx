import { Panel, PanelGroup } from "react-resizable-panels";
import { DiffSplitView } from "./DiffSplitView";
import { ResizeHandle } from "./ResizeHandle";
import type { DiffPayload } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import { Markdown, Modal, ModalHeader } from "./ui";

interface DiffViewerModalProps {
  payload: DiffPayload | null;
  title: string;
  subtitle?: string;
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
  onClose: () => void;
}

export function DiffViewerModal({
  payload,
  title,
  subtitle,
  body,
  cwd,
  onClose,
}: DiffViewerModalProps) {
  // Read-only viewer: Enter dismisses just like Esc since there is no other
  // primary action.
  useDialogShortcuts(payload !== null, {
    onCancel: onClose,
    onConfirm: onClose,
  });

  const hasBody = !!body && body.trim().length > 0;

  return (
    <Modal
      open={payload !== null}
      onClose={onClose}
      variant="panel"
      size="5xl"
    >
      {payload ? (
        <>
          <ModalHeader title={title} subtitle={subtitle} onClose={onClose} />
          <div className="min-h-0 flex-1 overflow-hidden">
            {hasBody ? (
              <PanelGroup
                direction="vertical"
                autoSaveId="acorn:commit-viewer-body-diff"
                className="h-full"
              >
                <Panel id="body" order={1} defaultSize={25} minSize={8} maxSize={70}>
                  <div className="acorn-selectable h-full overflow-y-auto bg-bg-sidebar/40 px-4 py-2">
                    <Markdown content={body!} />
                  </div>
                </Panel>
                <ResizeHandle direction="vertical" />
                <Panel id="diff" order={2} defaultSize={75} minSize={20}>
                  <DiffSplitView payload={payload} cwd={cwd} />
                </Panel>
              </PanelGroup>
            ) : (
              <DiffSplitView payload={payload} cwd={cwd} />
            )}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
