import {
  AlertTriangle,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Loader2,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { STANDARD_PR_GENERATION_PROMPT } from "../lib/project-settings";
import { basenamePath, projectRootPaths } from "../lib/projectFolders";
import {
  sessionsUsingProjectWorktree,
  sessionsUsingWorktreePath,
} from "../lib/sessionWorktree";
import type { ProjectSettings, ProjectWorktree, Session } from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import {
  Button,
  CheckboxRow,
  CodeValue,
  Field,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  SegmentedControl,
} from "./ui";

const PROMPT_MAX_CHARS = 2_000;

type DialogTranslationKey = Extract<TranslationKey, `dialogs.${string}`>;
export type ProjectSettingsTab =
  | "general"
  | "sources"
  | "pullRequests"
  | "worktrees";

const PROJECT_SETTINGS_TABS: Array<{
  id: ProjectSettingsTab;
  labelKey: DialogTranslationKey;
}> = [
  { id: "general", labelKey: "dialogs.projectSettings.tabs.general" },
  { id: "sources", labelKey: "dialogs.projectSettings.tabs.sources" },
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

/**
 * A worktree plus the project root it is linked to. A project can span several
 * repositories, and every worktree command is scoped to one of them.
 */
type RootedWorktree = ProjectWorktree & { rootPath: string };

async function listWorktreesForRoots(
  roots: readonly string[],
): Promise<RootedWorktree[]> {
  const perRoot = await Promise.all(
    roots.map(async (rootPath) =>
      (await api.listProjectWorktrees(rootPath)).map((worktree) => ({
        ...worktree,
        rootPath,
      })),
    ),
  );
  return perRoot.flat();
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

function blockingSessionsForProjectWorktree(
  sessions: readonly Session[],
  repoPath: string,
  worktreePath: string,
  activeSessionId: string | null,
): Session[] {
  const targetSessions = sessionsUsingProjectWorktree(
    sessions,
    repoPath,
    worktreePath,
  );
  const targetIds = new Set(targetSessions.map((session) => session.id));
  return sessionsUsingWorktreePath(sessions, worktreePath).filter(
    (session) => !targetIds.has(session.id) || session.id !== activeSessionId,
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
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  // The merge confirmation renders above this modal, so hand it the keyboard.
  const pendingSourceMerge = useAppStore((s) => s.pendingSourceMerge);
  const removeProjectWorktree = useAppStore((s) => s.removeProjectWorktree);
  const projects = useAppStore((s) => s.projects);
  const projectEntry = project
    ? projects.find((entry) => entry.repo_path === project.repoPath)
    : undefined;
  // Worktrees belong to a repository, so a multi-root project has to list and
  // remove them per root rather than through its primary one.
  const projectRoots = projectEntry
    ? projectRootPaths(projectEntry)
    : project
      ? [project.repoPath]
      : [];
  const projectRootsKey = projectRoots.join("\u0000");
  const [tab, setTab] = useState<ProjectSettingsTab>(initialTab);
  const [settings, setSettings] = useState<ProjectSettings>(() =>
    defaultProjectSettings(),
  );
  const [identity, setIdentity] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<RootedWorktree[]>([]);
  const [loading, setLoading] = useState(false);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] =
    useState<RootedWorktree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worktreeError, setWorktreeError] = useState<{
    kind: "load" | "remove";
    message: string;
  } | null>(null);

  const confirmRemoveSessions = confirmRemove
    ? sessionsUsingProjectWorktree(
        sessions,
        confirmRemove.rootPath,
        confirmRemove.path,
      )
    : [];
  const confirmRemoveOtherSessions = confirmRemove
    ? blockingSessionsForProjectWorktree(
        sessions,
        confirmRemove.rootPath,
        confirmRemove.path,
        activeSessionId,
      )
    : [];
  const canShowConfirmRemove =
    confirmRemove !== null && confirmRemoveOtherSessions.length === 0;

  useDialogShortcuts(
    project !== null && confirmRemove === null && pendingSourceMerge === null,
    {
      onCancel: onClose,
      onConfirm: () => {},
    },
  );

  useDialogShortcuts(canShowConfirmRemove, {
    onCancel: () => setConfirmRemove(null),
    onConfirm: () => {
      void removeConfirmedWorktree();
    },
  });

  useEffect(() => {
    if (confirmRemoveOtherSessions.length > 0) setConfirmRemove(null);
  }, [confirmRemoveOtherSessions.length]);

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

    listWorktreesForRoots(projectRoots)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectRootsKey]);

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
    const targetSessions = sessionsUsingProjectWorktree(
      sessions,
      target.rootPath,
      target.path,
    );
    const blockingSessions = blockingSessionsForProjectWorktree(
      sessions,
      target.rootPath,
      target.path,
      activeSessionId,
    );
    if (blockingSessions.length > 0) {
      setConfirmRemove(null);
      return;
    }
    setRemovingPath(target.path);
    setWorktreeError(null);
    try {
      await removeProjectWorktree(
        target.rootPath,
        target.path,
        targetSessions.length > 0,
      );
      setConfirmRemove(null);
      setWorktrees(await listWorktreesForRoots(projectRoots));
    } catch (e) {
      setWorktreeError({ kind: "remove", message: String(e) });
    } finally {
      setRemovingPath(null);
    }
  }

  function requestRemoveWorktree(worktree: RootedWorktree) {
    if (!project) return;
    const blockingSessions = blockingSessionsForProjectWorktree(
      sessions,
      worktree.rootPath,
      worktree.path,
      activeSessionId,
    );
    if (blockingSessions.length > 0) return;
    setConfirmRemove(worktree);
  }

  return (
    <Modal
      open={project !== null}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabelledBy="project-settings-title"
      className="flex flex-col overflow-hidden"
    >
      {project ? (
        <>
          <ModalHeader
            title={dt(t, "dialogs.projectSettings.title")}
            titleId="project-settings-title"
            subtitle={project.name}
            icon={<Settings size={16} className="text-fg-muted" />}
            variant="dialog"
            onClose={onClose}
          />
          <div className="flex h-[28rem] min-h-0">
            <SegmentedControl
              activeId={tab}
              items={PROJECT_SETTINGS_TABS.map((tabMeta) => ({
                id: tabMeta.id,
                label: dt(t, tabMeta.labelKey),
              }))}
              onChange={setTab}
              orientation="vertical"
              surface="dialog"
              ariaLabel={dt(t, "dialogs.projectSettings.title")}
              className="w-40 shrink-0 border-r border-border bg-bg-sidebar/40 px-1.5 py-2"
            />
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
              ) : tab === "sources" ? (
                <ProjectSettingsGroup
                  title={dt(t, "dialogs.projectSettings.sources")}
                  description={dt(t, "dialogs.projectSettings.sourcesHint")}
                >
                  <ProjectSourceFolderList repoPath={project.repoPath} />
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
                      className="w-full resize-none rounded-md border border-input-border bg-input px-2 py-1.5 font-mono text-[11px] leading-relaxed text-fg outline-none transition focus:border-accent focus:bg-input-hover disabled:opacity-60"
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
                    showRoot={projectRoots.length > 1}
                    worktrees={worktrees}
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    loading={worktreesLoading}
                    removingPath={removingPath}
                    error={worktreeError}
                    onRequestRemove={requestRemoveWorktree}
                    t={t}
                  />
                </ProjectSettingsGroup>
              )}

              {error ? (
                <Notice tone="danger" density="compact" className="mt-4">
                  {error}
                </Notice>
              ) : null}
            </div>
          </div>
          <ModalFooter variant="sidebar">
            <Button
              onClick={onClose}
              disabled={saving}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.common.cancel")}
            </Button>
            <Button
              onClick={() => void save()}
              disabled={loading || saving}
              variant="accentSoft"
              size="md"
              surface="dialog"
            >
              {saving
                ? dt(t, "dialogs.projectSettings.saving")
                : dt(t, "dialogs.projectSettings.save")}
            </Button>
          </ModalFooter>
          <RemoveWorktreeConfirmDialog
            worktree={canShowConfirmRemove ? confirmRemove : null}
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

/**
 * Source folders of a project: the primary repository root plus every extra
 * root added to it. Removal is refused by the backend while sessions still
 * live in a folder, so the row surfaces that count instead of guessing.
 */
function ProjectSourceFolderList({ repoPath }: { repoPath: string }) {
  const t = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const addProjectSource = useAppStore((s) => s.addProjectSource);
  const removeProjectSource = useAppStore((s) => s.removeProjectSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = projects.find((entry) => entry.repo_path === repoPath);
  const roots = project ? projectRootPaths(project) : [repoPath];

  async function add() {
    setBusy(true);
    setError(null);
    const ok = await addProjectSource(
      repoPath,
      dt(t, "dialogs.projectSettings.addSourceFolder"),
    );
    if (!ok) {
      const message = useAppStore.getState().consumeError();
      if (message) {
        setError(`${dt(t, "dialogs.projectSettings.addSourceFailed")} ${message}`);
      }
    }
    setBusy(false);
  }

  async function remove(sourcePath: string) {
    setBusy(true);
    setError(null);
    const ok = await removeProjectSource(repoPath, sourcePath);
    if (!ok) {
      const message = useAppStore.getState().consumeError();
      setError(
        `${dt(t, "dialogs.projectSettings.removeSourceFailed")} ${message ?? ""}`.trim(),
      );
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-[var(--acorn-pane-radius)] border border-border bg-bg">
        {roots.map((root, index) => {
          const isPrimary = index === 0;
          const sessionCount = sessions.filter(
            (session) => session.repo_path === root,
          ).length;
          return (
            <li
              key={root}
              className="flex items-center gap-2 px-3 py-2"
            >
              <FolderGit2 size={13} className="shrink-0 text-fg-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-fg">
                  {basenamePath(root)}
                </p>
                <p className="truncate font-mono text-[10px] text-fg-muted">
                  {root}
                </p>
              </div>
              {sessionCount > 0 ? (
                <span className="shrink-0 text-[10px] text-fg-muted">
                  {sessionCount === 1
                    ? dt(t, "dialogs.projectSettings.usedBySession")
                    : dtf(t, "dialogs.projectSettings.usedBySessions", {
                        count: sessionCount,
                      })}
                </span>
              ) : null}
              {isPrimary ? (
                <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted">
                  {dt(t, "dialogs.projectSettings.primarySource")}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void remove(root)}
                  disabled={busy || sessionCount > 0}
                  title={
                    sessionCount > 0
                      ? dt(t, "dialogs.projectSettings.removeSourceBlocked")
                      : undefined
                  }
                  aria-label={dtf(
                    t,
                    "dialogs.projectSettings.removeSourceAria",
                    { name: basenamePath(root) },
                  )}
                  className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                >
                  <X size={12} />
                </button>
              )}
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:opacity-50"
          >
            <FolderPlus size={13} className="shrink-0" />
            {dt(t, "dialogs.projectSettings.addSourceFolder")}
          </button>
        </li>
      </ul>
      {roots.length === 1 ? (
        <p className="text-[11px] text-fg-muted/80">
          {dt(t, "dialogs.projectSettings.noSources")}
        </p>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

function ProjectWorktreeList({
  showRoot,
  worktrees,
  sessions,
  activeSessionId,
  loading,
  removingPath,
  error,
  onRequestRemove,
  t,
}: {
  showRoot: boolean;
  worktrees: RootedWorktree[];
  sessions: Session[];
  activeSessionId: string | null;
  loading: boolean;
  removingPath: string | null;
  error: { kind: "load" | "remove"; message: string } | null;
  onRequestRemove: (worktree: RootedWorktree) => void;
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
        <ul className="divide-y divide-border rounded-[var(--acorn-pane-radius)] border border-border bg-bg">
          {worktrees.map((worktree) => {
            const modified = formatModifiedTime(worktree.modified_ms);
            const isRemoving = removingPath === worktree.path;
            const usedBySessions = sessionsUsingWorktreePath(
              sessions,
              worktree.path,
            );
            const sessionCount = usedBySessions.length;
            const removeBlockedByOtherSessions =
              blockingSessionsForProjectWorktree(
                sessions,
                worktree.rootPath,
                worktree.path,
                activeSessionId,
              ).length > 0;
            return (
              <li key={`${worktree.rootPath}:${worktree.path}`} className="px-3 py-2">
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
                      {showRoot ? (
                        <span className="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] text-fg-muted">
                          {basenamePath(worktree.rootPath)}
                        </span>
                      ) : null}
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
                    {removeBlockedByOtherSessions ? (
                      <p className="text-[11px] text-fg-muted">
                        {dt(
                          t,
                          "dialogs.projectSettings.removeWorktreeBlockedByOtherSessions",
                        )}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    aria-label={dtf(
                      t,
                      "dialogs.projectSettings.removeWorktreeAria",
                      { name: worktree.name },
                    )}
                    title={
                      removeBlockedByOtherSessions
                        ? dt(
                            t,
                            "dialogs.projectSettings.removeWorktreeBlockedByOtherSessions",
                          )
                        : undefined
                    }
                    onClick={() => onRequestRemove(worktree)}
                    disabled={
                      removingPath !== null || removeBlockedByOtherSessions
                    }
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 text-[11px] text-fg-muted hover:text-danger"
                  >
                    {isRemoving ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    {isRemoving
                      ? dt(t, "dialogs.projectSettings.deletingWorktree")
                      : dt(t, "dialogs.projectSettings.removeWorktree")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <Notice tone="danger" density="compact">
          {dt(
            t,
            error.kind === "load"
              ? "dialogs.projectSettings.loadWorktreesFailed"
              : "dialogs.projectSettings.removeWorktreeFailed",
          )}{" "}
          {error.message}
        </Notice>
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
  worktree: RootedWorktree | null;
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
            <CodeValue
              tone="muted"
              overflow="breakAll"
              className="px-3 py-2 text-[10px] leading-relaxed"
            >
              {worktree.path}
            </CodeValue>
            {hasSessions ? (
              <Notice tone="warning" density="compact">
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
                      className="truncate rounded-md bg-bg/60 px-2 py-1 text-[11px] text-fg"
                    >
                      {session.name}
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : null}
          </div>
          <ModalFooter variant="sidebar">
            <Button
              onClick={onCancel}
              disabled={removing}
              size="md"
              surface="dialog"
            >
              {dt(t, "dialogs.projectSettings.cancelRemove")}
            </Button>
            <Button
              onClick={onConfirm}
              disabled={removing}
              variant="dangerSoft"
              size="md"
              surface="dialog"
              className="gap-1"
            >
              {removing ? <Loader2 size={12} className="animate-spin" /> : null}
              {removing
                ? dt(t, "dialogs.projectSettings.deletingWorktree")
                : hasSessions
                  ? dt(t, "dialogs.projectSettings.deleteWorktreeAndSessions")
                  : dt(t, "dialogs.projectSettings.deleteWorktree")}
            </Button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}
