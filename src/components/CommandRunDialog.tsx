import { useState, type ReactElement } from "react";
import { Copy, Play, Terminal as TerminalIcon } from "lucide-react";
import { useAppStore } from "../store";
import { useToasts } from "../lib/toasts";
import { useDialogShortcuts } from "../lib/dialog";
import { Modal, ModalHeader, TextSwap } from "./ui";

interface CommandRunDialogProps {
  open: boolean;
  command: string;
  /**
   * Working directory for the new session created by the "Run" action.
   * When `null`, the dialog falls back to the first known project's repo
   * path so callers without a repo context (e.g. Settings) still resolve
   * a workspace. If no project is registered the Run button is disabled.
   */
  repoPath: string | null;
  onClose: () => void;
}

/**
 * Truncate the command so the auto-generated session tab stays readable
 * in the sidebar — full command still runs inside the PTY, only the
 * label is shortened.
 */
function deriveSessionName(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length <= 32) return trimmed;
  return `${trimmed.slice(0, 29)}…`;
}

/**
 * Confirmation modal opened by [`CommandHint`]. Offers two paths so the
 * user never executes a suggested command from a single accidental click:
 *
 * - **Copy** — writes the command to the clipboard and emits a toast.
 * - **Run** — creates a new regular session in the resolved repo, then
 *   queues the command via [`setPendingTerminalInput`] so `Terminal.tsx`
 *   writes it once the PTY has spawned. The shell buffers the input
 *   until its prompt is ready, so we do not coordinate with a
 *   prompt-ready signal.
 */
export function CommandRunDialog({
  open,
  command,
  repoPath,
  onClose,
}: CommandRunDialogProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projects = useAppStore((s) => s.projects);
  const createSession = useAppStore((s) => s.createSession);
  const setPendingTerminalInput = useAppStore(
    (s) => s.setPendingTerminalInput,
  );
  const showToast = useToasts((s) => s.show);

  const resolvedRepoPath = repoPath ?? projects[0]?.repo_path ?? null;

  function close() {
    if (busy) return;
    setError(null);
    onClose();
  }

  useDialogShortcuts(open, {
    onCancel: close,
    onConfirm: () => {
      if (busy || !resolvedRepoPath) return;
      void handleRun();
    },
  });

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      showToast(`Copied: ${command}`);
      onClose();
    } catch (e) {
      setError(`Copy failed: ${String(e)}`);
    }
  }

  async function handleRun() {
    if (!resolvedRepoPath) {
      setError("No project available to host the new session.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createSession(
        deriveSessionName(command),
        resolvedRepoPath,
      );
      if (!created) {
        const storeError = useAppStore.getState().error;
        setError(storeError ?? "Failed to create session.");
        setBusy(false);
        return;
      }
      // Queue BEFORE the Terminal mounts. The Terminal effect drains the
      // queue inside its own `pty_spawn` resolver, so the value just has
      // to be present by the time the spawn completes.
      setPendingTerminalInput(created.id, command);
      showToast(`Running: ${command}`);
      setBusy(false);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      variant="dialog"
      size="md"
      ariaLabel="Run command"
    >
      <ModalHeader
        title="Run this command?"
        icon={<TerminalIcon size={14} className="text-accent" />}
        variant="dialog"
        onClose={close}
      />
      <div className="space-y-3 px-4 py-4 text-xs text-fg-muted">
        <p className="text-fg">
          A new terminal session will open and run:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-bg-sidebar/70 px-3 py-2 font-mono text-[12px] text-fg">
          {command}
        </pre>
        {resolvedRepoPath ? (
          <p>
            <span className="opacity-70">cwd:</span>{" "}
            <span className="font-mono text-fg">{resolvedRepoPath}</span>
          </p>
        ) : (
          <p className="text-danger">
            No project is registered — add a project before running this
            command, or use "Copy" to paste it into an existing terminal.
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
          onClick={close}
          disabled={busy}
          className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition hover:bg-bg-elevated disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Copy size={12} />
          Copy
        </button>
        <button
          type="button"
          onClick={() => void handleRun()}
          disabled={busy || !resolvedRepoPath}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Play size={12} />
          <TextSwap>{busy ? "Running…" : "Run"}</TextSwap>
        </button>
      </footer>
    </Modal>
  );
}
