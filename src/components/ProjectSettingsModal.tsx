import {
  AlertTriangle,
  GitBranch,
  Loader2,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { STANDARD_PR_GENERATION_PROMPT } from "../lib/project-settings";
import type { ProjectSettings, ProjectWorktree, Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import { CheckboxRow, Field, Modal, ModalHeader } from "./ui";

const PROMPT_MAX_CHARS = 2_000;

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;
type ProjectSettingsTab = "general" | "pullRequests" | "worktrees";

const PROJECT_SETTINGS_TABS: Array<{
  id: ProjectSettingsTab;
  labelKey: DialogTranslationKey;
}> = [
  { id: "general", labelKey: "dialogs.projectSettings.tabs.general" },
  {
    id: "pullRequests",
    labelKey: "dialogs.projectSettings.tabs.pullRequests",
  },
  { id: "worktrees", labelKey: "dialogs.projectSettings.tabs.worktrees" },
];

function dt(t: Translator, key: DialogTranslationKey): string {
  return t(key);
}

function dtf(
  t: Translator,
  key: DialogTranslationKey,
  values: Record<string, string | number>,
): string {
  return dt(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
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

function formatModifiedTime(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.length > 0 ? normalized : "/";
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function sessionsUsingWorktree(
  sessions: readonly Session[],
  repoPath: string,
  worktreePath: string,
): Session[] {
  return sessions.filter(
    (session) =>
      samePath(session.repo_path, repoPath) &&
      samePath(session.worktree_path, worktreePath),
  );
}

interface ProjectSettingsModalProps {
  project: { name: string; repoPath: string } | null;
  initialTab?: ProjectSettingsTab;
  onClose: () => void;
}

export function ProjectSettingsModal({
  project,
  initialTab = "general",
  onClose,
}: ProjectSettingsModalProps) {
  const t = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const removeProjectWorktree = useAppStore((s) => s.removeProjectWorktree);
  const [tab, setTab] = useState<ProjectSettingsTab>(initialTab);
  const [settings, setSettings] = useState<ProjectSettings>(() =>
    defaultProjectSettings(),
  );
  const [identity, setIdentity] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<ProjectWorktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] =
    useState<ProjectWorktree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worktreeError, setWorktreeError] = useState<{
    kind: "load" | "remove";
    message: string;
  } | null>(null);

  const confirmRemoveSessions =
    project && confirmRemove
      ? sessionsUsingWorktree(sessions, project.repoPath, confirmRemove.path)
      : [];

  useDialogShortcuts(project !== null && confirmRemove === null, {
    onCancel: onClose,
    onConfirm: () => {},
  });

  useDialogShortcuts(confirmRemove !== null, {
    onCancel: () => setConfirmRemove(null),
    onConfirm: () => {
      void removeConfirmedWorktree();
    },
  });

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, project?.repoPath]);

  useEffect(() => {
    if (!project) {
      setSettings(defaultProjectSettings());
      setIdentity(null);
      setWorktrees([]);
      setLoading(false);
      setWorktreesLoading(false);
      setSaving(false);
      setRemovingPath(null);
      setConfirmRemove(null);
      setError(null);
      setWorktreeError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setWorktreesLoading(true);
    setRemovingPath(null);
    setConfirmRemove(null);
    setError(null);
    setWorktreeError(null);

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

    api
      .listProjectWorktrees(project.repoPath)
      .then((items) => {
        if (cancelled) return;
        setWorktrees(items);
      })
      .catch((e) => {
        if (cancelled) return;
        setWorktrees([]);
        setWorktreeError({ kind: "load", message: String(e) });
      })
      .finally(() => {
        if (!cancelled) setWorktreesLoading(false);
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

  async function removeConfirmedWorktree() {
    if (!project || !confirmRemove || removingPath !== null) return;
    const target = confirmRemove;
    const targetSessions = sessionsUsingWorktree(
      sessions,
      project.repoPath,
      target.path,
    );
    setRemovingPath(target.path);
    setWorktreeError(null);
    try {
      await removeProjectWorktree(
        project.repoPath,
        target.path,
        targetSessions.length > 0,
      );
      setConfirmRemove(null);
      setWorktrees(await api.listProjectWorktrees(project.repoPath));
    } catch (e) {
      setWorktreeError({ kind: "remove", message: String(e) });
    } finally {
      setRemovingPath(null);
    }
  }

  return (
    <Modal
      open={project !== null}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabelledBy="project-settings-title"
    >
      {project ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.projectSettings.title")}
            titleId="project-settings-title"
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
          <div className="flex h-[28rem]">
            <nav className="flex w-40 shrink-0 flex-col border-r border-border bg-bg-sidebar/40 py-2">
              {PROJECT_SETTINGS_TABS.map((tabMeta) => (
                <button
                  key={tabMeta.id}
                  type="button"
                  onClick={() => setTab(tabMeta.id)}
                  className={cn(
                    "px-4 py-1.5 text-left text-xs transition",
                    tab === tabMeta.id
                      ? "bg-bg-elevated text-fg"
                      : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
                  )}
                >
                  {dt(t, tabMeta.labelKey)}
                </button>
              ))}
            </nav>
            <div className="flex-1 overflow-y-auto p-4 text-xs text-fg">
              {tab === "general" ? (
                <ProjectSettingsGroup
                  title={dt(t, "dialogs.projectSettings.general")}
                  description={dt(t, "dialogs.projectSettings.generalHint")}
                >
                  <div className="space-y-1 rounded-md border border-border bg-bg px-3 py-2">
                    <p className="break-all font-mono text-[11px] text-fg-muted">
                      {project.repoPath}
                    </p>
                    {identity ? (
                      <p className="break-all font-mono text-[10px] text-fg-muted/80">
                        {identity}
                      </p>
                    ) : null}
                  </div>
                  <CheckboxRow
                    label={dt(
                      t,
                      "dialogs.projectSettings.rememberAfterClose",
                    )}
                    description={dt(
                      t,
                      "dialogs.projectSettings.rememberAfterCloseHint",
                    )}
                    checked={settings.remember_after_close}
                    disabled={loading || saving}
                    onChange={updateRememberAfterClose}
                  />
                </ProjectSettingsGroup>
              ) : tab === "pullRequests" ? (
                <ProjectSettingsGroup
                  title={dt(t, "dialogs.projectSettings.pullRequests")}
                  description={dt(
                    t,
                    "dialogs.projectSettings.pullRequestsHint",
                  )}
                >
                  <Field
                    label={dt(t, "dialogs.projectSettings.generationPrompt")}
                    hint={dt(
                      t,
                      "dialogs.projectSettings.generationPromptHint",
                    )}
                  >
                    <textarea
                      value={prompt}
                      onChange={(e) => updatePrompt(e.target.value)}
                      disabled={loading || saving}
                      rows={9}
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
                </ProjectSettingsGroup>
              ) : (
                <ProjectSettingsGroup
                  title={dt(t, "dialogs.projectSettings.worktrees")}
                  description={dt(t, "dialogs.projectSettings.worktreesHint")}
                >
                  <ProjectWorktreeList
                    repoPath={project.repoPath}
                    worktrees={worktrees}
                    sessions={sessions}
                    loading={worktreesLoading}
                    removingPath={removingPath}
                    error={worktreeError}
                    onRequestRemove={setConfirmRemove}
                    t={t}
                  />
                </ProjectSettingsGroup>
              )}

              {error ? (
                <p className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                  {error}
                </p>
              ) : null}
            </div>
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
              {saving
                ? dt(t, "dialogs.projectSettings.saving")
                : dt(t, "dialogs.projectSettings.save")}
            </button>
          </footer>
          <RemoveWorktreeConfirmDialog
            worktree={confirmRemove}
            sessions={confirmRemoveSessions}
            removing={removingPath === confirmRemove?.path}
            onCancel={() => setConfirmRemove(null)}
            onConfirm={() => void removeConfirmedWorktree()}
            t={t}
          />
        </>
      ) : null}
    </Modal>
  );
}

function ProjectSettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {title}
        </h3>
        {description ? (
          <p className="mt-0.5 text-[11px] text-fg-muted/80">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function ProjectWorktreeList({
  repoPath,
  worktrees,
  sessions,
  loading,
  removingPath,
  error,
  onRequestRemove,
  t,
}: {
  repoPath: string;
  worktrees: ProjectWorktree[];
  sessions: Session[];
  loading: boolean;
  removingPath: string | null;
  error: { kind: "load" | "remove"; message: string } | null;
  onRequestRemove: (worktree: ProjectWorktree) => void;
  t: Translator;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-fg-muted">
        <Loader2 size={12} className="animate-spin" />
        {dt(t, "dialogs.projectSettings.loadingWorktrees")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {worktrees.length === 0 ? (
        <p className="rounded-md border border-border bg-bg px-3 py-2 text-[11px] text-fg-muted">
          {dt(t, "dialogs.projectSettings.noWorktrees")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-bg">
          {worktrees.map((worktree) => {
            const modified = formatModifiedTime(worktree.modified_ms);
            const isRemoving = removingPath === worktree.path;
            const usedBySessions = sessionsUsingWorktree(
              sessions,
              repoPath,
              worktree.path,
            );
            const sessionCount = usedBySessions.length;
            return (
              <li key={worktree.path} className="px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <GitBranch
                        size={13}
                        className="shrink-0 text-fg-muted"
                      />
                      <span className="truncate text-xs font-medium text-fg">
                        {worktree.name}
                      </span>
                    </div>
                    <p className="break-all font-mono text-[10px] leading-relaxed text-fg-muted">
                      {worktree.path}
                    </p>
                    <p className="text-[11px] text-fg-muted">
                      {modified
                        ? `${dt(t, "dialogs.projectSettings.lastModified")}: ${modified}`
                        : dt(t, "dialogs.projectSettings.lastModifiedUnknown")}
                    </p>
                    {sessionCount > 0 ? (
                      <p className="text-[11px] font-medium text-warning">
                        {dtf(
                          t,
                          sessionCount === 1
                            ? "dialogs.projectSettings.usedBySession"
                            : "dialogs.projectSettings.usedBySessions",
                          { count: sessionCount },
                        )}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={dtf(
                      t,
                      "dialogs.projectSettings.removeWorktreeAria",
                      { name: worktree.name },
                    )}
                    onClick={() => onRequestRemove(worktree)}
                    disabled={removingPath !== null}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-danger disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isRemoving ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    {isRemoving
                      ? dt(t, "dialogs.projectSettings.deletingWorktree")
                      : dt(t, "dialogs.projectSettings.removeWorktree")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {dt(
            t,
            error.kind === "load"
              ? "dialogs.projectSettings.loadWorktreesFailed"
              : "dialogs.projectSettings.removeWorktreeFailed",
          )}{" "}
          {error.message}
        </p>
      ) : null}
    </div>
  );
}

function RemoveWorktreeConfirmDialog({
  worktree,
  sessions,
  removing,
  onCancel,
  onConfirm,
  t,
}: {
  worktree: ProjectWorktree | null;
  sessions: Session[];
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: Translator;
}) {
  const sessionCount = sessions.length;
  const hasSessions = sessionCount > 0;
  return (
    <Modal
      open={worktree !== null}
      onClose={onCancel}
      variant="dialog"
      size="md"
      ariaLabel={dt(t, "dialogs.projectSettings.confirmRemoveDialog")}
    >
      {worktree ? (
        <>
          <ModalHeader
            title={dtf(t, "dialogs.projectSettings.confirmRemoveTitle", {
              name: worktree.name,
            })}
            icon={<AlertTriangle size={16} className="text-warning" />}
            variant="dialog"
            onClose={onCancel}
          />
          <div className="space-y-3 px-4 py-3 text-xs text-fg">
            <p className="text-fg-muted">
              {hasSessions
                ? dtf(t, "dialogs.projectSettings.confirmRemoveInUseBody", {
                    count: sessionCount,
                  })
                : dt(t, "dialogs.projectSettings.confirmRemoveBody")}
            </p>
            <div className="rounded-md border border-border bg-bg px-3 py-2">
              <p className="break-all font-mono text-[10px] leading-relaxed text-fg-muted">
                {worktree.path}
              </p>
            </div>
            {hasSessions ? (
              <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                <p className="text-[11px] font-medium text-warning">
                  {dtf(
                    t,
                    sessionCount === 1
                      ? "dialogs.projectSettings.sessionsToRemoveSingular"
                      : "dialogs.projectSettings.sessionsToRemovePlural",
                    { count: sessionCount },
                  )}
                </p>
                <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto">
                  {sessions.map((session) => (
                    <li
                      key={session.id}
                      className="truncate rounded bg-bg/60 px-2 py-1 text-[11px] text-fg"
                    >
                      {session.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-bg-sidebar/40 px-4 py-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={removing}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition hover:bg-bg-sidebar hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {dt(t, "dialogs.projectSettings.cancelRemove")}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={removing}
              className="inline-flex items-center gap-1 rounded-md bg-danger/15 px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {removing ? <Loader2 size={12} className="animate-spin" /> : null}
              {removing
                ? dt(t, "dialogs.projectSettings.deletingWorktree")
                : hasSessions
                  ? dt(t, "dialogs.projectSettings.deleteWorktreeAndSessions")
                  : dt(t, "dialogs.projectSettings.deleteWorktree")}
            </button>
          </footer>
        </>
      ) : null}
    </Modal>
  );
}
