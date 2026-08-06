import {
  AlertTriangle,
  FolderGit2,
  FolderPlus,
  FolderSymlink,
  GitBranch,
  Loader2,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { STANDARD_PR_GENERATION_PROMPT } from "../lib/project-settings";
import { basenamePath, projectRootPaths } from "../lib/projectFolders";
import {
  sessionsUsingProjectWorktree,
  sessionsUsingWorktreePath,
} from "../lib/sessionWorktree";
import type {
  ProjectBranch,
  ProjectSettings,
  ProjectWorktree,
  Session,
} from "../lib/types";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import { ContextMenu } from "./ContextMenu";
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
  Select,
  type SelectItem,
  type SelectOptionGroup,
} from "./ui";

const PROMPT_MAX_CHARS = 2_000;
const NAME_MAX_CHARS = 120;
const BRANCH_MAX_CHARS = 255;
const AUTOMATIC_BASE_BRANCH_VALUE = "automatic";
const CUSTOM_BASE_BRANCH_VALUE = "custom";
const BRANCH_VALUE_PREFIX = "branch:";

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
    worktrees: {
      base_branch: null,
    },
  };
}

function projectBranchReference(branch: ProjectBranch): string {
  return branch.is_remote
    ? `refs/remotes/${branch.name}`
    : `refs/heads/${branch.name}`;
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
  // So does the source folder's context menu — Escape should dismiss the menu
  // rather than the whole modal underneath it.
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const removeProjectWorktree = useAppStore((s) => s.removeProjectWorktree);
  const projects = useAppStore((s) => s.projects);
  // The modal is also opened from a session's repo path, which for a session
  // in a source folder is not any project's primary root. Match on every root
  // a project spans so it still resolves to the project that owns it.
  const projectEntry = project
    ? projects.find((entry) =>
        projectRootPaths(entry).includes(project.repoPath),
      )
    : undefined;
  // Worktrees belong to a repository, so a multi-root project has to list and
  // remove them per root rather than through its primary one.
  const projectRoots = projectEntry
    ? projectRootPaths(projectEntry)
    : project
      ? [project.repoPath]
      : [];
  const projectRootsKey = projectRoots.join("\u0000");
  const projectName = projectEntry?.name ?? project?.name ?? "";
  const renameProject = useAppStore((s) => s.renameProject);
  const [name, setName] = useState(projectName);
  const [tab, setTab] = useState<ProjectSettingsTab>(initialTab);
  const [settings, setSettings] = useState<ProjectSettings>(() =>
    defaultProjectSettings(),
  );
  const [settingsByRoot, setSettingsByRoot] = useState<
    Record<string, ProjectSettings>
  >({});
  const [dirtyWorktreeRoots, setDirtyWorktreeRoots] = useState<Set<string>>(
    () => new Set(),
  );
  const [worktreeRootPath, setWorktreeRootPath] = useState("");
  const [identity, setIdentity] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<RootedWorktree[]>([]);
  const [branches, setBranches] = useState<ProjectBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [worktreesLoading, setWorktreesLoading] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingPath, setRemovingPath] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] =
    useState<RootedWorktree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [worktreeError, setWorktreeError] = useState<{
    kind: "load" | "remove";
    message: string;
  } | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

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
    project !== null &&
      confirmRemove === null &&
      pendingSourceMerge === null &&
      !sourceMenuOpen,
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
    setName(projectName);
  }, [project?.repoPath, projectName]);

  useEffect(() => {
    const requestedRoot = project?.repoPath;
    setWorktreeRootPath(
      requestedRoot && projectRoots.includes(requestedRoot)
        ? requestedRoot
        : (projectRoots[0] ?? ""),
    );
  }, [project?.repoPath, projectRootsKey]);

  const activeWorktreeRoot = projectRoots.includes(worktreeRootPath)
    ? worktreeRootPath
    : (projectRoots[0] ?? "");

  useEffect(() => {
    if (!project) {
      setSettings(defaultProjectSettings());
      setSettingsByRoot({});
      setDirtyWorktreeRoots(new Set());
      setWorktreeRootPath("");
      setIdentity(null);
      setWorktrees([]);
      setBranches([]);
      setLoading(false);
      setWorktreesLoading(false);
      setBranchesLoading(false);
      setSaving(false);
      setRemovingPath(null);
      setConfirmRemove(null);
      setError(null);
      setWorktreeError(null);
      setBranchError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setWorktreesLoading(true);
    setRemovingPath(null);
    setConfirmRemove(null);
    setError(null);
    setWorktreeError(null);
    setBranchError(null);

    Promise.all(
      projectRoots.map(async (rootPath) => ({
        rootPath,
        record: await api.getProjectSettings(rootPath),
      })),
    )
      .then((entries) => {
        if (cancelled) return;
        const nextByRoot = Object.fromEntries(
          entries.map(({ rootPath, record }) => [rootPath, record.settings]),
        );
        const currentRecord = entries.find(
          ({ rootPath }) => rootPath === project.repoPath,
        )?.record;
        setSettings(currentRecord?.settings ?? defaultProjectSettings());
        setSettingsByRoot(nextByRoot);
        setDirtyWorktreeRoots(new Set());
        setIdentity(currentRecord?.key ?? null);
      })
      .catch((e) => {
        if (cancelled) return;
        setSettings(defaultProjectSettings());
        setSettingsByRoot({});
        setDirtyWorktreeRoots(new Set());
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

  useEffect(() => {
    if (!project || !activeWorktreeRoot) {
      setBranches([]);
      setBranchesLoading(false);
      setBranchError(null);
      return;
    }

    let cancelled = false;
    setBranches([]);
    setBranchesLoading(true);
    setBranchError(null);
    api
      .listProjectBranches(activeWorktreeRoot)
      .then((items) => {
        if (!cancelled) setBranches(items);
      })
      .catch((e) => {
        if (cancelled) return;
        setBranches([]);
        setBranchError(String(e));
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project, activeWorktreeRoot]);

  const prompt = settings.pull_requests.generation_prompt ?? "";
  const activeRootSettings =
    settingsByRoot[activeWorktreeRoot] ??
    (activeWorktreeRoot === project?.repoPath
      ? settings
      : defaultProjectSettings());
  const configuredBaseBranch = activeRootSettings.worktrees.base_branch;
  const configuredProjectBranch = branches.find(
    (branch) => projectBranchReference(branch) === configuredBaseBranch,
  ) ?? branches.find((branch) => branch.name === configuredBaseBranch);
  const selectedBaseBranch =
    configuredBaseBranch === null
      ? AUTOMATIC_BASE_BRANCH_VALUE
      : configuredProjectBranch
        ? `${BRANCH_VALUE_PREFIX}${projectBranchReference(configuredProjectBranch)}`
        : CUSTOM_BASE_BRANCH_VALUE;
  const branchOptions = useMemo<Array<SelectItem | SelectOptionGroup>>(() => {
    const localBranches: SelectItem[] = branches
      .filter((branch) => !branch.is_remote)
      .map((branch) => ({
        value: `${BRANCH_VALUE_PREFIX}${projectBranchReference(branch)}`,
        label: branch.name,
      }));
    const remoteBranches: SelectItem[] = branches
      .filter((branch) => branch.is_remote)
      .map((branch) => ({
        value: `${BRANCH_VALUE_PREFIX}${projectBranchReference(branch)}`,
        label: branch.name,
      }));
    return [
      {
        value: AUTOMATIC_BASE_BRANCH_VALUE,
        label: dt(t, "dialogs.projectSettings.worktreeBaseBranchAutomatic"),
      },
      ...(localBranches.length > 0
        ? [
            {
              label: dt(t, "dialogs.projectSettings.localBranches"),
              options: localBranches,
            } satisfies SelectOptionGroup,
          ]
        : []),
      ...(remoteBranches.length > 0
        ? [
            {
              label: dt(t, "dialogs.projectSettings.remoteBranches"),
              options: remoteBranches,
            } satisfies SelectOptionGroup,
          ]
        : []),
      {
        value: CUSTOM_BASE_BRANCH_VALUE,
        label: dt(t, "dialogs.projectSettings.worktreeBaseBranchCustom"),
      },
    ];
  }, [branches, t]);
  const worktreeRootOptions: SelectItem[] = projectRoots.map((rootPath) => ({
    value: rootPath,
    label: rootPath,
    searchText: `${basenamePath(rootPath)} ${rootPath}`,
  }));

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

  function updateWorktreeBaseBranch(value: string | null) {
    if (!activeWorktreeRoot) return;
    const next =
      value === null
        ? null
        : Array.from(value).slice(0, BRANCH_MAX_CHARS).join("");
    setSettingsByRoot((current) => {
      const currentSettings =
        current[activeWorktreeRoot] ??
        (activeWorktreeRoot === project?.repoPath
          ? settings
          : defaultProjectSettings());
      return {
        ...current,
        [activeWorktreeRoot]: {
          ...currentSettings,
          worktrees: {
            ...currentSettings.worktrees,
            base_branch: next,
          },
        },
      };
    });
    setDirtyWorktreeRoots((current) => {
      const nextRoots = new Set(current);
      nextRoots.add(activeWorktreeRoot);
      return nextRoots;
    });
  }

  function selectWorktreeBaseBranch(value: string) {
    if (value === AUTOMATIC_BASE_BRANCH_VALUE) {
      updateWorktreeBaseBranch(null);
      return;
    }
    if (value === CUSTOM_BASE_BRANCH_VALUE) {
      if (selectedBaseBranch !== CUSTOM_BASE_BRANCH_VALUE) {
        updateWorktreeBaseBranch("");
      }
      return;
    }
    if (value.startsWith(BRANCH_VALUE_PREFIX)) {
      updateWorktreeBaseBranch(value.slice(BRANCH_VALUE_PREFIX.length));
    }
  }

  async function save() {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (trimmed && trimmed !== projectName) {
        const renamed = await renameProject(
          projectEntry?.repo_path ?? project.repoPath,
          trimmed,
        );
        if (!renamed) {
          const message = useAppStore.getState().consumeError();
          setError(
            `${dt(t, "dialogs.projectSettings.renameFailed")} ${message ?? ""}`.trim(),
          );
          return;
        }
      }
      for (const rootPath of dirtyWorktreeRoots) {
        if (rootPath === project.repoPath) continue;
        const rootSettings = settingsByRoot[rootPath];
        if (rootSettings) {
          await api.updateProjectSettings(rootPath, rootSettings);
        }
      }
      const currentRootWorktreeSettings =
        settingsByRoot[project.repoPath]?.worktrees ?? settings.worktrees;
      const record = await api.updateProjectSettings(
        project.repoPath,
        { ...settings, worktrees: currentRootWorktreeSettings },
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
                  <Field label={dt(t, "dialogs.projectSettings.name")}>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={loading || saving}
                      maxLength={NAME_MAX_CHARS}
                      placeholder={projectName}
                      className="w-full rounded-md border border-input-border bg-input px-2 py-1.5 text-xs text-fg outline-none transition focus:border-accent focus:bg-input-hover disabled:opacity-60"
                    />
                  </Field>
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
                  <ProjectSourceFolderList
                    repoPath={project.repoPath}
                    onMenuOpenChange={setSourceMenuOpen}
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
                  {projectRoots.length > 1 ? (
                    <Field
                      label={dt(
                        t,
                        "dialogs.projectSettings.worktreeRepository",
                      )}
                      hint={dt(
                        t,
                        "dialogs.projectSettings.worktreeRepositoryHint",
                      )}
                    >
                      <Select
                        value={activeWorktreeRoot}
                        onValueChange={setWorktreeRootPath}
                        options={worktreeRootOptions}
                        searchable
                        disabled={loading || saving}
                        aria-label={dt(
                          t,
                          "dialogs.projectSettings.worktreeRepository",
                        )}
                        searchPlaceholder={dt(
                          t,
                          "dialogs.projectSettings.searchRepositories",
                        )}
                      />
                    </Field>
                  ) : null}
                  <Field
                    label={dt(t, "dialogs.projectSettings.worktreeBaseBranch")}
                    hint={dt(
                      t,
                      "dialogs.projectSettings.worktreeBaseBranchHint",
                    )}
                  >
                    <Select
                      value={selectedBaseBranch}
                      onValueChange={selectWorktreeBaseBranch}
                      options={branchOptions}
                      searchable
                      disabled={loading || saving}
                      aria-label={dt(
                        t,
                        "dialogs.projectSettings.worktreeBaseBranch",
                      )}
                      searchPlaceholder={dt(
                        t,
                        "dialogs.projectSettings.searchBranches",
                      )}
                    />
                    {branchesLoading ? (
                      <p className="text-[10px] text-fg-muted">
                        {dt(t, "dialogs.projectSettings.loadingBranches")}
                      </p>
                    ) : branchError ? (
                      <p className="text-[10px] text-danger">
                        {dt(t, "dialogs.projectSettings.loadBranchesFailed")} {branchError}
                      </p>
                    ) : null}
                    {selectedBaseBranch === CUSTOM_BASE_BRANCH_VALUE ? (
                      <input
                        value={configuredBaseBranch ?? ""}
                        onChange={(e) =>
                          updateWorktreeBaseBranch(e.target.value)
                        }
                        disabled={loading || saving}
                        maxLength={BRANCH_MAX_CHARS}
                        aria-label={dt(
                          t,
                          "dialogs.projectSettings.customWorktreeBaseBranch",
                        )}
                        placeholder={dt(
                          t,
                          "dialogs.projectSettings.worktreeBaseBranchPlaceholder",
                        )}
                        className="w-full rounded-md border border-input-border bg-input px-2 py-1.5 font-mono text-xs text-fg outline-none transition focus:border-accent focus:bg-input-hover disabled:opacity-60"
                      />
                    ) : null}
                  </Field>
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
function ProjectSourceFolderList({
  repoPath,
  onMenuOpenChange,
}: {
  repoPath: string;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const t = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const addProjectSource = useAppStore((s) => s.addProjectSource);
  const removeProjectSource = useAppStore((s) => s.removeProjectSource);
  const splitProjectSource = useAppStore((s) => s.splitProjectSource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    sourcePath: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    onMenuOpenChange(menu !== null);
    // Leaving the tab with the menu open must not leave the modal's Escape
    // handler switched off.
    return () => onMenuOpenChange(false);
  }, [menu, onMenuOpenChange]);

  const project = projects.find((entry) =>
    projectRootPaths(entry).includes(repoPath),
  );
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

  async function split(sourcePath: string) {
    setBusy(true);
    setError(null);
    const ok = await splitProjectSource(repoPath, sourcePath);
    if (!ok) {
      const message = useAppStore.getState().consumeError();
      setError(
        `${dt(t, "dialogs.projectSettings.splitSourceFailed")} ${message ?? ""}`.trim(),
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
              onContextMenu={(e) => {
                if (isPrimary) return;
                e.preventDefault();
                setMenu({ sourcePath: root, x: e.clientX, y: e.clientY });
              }}
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
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={[
          {
            label: dt(t, "dialogs.projectSettings.splitSourceFolder"),
            icon: <FolderSymlink size={12} />,
            disabled: busy,
            onClick: () => {
              if (menu) void split(menu.sourcePath);
            },
          },
        ]}
      />
      {roots.length === 1 ? (
        <p className="text-[11px] text-fg-muted/80">
          {dt(t, "dialogs.projectSettings.noSources")}
        </p>
      ) : (
        <p className="text-[11px] text-fg-muted/80">
          {dt(t, "dialogs.projectSettings.splitSourceHint")}
        </p>
      )}
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
