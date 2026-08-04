import { FolderGit2, FolderOpen, FolderPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { basenamePath } from "../lib/projectFolders";
import { useAppStore } from "../store";
import { useTranslation } from "../lib/useTranslation";
import { Button, Modal, ModalFooter, ModalHeader, Notice } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

const TITLE_ID = "add-existing-project-title";

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface AddExistingProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Assembles a project before anything is registered: the roots it spans and
 * the name it carries are collected here, and cancelling leaves the app
 * exactly as it was. Nothing opens on save either — the project appears in the
 * sidebar and the user decides when to start a session in it.
 */
export function AddExistingProjectDialog({
  open,
  onClose,
}: AddExistingProjectDialogProps) {
  const t = useTranslation();
  const refreshProjects = useAppStore((s) => s.refreshProjects);
  const [roots, setRoots] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setRoots([]);
    setName("");
    setNameTouched(false);
    setBusy(false);
    setError(null);
  }, [open]);

  async function addFolder() {
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickProjectFolder(
        dt(t, "dialogs.addExistingProject.pickTitle"),
      );
      if (!picked) return;
      if (picked.ownerName) {
        setError(
          dt(t, "dialogs.addExistingProject.folderTaken").replace(
            "{project}",
            picked.ownerName,
          ),
        );
        return;
      }
      if (roots.includes(picked.path)) return;
      setRoots((current) => [...current, picked.path]);
      // The first folder names the project until the user says otherwise.
      if (!nameTouched && roots.length === 0) setName(picked.name);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (roots.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.addProjectAt(name.trim() || basenamePath(roots[0]), roots);
      await refreshProjects();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useDialogShortcuts(open, {
    onCancel: onClose,
    onConfirm: () => {
      if (roots.length > 0 && !busy) void save();
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="md"
      ariaLabelledBy={TITLE_ID}
    >
      <ModalHeader
        title={dt(t, "dialogs.addExistingProject.title")}
        titleId={TITLE_ID}
        icon={<FolderOpen size={16} className="text-accent" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="space-y-3 px-4 py-3 text-sm text-fg">
        <label className="flex items-center gap-2 rounded-md border border-input-border bg-input px-2 py-1.5 focus-within:border-accent">
          <FolderGit2 size={13} className="shrink-0 text-fg-muted" />
          <input
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value);
            }}
            placeholder={dt(t, "dialogs.addExistingProject.namePlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none"
          />
        </label>

        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-fg-muted">
            {dt(t, "dialogs.projectSettings.sources")}
          </p>
          <ul className="divide-y divide-border rounded-[var(--acorn-pane-radius)] border border-border bg-bg">
            {roots.map((root, index) => (
              <li key={root} className="flex items-center gap-2 px-3 py-2">
                <FolderGit2 size={13} className="shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-fg">
                    {basenamePath(root)}
                  </p>
                  <p className="truncate font-mono text-[10px] text-fg-muted">
                    {root}
                  </p>
                </div>
                {index === 0 ? (
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted">
                    {dt(t, "dialogs.projectSettings.primarySource")}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setRoots((current) =>
                      current.filter((entry) => entry !== root),
                    )
                  }
                  disabled={busy}
                  aria-label={dt(t, "dialogs.projectSettings.removeSource")}
                  className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-danger disabled:opacity-40"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => void addFolder()}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:opacity-40"
              >
                <FolderPlus size={13} className="shrink-0" />
                {dt(t, "dialogs.addExistingProject.addFolder")}
              </button>
            </li>
          </ul>
        </div>

        <Notice tone="info">
          {dt(t, "dialogs.addExistingProject.agentSupport")}
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
      <ModalFooter variant="sidebar">
        <Button onClick={onClose} size="md" surface="dialog">
          {dt(t, "dialogs.common.cancel")}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={busy || roots.length === 0}
          variant="accentSoft"
          size="md"
          surface="dialog"
        >
          {dt(t, "dialogs.projectSettings.save")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
