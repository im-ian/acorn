import { FolderPlus } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { validateProjectName } from "../lib/projectName";
import { cn } from "../lib/cn";
import { useTranslation } from "../lib/useTranslation";
import { Field, Modal, ModalHeader, TextInput } from "./ui";

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (
    parentPath: string,
    name: string,
    ignoreSafeName: boolean,
  ) => Promise<void>;
}

export function NewProjectDialog({
  open: isOpen,
  onClose,
  onCreate,
}: NewProjectDialogProps) {
  const t = useTranslation();
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ignoreSafeName, setIgnoreSafeName] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setParentPath("");
    setError(null);
    setIgnoreSafeName(false);
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

  const validation = validateProjectName(trimmedName);
  const canOverrideSafeName = validation.kind === "safe";
  const validationError =
    validation.kind === "ok"
      ? null
      : validation.kind === "safe" && ignoreSafeName
        ? null
        : dt(t, `dialogs.newProject.validation.${validation.reason}`);
  const canCreate =
    !pending &&
    parentPath !== "" &&
    (validation.kind === "ok" ||
      (validation.kind === "safe" && ignoreSafeName));

  async function chooseLocation() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: dt(t, "dialogs.newProject.selectParentFolder"),
    });
    if (!picked || typeof picked !== "string") return;
    setParentPath(picked);
    setError(null);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canCreate) {
      setError(validationError ?? dt(t, "dialogs.newProject.chooseLocationError"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCreate(parentPath, trimmedName, ignoreSafeName);
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
          title={dt(t, "dialogs.newProject.title")}
          titleId="new-project-title"
          subtitle={dt(t, "dialogs.newProject.subtitle")}
          icon={<FolderPlus size={16} className="text-accent" />}
          variant="dialog"
          onClose={() => {
            if (!pending) onClose();
          }}
        />
        <div className="space-y-3 px-4 py-3">
          <Field
            label={dt(t, "dialogs.newProject.projectNameLabel")}
            hint={dt(t, "dialogs.newProject.projectNameHint")}
          >
            <TextInput
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
                setIgnoreSafeName(false);
              }}
              placeholder="my-project"
              aria-label={dt(t, "dialogs.newProject.projectNameLabel")}
              aria-invalid={validationError !== null}
              aria-describedby={
                validationError ? "new-project-name-error" : undefined
              }
              className={cn(validationError ? "border-danger" : null)}
            />
            {validationError ? (
              <span
                id="new-project-name-error"
                role="alert"
                className="text-[11px] text-danger"
              >
                {validationError}
              </span>
            ) : null}
          </Field>
          {canOverrideSafeName ? (
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={ignoreSafeName}
                onChange={(e) => {
                  setIgnoreSafeName(e.target.checked);
                  setError(null);
                }}
                className="size-3 accent-accent"
              />
              <span>{dt(t, "dialogs.newProject.ignoreSafeName")}</span>
            </label>
          ) : null}
          <Field label={dt(t, "dialogs.newProject.locationLabel")}>
            <div className="flex gap-2">
              <TextInput
                readOnly
                value={parentPath}
                placeholder={dt(t, "dialogs.newProject.locationPlaceholder")}
                aria-label={dt(t, "dialogs.newProject.locationAriaLabel")}
                className="min-w-0 flex-1"
              />
              <button
                type="button"
                onClick={() => void chooseLocation()}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              >
                {dt(t, "dialogs.newProject.choose")}
              </button>
            </div>
          </Field>
          {finalPath ? (
            <div className="rounded-md border border-border bg-bg-sidebar/60 p-3 text-xs">
              <div className="mb-1 text-fg-muted">
                {dt(t, "dialogs.newProject.creates")}
              </div>
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
            {dt(t, "dialogs.common.cancel")}
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending
              ? dt(t, "dialogs.newProject.creating")
              : dt(t, "dialogs.newProject.createProject")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
