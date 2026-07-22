import { FolderPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { validateProjectName } from "../lib/projectName";
import { cn } from "../lib/cn";
import { useTranslation } from "../lib/useTranslation";
import {
  Button,
  CodeValue,
  Field,
  Modal,
  ModalFooter,
  ModalHeader,
  TextInput,
} from "./ui";

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
    initCommit: boolean,
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
  const [initCommit, setInitCommit] = useState(false);
  const [gitIdentityConfigured, setGitIdentityConfigured] = useState<
    boolean | null
  >(null);
  const [pending, setPending] = useState(false);
  const locationPickedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    locationPickedRef.current = false;
    setName("");
    setParentPath("");
    setError(null);
    setIgnoreSafeName(false);
    setInitCommit(false);
    setGitIdentityConfigured(null);
    setPending(false);
    void api
      .getLastProjectParentFolder()
      .then((path) => {
        if (!cancelled && !locationPickedRef.current) {
          setParentPath(path ?? "");
        }
      })
      .catch(() => {
        if (!cancelled && !locationPickedRef.current) {
          setParentPath("");
        }
      });
    void api
      .hasGitIdentity()
      .then((configured) => {
        if (!cancelled) {
          setGitIdentityConfigured(configured);
          setInitCommit(configured);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitIdentityConfigured(false);
          setInitCommit(false);
        }
      });
    return () => {
      cancelled = true;
    };
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
    gitIdentityConfigured !== null &&
    parentPath !== "" &&
    (validation.kind === "ok" ||
      (validation.kind === "safe" && ignoreSafeName));

  async function chooseLocation() {
    const picked = await api.selectProjectParentFolder(
      dt(t, "dialogs.newProject.selectParentFolder"),
    );
    if (!picked) return;
    locationPickedRef.current = true;
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
      await onCreate(
        parentPath,
        trimmedName,
        ignoreSafeName,
        initCommit && gitIdentityConfigured === true,
      );
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
                className="acorn-check"
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
              <Button
                onClick={() => void chooseLocation()}
                variant="outline"
                size="md"
                surface="dialog"
              >
                {dt(t, "dialogs.newProject.choose")}
              </Button>
            </div>
          </Field>
          {gitIdentityConfigured === true ? (
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={initCommit}
                onChange={(e) => setInitCommit(e.target.checked)}
                className="acorn-check"
              />
              <span>{dt(t, "dialogs.newProject.initCommit")}</span>
            </label>
          ) : gitIdentityConfigured === false ? (
            <p className="text-xs text-fg-muted">
              {dt(t, "dialogs.newProject.initCommitUnavailable")}
            </p>
          ) : null}
          {finalPath ? (
            <div className="space-y-1 text-xs">
              <div className="text-fg-muted">
                {dt(t, "dialogs.newProject.creates")}
              </div>
              <CodeValue
                surface="muted"
                overflow="breakAll"
                className="px-3 py-2"
              >
                {finalPath}
              </CodeValue>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="text-xs text-danger">
              {error}
            </div>
          ) : null}
        </div>
        <ModalFooter variant="sidebar">
          <Button
            disabled={pending}
            onClick={onClose}
            size="md"
            surface="dialog"
            className="disabled:opacity-50"
          >
            {dt(t, "dialogs.common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={!canCreate}
            variant="primary"
            size="md"
            surface="dialog"
            className="text-bg hover:opacity-90 disabled:opacity-50"
          >
            {pending
              ? dt(t, "dialogs.newProject.creating")
              : dt(t, "dialogs.newProject.createProject")}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return JSON.stringify(e);
}
