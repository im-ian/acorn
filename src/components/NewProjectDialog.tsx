import { FolderPlus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useDialogShortcuts } from "../lib/dialog";
import { Field, Modal, ModalHeader, TextInput } from "./ui";

interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (parentPath: string, name: string) => Promise<void>;
}

export function NewProjectDialog({
  open: isOpen,
  onClose,
  onCreate,
}: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setParentPath("");
    setError(null);
    setPending(false);
  }, [isOpen]);

  useDialogShortcuts(isOpen, {
    onCancel: () => {
      if (!pending) onClose();
    },
  });

  const trimmedName = name.trim();
  const finalPath = useMemo(() => {
    if (!parentPath || !trimmedName) return "";
    return `${parentPath.replace(/\/+$/, "")}/${trimmedName}`;
  }, [parentPath, trimmedName]);

  const validationError = validateProjectName(trimmedName);
  const canCreate = !pending && parentPath !== "" && validationError === null;

  async function chooseLocation() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Select parent folder",
    });
    if (!picked || typeof picked !== "string") return;
    setParentPath(picked);
    setError(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canCreate) {
      setError(validationError ?? "Choose a location for the new project.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCreate(parentPath, trimmedName);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={() => {
        if (!pending) onClose();
      }}
      variant="dialog"
      size="md"
      ariaLabelledBy="new-project-title"
    >
      <form onSubmit={submit}>
        <ModalHeader
          title="New project"
          titleId="new-project-title"
          subtitle="Create a git repository and add it to Acorn"
          icon={<FolderPlus size={16} className="text-accent" />}
          variant="dialog"
          onClose={() => {
            if (!pending) onClose();
          }}
        />
        <div className="space-y-3 px-4 py-3">
          <Field label="Project name" hint="Use a single folder name.">
            <TextInput
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="my-project"
              aria-label="Project name"
            />
          </Field>
          <Field label="Location">
            <div className="flex gap-2">
              <TextInput
                readOnly
                value={parentPath}
                placeholder="Choose a parent folder"
                aria-label="Project location"
                className="min-w-0 flex-1"
              />
              <button
                type="button"
                onClick={() => void chooseLocation()}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              >
                Choose
              </button>
            </div>
          </Field>
          {finalPath ? (
            <div className="rounded-md border border-border bg-bg-sidebar/60 p-3 text-xs">
              <div className="mb-1 text-fg-muted">Creates</div>
              <div className="break-all font-mono text-fg">{finalPath}</div>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="text-xs text-danger">
              {error}
            </div>
          ) : null}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Creating..." : "Create project"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function validateProjectName(name: string): string | null {
  if (!name) return "Project name is required.";
  if (name === "." || name === "..") return "Project name is not valid.";
  if (name.includes("/") || name.includes("\\"))
    return "Project name must be a single folder name.";
  return null;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
