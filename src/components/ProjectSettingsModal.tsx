import { Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { STANDARD_PR_GENERATION_PROMPT } from "../lib/project-settings";
import type { ProjectSettings } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { CheckboxRow, Field, Modal, ModalHeader, TextSwap } from "./ui";

const PROMPT_MAX_CHARS = 2_000;

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function defaultProjectSettings(): ProjectSettings {
  return {
    remember_after_close: true,
    pull_requests: {
      generation_prompt: STANDARD_PR_GENERATION_PROMPT,
    },
  };
}

function promptCount(template: string, count: number): string {
  return template
    .replace("{count}", String(count))
    .replace("{max}", String(PROMPT_MAX_CHARS));
}

interface ProjectSettingsModalProps {
  project: { name: string; repoPath: string } | null;
  onClose: () => void;
}

export function ProjectSettingsModal({
  project,
  onClose,
}: ProjectSettingsModalProps) {
  const t = useTranslation();
  const [settings, setSettings] = useState<ProjectSettings>(() =>
    defaultProjectSettings(),
  );
  const [identity, setIdentity] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogShortcuts(project !== null, {
    onCancel: onClose,
    onConfirm: () => {},
  });

  useEffect(() => {
    if (!project) {
      setSettings(defaultProjectSettings());
      setIdentity(null);
      setLoading(false);
      setSaving(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getProjectSettings(project.repoPath)
      .then((record) => {
        if (cancelled) return;
        setSettings(record.settings);
        setIdentity(record.key);
      })
      .catch((e) => {
        if (cancelled) return;
        setSettings(defaultProjectSettings());
        setIdentity(null);
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const prompt = settings.pull_requests.generation_prompt ?? "";

  function updatePrompt(value: string) {
    const next = Array.from(value).slice(0, PROMPT_MAX_CHARS).join("");
    setSettings((current) => ({
      ...current,
      pull_requests: {
        ...current.pull_requests,
        generation_prompt: next,
      },
    }));
  }

  function updateRememberAfterClose(value: boolean) {
    setSettings((current) => ({
      ...current,
      remember_after_close: value,
    }));
  }

  async function save() {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      const record = await api.updateProjectSettings(
        project.repoPath,
        settings,
      );
      setSettings(record.settings);
      setIdentity(record.key);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={project !== null}
      onClose={onClose}
      variant="dialog"
      size="lg"
    >
      {project ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.projectSettings.title")}
            subtitle={project.name}
            icon={
              <Settings
                size={16}
                className="mt-0.5 self-start text-fg-muted"
              />
            }
            variant="dialog"
            onClose={onClose}
          />
          <div className="space-y-4 px-4 py-3 text-xs text-fg">
            <div className="space-y-1 rounded-md border border-border bg-bg-sidebar/40 px-3 py-2">
              <p className="break-all font-mono text-[11px] text-fg-muted">
                {project.repoPath}
              </p>
              {identity ? (
                <p className="break-all font-mono text-[10px] text-fg-muted/80">
                  {identity}
                </p>
              ) : null}
            </div>

            <section className="space-y-2">
              <div>
                <h3 className="text-xs font-medium text-fg">
                  {dt(t, "dialogs.projectSettings.pullRequests")}
                </h3>
                <p className="mt-0.5 text-[11px] text-fg-muted">
                  {dt(t, "dialogs.projectSettings.pullRequestsHint")}
                </p>
              </div>
              <Field
                label={dt(t, "dialogs.projectSettings.generationPrompt")}
                hint={dt(t, "dialogs.projectSettings.generationPromptHint")}
              >
                <textarea
                  value={prompt}
                  onChange={(e) => updatePrompt(e.target.value)}
                  disabled={loading || saving}
                  rows={7}
                  maxLength={PROMPT_MAX_CHARS}
                  placeholder={dt(
                    t,
                    "dialogs.projectSettings.generationPromptPlaceholder",
                  )}
                  className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg outline-none transition focus:border-accent disabled:opacity-60"
                />
                <p className="text-right text-[10px] tabular-nums text-fg-muted">
                  {promptCount(
                    dt(t, "dialogs.projectSettings.promptCount"),
                    Array.from(prompt).length,
                  )}
                </p>
              </Field>
            </section>

            <CheckboxRow
              label={dt(t, "dialogs.projectSettings.rememberAfterClose")}
              description={dt(
                t,
                "dialogs.projectSettings.rememberAfterCloseHint",
              )}
              checked={settings.remember_after_close}
              disabled={loading || saving}
              onChange={updateRememberAfterClose}
            />

            {error ? (
              <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dt(t, "dialogs.common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={loading || saving}
              className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <TextSwap>
                {saving
                  ? dt(t, "dialogs.projectSettings.saving")
                  : dt(t, "dialogs.projectSettings.save")}
              </TextSwap>
            </button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
