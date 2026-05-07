import { DiffSplitView } from "./DiffSplitView";
import type { DiffPayload } from "../lib/types";
import { useDialogShortcuts } from "../lib/dialog";
import { Modal, ModalHeader } from "./ui";

interface DiffViewerModalProps {
  payload: DiffPayload | null;
  title: string;
  subtitle?: string;
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
  cwd,
  onClose,
}: DiffViewerModalProps) {
  // Read-only viewer: Enter dismisses just like Esc since there is no other
  // primary action.
  useDialogShortcuts(payload !== null, {
    onCancel: onClose,
    onConfirm: onClose,
  });

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
            <DiffSplitView payload={payload} cwd={cwd} />
          </div>
        </>
      ) : null}
    </Modal>
  );
}
