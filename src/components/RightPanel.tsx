import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Copy,
  ExternalLink,
  FileDiff,
  FolderTree,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Globe,
  History,
  Loader2,
  ListTodo,
  Maximize2,
  MessageSquare,
  MinusCircle,
  Play,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Panel, PanelGroup } from "react-resizable-panels";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, FS_CHANGED_EVENT, type FsChangePayload } from "../lib/api";
import { cn } from "../lib/cn";
import { openFileInEditor } from "../lib/editor";
import { joinPath } from "../lib/paths";
import { rightPanelCache } from "../lib/right-panel-cache";
import { classifyRightPanelFsChange } from "../lib/right-panel-invalidation";
import { useSettings } from "../lib/settings";
import { useAppStore } from "../store";
import { AgentProviderIcon } from "../lib/agentProvider";
import {
  invalidateGitRepositoryStatus,
  prefetchGitHubRepoStatus,
  useIsGitRepository,
  useIsGitHubRepo,
} from "../lib/useIsGitHubRepo";
import {
  RIGHT_GROUPS,
  groupOfTab,
  tabsForGroup,
  type RightGroup,
  type RightTab,
} from "../lib/rightPanelGroups";
import type {
  AccountSummary,
  AgentHistoryItem,
  AgentHistoryProvider,
  CommitInfo,
  DiffPayload,
  IssueInfo,
  IssueListing,
  IssueStateFilter,
  PrStateFilter,
  PullRequestChecksSummary,
  PullRequestDetail,
  PullRequestInfo,
  PullRequestLabel,
  PullRequestListing,
  SessionNotification,
  SessionNotificationKind,
  SessionAgentProvider,
  StagedFile,
  TodoItem,
  WorkflowJob,
  WorkflowJobStep,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunDetailListing,
  WorkflowRunsListing,
} from "../lib/types";
import { AuthorAvatar } from "./AuthorAvatar";
import { loginFromEmail } from "./AuthorTag";
import { ClosePullRequestDialog } from "./ClosePullRequestDialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DiffView } from "./DiffView";
import { DiffViewerModal } from "./DiffViewerModal";
import { FileExplorer } from "./FileExplorer";
import { GitHubLabelChip } from "./GitHubLabelChip";
import { IssueDetailModal } from "./IssueDetailModal";
import { MergePullRequestDialog } from "./MergePullRequestDialog";
import { PullRequestDetailModal } from "./PullRequestDetailModal";
import { ResizeHandle } from "./ResizeHandle";
import { Tooltip } from "./Tooltip";
import {
  CommandHint,
  ListActionRow,
  ListBox,
  ListEmptyState,
  ListRow,
  Modal,
  ModalHeader,
  RefreshButton,
  Select,
  SkeletonBlock,
  SkeletonCircle,
  SkeletonList,
  SkeletonText,
  TextInput,
  listBoxClassName,
  listRowClassName,
  type ListRowDensity,
} from "./ui";
import { useDialogShortcuts } from "../lib/dialog";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import {
  applySessionCreateRequest,
  buildSessionCreateRequest,
  resolveProjectScopedForRepoPath,
  scopeForSession,
} from "../lib/sessionCreation";

interface ExpandedDiff {
  payload: DiffPayload | null;
  title: string;
  /** Rich React subtitle — avatar + author + sha line for commit expansion. */
  subtitle?: ReactNode;
  /** Right-side header buttons (Copy SHA / Open on GitHub for commits). */
  headerActions?: ReactNode;
  /**
   * Commit message body to show above the diff. Populated when expanding a
   * commit; omitted for staged-diff expansion (no commit context).
   */
  body?: string;
  loading?: boolean;
  error?: string | null;
  requestId?: number;
}

type SetExpandedDiff = Dispatch<SetStateAction<ExpandedDiff | null>>;

const COMMITS_PAGE_SIZE = 50;
const COMMIT_ROW_HEIGHT = 48;
const COMMIT_LIST_PADDING_Y = 4;
const BACKGROUND_LOADED_TABS = new Set<RightTab>([
  "prs",
  "issues",
  "actions",
  "history",
]);
const PROJECT_PREFETCH_START_DELAY_MS = 1_000;
const PROJECT_PREFETCH_GAP_MS = 250;

type RightPanelTranslationKey = Extract<TranslationKey, `rightPanel.${string}`>;

function rt(t: Translator, key: RightPanelTranslationKey): string {
  return t(key);
}

function rtf(
  t: Translator,
  key: RightPanelTranslationKey,
  values: Record<string, string | number>,
): string {
  return rt(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function useLiveUnixSeconds(enabled: boolean): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!enabled) return;
    setNow(Math.floor(Date.now() / 1000));
    const handle = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1_000);
    return () => window.clearInterval(handle);
  }, [enabled]);
  return now;
}

async function prefetchProjectPanelData(repoPath: string): Promise<void> {
  void rightPanelCache.fetchAgentHistory(repoPath).catch((error) => {
    console.debug("[RightPanel] agent history prefetch failed", repoPath, error);
  });
  const isGitHub = await prefetchGitHubRepoStatus(repoPath);
  if (!isGitHub) return;
  await rightPanelCache.fetchPullRequests(repoPath, "open", PR_PAGE_SIZE);
  for (const filter of PR_BACKGROUND_PREFETCH_STATES) {
    await rightPanelCache.fetchPullRequests(repoPath, filter, PR_PAGE_SIZE);
  }
  await rightPanelCache.fetchIssues(repoPath, "open", ISSUE_PAGE_SIZE);
  for (const filter of ISSUE_BACKGROUND_PREFETCH_STATES) {
    await rightPanelCache.fetchIssues(repoPath, filter, ISSUE_PAGE_SIZE);
  }
  await rightPanelCache.fetchWorkflowRuns(repoPath, WORKFLOW_RUNS_LIMIT);
}

export function RightPanel() {
  const t = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const activeProject = useAppStore((s) => s.activeProject);
  const workspaceTabs = useAppStore((s) => s.workspaceTabs);
  const rightTab = useAppStore((s) => s.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const setRightGroup = useAppStore((s) => s.setRightGroup);
  const activityUnreadCount = useAppStore(
    (s) =>
      s.sessionNotifications.filter((notification) => !notification.readAt)
        .length,
  );
  const active = sessions.find((s) => s.id === activeSessionId);
  const activeWorkspaceTab = activeTabId ? workspaceTabs[activeTabId] : undefined;
  // The session's recorded worktree path is what we set at spawn time. The
  // PTY child (or any descendant) may have chdir'd since — most notably via
  // `claude --worktree`, which silently moves the running session into a
  // freshly created worktree. `useLiveRepoPath` asks the backend on demand
  // and falls back to the recorded path when there's no live PTY.
  const fallbackWorktreePath =
    active?.worktree_path ?? activeWorkspaceTab?.repoPath ?? activeProject ?? null;
  const liveRepoPath = useLiveRepoPath(
    active?.id ?? null,
    fallbackWorktreePath,
  );
  const activeIsLocalChat = active?.project_scoped === false;
  const agentHistoryScope =
    activeIsLocalChat || (!active && activeProject === null)
      ? "unscoped"
      : "project";
  // Code tabs follow the active worktree; GitHub/history stay anchored to the
  // project root so same-project pane focus changes do not remount them.
  const codePanelRepoPath = activeIsLocalChat ? null : liveRepoPath;
  const projectRootFallbackPath =
    active?.repo_path ??
    activeProject ??
    activeWorkspaceTab?.repoPath ??
    liveRepoPath;
  const projectRootRepoPath = activeIsLocalChat ? null : projectRootFallbackPath;
  const agentHistoryPath =
    agentHistoryScope === "project" ? projectRootRepoPath : null;
  const localSessionHostPath =
    sessions.find((session) => session.project_scoped === false)?.repo_path ??
    null;
  const sessionHostRepoPath =
    active?.repo_path ??
    activeProject ??
    activeWorkspaceTab?.repoPath ??
    localSessionHostPath ??
    liveRepoPath;
  const sessionHostProjectScoped = active
    ? scopeForSession(active).placement.projectScoped
    : agentHistoryScope === "unscoped"
      ? false
    : sessionHostRepoPath
      ? resolveProjectScopedForRepoPath(
          { sessions, projects },
          sessionHostRepoPath,
        )
      : true;
  const [gitRepoProbeVersion, setGitRepoProbeVersion] = useState(0);
  const invalidateGitProbe = useCallback(() => {
    const paths = new Set(
      [codePanelRepoPath, projectRootRepoPath].filter(
        (path): path is string => path !== null,
      ),
    );
    if (paths.size === 0) return;
    for (const path of paths) invalidateGitRepositoryStatus(path);
    setGitRepoProbeVersion((version) => version + 1);
  }, [codePanelRepoPath, projectRootRepoPath]);
  const invalidations = useRightPanelInvalidations(
    codePanelRepoPath,
    invalidateGitProbe,
  );
  const [expanded, setExpanded] = useState<ExpandedDiff | null>(null);
  const [prDetail, setPrDetail] = useState<{
    repoPath: string;
    number: number;
  } | null>(null);
  // Open state for the PR search modal. Carries `repoPath` so the modal can
  // run its own search fetches scoped to whichever repo was active when
  // search was triggered.
  const [prSearch, setPrSearch] = useState<{ repoPath: string } | null>(null);
  // Bumped from the PR detail modal after a merge/close so the PRs tab
  // refetches without waiting for the next polling tick.
  const [prListVersion, setPrListVersion] = useState(0);

  // Polling lives at the panel level (not inside TodosTab) so we can hide the
  // Todos tab when the active session has none — without requiring the tab to
  // be mounted first to discover that.
  const todosState = useSessionTodos(
    active?.id ?? null,
    active?.worktree_path ?? null,
  );
  const showTodos = todosState.todos.length > 0;
  const isCodeGitRepo = useIsGitRepository(
    codePanelRepoPath,
    gitRepoProbeVersion,
  );
  const isGitHubRepo = useIsGitHubRepo(
    projectRootRepoPath,
    gitRepoProbeVersion,
  );
  const githubVisible = isGitHubRepo === true;
  const gitBackedTabsVisible =
    codePanelRepoPath !== null && isCodeGitRepo !== false;

  const visibleTabsByGroup = useMemo<
    Record<RightGroup, ReadonlyArray<RightTab>>
  >(
    () => ({
      code:
        codePanelRepoPath === null
          ? []
          : gitBackedTabsVisible
            ? tabsForGroup("code")
            : tabsForGroup("code").filter((tab) => tab === "files"),
      github: githubVisible ? tabsForGroup("github") : [],
      agents: showTodos
        ? tabsForGroup("agents")
        : tabsForGroup("agents").filter((tab) => tab !== "todos"),
    }),
    [codePanelRepoPath, gitBackedTabsVisible, githubVisible, showTodos],
  );
  const visibleGroups = useMemo(
    () => RIGHT_GROUPS.filter((g) => visibleTabsByGroup[g].length > 0),
    [visibleTabsByGroup],
  );
  const activeGroup: RightGroup = visibleGroups.includes(groupOfTab(rightTab))
    ? groupOfTab(rightTab)
    : (visibleGroups[0] ?? "code");
  const visibleTabs = visibleTabsByGroup[activeGroup];
  const shouldLoadGitHubTabs =
    projectRootRepoPath !== null && isGitHubRepo === true;
  const projectKey = useMemo(
    () => projects.map((project) => project.repo_path).join("\0"),
    [projects],
  );
  const retainedRepoPaths = useMemo(() => {
    const repos = new Set<string>();
    for (const project of projects) repos.add(project.repo_path);
    for (const session of sessions) {
      repos.add(session.repo_path);
      repos.add(session.worktree_path);
    }
    for (const tab of Object.values(workspaceTabs)) {
      if (tab.repoPath) repos.add(tab.repoPath);
    }
    return Array.from(repos);
  }, [projects, sessions, workspaceTabs]);

  // If the user is sitting on a tab that just became invisible (Todos emptied,
  // GitHub origin disappeared, etc.), slide them to the nearest visible tab
  // rather than render the panel against a stale selection.
  useEffect(() => {
    if (
      codePanelRepoPath === null &&
      activeProject === null &&
      !active &&
      projects.length === 0 &&
      sessions.length === 0
    ) {
      return;
    }
    if (visibleTabs.length === 0) return;
    if (!visibleTabs.includes(rightTab)) {
      if (
        codePanelRepoPath !== null &&
        isCodeGitRepo === null &&
        groupOfTab(rightTab) === "code" &&
        rightTab !== "files"
      ) {
        return;
      }
      if (
        projectRootRepoPath !== null &&
        isGitHubRepo === null &&
        groupOfTab(rightTab) === "github"
      ) {
        return;
      }
      setRightTab(visibleTabs[0]);
    }
  }, [
    isGitHubRepo,
    isCodeGitRepo,
    active,
    activeProject,
    codePanelRepoPath,
    projectRootRepoPath,
    projects.length,
    rightTab,
    sessions.length,
    visibleTabs,
    setRightTab,
  ]);

  useEffect(() => {
    if (projects.length === 0) return;
    const repos = projects.map((project) => project.repo_path);
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        for (const repo of repos) {
          if (cancelled) return;
          if (!rightPanelCache.claimProjectPrefetch(repo)) continue;
          await prefetchProjectPanelData(repo).catch((error) => {
            console.debug("[RightPanel] project prefetch failed", repo, error);
          });
          if (!cancelled) await sleep(PROJECT_PREFETCH_GAP_MS);
        }
      })();
    }, PROJECT_PREFETCH_START_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [projectKey, projects]);

  useEffect(() => {
    rightPanelCache.retainRepos(retainedRepoPaths);
  }, [retainedRepoPaths]);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar">
      <nav
        className={cn(
          "flex shrink-0 gap-0.5 overflow-x-auto whitespace-nowrap border-b border-border px-1.5 py-1",
          "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        aria-label="Right panel group"
      >
        {visibleGroups.map((group) => (
          <TabButton
            key={group}
            icon={groupIcon(group)}
            label={rt(t, groupLabelKey(group))}
            active={group === activeGroup}
            onClick={() => setRightGroup(group)}
          />
        ))}
      </nav>
      {visibleTabs.length > 0 ? (
        <nav
          className={cn(
            "flex shrink-0 gap-0.5 overflow-x-auto whitespace-nowrap border-b border-border bg-bg-elevated/30 px-1.5 py-1",
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
          aria-label="Right panel sub-tab"
        >
          {visibleTabs.map((tab) => (
            <SubTabButton
              key={tab}
              icon={tabIcon(tab)}
              label={rt(t, tabLabelKey(tab))}
              badge={
                tab === "activity"
                  ? activityUnreadCount
                  : tab === "todos"
                    ? todosState.todos.length
                    : undefined
              }
              active={tab === rightTab}
              onClick={() => setRightTab(tab)}
            />
          ))}
        </nav>
      ) : null}
      <div className="flex-1 overflow-hidden">
        {rightTab === "activity" ? (
          <ActivityTab />
        ) : rightTab === "todos" ? (
          active && showTodos ? (
            <TodosTab todos={todosState.todos} />
          ) : (
            <Empty msg={rt(t, "rightPanel.empty.noTodos")} />
          )
        ) : rightTab === "commits" ? (
          codePanelRepoPath ? (
            // `key` forces a full remount on project switch so any in-flight
            // git request from the previous repo cannot land its `setState`
            // into the new repo's component (cross-project data leak).
            <CommitsTab
              key={codePanelRepoPath}
              repoPath={codePanelRepoPath}
              invalidateKey={invalidations.commits}
              onExpand={setExpanded}
            />
          ) : (
            <Empty msg={rt(t, "rightPanel.empty.noProject")} />
          )
        ) : rightTab === "staged" ? (
          codePanelRepoPath ? (
            <StagedTab
              key={codePanelRepoPath}
              repoPath={codePanelRepoPath}
              invalidateKey={invalidations.staged}
              onExpand={setExpanded}
            />
          ) : (
            <Empty msg={rt(t, "rightPanel.empty.noProject")} />
          )
        ) : rightTab === "files" ? (
          codePanelRepoPath ? (
            <FileExplorer
              key={codePanelRepoPath}
              rootPath={codePanelRepoPath}
            />
          ) : (
            <Empty msg={rt(t, "rightPanel.empty.noProject")} />
          )
        ) : BACKGROUND_LOADED_TABS.has(rightTab) ? (
          rightTab === "history" ? (
            agentHistoryScope === "unscoped" || agentHistoryPath ? null : (
              <Empty msg={rt(t, "rightPanel.empty.noProject")} />
            )
          ) : projectRootRepoPath ? null : (
            <Empty msg={rt(t, "rightPanel.empty.noProject")} />
          )
        ) : (
          <Empty msg={rt(t, "rightPanel.empty.noProject")} />
        )}
        {projectRootRepoPath && shouldLoadGitHubTabs ? (
          <>
            <BackgroundLoadedTab active={rightTab === "prs"}>
              <PullRequestsTab
                key={`prs:${projectRootRepoPath}`}
                repoPath={projectRootRepoPath}
                onOpenDetail={(number) =>
                  setPrDetail({ repoPath: projectRootRepoPath, number })
                }
                onOpenSearch={() =>
                  setPrSearch({ repoPath: projectRootRepoPath })
                }
                refreshKey={prListVersion}
              />
            </BackgroundLoadedTab>
            <BackgroundLoadedTab active={rightTab === "issues"}>
              <IssuesTab
                key={`issues:${projectRootRepoPath}`}
                repoPath={projectRootRepoPath}
              />
            </BackgroundLoadedTab>
            <BackgroundLoadedTab active={rightTab === "actions"}>
              <ActionsTab
                key={`actions:${projectRootRepoPath}`}
                repoPath={projectRootRepoPath}
              />
            </BackgroundLoadedTab>
          </>
        ) : null}
        {agentHistoryScope === "unscoped" || agentHistoryPath ? (
          <BackgroundLoadedTab active={rightTab === "history"}>
            <AgentHistoryTab
              key={
                agentHistoryScope === "unscoped"
                  ? "history:unscoped"
                  : `history:${agentHistoryPath}`
              }
              scope={agentHistoryScope}
              repoPath={agentHistoryPath}
              sessionHostRepoPath={sessionHostRepoPath}
              sessionHostProjectScoped={sessionHostProjectScoped}
            />
          </BackgroundLoadedTab>
        ) : null}
      </div>
      <DiffViewerModal
        payload={expanded?.payload ?? null}
        open={expanded !== null}
        loading={expanded?.loading ?? false}
        error={expanded?.error ?? null}
        title={expanded?.title ?? ""}
        subtitle={expanded?.subtitle}
        headerActions={expanded?.headerActions}
        body={expanded?.body}
        cwd={codePanelRepoPath ?? undefined}
        loadingLabel={rt(t, "rightPanel.loading.diffLower")}
        onClose={() => setExpanded(null)}
      />
      <PullRequestSearchModal
        open={prSearch}
        detailOpen={prDetail !== null}
        onClose={() => setPrSearch(null)}
        onOpenDetail={(number) => {
          if (!prSearch) return;
          setPrDetail({ repoPath: prSearch.repoPath, number });
        }}
      />
      <PullRequestDetailModal
        open={prDetail}
        cwd={projectRootRepoPath ?? undefined}
        onClose={() => setPrDetail(null)}
        onMutated={() => setPrListVersion((v) => v + 1)}
      />
    </aside>
  );
}

function BackgroundLoadedTab({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("h-full", active ? "block" : "hidden")}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}

interface TabButtonProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  className?: string;
}

function TabButton({ icon, label, active, onClick, badge, className }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition",
        active
          ? "acorn-tab-active-bg text-fg"
          : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
        className,
      )}
    >
      {icon}
      {label}
      {typeof badge === "number" && badge > 0 ? (
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[9px] font-medium tabular-nums",
            active
              ? "bg-accent/20 text-fg"
              : "bg-fg-muted/15 text-fg-muted",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// Sub-tabs sit under the group bar with denser padding and a lighter inactive
// state, so the eye registers "group is primary, sub-tab is secondary".
function SubTabButton({ icon, label, active, onClick, badge }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex shrink-0 items-center justify-center gap-1.5 rounded px-2 py-1 text-[11px] transition",
        active
          ? "bg-bg-elevated text-fg"
          : "text-fg-muted/80 hover:bg-bg-elevated/40 hover:text-fg",
      )}
    >
      {icon}
      {label}
      {typeof badge === "number" && badge > 0 ? (
        <span
          className={cn(
            "rounded-full px-1 py-px text-[9px] font-medium tabular-nums",
            active
              ? "bg-accent/20 text-fg"
              : "bg-fg-muted/15 text-fg-muted",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function groupIcon(group: RightGroup): ReactNode {
  switch (group) {
    case "code":
      return <Code2 size={14} />;
    case "github":
      return <Globe size={14} />;
    case "agents":
      return <Bot size={14} />;
  }
}

function groupLabelKey(group: RightGroup): RightPanelTranslationKey {
  switch (group) {
    case "code":
      return "rightPanel.groups.code";
    case "github":
      return "rightPanel.groups.github";
    case "agents":
      return "rightPanel.groups.agents";
  }
}

function tabIcon(tab: RightTab): ReactNode {
  switch (tab) {
    case "files":
      return <FolderTree size={12} />;
    case "staged":
      return <FileDiff size={12} />;
    case "commits":
      return <GitCommit size={12} />;
    case "prs":
      return <GitPullRequest size={12} />;
    case "issues":
      return <CircleDot size={12} />;
    case "actions":
      return <Activity size={12} />;
    case "activity":
      return <CircleAlert size={12} />;
    case "todos":
      return <ListTodo size={12} />;
    case "history":
      return <History size={12} />;
  }
}

function tabLabelKey(tab: RightTab): RightPanelTranslationKey {
  return `rightPanel.tabs.${tab}` as RightPanelTranslationKey;
}

function Empty({ msg }: { msg: string }) {
  return <ListEmptyState>{msg}</ListEmptyState>;
}

/**
 * Shaped placeholder for the Pull Requests tab. Mirrors the real PR row
 * layout — two lines, with `#number`, state badge, title on top and
 * author · branches · time underneath — so the panel doesn't reflow when
 * data arrives. Bar widths are randomized per row (deterministically) so
 * the placeholder reads as multiple distinct items rather than a stripe.
 */
function PrSkeletonRow({ index }: { index: number }) {
  // Cycle through a handful of width pairs so the skeleton looks like a
  // varied list instead of identical bars stacked vertically.
  const titleWidths = ["55%", "72%", "40%", "65%", "48%", "60%"];
  const branchWidths = ["38%", "52%", "30%", "44%"];
  const titleW = titleWidths[index % titleWidths.length];
  const branchW = branchWidths[index % branchWidths.length];
  return (
    <div
      className={listRowClassName({
        className: "flex flex-col gap-1.5",
      })}
    >
      <div className="flex w-full items-center gap-2">
        <SkeletonBlock className="h-3 w-8 shrink-0 bg-fg-muted/15" />
        <SkeletonBlock className="h-4 w-12 shrink-0 rounded-full bg-fg-muted/15" />
        <SkeletonBlock
          className="h-3 min-w-0 flex-1"
          style={{ width: titleW }}
        />
      </div>
      <div className="flex w-full items-center gap-2">
        <SkeletonBlock className="h-2.5 w-16 shrink-0" />
        <span className="text-[10px] text-fg-muted/40">·</span>
        <SkeletonBlock
          className="h-2.5"
          style={{ width: branchW }}
        />
        <span className="text-[10px] text-fg-muted/40">·</span>
        <SkeletonBlock className="h-2.5 w-10 shrink-0" />
      </div>
    </div>
  );
}

function PrSkeletonList({ count = 6 }: { count?: number }) {
  return (
    <div className={listBoxClassName()}>
      {Array.from({ length: count }).map((_, i) => (
        <PrSkeletonRow key={i} index={i} />
      ))}
    </div>
  );
}

/**
 * Shaped placeholder for an Agents History row. Mirrors the real row's
 * structure — provider icon on the left, then title / preview / worktree /
 * timestamp stacked on the right — so the panel doesn't reflow when items
 * arrive. Some rows skip the worktree bar to look like a real mixed list.
 */
function HistorySkeletonRow({
  index,
  showAgentProviderIcons,
}: {
  index: number;
  showAgentProviderIcons: boolean;
}) {
  const titleWidths = ["68%", "82%", "54%", "74%", "60%", "88%"];
  const previewWidths = ["92%", "76%", "60%", "84%"];
  const titleW = titleWidths[index % titleWidths.length];
  const previewW = previewWidths[index % previewWidths.length];
  const showWorktree = index % 3 !== 1;
  return (
    <div
      aria-hidden="true"
      className={listRowClassName({ className: "flex items-start gap-2" })}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <SkeletonBlock
        className={cn(
          "mt-0.5 shrink-0 bg-fg-muted/15",
          showAgentProviderIcons ? "size-5" : "h-4 w-12",
        )}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <SkeletonBlock
          className="h-3 bg-fg-muted/15"
          style={{ width: titleW }}
        />
        <SkeletonBlock
          className="h-2.5"
          style={{ width: previewW }}
        />
        {showWorktree ? (
          <SkeletonBlock className="h-2.5 w-24" />
        ) : null}
        <SkeletonBlock className="h-2 w-12" />
      </div>
    </div>
  );
}

const RIGHT_PANEL_REFRESH_DEBOUNCE_MS = 150;
const TODOS_ACTIVITY_DEBOUNCE_MS = 750;
const TODOS_SAFETY_INTERVAL_MS = 30_000;
const COMMITS_SAFETY_INTERVAL_MS = 30_000;
const STAGED_SAFETY_INTERVAL_MS = 30_000;

interface SessionTodosState {
  todos: TodoItem[];
  loaded: boolean;
  error: string | null;
}

interface RightPanelInvalidationKeys {
  commits: number;
  staged: number;
}

interface LiveRepoCache {
  sessionId: string;
  fallbackPath: string | null;
  repoPath: string | null;
}

function useRefreshScheduler(
  refresh: () => Promise<void>,
  debounceMs = RIGHT_PANEL_REFRESH_DEBOUNCE_MS,
) {
  const refreshRef = useRef(refresh);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const unmountedRef = useRef(false);
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  const run = useCallback(() => {
    if (unmountedRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }

    inFlightRef.current = true;
    void refreshRef
      .current()
      .catch((err: unknown) => {
        console.debug("[RightPanel] scheduled refresh failed", err);
      })
      .finally(() => {
        inFlightRef.current = false;
        if (pendingRef.current && !unmountedRef.current) {
          pendingRef.current = false;
          timerRef.current = setTimeout(() => runRef.current(), debounceMs);
        }
      });
  }, [debounceMs]);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  useEffect(
    () => {
      unmountedRef.current = false;
      return () => {
        unmountedRef.current = true;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        pendingRef.current = false;
      };
    },
    [],
  );

  const scheduleRefresh = useCallback(
    (delayMs = debounceMs) => {
      if (unmountedRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => runRef.current(), delayMs);
    },
    [debounceMs],
  );

  const refreshNow = useCallback(() => {
    scheduleRefresh(0);
  }, [scheduleRefresh]);

  return { refreshNow, scheduleRefresh };
}

function useSafetyRefreshInterval(
  refreshNow: () => void,
  intervalMs: number,
  deps: DependencyList,
) {
  useEffect(() => {
    refreshNow();
    const handle = setInterval(refreshNow, intervalMs);
    return () => clearInterval(handle);
    // The caller owns the lifecycle dependencies that should restart the
    // safety interval; `refreshNow` is stable across refresh callback changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function useRightPanelInvalidations(
  repoPath: string | null,
  onGitMetadataChanged?: () => void,
): RightPanelInvalidationKeys {
  const [keys, setKeys] = useState<RightPanelInvalidationKeys>({
    commits: 0,
    staged: 0,
  });

  useEffect(() => {
    void api.fsWatchSetRoot(repoPath).catch((e) => {
      console.debug("[RightPanel] fs_watch_set_root failed", e);
    });
    return () => {
      void api.fsWatchSetRoot(null).catch(() => {});
    };
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let pending: RightPanelInvalidationKeys = { commits: 0, staged: 0 };

    const flush = () => {
      flushTimer = null;
      const next = pending;
      pending = { commits: 0, staged: 0 };
      if (next.commits === 0 && next.staged === 0) return;
      setKeys((prev) => ({
        commits: prev.commits + next.commits,
        staged: prev.staged + next.staged,
      }));
    };

    void listen<FsChangePayload>(FS_CHANGED_EVENT, (event) => {
      if (cancelled) return;
      if (event.payload.dotgit_changed) {
        onGitMetadataChanged?.();
      }
      const invalidation = classifyRightPanelFsChange(
        repoPath,
        event.payload.paths,
      );
      if (invalidation.commits) pending.commits = 1;
      if (invalidation.staged) pending.staged = 1;
      if (!flushTimer && (pending.commits || pending.staged)) {
        flushTimer = setTimeout(flush, RIGHT_PANEL_REFRESH_DEBOUNCE_MS);
      }
    }).then((cancel) => {
      if (cancelled) {
        cancel();
        return;
      }
      unlisten = cancel;
    });

    return () => {
      cancelled = true;
      if (flushTimer) clearTimeout(flushTimer);
      if (unlisten) unlisten();
    };
  }, [onGitMetadataChanged, repoPath]);

  return keys;
}

/**
 * Strip a trailing slash so a backend-resolved repo path byte-matches the
 * slash-free paths Acorn records (project `repo_path`, session
 * `worktree_path`). `pty_repo_root` returns libgit2's `Repository::workdir()`,
 * which always carries a trailing slash (e.g. `/repo/.acorn/worktrees/wt/`).
 * If that slashed form reaches the right panel as `repoPath`, it never matches
 * a retained repo path, so `rightPanelCache.canStore` silently drops File
 * Explorer expansion writes — collapsing every expanded folder on the next
 * remount (tab switch). Preserve a bare root `/`.
 */
function normalizeRepoPath(path: string | null): string | null {
  if (path === null) return null;
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Resolve the live working directory of a session's PTY tree to the git
 * repo it sits inside, with the recorded `fallback` path as the immediate
 * (and final) fallback. Backed by `pty_repo_root`, which does the
 * `Repository::discover` walk server-side and returns `null` when the cwd
 * lies outside any git repo — so a user `cd`-ing into e.g. a Cargo registry
 * dir doesn't push a non-repo path into git commands and produce a
 * persistent "could not find git repository from '<…>'" banner. Re-resolves
 * lazily on session change, tab change, and window refocus; deliberately
 * not polled on a timer.
 */
function useLiveRepoPath(
  sessionId: string | null,
  fallbackPath: string | null,
): string | null {
  const [liveRepo, setLiveRepo] = useState<LiveRepoCache | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setLiveRepo(null);
      return;
    }
    let cancelled = false;
    api
      .ptyRepoRoot(sessionId)
      .then((repoPath) => {
        if (!cancelled) {
          setLiveRepo({
            sessionId,
            fallbackPath,
            repoPath: normalizeRepoPath(repoPath),
          });
        }
      })
      .catch((err: unknown) => {
        // Don't blow away a previously resolved path on a transient backend
        // error — the static fallback will kick in only if liveRepo was never
        // set in the first place. Logging stays at debug to avoid noise.
        console.debug("[RightPanel] ptyRepoRoot resolve failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, fallbackPath, tick]);

  // Refocusing the app is a strong signal the user is about to look at the
  // panel — re-resolve so a `claude --worktree` that happened while we were
  // backgrounded is reflected immediately.
  useEffect(() => {
    const onFocus = () => setTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (
    liveRepo?.sessionId === sessionId &&
    liveRepo.fallbackPath === fallbackPath
  ) {
    return liveRepo.repoPath ?? fallbackPath;
  }
  return fallbackPath;
}

function useSessionTodos(
  sessionId: string | null,
  cwd: string | null,
): SessionTodosState {
  const [state, setState] = useState<SessionTodosState>({
    todos: [],
    loaded: false,
    error: null,
  });
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId || !cwd) return;
    const generation = generationRef.current;
    try {
      const result = await api.readSessionTodos(sessionId, cwd);
      if (generationRef.current !== generation) return;
      // Defensive: the Rust contract returns Vec<TodoItem> (→ []), but a
      // serialization edge or future error path that produces null would
      // crash on the `todos.length` access elsewhere in this panel.
      setState({
        todos: Array.isArray(result) ? result : [],
        loaded: true,
        error: null,
      });
    } catch (e) {
      if (generationRef.current !== generation) return;
      setState((prev) => ({ ...prev, loaded: true, error: String(e) }));
    }
  }, [sessionId, cwd]);

  const { refreshNow, scheduleRefresh } = useRefreshScheduler(refresh);

  useEffect(() => {
    generationRef.current += 1;
    if (!sessionId || !cwd) {
      setState({ todos: [], loaded: true, error: null });
      return;
    }
    setState({ todos: [], loaded: false, error: null });
    refreshNow();
    const handle = setInterval(refreshNow, TODOS_SAFETY_INTERVAL_MS);
    return () => {
      generationRef.current += 1;
      clearInterval(handle);
    };
  }, [sessionId, cwd, refreshNow]);

  useEffect(() => {
    if (!sessionId || !cwd) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen(`pty:output:${sessionId}`, () => {
      if (!cancelled) scheduleRefresh(TODOS_ACTIVITY_DEBOUNCE_MS);
    }).then((cancel) => {
      if (cancelled) {
        cancel();
        return;
      }
      unlisten = cancel;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [sessionId, cwd, scheduleRefresh]);

  return state;
}

function TodosTab({ todos }: { todos: TodoItem[] }) {
  const t = useTranslation();
  const counts = countByStatus(todos);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2 text-[10px] uppercase tracking-wide text-fg-muted">
        <span className="mr-3">
          {rtf(t, "rightPanel.todos.doneCount", {
            completed: counts.completed,
            total: todos.length,
          })}
        </span>
        {counts.in_progress > 0 ? (
          <span className="text-accent">
            {rtf(t, "rightPanel.todos.inProgressCount", {
              count: counts.in_progress,
            })}
          </span>
        ) : null}
      </div>
      <ListBox className="acorn-no-scrollbar flex-1 overflow-y-auto">
        {todos.map((t, i) => (
          <TodoRow key={`${i}-${t.content}`} todo={t} />
        ))}
      </ListBox>
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const status = todo.status as string;
  const display =
    status === "in_progress" && todo.activeForm
      ? todo.activeForm
      : todo.content;
  return (
    <ListRow
      className="flex items-start gap-2"
      selected={status === "in_progress"}
      selectedClassName="bg-bg-elevated/40"
    >
      <span className="mt-0.5 shrink-0">{statusGlyph(status)}</span>
      <span
        className={cn(
          "min-w-0 flex-1",
          status === "completed" && "text-fg-muted line-through opacity-70",
          status === "in_progress" && "text-fg",
          status === "pending" && "text-fg",
        )}
      >
        {display}
      </span>
    </ListRow>
  );
}

function statusGlyph(status: string): ReactNodeLike {
  if (status === "completed") {
    return <span className="text-accent">✓</span>;
  }
  if (status === "in_progress") {
    return <span className="text-accent animate-pulse">▸</span>;
  }
  return <span className="text-fg-muted">○</span>;
}

type ReactNodeLike = React.ReactNode;

function countByStatus(todos: TodoItem[]) {
  let pending = 0;
  let in_progress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === "completed") completed++;
    else if (t.status === "in_progress") in_progress++;
    else pending++;
  }
  return { pending, in_progress, completed };
}

const ACTIVITY_KIND_KEYS: Record<
  SessionNotificationKind,
  RightPanelTranslationKey
> = {
  needs_input: "rightPanel.activity.kind.needsInput",
  failed: "rightPanel.activity.kind.failed",
  completed: "rightPanel.activity.kind.completed",
  became_idle: "rightPanel.activity.kind.becameIdle",
};

function ActivityTab() {
  const t = useTranslation();
  const notifications = useAppStore((s) => s.sessionNotifications);
  const markAllRead = useAppStore((s) => s.markAllSessionNotificationsRead);
  const clearRead = useAppStore((s) => s.clearReadSessionNotifications);
  const unreadCount = notifications.filter((notification) => !notification.readAt)
    .length;
  const readCount = notifications.length - unreadCount;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0 text-[10px] uppercase tracking-wide text-fg-muted">
          <span className="mr-3">
            {rtf(t, "rightPanel.activity.unreadCount", {
              count: unreadCount,
            })}
          </span>
          {readCount > 0 ? (
            <span>
              {rtf(t, "rightPanel.activity.readCount", { count: readCount })}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip
            label={rt(t, "rightPanel.activity.actions.markAllRead")}
            side="top"
          >
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="rounded border border-border px-2 py-1 text-[10px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              {rt(t, "rightPanel.activity.actions.markAllRead")}
            </button>
          </Tooltip>
          <Tooltip
            label={rt(t, "rightPanel.activity.actions.clearRead")}
            side="top"
          >
            <button
              type="button"
              onClick={clearRead}
              disabled={readCount === 0}
              className="rounded border border-border px-2 py-1 text-[10px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              {rt(t, "rightPanel.activity.actions.clearRead")}
            </button>
          </Tooltip>
        </div>
      </div>
      {notifications.length === 0 ? (
        <Empty msg={rt(t, "rightPanel.activity.empty")} />
      ) : (
        <ListBox className="acorn-no-scrollbar flex-1 overflow-y-auto">
          {notifications.map((notification) => (
            <ActivityRow key={notification.id} notification={notification} />
          ))}
        </ListBox>
      )}
    </div>
  );
}

function ActivityRow({
  notification,
}: {
  notification: SessionNotification;
}) {
  const t = useTranslation();
  const selectSession = useAppStore((s) => s.selectSession);
  const markRead = useAppStore((s) => s.markSessionNotificationRead);
  const dismiss = useAppStore((s) => s.dismissSessionNotification);
  const unread = !notification.readAt;

  const openSession = () => {
    markRead(notification.id);
    selectSession(notification.sessionId);
  };

  return (
    <ListRow
      interactive
      className="group flex items-start gap-2"
      selected={unread}
      selectedClassName="bg-warning/5"
    >
      <button
        type="button"
        onClick={openSession}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <span
          className={cn(
            "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
            activityDotClass(notification.kind),
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "truncate font-mono text-[11px]",
                unread ? "text-fg" : "text-fg-muted",
              )}
            >
              {rt(t, ACTIVITY_KIND_KEYS[notification.kind])}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-fg-muted/70">
              {formatActivityTime(notification.createdAt)}
            </span>
          </span>
          <span className="block truncate text-[11px] text-fg">
            {rtf(t, "rightPanel.activity.itemTitle", {
              project: notification.projectName,
              session: notification.sessionName,
            })}
          </span>
          <span className="block truncate text-[10px] text-fg-muted">
            {notification.repoPath}
          </span>
        </span>
      </button>
      <Tooltip label={rt(t, "rightPanel.activity.actions.dismiss")} side="top">
        <button
          type="button"
          onClick={() => dismiss(notification.id)}
          className="rounded p-1 text-fg-muted opacity-0 transition hover:bg-bg-sidebar hover:text-fg group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      </Tooltip>
    </ListRow>
  );
}

function activityDotClass(kind: SessionNotificationKind): string {
  if (kind === "failed") return "bg-danger";
  if (kind === "completed") return "bg-accent";
  return "bg-warning";
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ALL_AGENT_HISTORY_PROVIDERS = "__all__";
type AgentHistoryProviderFilter =
  | typeof ALL_AGENT_HISTORY_PROVIDERS
  | AgentHistoryProvider;

function isAgentProvider(
  provider: AgentHistoryProvider,
): provider is SessionAgentProvider {
  return (
    provider === "claude" ||
    provider === "codex" ||
    provider === "antigravity"
  );
}

function AgentHistoryTab({
  scope,
  repoPath,
  sessionHostRepoPath,
  sessionHostProjectScoped,
}: {
  scope: "project" | "unscoped";
  repoPath: string | null;
  sessionHostRepoPath: string | null;
  sessionHostProjectScoped: boolean;
}) {
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const createSession = useAppStore((s) => s.createSession);
  const adoptSessionWorktree = useAppStore((s) => s.adoptSessionWorktree);
  const setPendingTerminalInput = useAppStore((s) => s.setPendingTerminalInput);
  const showAgentProviderIcons = useSettings(
    (s) => s.settings.sessionDisplay.icons.agentProvider,
  );
  const historyLimit = 100;
  // Hydrate from the module-level cache so re-opening a project or the
  // unscoped Chats history shows its list instantly.
  const [items, setItems] = useState<AgentHistoryItem[] | null>(() =>
    scope === "project" && repoPath
      ? rightPanelCache.getAgentHistory(repoPath)
      : scope === "unscoped"
        ? rightPanelCache.getUnscopedAgentHistory(historyLimit)
      : null,
  );
  const [providerFilter, setProviderFilter] =
    useState<AgentHistoryProviderFilter>(ALL_AGENT_HISTORY_PROVIDERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    item: AgentHistoryItem;
  } | null>(null);
  const [worktreeNotice, setWorktreeNotice] = useState<
    NonNullable<AgentHistoryItem["worktree"]> | null
  >(null);
  const [trashCandidate, setTrashCandidate] = useState<AgentHistoryItem | null>(
    null,
  );

  useDialogShortcuts(worktreeNotice !== null, {
    onCancel: () => setWorktreeNotice(null),
  });
  useDialogShortcuts(trashCandidate !== null, {
    onCancel: () => setTrashCandidate(null),
  });

  // Stale responses from a previous repoPath (or an earlier in-flight call)
  // must not overwrite newer results. Each fetch claims a token; only the
  // latest token is allowed to commit.
  const fetchTokenRef = useRef(0);

  const fetchHistory = useCallback(async (options: { force?: boolean } = {}) => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const result =
        scope === "unscoped"
          ? await rightPanelCache.fetchUnscopedAgentHistory(historyLimit, options)
          : repoPath
            ? await rightPanelCache.fetchAgentHistory(repoPath, options)
            : [];
      if (token !== fetchTokenRef.current) return;
      setItems(result);
    } catch (e) {
      if (token !== fetchTokenRef.current) return;
      setError(String(e));
    } finally {
      if (token === fetchTokenRef.current) setLoading(false);
    }
  }, [repoPath, scope]);

  useEffect(() => {
    void fetchHistory();
  }, [fetchHistory]);

  const historyItems = useMemo(() => {
    if (!items) return null;
    return [...items]
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, historyLimit);
  }, [items]);
  const visibleItems = useMemo(() => {
    if (!historyItems) return [];
    return providerFilter === ALL_AGENT_HISTORY_PROVIDERS
      ? historyItems
      : historyItems.filter((item) => item.provider === providerFilter);
  }, [historyItems, providerFilter]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function runSession(
    item: AgentHistoryItem,
    mode: "auto" | "repo" | "worktree" = "auto",
  ) {
    if (!isAgentProvider(item.provider)) return;
    const agentProvider = item.provider;
    if (!item.resume_command) return;
    setError(null);
    const shouldUseWorktree =
      mode !== "repo" && item.worktree !== null && item.worktree.exists;
    if (mode === "worktree" && !shouldUseWorktree) {
      setError(rt(t, "rightPanel.history.worktreeUnavailable"));
      return;
    }
    try {
      const targetRepoPath = sessionHostRepoPath ?? item.cwd;
      if (!targetRepoPath) {
        setError(rt(t, "rightPanel.history.createFailed"));
        return;
      }
      const created = await applySessionCreateRequest(
        createSession,
        buildSessionCreateRequest(
          { sessions, projects },
          {
            name: `${item.provider} ${rt(t, "rightPanel.history.resumeSessionName")}`,
            repoPath: targetRepoPath,
            agentProvider,
            projectScoped: sessionHostProjectScoped,
          },
        ),
      );
      if (!created) {
        const storeError = useAppStore.getState().consumeError();
        const message = storeError ?? rt(t, "rightPanel.history.createFailed");
        setError(message);
        showToast(`${t("toasts.session.createFailed")} ${message}`);
        return;
      }
      if (shouldUseWorktree && item.worktree) {
        try {
          await adoptSessionWorktree(created.id, item.worktree.path);
          const error = useAppStore.getState().consumeError();
          if (error) {
            setError(error);
            showToast(`${t("toasts.session.worktreeAdoptFailed")} ${error}`);
            return;
          }
        } catch (e) {
          const message = String(e);
          setError(message);
          showToast(`${t("toasts.session.worktreeAdoptFailed")} ${message}`);
          return;
        }
      }
      setPendingTerminalInput(created.id, item.resume_command, {
        agentProvider,
      });
      if (shouldUseWorktree && item.worktree) {
        setWorktreeNotice(item.worktree);
      }
    } catch (e) {
      const message = String(e);
      setError(message);
      showToast(`${t("toasts.session.createFailed")} ${message}`);
    }
  }

  async function moveTranscriptToTrash(item: AgentHistoryItem) {
    setError(null);
    try {
      await api.trashAgentHistoryTranscript(item);
      setItems((prev) => {
        if (!prev) return prev;
        const next = prev.filter(
          (candidate) =>
            candidate.provider !== item.provider ||
            candidate.id !== item.id ||
            candidate.transcript_path !== item.transcript_path,
        );
        if (scope === "project" && repoPath) {
          rightPanelCache.setAgentHistory(repoPath, next);
        } else if (scope === "unscoped") {
          rightPanelCache.setUnscopedAgentHistory(historyLimit, next);
        }
        return next;
      });
      setTrashCandidate(null);
    } catch (e) {
      const message = String(e);
      setTrashCandidate(null);
      setError(message);
      showToast(`${t("toasts.files.trashFailed")} ${message}`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Select
          value={providerFilter}
          onChange={(e) =>
            setProviderFilter(e.target.value as AgentHistoryProviderFilter)
          }
          aria-label={rt(t, "rightPanel.history.filterByAgent")}
          disabled={!historyItems || historyItems.length === 0}
          className="min-w-0 max-w-full flex-1 truncate"
        >
          <option value={ALL_AGENT_HISTORY_PROVIDERS}>
            {rt(t, "rightPanel.history.allAgents")}
          </option>
          <option value="codex">{rt(t, "rightPanel.history.codex")}</option>
          <option value="claude">{rt(t, "rightPanel.history.claude")}</option>
          <option value="antigravity">
            {rt(t, "rightPanel.history.antigravity")}
          </option>
        </Select>
        <RefreshButton
          onClick={() => void fetchHistory({ force: true })}
          loading={loading}
          size={12}
        />
      </div>
      <div className="acorn-no-scrollbar flex-1 overflow-x-hidden overflow-y-auto">
        {error ? (
          <div className="p-3 text-xs text-danger">{error}</div>
        ) : !historyItems ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={rt(t, "rightPanel.history.loading")}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <HistorySkeletonRow
                key={i}
                index={i}
                showAgentProviderIcons={showAgentProviderIcons}
              />
            ))}
          </div>
        ) : historyItems.length === 0 ? (
          <Empty msg={rt(t, "rightPanel.history.empty")} />
        ) : visibleItems.length === 0 ? (
          <Empty msg={rt(t, "rightPanel.history.emptyForFilter")} />
        ) : (
          <div className={listBoxClassName({ text: "none" })}>
            {visibleItems.map((item) => {
              const providerTone =
                item.provider === "codex"
                  ? "bg-[#3867ff]/15 text-[#5f7dff]"
                  : item.provider === "antigravity"
                    ? "bg-[#19a974]/15 text-[#22b47e]"
                  : "bg-[#de7356]/15 text-[#de7356]";
              return (
                <div
                  key={`${item.provider}:${item.id}:${item.transcript_path}`}
                  className={listRowClassName({
                    interactive: true,
                    className: "group cursor-default",
                  })}
                  onDoubleClick={() => void runSession(item)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, item });
                  }}
                >
                  <div className="flex items-start gap-2">
                    {showAgentProviderIcons ? (
                      <span
                        className={cn(
                          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded",
                          providerTone,
                        )}
                      >
                        <Tooltip label={item.provider} side="right">
                          <AgentProviderIcon
                            provider={item.provider}
                            className="size-3"
                          />
                        </Tooltip>
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                          providerTone,
                        )}
                      >
                        {item.provider}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-fg">
                        {item.title}
                      </div>
                      {item.preview ? (
                        <div className="mt-1 max-h-8 overflow-hidden text-[11px] leading-4 text-fg-muted">
                          {item.preview}
                        </div>
                      ) : null}
                      {item.worktree ? (
                        <Tooltip
                          label={
                            item.worktree.exists
                              ? item.worktree.path
                              : `${item.worktree.path} (${rt(t, "rightPanel.history.worktreeMissing")})`
                          }
                          side="bottom"
                        >
                          <div
                            className={cn(
                              "mt-1 flex min-w-0 items-center gap-1 text-[10.5px] font-mono",
                              item.worktree.exists
                                ? "text-accent"
                                : "text-fg-muted",
                            )}
                          >
                            <GitBranch size={11} className="shrink-0" />
                            <span
                              className={cn(
                                "truncate",
                                item.worktree.exists ? null : "line-through",
                              )}
                            >
                              {item.worktree.name}
                            </span>
                          </div>
                        </Tooltip>
                      ) : null}
                      {scope === "unscoped" && item.cwd ? (
                        <Tooltip label={item.cwd} side="bottom">
                          <div className="mt-1 flex min-w-0 items-center gap-1 text-[10.5px] font-mono text-fg-muted">
                            <FolderTree size={11} className="shrink-0" />
                            <span className="truncate">{item.cwd}</span>
                          </div>
                        </Tooltip>
                      ) : null}
                      <div className="mt-1 flex min-w-0 items-center gap-2 text-[10.5px] text-fg-muted/80">
                        <Tooltip
                          label={absoluteTime(item.updated_at)}
                          side="bottom"
                        >
                          <span className="shrink-0 font-mono">
                            {relativeTime(item.updated_at, t)}
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
        items={
          menu
            ? ([
                {
                  label: rt(t, "rightPanel.history.runSession"),
                  icon: <Play size={12} />,
                  disabled: !menu.item.resume_command,
                  onClick: () => void runSession(menu.item, "repo"),
                },
                {
                  label: rt(t, "rightPanel.history.runInWorktree"),
                  icon: <GitBranch size={12} />,
                  disabled:
                    !menu.item.resume_command || !menu.item.worktree?.exists,
                  onClick: () => void runSession(menu.item, "worktree"),
                },
                { type: "separator" },
                {
                  label: rt(t, "rightPanel.history.copyResume"),
                  icon: <Copy size={12} />,
                  disabled: !menu.item.resume_command,
                  onClick: () => void copy(menu.item.resume_command ?? ""),
                },
                {
                  label: rt(t, "rightPanel.history.copyWorktreePath"),
                  icon: <GitBranch size={12} />,
                  disabled: !menu.item.worktree,
                  onClick: () => void copy(menu.item.worktree?.path ?? ""),
                },
                { type: "separator" },
                {
                  label: rt(t, "rightPanel.history.moveTranscriptToTrash"),
                  icon: <Trash2 size={12} />,
                  onClick: () => setTrashCandidate(menu.item),
                },
              ] satisfies ContextMenuItem[])
            : []
        }
      />
      <Modal
        open={worktreeNotice !== null}
        onClose={() => setWorktreeNotice(null)}
        variant="dialog"
        size="md"
        ariaLabel={rt(t, "rightPanel.history.worktreeRunTitle")}
      >
        <ModalHeader
          title={rt(t, "rightPanel.history.worktreeRunTitle")}
          icon={<GitBranch size={15} className="text-accent" />}
          variant="dialog"
          onClose={() => setWorktreeNotice(null)}
        />
        <div className="space-y-3 px-4 py-4 text-sm text-fg">
          <p className="text-sm leading-5 text-fg-muted">
            {rtf(t, "rightPanel.history.worktreeRunBody", {
              name: worktreeNotice?.name ?? "",
            })}
          </p>
          {worktreeNotice ? (
            <div className="rounded border border-border bg-bg-sidebar px-3 py-2 font-mono text-[11px] text-fg-muted">
              {worktreeNotice.path}
            </div>
          ) : null}
          <div className="flex justify-end">
            <button
              type="button"
              className="rounded border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              onClick={() => setWorktreeNotice(null)}
            >
              {rt(t, "rightPanel.history.worktreeRunConfirm")}
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={trashCandidate !== null}
        onClose={() => setTrashCandidate(null)}
        variant="dialog"
        size="md"
        ariaLabel={rt(t, "rightPanel.history.trashTranscriptTitle")}
      >
        <ModalHeader
          title={rt(t, "rightPanel.history.trashTranscriptTitle")}
          icon={<Trash2 size={15} className="text-danger" />}
          variant="dialog"
          onClose={() => setTrashCandidate(null)}
        />
        <div className="space-y-3 px-4 py-4 text-sm text-fg">
          <p className="text-sm leading-5 text-fg-muted">
            {rt(t, "rightPanel.history.trashTranscriptBody")}
          </p>
          {trashCandidate ? (
            <div className="rounded border border-border bg-bg-sidebar px-3 py-2 font-mono text-[11px] text-fg-muted">
              {trashCandidate.transcript_path}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg transition hover:bg-bg-sidebar"
              onClick={() => setTrashCandidate(null)}
            >
              {rt(t, "rightPanel.history.trashTranscriptCancel")}
            </button>
            <button
              type="button"
              className="rounded border border-danger/50 bg-danger/10 px-3 py-1.5 text-xs text-danger transition hover:bg-danger/15"
              onClick={() =>
                trashCandidate
                  ? void moveTranscriptToTrash(trashCandidate)
                  : undefined
              }
            >
              {rt(t, "rightPanel.history.trashTranscriptConfirm")}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function CommitsTab({
  repoPath,
  invalidateKey,
  onExpand,
}: {
  repoPath: string;
  invalidateKey: number;
  onExpand: SetExpandedDiff;
}) {
  const t = useTranslation();
  const cachedCommits = rightPanelCache.getCommits(repoPath);
  const [commits, setCommits] = useState<CommitInfo[]>(
    () => cachedCommits?.commits ?? [],
  );
  const [commitLogins, setCommitLogins] = useState<
    Record<string, string | null>
  >({});
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(() => cachedCommits?.hasMore ?? true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Tracks the very first fetch for the current `repoPath` so we can show
  // skeleton rows instead of a blank panel on project switch. Cache hit
  // skips the skeleton entirely.
  const [loadingFirst, setLoadingFirst] = useState(!cachedCommits);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    commit: CommitInfo;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const generationRef = useRef(0);
  const diffGenerationRef = useRef(0);
  const expandRequestRef = useRef(0);
  // Hydrated cache counts as a successful top-of-history load so a failed
  // background refresh doesn't replace good data with an error banner.
  const loadedTopRef = useRef(!!cachedCommits);

  const refreshFirstPage = useCallback(async () => {
    const generation = generationRef.current;
    try {
      const page = await api.listCommits(repoPath, 0, COMMITS_PAGE_SIZE);
      if (generationRef.current !== generation) return;
      loadedTopRef.current = true;
      setCommits((prev) => {
        if (prev.length === 0) {
          return page;
        }
        // The fetched page is authoritative for the top of history. Splice it
        // over the equivalent prefix of `prev` so abandoned commits (e.g.
        // after `git reset` / amend) get evicted instead of lingering in the
        // middle of the list.
        return [...page, ...prev.slice(page.length)];
      });
      setHasMore(page.length === COMMITS_PAGE_SIZE);
      setError(null);
    } catch (e) {
      if (generationRef.current !== generation) return;
      if (!loadedTopRef.current) setError(String(e));
    } finally {
      if (generationRef.current === generation) setLoadingFirst(false);
    }
  }, [repoPath]);

  const { refreshNow, scheduleRefresh } = useRefreshScheduler(refreshFirstPage);

  // Parent mounts CommitsTab with key={repoPath}, so this effect only fires
  // on initial mount — useState initializers already seeded the right state
  // for that mount (cache hit or empty). We only need the cleanup bump so
  // any in-flight refresh from the previous instance bails on unmount.
  useEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
      diffGenerationRef.current += 1;
      expandRequestRef.current += 1;
    };
  }, [repoPath]);

  useSafetyRefreshInterval(refreshNow, COMMITS_SAFETY_INTERVAL_MS, [
    repoPath,
    refreshNow,
  ]);

  useEffect(() => {
    if (invalidateKey > 0) scheduleRefresh();
  }, [invalidateKey, scheduleRefresh]);

  // Mirror local list state into the module-level cache so the next mount of
  // CommitsTab for this repo hydrates synchronously. Skip the very first
  // pre-fetch state (empty + loadingFirst) so we don't pollute the cache with
  // a blank entry that suppresses the skeleton on a true first visit.
  useEffect(() => {
    if (loadingFirst) return;
    rightPanelCache.setCommits(repoPath, { commits, hasMore });
  }, [repoPath, commits, hasMore, loadingFirst]);

  // Resolve commit author logins via GitHub GraphQL for any sha we don't
  // already have. The backend caches by (slug, sha) so re-fetches across
  // pagination / project re-entry are free.
  useEffect(() => {
    if (commits.length === 0) return;
    const missing = commits
      .map((c) => c.sha)
      .filter((sha) => !(sha in commitLogins));
    if (missing.length === 0) return;
    let cancelled = false;
    // Mark every attempted sha in `commitLogins` (resolved or not) so this
    // effect doesn't re-fire forever for unknown authors. Without this, the
    // `missing` filter keeps matching the same shas — backend returns only
    // the subset with a known login, and `setCommitLogins` always produces
    // a fresh object reference, which retriggers the effect via the
    // `commitLogins` dep.
    const settle = (map: Record<string, string | null>) => {
      setCommitLogins((prev) => {
        const next: Record<string, string | null> = { ...prev };
        for (const sha of missing) {
          if (!(sha in next)) next[sha] = null;
        }
        for (const [sha, login] of Object.entries(map)) {
          next[sha] = login;
        }
        return next;
      });
    };
    api
      .resolveCommitLogins(repoPath, missing)
      .then((map) => {
        if (cancelled) return;
        settle(map);
      })
      .catch(() => {
        // No gh access / network failure — record null entries so we don't
        // retry the same shas every render.
        if (cancelled) return;
        settle({});
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, commits, commitLogins]);

  const loadMore = useCallback(() => {
    setLoadingMore((cur) => {
      if (cur) return cur;
      const offset = commits.length;
      api
        .listCommits(repoPath, offset, COMMITS_PAGE_SIZE)
        .then((page) => {
          setCommits((prev) => [...prev, ...page]);
          setHasMore(page.length === COMMITS_PAGE_SIZE);
          setLoadingMore(false);
        })
        .catch((e) => {
          setError(String(e));
          setLoadingMore(false);
        });
      return true;
    });
  }, [repoPath, commits.length]);

  function loadCommitDiff(sha: string): Promise<DiffPayload> {
    return rightPanelCache.fetchCommitDiff(repoPath, sha);
  }

  function selectCommit(sha: string) {
    const token = ++diffGenerationRef.current;
    setSelected(sha);
    setDiff(null);
    loadCommitDiff(sha)
      .then((payload) => {
        if (diffGenerationRef.current !== token) return;
        setDiff(payload);
      })
      .catch((e) => {
        if (diffGenerationRef.current !== token) return;
        setError(String(e));
      });
  }

  function buildSubtitle(c: CommitInfo): ReactNode {
    const login = commitLogins[c.sha] ?? loginFromEmail(c.author_email);
    return (
      <span className="flex items-center gap-2 text-[11px] text-fg-muted">
        <span className="flex items-center gap-1.5">
          <AuthorAvatar login={login} size={16} />
          <span>{c.author}</span>
        </span>
        <span className="opacity-50">·</span>
        <Tooltip label={absoluteTime(c.timestamp)} side="bottom">
          <span className="font-mono">{relativeTime(c.timestamp, t)}</span>
        </Tooltip>
      </span>
    );
  }

  function buildHeaderActions(c: CommitInfo, webUrl: string | null): ReactNode {
    return (
      <>
        <Tooltip label={rt(t, "rightPanel.tooltips.copySha")} side="bottom">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(c.sha)}
            className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            {c.short_sha}
          </button>
        </Tooltip>
        {webUrl ? (
          <Tooltip label={rt(t, "rightPanel.tooltips.openOnGitHub")} side="bottom">
            <button
              type="button"
              onClick={() => void openUrl(webUrl)}
              className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
            >
              <ExternalLink size={12} />
            </button>
          </Tooltip>
        ) : null}
      </>
    );
  }

  async function expandCommit(c: CommitInfo) {
    const requestId = ++expandRequestRef.current;
    const cachedPayload = rightPanelCache.getCommitDiff(repoPath, c.sha);
    onExpand({
      payload: cachedPayload,
      title: c.summary,
      subtitle: buildSubtitle(c),
      headerActions: buildHeaderActions(c, null),
      body: c.body,
      loading: cachedPayload === null,
      error: null,
      requestId,
    });
    try {
      const [payload, webUrl] = await Promise.all([
        loadCommitDiff(c.sha),
        api.commitWebUrl(repoPath, c.sha).catch(() => null),
      ]);
      if (expandRequestRef.current !== requestId) return;
      onExpand((current) => {
        if (current?.requestId !== requestId) return current;
        return {
          ...current,
          payload,
          headerActions: buildHeaderActions(c, webUrl),
          loading: false,
          error: null,
        };
      });
    } catch (e) {
      if (expandRequestRef.current !== requestId) return;
      const message = String(e);
      onExpand((current) => {
        if (current?.requestId !== requestId) return current;
        return {
          ...current,
          loading: false,
          error: message,
        };
      });
    }
  }

  async function openOnGitHub(c: CommitInfo) {
    try {
      const url = await api.commitWebUrl(repoPath, c.sha);
      if (!url) {
        setError(rt(t, "rightPanel.errors.notGitHubRemote"));
        return;
      }
      await openUrl(url);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  const rowCount = commits.length + (hasMore ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_ROW_HEIGHT,
    paddingStart: COMMIT_LIST_PADDING_Y,
    paddingEnd: COMMIT_LIST_PADDING_Y,
    overscan: 8,
  });

  const items = virtualizer.getVirtualItems();
  const lastItem = items[items.length - 1];
  useEffect(() => {
    if (!lastItem) return;
    if (hasMore && !loadingMore && lastItem.index >= commits.length - 1) {
      loadMore();
    }
  }, [lastItem, hasMore, loadingMore, commits.length, loadMore]);

  if (error) return <div className="p-3 text-xs text-danger">{error}</div>;
  if (loadingFirst && commits.length === 0) {
    return (
      <PanelGroup direction="vertical" autoSaveId="acorn:layout:commits">
        <Panel id="commits-list" order={1} defaultSize={50} minSize={20}>
          <div className="acorn-no-scrollbar h-full overflow-y-auto">
            <SkeletonList count={8} />
          </div>
        </Panel>
        <ResizeHandle direction="vertical" gap />
        <Panel id="commits-diff" order={2} defaultSize={50} minSize={15}>
          <div className="acorn-no-scrollbar h-full overflow-y-auto p-3">
            <SkeletonBlock className="h-3 w-1/2 bg-fg-muted/15" />
            <SkeletonBlock className="mt-2 h-3 w-3/4" />
            <SkeletonBlock className="mt-2 h-3 w-2/3" />
          </div>
        </Panel>
      </PanelGroup>
    );
  }

  return (
    <PanelGroup direction="vertical" autoSaveId="acorn:layout:commits">
      <Panel id="commits-list" order={1} defaultSize={50} minSize={20}>
        <div
          ref={scrollRef}
          className="acorn-no-scrollbar h-full overflow-x-hidden overflow-y-auto"
        >
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((vi) => {
            const isSentinel = vi.index >= commits.length;
            const c = commits[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="px-1"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {isSentinel ? (
                  <div className="px-3 py-3 text-center text-[10px] text-fg-muted">
                    {loadingMore ? rt(t, "rightPanel.loading.moreLower") : "—"}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => selectCommit(c.sha)}
                    onDoubleClick={() => {
                      void expandCommit(c);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, commit: c });
                    }}
                    className={listRowClassName({
                      interactive: true,
                      selected: selected === c.sha,
                      surface: "subtle",
                      className:
                        "flex w-full flex-col items-start gap-0.5 text-left text-xs",
                    })}
                    style={{ height: COMMIT_ROW_HEIGHT }}
                  >
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <Tooltip
                        label={
                          c.pushed
                            ? rt(t, "rightPanel.commits.pushed")
                            : rt(t, "rightPanel.commits.notPushed")
                        }
                        side="top"
                      >
                        <span
                          className={cn(
                            "shrink-0 font-mono",
                            c.pushed ? "text-accent" : "text-fg-muted",
                          )}
                        >
                          {c.short_sha}
                        </span>
                      </Tooltip>
                      <Tooltip label={c.summary} side="top" multiline className="flex! min-w-0 flex-1">
                        <span className="min-w-0 flex-1 truncate text-fg">{c.summary}</span>
                      </Tooltip>
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-2 text-[11px] text-fg-muted">
                      <span className="flex min-w-0 shrink items-center gap-1.5">
                        <AuthorAvatar
                          login={
                            commitLogins[c.sha] ?? loginFromEmail(c.author_email)
                          }
                          size={14}
                        />
                        <span className="truncate">{c.author}</span>
                      </span>
                      <span className="opacity-50">·</span>
                      <Tooltip label={absoluteTime(c.timestamp)} side="top">
                        <span className="font-mono">
                          {relativeTime(c.timestamp, t)}
                        </span>
                      </Tooltip>
                    </span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
        </div>
      </Panel>
      <ResizeHandle direction="vertical" gap />
      <Panel id="commits-diff" order={2} defaultSize={50} minSize={15}>
        <div className="acorn-no-scrollbar h-full overflow-y-auto">
          {selected && diff ? (
            <DiffView
              payload={diff}
              onExpand={() => {
                const c = commits.find((x) => x.sha === selected);
                if (c) {
                  void expandCommit(c);
                } else {
                  onExpand({
                    payload: diff,
                    title: selected.slice(0, 12),
                    subtitle: selected.slice(0, 7),
                  });
                }
              }}
            />
          ) : selected ? (
            <Empty msg={rt(t, "rightPanel.loading.diffLower")} />
          ) : (
            <Empty msg={rt(t, "rightPanel.commits.selectToSeeDiff")} />
          )}
        </div>
      </Panel>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={
          menu
            ? ([
                {
                  label: rt(t, "rightPanel.menu.expandDiff"),
                  icon: <Maximize2 size={12} />,
                  onClick: () => {
                    void expandCommit(menu.commit);
                  },
                },
                {
                  label: rt(t, "rightPanel.menu.viewOnGitHub"),
                  icon: <Globe size={12} />,
                  onClick: () => {
                    void openOnGitHub(menu.commit);
                  },
                },
                { type: "separator" },
                {
                  label: rtf(t, "rightPanel.menu.copyShaWithValue", {
                    sha: menu.commit.short_sha,
                  }),
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyToClipboard(menu.commit.sha);
                  },
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
    </PanelGroup>
  );
}

function relativeTime(unixSeconds: number, t: Translator): string {
  const diffSec = Math.round(Date.now() / 1000) - unixSeconds;
  if (diffSec < 60) {
    return rtf(t, "rightPanel.time.secondsAgo", { count: diffSec });
  }
  const min = Math.round(diffSec / 60);
  if (min < 60) return rtf(t, "rightPanel.time.minutesAgo", { count: min });
  const hr = Math.round(diffSec / 3600);
  if (hr < 24) return rtf(t, "rightPanel.time.hoursAgo", { count: hr });
  const day = Math.round(diffSec / 86400);
  if (day < 30) return rtf(t, "rightPanel.time.daysAgo", { count: day });
  const mo = Math.round(diffSec / (86400 * 30));
  if (mo < 12) return rtf(t, "rightPanel.time.monthsAgo", { count: mo });
  const yr = Math.round(diffSec / (86400 * 365));
  return rtf(t, "rightPanel.time.yearsAgo", { count: yr });
}

function absoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function StagedTab({
  repoPath,
  invalidateKey,
  onExpand,
}: {
  repoPath: string;
  invalidateKey: number;
  onExpand: SetExpandedDiff;
}) {
  const t = useTranslation();
  const openCodeViewerTab = useAppStore((s) => s.openCodeViewerTab);
  const cachedStaged = rightPanelCache.getStaged(repoPath);
  const initialSelectedPath =
    cachedStaged?.selectedPath &&
    cachedStaged.files.some((file) => file.path === cachedStaged.selectedPath)
      ? cachedStaged.selectedPath
      : (cachedStaged?.files[0]?.path ?? null);
  const [files, setFiles] = useState<StagedFile[]>(
    () => cachedStaged?.files ?? [],
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => initialSelectedPath,
  );
  const [diffByPath, setDiffByPath] = useState<Record<string, DiffPayload>>(
    () => cachedStaged?.diffByPath ?? {},
  );
  const [listError, setListError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingFirst, setLoadingFirst] = useState(!cachedStaged);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: StagedFile;
  } | null>(null);
  const generationRef = useRef(0);
  const diffGenerationRef = useRef(0);
  const diffByPathRef = useRef(diffByPath);

  useEffect(() => {
    diffByPathRef.current = diffByPath;
  }, [diffByPath]);

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedPath) ?? null,
    [files, selectedPath],
  );
  const selectedDiff = selectedPath ? (diffByPath[selectedPath] ?? null) : null;

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    try {
      const f = await api.listStaged(repoPath);
      if (generationRef.current !== generation) return;
      const nextPaths = new Set(f.map((file) => file.path));
      setFiles(f);
      setSelectedPath((prev) =>
        prev && nextPaths.has(prev) ? prev : (f[0]?.path ?? null),
      );
      setDiffByPath((prev) => {
        let changed = false;
        const next: Record<string, DiffPayload> = {};
        for (const [path, payload] of Object.entries(prev)) {
          if (nextPaths.has(path)) {
            next[path] = payload;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setListError(null);
      setDiffRefreshKey((key) => key + 1);
    } catch (e) {
      if (generationRef.current !== generation) return;
      setListError(String(e));
    } finally {
      if (generationRef.current === generation) setLoadingFirst(false);
    }
  }, [repoPath]);

  const { refreshNow, scheduleRefresh } = useRefreshScheduler(refresh);

  // Same shape as CommitsTab: key={repoPath} on the parent means this only
  // fires on initial mount, so useState initializers handle the hydration.
  // Cleanup bump still cancels any in-flight refresh on unmount.
  useEffect(() => {
    generationRef.current += 1;
    return () => {
      generationRef.current += 1;
    };
  }, [repoPath]);

  useSafetyRefreshInterval(refreshNow, STAGED_SAFETY_INTERVAL_MS, [
    repoPath,
    refreshNow,
  ]);

  useEffect(() => {
    if (invalidateKey > 0) scheduleRefresh();
  }, [invalidateKey, scheduleRefresh]);

  useEffect(() => {
    if (!selectedPath) {
      setLoadingDiff(false);
      setDiffError(null);
      return;
    }
    const token = ++diffGenerationRef.current;
    const hasCachedDiff = Boolean(diffByPathRef.current[selectedPath]);
    setLoadingDiff(!hasCachedDiff);
    setDiffError(null);
    void api
      .stagedFileDiff(repoPath, selectedPath)
      .then((payload) => {
        if (diffGenerationRef.current !== token) return;
        setDiffByPath((prev) => ({ ...prev, [selectedPath]: payload }));
      })
      .catch((e) => {
        if (diffGenerationRef.current !== token) return;
        setDiffError(String(e));
      })
      .finally(() => {
        if (diffGenerationRef.current === token) setLoadingDiff(false);
      });
    return () => {
      diffGenerationRef.current += 1;
    };
  }, [repoPath, selectedPath, diffRefreshKey]);

  // Mirror to module cache so the next mount for this repo hydrates instantly.
  useEffect(() => {
    if (loadingFirst) return;
    rightPanelCache.setStaged(repoPath, { files, selectedPath, diffByPath });
  }, [repoPath, files, selectedPath, diffByPath, loadingFirst]);

  function isDeleted(file: StagedFile): boolean {
    return file.status.toLowerCase().includes("delete");
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setListError(String(e));
    }
  }

  async function openInEditor(file: StagedFile) {
    if (isDeleted(file)) {
      setListError(rt(t, "rightPanel.errors.deletedFile"));
      return;
    }
    try {
      await openFileInEditor(joinPath(repoPath, file.path));
    } catch (e) {
      setListError(String(e));
    }
  }

  function openInCodeViewer(file: StagedFile) {
    if (isDeleted(file)) {
      setListError(rt(t, "rightPanel.errors.deletedFile"));
      return;
    }
    try {
      openCodeViewerTab(joinPath(repoPath, file.path), repoPath);
    } catch (e) {
      setListError(String(e));
    }
  }

  if (listError) {
    return <div className="p-3 text-xs text-danger">{listError}</div>;
  }
  if (files.length === 0) {
    if (loadingFirst) return <SkeletonList count={6} />;
    return <Empty msg={rt(t, "rightPanel.staged.empty")} />;
  }

  return (
    <PanelGroup direction="vertical" autoSaveId="acorn:layout:staged">
      <Panel id="staged-list" order={1} defaultSize={35} minSize={15}>
        <ListBox className="acorn-no-scrollbar h-full overflow-x-hidden overflow-y-auto">
          {files.map((f) => {
            const canOpen = !isDeleted(f);
            return (
              <ListRow
                key={f.path}
                aria-disabled={!canOpen}
                onClick={() => setSelectedPath(f.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, file: f });
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  if (!canOpen) return;
                  openInCodeViewer(f);
                }}
                density="compact"
                interactive
                selected={selectedPath === f.path}
                surface="subtle"
                className="flex cursor-default items-center gap-2 font-mono text-xs"
              >
                <span className="w-24 shrink-0 truncate text-fg-muted">
                  {f.status}
                </span>
                <Tooltip
                  label={f.path}
                  side="top"
                  multiline
                  className="flex! min-w-0 flex-1"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      canOpen ? "text-fg" : "text-fg-muted line-through",
                    )}
                  >
                    {f.path}
                  </span>
                </Tooltip>
              </ListRow>
            );
          })}
        </ListBox>
      </Panel>
      <ResizeHandle direction="vertical" gap />
      <Panel id="staged-diff" order={2} defaultSize={65} minSize={15}>
        <div className="acorn-no-scrollbar h-full overflow-y-auto">
          {selectedDiff ? (
            <DiffView
              payload={selectedDiff}
              onExpand={() =>
                onExpand({
                  payload: selectedDiff,
                  title:
                    selectedFile?.path ??
                    rt(t, "rightPanel.staged.workingTreeChanges"),
                  subtitle: <span className="font-mono">{repoPath}</span>,
                })
              }
            />
          ) : diffError ? (
            <div className="p-3 text-xs text-danger">{diffError}</div>
          ) : loadingDiff ? (
            <Empty msg={rt(t, "rightPanel.loading.diffLower")} />
          ) : (
            <Empty msg={rt(t, "rightPanel.staged.noDiff")} />
          )}
        </div>
      </Panel>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={
          menu
            ? ([
                {
                  label: rt(t, "rightPanel.menu.openInEditor"),
                  icon: <ExternalLink size={12} />,
                  disabled: isDeleted(menu.file),
                  onClick: () => {
                    void openInEditor(menu.file);
                  },
                },
                { type: "separator" },
                {
                  label: rt(t, "rightPanel.menu.copyRelativePath"),
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyText(menu.file.path);
                  },
                },
                {
                  label: rt(t, "rightPanel.menu.copyAbsolutePath"),
                  icon: <Copy size={12} />,
                  onClick: () => {
                    void copyText(joinPath(repoPath, menu.file.path));
                  },
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
    </PanelGroup>
  );
}

const PR_STATE_OPTIONS: { value: PrStateFilter }[] = [
  { value: "open" },
  { value: "closed" },
  { value: "merged" },
  { value: "all" },
];
const PR_BACKGROUND_PREFETCH_STATES: ReadonlyArray<PrStateFilter> = [
  "merged",
  "closed",
  "all",
];
const PR_BACKGROUND_PREFETCH_DELAY_MS = 700;

function prStateLabelKey(value: PrStateFilter): RightPanelTranslationKey {
  return `rightPanel.prStates.${value}`;
}

/** Initial page size and per-scroll growth increment for PR list pagination. */
const PR_PAGE_SIZE = 50;
/** Backend clamps to 1000; mirror that here so the UI stops growing the limit. */
const PR_PAGE_MAX = 1000;

interface PrListState {
  listing: PullRequestListing | null;
  error: string | null;
  limit: number;
}

function cachedPrListing(
  repoPath: string,
  filter: PrStateFilter,
  limit = PR_PAGE_SIZE,
): PullRequestListing | null {
  return rightPanelCache.getPullRequests(repoPath, filter, limit);
}

function fetchPullRequestsCached(
  repoPath: string,
  filter: PrStateFilter,
  limit: number,
  options: { force?: boolean } = {},
): Promise<PullRequestListing> {
  return rightPanelCache.fetchPullRequests(repoPath, filter, limit, options);
}

function emptyPrListState(): PrListState {
  return { listing: null, error: null, limit: PR_PAGE_SIZE };
}

function initialPrListStates(repoPath?: string): Record<PrStateFilter, PrListState> {
  return {
    open: prListStateFromCache(repoPath, "open"),
    closed: prListStateFromCache(repoPath, "closed"),
    merged: prListStateFromCache(repoPath, "merged"),
    all: prListStateFromCache(repoPath, "all"),
  };
}

function prListStateFromCache(
  repoPath: string | undefined,
  filter: PrStateFilter,
): PrListState {
  if (!repoPath) return emptyPrListState();
  return {
    listing: cachedPrListing(repoPath, filter),
    error: null,
    limit: PR_PAGE_SIZE,
  };
}

type PrDialogTarget = {
  number: number;
  detail: PullRequestDetail | null;
  loading: boolean;
  error: string | null;
  requestId: number;
};

/**
 * Shared PR row actions: context menu, copy/open helpers, and the
 * merge/close dialog overlays. Lets the PRs tab and the search modal
 * render the same right-click menu without duplicating handlers or state.
 *
 * `onMutated` fires after a merge or close so callers can refetch their
 * own listing.
 */
function usePrRowActions(
  repoPath: string,
  onOpenDetail: (number: number) => void,
  onMutated?: () => void,
) {
  const t = useTranslation();
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    pr: PullRequestInfo;
  } | null>(null);
  const [mergeFor, setMergeFor] = useState<{
    number: number;
    detail: PullRequestDetail | null;
    loading: boolean;
    error: string | null;
    requestId: number;
  } | null>(null);
  const [closeFor, setCloseFor] = useState<{
    number: number;
    detail: PullRequestDetail | null;
    loading: boolean;
    error: string | null;
    requestId: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every detail fetch / dialog dismiss so stale getPullRequestDetail
  // responses can't open a dialog after the user moved on.
  const dialogEpochRef = useRef(0);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openPrInBrowser(pr: PullRequestInfo) {
    try {
      await openUrl(pr.url);
    } catch (e) {
      setError(String(e));
    }
  }

  function detailLoadError(listing: PullRequestListing): string | null {
    if (listing.kind === "ok") return null;
    return listing.kind === "not_github"
      ? rt(t, "rightPanel.errors.originNotGitHub")
      : rtf(t, "rightPanel.errors.noAccessToSlug", {
          slug: listing.slug,
        });
  }

  function updateMergeTarget(
    requestId: number,
    update: (current: PrDialogTarget) => PrDialogTarget,
  ) {
    setMergeFor((current) => {
      if (!current || current.requestId !== requestId) return current;
      return update(current);
    });
  }

  function updateCloseTarget(
    requestId: number,
    update: (current: PrDialogTarget) => PrDialogTarget,
  ) {
    setCloseFor((current) => {
      if (!current || current.requestId !== requestId) return current;
      return update(current);
    });
  }

  function openMergeFor(pr: PullRequestInfo) {
    const requestId = ++dialogEpochRef.current;
    setError(null);
    setMergeFor({
      number: pr.number,
      detail: null,
      loading: true,
      error: null,
      requestId,
    });
    void api
      .getPullRequestDetail(repoPath, pr.number)
      .then((listing) => {
        if (requestId !== dialogEpochRef.current) return;
        if (listing.kind !== "ok") {
          const loadError = detailLoadError(listing);
          if (!loadError) return;
          setError(loadError);
          updateMergeTarget(requestId, (current) => ({
            ...current,
            loading: false,
            error: loadError,
          }));
          return;
        }
        updateMergeTarget(requestId, (current) => ({
          ...current,
          detail: listing.detail,
          loading: false,
          error: null,
        }));
      })
      .catch((e) => {
        if (requestId !== dialogEpochRef.current) return;
        const message = String(e);
        setError(message);
        updateMergeTarget(requestId, (current) => ({
          ...current,
          loading: false,
          error: message,
        }));
      });
  }

  function openCloseFor(pr: PullRequestInfo) {
    const requestId = ++dialogEpochRef.current;
    setError(null);
    setCloseFor({
      number: pr.number,
      detail: null,
      loading: true,
      error: null,
      requestId,
    });
    void api
      .getPullRequestDetail(repoPath, pr.number)
      .then((listing) => {
        if (requestId !== dialogEpochRef.current) return;
        if (listing.kind !== "ok") {
          const loadError = detailLoadError(listing);
          if (!loadError) return;
          setError(loadError);
          updateCloseTarget(requestId, (current) => ({
            ...current,
            loading: false,
            error: loadError,
          }));
          return;
        }
        updateCloseTarget(requestId, (current) => ({
          ...current,
          detail: listing.detail,
          loading: false,
          error: null,
        }));
      })
      .catch((e) => {
        if (requestId !== dialogEpochRef.current) return;
        const message = String(e);
        setError(message);
        updateCloseTarget(requestId, (current) => ({
          ...current,
          loading: false,
          error: message,
        }));
      });
  }

  function openContextMenu(
    e: React.MouseEvent<HTMLLIElement>,
    pr: PullRequestInfo,
  ) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, pr });
  }

  const overlays = (
    <>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={
          menu
            ? ([
                {
                  label: rt(t, "rightPanel.menu.openDetail"),
                  icon: <Maximize2 size={12} />,
                  onClick: () => onOpenDetail(menu.pr.number),
                },
                {
                  label: rt(t, "rightPanel.menu.openInBrowser"),
                  icon: <ExternalLink size={12} />,
                  onClick: () => void openPrInBrowser(menu.pr),
                },
                { type: "separator" },
                {
                  label: rt(t, "rightPanel.menu.copyPrNumber"),
                  icon: <Copy size={12} />,
                  onClick: () => void copyText(`#${menu.pr.number}`),
                },
                {
                  label: rt(t, "rightPanel.menu.copyUrl"),
                  icon: <Copy size={12} />,
                  onClick: () => void copyText(menu.pr.url),
                },
                {
                  label: rtf(t, "rightPanel.menu.copyBranchWithValue", {
                    branch: menu.pr.head_branch,
                  }),
                  icon: <Copy size={12} />,
                  onClick: () => void copyText(menu.pr.head_branch),
                },
                { type: "separator" },
                {
                  label: rt(t, "rightPanel.menu.merge"),
                  icon: <GitMerge size={12} />,
                  disabled: menu.pr.state.toUpperCase() !== "OPEN",
                  onClick: () => void openMergeFor(menu.pr),
                },
                {
                  label: rt(t, "rightPanel.menu.close"),
                  icon: <GitPullRequestClosed size={12} />,
                  disabled: menu.pr.state.toUpperCase() !== "OPEN",
                  onClick: () => void openCloseFor(menu.pr),
                },
              ] satisfies ContextMenuItem[])
            : []
        }
        onClose={() => setMenu(null)}
      />
      <MergePullRequestDialog
        open={mergeFor !== null}
        repoPath={repoPath}
        number={mergeFor?.number}
        detail={mergeFor?.detail ?? null}
        loading={mergeFor?.loading ?? false}
        loadError={mergeFor?.error ?? null}
        onClose={() => {
          dialogEpochRef.current += 1;
          setMergeFor(null);
        }}
        onMerged={() => {
          dialogEpochRef.current += 1;
          setMergeFor(null);
          onMutated?.();
        }}
      />
      <ClosePullRequestDialog
        open={closeFor !== null}
        repoPath={repoPath}
        number={closeFor?.number}
        detail={closeFor?.detail ?? null}
        loading={closeFor?.loading ?? false}
        loadError={closeFor?.error ?? null}
        onClose={() => {
          dialogEpochRef.current += 1;
          setCloseFor(null);
        }}
        onClosed={() => {
          dialogEpochRef.current += 1;
          setCloseFor(null);
          onMutated?.();
        }}
      />
    </>
  );

  return { openContextMenu, overlays, error };
}

function PullRequestsTab({
  repoPath,
  onOpenDetail,
  onOpenSearch,
  refreshKey,
}: {
  repoPath: string;
  onOpenDetail: (number: number) => void;
  onOpenSearch: () => void;
  /** Bumped by the parent to force an out-of-band refetch (e.g. after a PR is merged via the modal). */
  refreshKey: number;
}) {
  const t = useTranslation();
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const showAvatars = useSettings((s) => s.settings.github.showAvatars);
  const showLabels = useSettings((s) => s.settings.github.showLabels);
  const showBranches = useSettings((s) => s.settings.github.showBranches);
  const showChecks = useSettings((s) => s.settings.github.showChecks);
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("open");
  const [listsByState, setListsByState] = useState(() =>
    initialPrListStates(repoPath),
  );
  const [loadingKeys, setLoadingKeys] = useState<Record<string, number>>({});
  const requestSeqByListRef = useRef<Record<string, number>>({});
  const setPrAccountForRepo = useAppStore((s) => s.setPrAccountForRepo);
  const activeList = listsByState[stateFilter] ?? emptyPrListState();
  const listing = activeList.listing;
  const error = activeList.error;
  const limit = activeList.limit;
  const activeLoadingKey = `${repoPath}:${stateFilter}:${limit}`;
  const loading = loadingKeys[activeLoadingKey] !== undefined;

  const fetchPrs = useCallback(
    async (
      filter: PrStateFilter,
      requestedLimit: number,
      signal?: { cancelled: boolean },
    ) => {
      const key = `${repoPath}:${filter}:${requestedLimit}`;
      const listKey = `${repoPath}:${filter}`;
      const requestSeq = (requestSeqByListRef.current[listKey] ?? 0) + 1;
      requestSeqByListRef.current[listKey] = requestSeq;
      setLoadingKeys((prev) => ({ ...prev, [key]: requestSeq }));
      try {
        const result = await fetchPullRequestsCached(
          repoPath,
          filter,
          requestedLimit,
          { force: true },
        );
        if (
          signal?.cancelled ||
          requestSeqByListRef.current[listKey] !== requestSeq
        ) {
          return;
        }
        setListsByState((prev) => ({
          ...prev,
          [filter]: {
            listing: result,
            error: null,
            limit: requestedLimit,
          },
        }));
        setPrAccountForRepo(
          repoPath,
          result.kind === "ok" ? result.account : null,
        );
      } catch (e) {
        if (
          signal?.cancelled ||
          requestSeqByListRef.current[listKey] !== requestSeq
        ) {
          return;
        }
        setListsByState((prev) => ({
          ...prev,
          [filter]: {
            ...(prev[filter] ?? emptyPrListState()),
            error: String(e),
            limit: requestedLimit,
          },
        }));
      } finally {
        setLoadingKeys((prev) => {
          if (prev[key] !== requestSeq) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [repoPath, setPrAccountForRepo],
  );
  const fetchActivePrs = useCallback(
    (signal?: { cancelled: boolean }) => fetchPrs(stateFilter, limit, signal),
    [fetchPrs, stateFilter, limit],
  );

  // Reset cached list state on project change. Individual filters keep their
  // first page cached so switching Open → Merged can be instant once the
  // background prefetch lands.
  useEffect(() => {
    requestSeqByListRef.current = {};
    setLoadingKeys({});
    setListsByState(initialPrListStates(repoPath));
  }, [repoPath]);

  useEffect(() => {
    const signal = { cancelled: false };
    void fetchActivePrs(signal);
    const handle = setInterval(() => {
      void fetchActivePrs(signal);
    }, refreshIntervalMs);
    return () => {
      signal.cancelled = true;
      clearInterval(handle);
    };
  }, [fetchActivePrs, refreshIntervalMs]);

  useEffect(() => {
    const signal = { cancelled: false };
    const handle = window.setTimeout(() => {
      void (async () => {
        for (const filter of PR_BACKGROUND_PREFETCH_STATES) {
          if (signal.cancelled) return;
          await fetchPrs(filter, PR_PAGE_SIZE, signal);
        }
      })();
    }, PR_BACKGROUND_PREFETCH_DELAY_MS);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(handle);
    };
  }, [repoPath, fetchPrs]);

  // Out-of-band refresh when the parent bumps `refreshKey` (e.g. PR merged via
  // the detail modal). Skip the very first render since the effect above
  // already kicks off the initial fetch.
  const firstRefreshKeyRender = useRef(true);
  useEffect(() => {
    if (firstRefreshKeyRender.current) {
      firstRefreshKeyRender.current = false;
      return;
    }
    const signal = { cancelled: false };
    void Promise.all(
      PR_STATE_OPTIONS.map((opt) => fetchPrs(opt.value, PR_PAGE_SIZE, signal)),
    );
    return () => {
      signal.cancelled = true;
    };
  }, [refreshKey, fetchPrs]);

  const rowActions = usePrRowActions(repoPath, onOpenDetail, () => {
    void fetchActivePrs();
  });

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (loading) return;
    if (!listing || listing.kind !== "ok") return;
    // Fewer items than the page size means gh returned everything — nothing
    // more to load. limit hitting the backend clamp is also terminal.
    if (listing.items.length < limit) return;
    if (limit >= PR_PAGE_MAX) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setListsByState((prev) => {
        const current = prev[stateFilter] ?? emptyPrListState();
        const nextLimit = Math.min(current.limit + PR_PAGE_SIZE, PR_PAGE_MAX);
        if (nextLimit === current.limit) return prev;
        return {
          ...prev,
          [stateFilter]: { ...current, limit: nextLimit },
        };
      });
    }
  }

  const reachedMax =
    listing?.kind === "ok" &&
    listing.items.length >= limit &&
    limit >= PR_PAGE_MAX;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {PR_STATE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStateFilter(opt.value)}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] transition",
              stateFilter === opt.value
                ? "bg-bg-elevated text-fg"
                : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
            )}
          >
            {rt(t, prStateLabelKey(opt.value))}
          </button>
        ))}
        <Tooltip
          label={rt(t, "rightPanel.search.aria")}
          side="bottom"
          className="ml-auto"
        >
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label={rt(t, "rightPanel.search.aria")}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <Search size={12} />
          </button>
        </Tooltip>
        <RefreshButton
          onClick={() => void fetchActivePrs()}
          loading={loading}
          size={12}
        />
      </div>
      <div
        className="acorn-no-scrollbar flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={handleScroll}
      >
        {error || rowActions.error ? (
          <div className="p-3 text-xs text-danger">
            {error ?? rowActions.error}
          </div>
        ) : !listing ? (
          <PrSkeletonList count={10} />
        ) : listing.kind === "not_github" ? (
          <Empty msg={rt(t, "rightPanel.errors.originNotGitHub")} />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner
            slug={listing.slug}
            accounts={listing.accounts}
            repoPath={repoPath}
          />
        ) : listing.items.length === 0 ? (
          <Empty
            msg={rtf(t, "rightPanel.prs.emptyByState", {
              state: rt(t, prStateLabelKey(stateFilter)).toLowerCase(),
            })}
          />
        ) : (
          <ListBox>
            {listing.items.map((pr) => (
              <PrRow
                key={pr.number}
                pr={pr}
                showAvatar={showAvatars}
                showLabels={showLabels}
                showBranches={showBranches}
                showChecks={showChecks}
                onOpen={() => onOpenDetail(pr.number)}
                onContextMenu={(e) => rowActions.openContextMenu(e, pr)}
              />
            ))}
            {loading && listing.items.length >= limit ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rt(t, "rightPanel.loading.more")}
              </li>
            ) : null}
            {reachedMax ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rtf(t, "rightPanel.prs.reachedMax", {
                  count: PR_PAGE_MAX,
                })}
              </li>
            ) : null}
          </ListBox>
        )}
      </div>
      {rowActions.overlays}
    </div>
  );
}

const ISSUE_STATE_OPTIONS: { value: IssueStateFilter }[] = [
  { value: "open" },
  { value: "closed" },
  { value: "all" },
];
const ISSUE_BACKGROUND_PREFETCH_STATES: ReadonlyArray<IssueStateFilter> = [
  "closed",
  "all",
];

function issueStateLabelKey(value: IssueStateFilter): RightPanelTranslationKey {
  return `rightPanel.issueStates.${value}`;
}

const ISSUE_PAGE_SIZE = 50;
const ISSUE_PAGE_MAX = 1000;

interface IssueListState {
  listing: IssueListing | null;
  error: string | null;
  limit: number;
}

function cachedIssueListing(
  repoPath: string,
  filter: IssueStateFilter,
  limit = ISSUE_PAGE_SIZE,
): IssueListing | null {
  return rightPanelCache.getIssues(repoPath, filter, limit);
}

function fetchIssuesCached(
  repoPath: string,
  filter: IssueStateFilter,
  limit: number,
  options: { force?: boolean } = {},
): Promise<IssueListing> {
  return rightPanelCache.fetchIssues(repoPath, filter, limit, options);
}

function emptyIssueListState(): IssueListState {
  return { listing: null, error: null, limit: ISSUE_PAGE_SIZE };
}

function initialIssueListStates(
  repoPath?: string,
): Record<IssueStateFilter, IssueListState> {
  return {
    open: issueListStateFromCache(repoPath, "open"),
    closed: issueListStateFromCache(repoPath, "closed"),
    all: issueListStateFromCache(repoPath, "all"),
  };
}

function issueListStateFromCache(
  repoPath: string | undefined,
  filter: IssueStateFilter,
): IssueListState {
  if (!repoPath) return emptyIssueListState();
  return {
    listing: cachedIssueListing(repoPath, filter),
    error: null,
    limit: ISSUE_PAGE_SIZE,
  };
}

function useIssueRowActions(onOpenDetail: (number: number) => void) {
  const t = useTranslation();
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    issue: IssueInfo;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openIssueInBrowser(issue: IssueInfo) {
    try {
      await openUrl(issue.url);
    } catch (e) {
      setError(String(e));
    }
  }

  function openContextMenu(
    e: React.MouseEvent<HTMLLIElement>,
    issue: IssueInfo,
  ) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, issue });
  }

  const overlays = (
    <ContextMenu
      open={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      items={
        menu
          ? ([
              {
                label: rt(t, "rightPanel.menu.openDetail"),
                icon: <Maximize2 size={12} />,
                onClick: () => onOpenDetail(menu.issue.number),
              },
              {
                label: rt(t, "rightPanel.menu.openInBrowser"),
                icon: <ExternalLink size={12} />,
                onClick: () => void openIssueInBrowser(menu.issue),
              },
              { type: "separator" },
              {
                label: rt(t, "rightPanel.menu.copyIssueNumber"),
                icon: <Copy size={12} />,
                onClick: () => void copyText(`#${menu.issue.number}`),
              },
              {
                label: rt(t, "rightPanel.menu.copyUrl"),
                icon: <Copy size={12} />,
                onClick: () => void copyText(menu.issue.url),
              },
            ] satisfies ContextMenuItem[])
          : []
      }
      onClose={() => setMenu(null)}
    />
  );

  return { openContextMenu, overlays, error };
}

function IssuesTab({ repoPath }: { repoPath: string }) {
  const t = useTranslation();
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const showAvatars = useSettings((s) => s.settings.github.showAvatars);
  const showLabels = useSettings((s) => s.settings.github.showLabels);
  const [stateFilter, setStateFilter] = useState<IssueStateFilter>("open");
  const [listsByState, setListsByState] = useState(() =>
    initialIssueListStates(repoPath),
  );
  const [loadingKeys, setLoadingKeys] = useState<Record<string, number>>({});
  const requestSeqByListRef = useRef<Record<string, number>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [issueDetail, setIssueDetail] = useState<{
    repoPath: string;
    number: number;
  } | null>(null);
  const activeList = listsByState[stateFilter] ?? emptyIssueListState();
  const listing = activeList.listing;
  const error = activeList.error;
  const limit = activeList.limit;
  const activeLoadingKey = `${repoPath}:${stateFilter}:${limit}`;
  const loading = loadingKeys[activeLoadingKey] !== undefined;

  const fetchIssues = useCallback(
    async (
      filter: IssueStateFilter,
      requestedLimit: number,
      signal?: { cancelled: boolean },
    ) => {
      const key = `${repoPath}:${filter}:${requestedLimit}`;
      const listKey = `${repoPath}:${filter}`;
      const requestSeq = (requestSeqByListRef.current[listKey] ?? 0) + 1;
      requestSeqByListRef.current[listKey] = requestSeq;
      setLoadingKeys((prev) => ({ ...prev, [key]: requestSeq }));
      try {
        const result = await fetchIssuesCached(
          repoPath,
          filter,
          requestedLimit,
          { force: true },
        );
        if (
          signal?.cancelled ||
          requestSeqByListRef.current[listKey] !== requestSeq
        ) {
          return;
        }
        setListsByState((prev) => ({
          ...prev,
          [filter]: {
            listing: result,
            error: null,
            limit: requestedLimit,
          },
        }));
      } catch (e) {
        if (
          signal?.cancelled ||
          requestSeqByListRef.current[listKey] !== requestSeq
        ) {
          return;
        }
        setListsByState((prev) => ({
          ...prev,
          [filter]: {
            ...(prev[filter] ?? emptyIssueListState()),
            error: String(e),
            limit: requestedLimit,
          },
        }));
      } finally {
        setLoadingKeys((prev) => {
          if (prev[key] !== requestSeq) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [repoPath],
  );
  const fetchActiveIssues = useCallback(
    (signal?: { cancelled: boolean }) =>
      fetchIssues(stateFilter, limit, signal),
    [fetchIssues, stateFilter, limit],
  );

  useEffect(() => {
    requestSeqByListRef.current = {};
    setLoadingKeys({});
    setListsByState(initialIssueListStates(repoPath));
  }, [repoPath]);

  useEffect(() => {
    const signal = { cancelled: false };
    void fetchActiveIssues(signal);
    const handle = setInterval(() => {
      void fetchActiveIssues(signal);
    }, refreshIntervalMs);
    return () => {
      signal.cancelled = true;
      clearInterval(handle);
    };
  }, [fetchActiveIssues, refreshIntervalMs]);

  useEffect(() => {
    const signal = { cancelled: false };
    const handle = window.setTimeout(() => {
      void (async () => {
        for (const filter of ISSUE_BACKGROUND_PREFETCH_STATES) {
          if (signal.cancelled) return;
          await fetchIssues(filter, ISSUE_PAGE_SIZE, signal);
        }
      })();
    }, PR_BACKGROUND_PREFETCH_DELAY_MS);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(handle);
    };
  }, [repoPath, fetchIssues]);

  const openIssueDetail = useCallback(
    (number: number) => setIssueDetail({ repoPath, number }),
    [repoPath],
  );
  const rowActions = useIssueRowActions(openIssueDetail);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (loading) return;
    if (!listing || listing.kind !== "ok") return;
    if (listing.items.length < limit) return;
    if (limit >= ISSUE_PAGE_MAX) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setListsByState((prev) => {
        const current = prev[stateFilter] ?? emptyIssueListState();
        const nextLimit = Math.min(
          current.limit + ISSUE_PAGE_SIZE,
          ISSUE_PAGE_MAX,
        );
        if (nextLimit === current.limit) return prev;
        return {
          ...prev,
          [stateFilter]: { ...current, limit: nextLimit },
        };
      });
    }
  }

  const reachedMax =
    listing?.kind === "ok" &&
    listing.items.length >= limit &&
    limit >= ISSUE_PAGE_MAX;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {ISSUE_STATE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setStateFilter(opt.value)}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] transition",
              stateFilter === opt.value
                ? "bg-bg-elevated text-fg"
                : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
            )}
          >
            {rt(t, issueStateLabelKey(opt.value))}
          </button>
        ))}
        <Tooltip
          label={rt(t, "rightPanel.issueSearch.aria")}
          side="bottom"
          className="ml-auto"
        >
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label={rt(t, "rightPanel.issueSearch.aria")}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <Search size={12} />
          </button>
        </Tooltip>
        <RefreshButton
          onClick={() => void fetchActiveIssues()}
          loading={loading}
          size={12}
        />
      </div>
      <div
        className="acorn-no-scrollbar flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={handleScroll}
      >
        {error || rowActions.error ? (
          <div className="p-3 text-xs text-danger">
            {error ?? rowActions.error}
          </div>
        ) : !listing ? (
          <PrSkeletonList count={10} />
        ) : listing.kind === "not_github" ? (
          <Empty msg={rt(t, "rightPanel.errors.originNotGitHub")} />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner
            slug={listing.slug}
            accounts={listing.accounts}
            repoPath={repoPath}
          />
        ) : listing.items.length === 0 ? (
          <Empty
            msg={rtf(t, "rightPanel.issues.emptyByState", {
              state: rt(t, issueStateLabelKey(stateFilter)).toLowerCase(),
            })}
          />
        ) : (
          <ListBox>
            {listing.items.map((issue) => (
              <IssueRow
                key={issue.number}
                issue={issue}
                showAvatar={showAvatars}
                showLabels={showLabels}
                onOpen={() => openIssueDetail(issue.number)}
                onContextMenu={(e) => rowActions.openContextMenu(e, issue)}
              />
            ))}
            {loading && listing.items.length >= limit ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rt(t, "rightPanel.loading.more")}
              </li>
            ) : null}
            {reachedMax ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rtf(t, "rightPanel.issues.reachedMax", {
                  count: ISSUE_PAGE_MAX,
                })}
              </li>
            ) : null}
          </ListBox>
        )}
      </div>
      {rowActions.overlays}
      <IssueSearchModal
        open={searchOpen ? { repoPath } : null}
        detailOpen={issueDetail !== null}
        onClose={() => setSearchOpen(false)}
        onOpenDetail={openIssueDetail}
      />
      <IssueDetailModal
        open={issueDetail}
        onClose={() => setIssueDetail(null)}
        onMutated={() => void fetchActiveIssues()}
      />
    </div>
  );
}

const WORKFLOW_RUNS_LIMIT = 50;
const ALL_WORKFLOWS = "__all__";

function cachedWorkflowRuns(
  repoPath: string,
  limit = WORKFLOW_RUNS_LIMIT,
): WorkflowRunsListing | null {
  return rightPanelCache.getWorkflowRuns(repoPath, limit);
}

function fetchWorkflowRunsCached(
  repoPath: string,
  limit: number,
  options: { force?: boolean } = {},
): Promise<WorkflowRunsListing> {
  return rightPanelCache.fetchWorkflowRuns(repoPath, limit, options);
}

function ActionsTab({ repoPath }: { repoPath: string }) {
  const t = useTranslation();
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const [listing, setListing] = useState<WorkflowRunsListing | null>(() =>
    cachedWorkflowRuns(repoPath),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [workflowFilter, setWorkflowFilter] = useState<string>(ALL_WORKFLOWS);
  const [detailRunId, setDetailRunId] = useState<number | null>(null);

  const fetchRuns = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setLoading(true);
      try {
        const result = await fetchWorkflowRunsCached(
          repoPath,
          WORKFLOW_RUNS_LIMIT,
          { force: true },
        );
        if (signal?.cancelled) return;
        setListing(result);
        setError(null);
      } catch (e) {
        if (signal?.cancelled) return;
        setError(String(e));
      } finally {
        if (!signal?.cancelled) setLoading(false);
      }
    },
    [repoPath],
  );

  useEffect(() => {
    setListing(cachedWorkflowRuns(repoPath));
    setError(null);
    setWorkflowFilter(ALL_WORKFLOWS);
    setDetailRunId(null);
  }, [repoPath]);

  useEffect(() => {
    const signal = { cancelled: false };
    void fetchRuns(signal);
    const handle = setInterval(() => {
      void fetchRuns(signal);
    }, refreshIntervalMs);
    return () => {
      signal.cancelled = true;
      clearInterval(handle);
    };
  }, [fetchRuns, refreshIntervalMs]);

  const workflowNames =
    listing?.kind === "ok"
      ? Array.from(new Set(listing.items.map((r) => r.workflow_name))).sort()
      : [];
  const visibleItems =
    listing?.kind === "ok"
      ? workflowFilter === ALL_WORKFLOWS
        ? listing.items
        : listing.items.filter((r) => r.workflow_name === workflowFilter)
      : [];
  const nowUnix = useLiveUnixSeconds(
    visibleItems.some(
      (run) => run.status.toLowerCase() !== "completed" && !!run.started_at,
    ),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Select
          value={workflowFilter}
          onChange={(e) => setWorkflowFilter(e.target.value)}
          aria-label={rt(t, "rightPanel.actions.filterByWorkflow")}
          disabled={listing?.kind !== "ok" || workflowNames.length === 0}
          className="min-w-0 max-w-full flex-1 truncate"
        >
          <option value={ALL_WORKFLOWS}>
            {rt(t, "rightPanel.actions.allWorkflows")}
          </option>
          {workflowNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <RefreshButton
          onClick={() => void fetchRuns()}
          loading={loading}
          size={12}
        />
      </div>
      <div className="acorn-no-scrollbar flex-1 overflow-x-hidden overflow-y-auto">
        {error ? (
          <div className="p-3 text-xs text-danger">{error}</div>
        ) : !listing ? (
          <PrSkeletonList count={8} />
        ) : listing.kind === "not_github" ? (
          <Empty msg={rt(t, "rightPanel.errors.originNotGitHub")} />
        ) : listing.kind === "no_access" ? (
          <NoAccessBanner
            slug={listing.slug}
            accounts={listing.accounts}
            repoPath={repoPath}
          />
        ) : visibleItems.length === 0 ? (
          <Empty
            msg={
              listing.items.length === 0
                ? rt(t, "rightPanel.actions.noRuns")
                : rt(t, "rightPanel.actions.noRunsForFilter")
            }
          />
        ) : (
          <ListBox>
            {visibleItems.map((run) => (
              <WorkflowRunRow
                key={run.id}
                run={run}
                nowUnix={nowUnix}
                onOpenDetail={() => setDetailRunId(run.id)}
              />
            ))}
          </ListBox>
        )}
      </div>
      <WorkflowRunDetailModal
        open={detailRunId !== null}
        repoPath={repoPath}
        runId={detailRunId}
        onClose={() => setDetailRunId(null)}
      />
    </div>
  );
}

function WorkflowRunRow({
  run,
  nowUnix,
  onOpenDetail,
}: {
  run: WorkflowRun;
  nowUnix: number;
  onOpenDetail: () => void;
}) {
  const t = useTranslation();
  const updated = toUnixSeconds(run.updated_at);
  const startedRelative = updated > 0 ? relativeTime(updated, t) : "";
  const startedAbsolute = updated > 0 ? absoluteTime(updated) : "";
  const title =
    run.display_title.trim().length > 0
      ? run.display_title
      : rtf(t, "rightPanel.actions.workflowRunFallbackTitle", {
          workflow: run.workflow_name,
        });
  const branch = run.head_branch?.trim() ?? "";
  const duration = run.started_at
    ? formatRunDuration(run.started_at, run.status, run.updated_at, t, nowUnix)
    : "";

  return (
    <li>
      <button
        type="button"
        onDoubleClick={onOpenDetail}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onOpenDetail();
          }
        }}
        className={listRowClassName({
          interactive: true,
          className: "flex w-full items-start gap-2 text-left",
        })}
      >
        <span className="mt-0.5 flex shrink-0 items-center">
          <WorkflowRunStatusIcon
            status={run.status}
            conclusion={run.conclusion}
          />
        </span>
        <div className="min-w-0 flex-1">
          <Tooltip
            label={rt(t, "rightPanel.actions.doubleClickDetails")}
            side="top"
            className="min-w-0 w-full"
          >
            <div className="truncate text-fg">{title}</div>
          </Tooltip>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-muted">
            <span className="truncate">{run.workflow_name}</span>
            <span className="opacity-50">·</span>
            <span className="truncate">{run.event}</span>
            {branch ? (
              <>
                <span className="opacity-50">·</span>
                <span className="truncate font-mono">{branch}</span>
              </>
            ) : null}
            {run.attempt > 1 ? (
              <>
                <span className="opacity-50">·</span>
                <span>
                  {rtf(t, "rightPanel.actions.retryAttempt", {
                    attempt: run.attempt,
                  })}
                </span>
              </>
            ) : null}
          </div>
        </div>
        {startedRelative ? (
          <Tooltip label={startedAbsolute}>
            <span className="mt-0.5 shrink-0 whitespace-nowrap text-[10px] text-fg-muted">
              {startedRelative}
            </span>
          </Tooltip>
        ) : null}
        {duration ? (
          <span className="mt-0.5 shrink-0 whitespace-nowrap font-mono text-[10px] text-fg-muted">
            {duration}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function WorkflowRunDetailModal({
  open,
  repoPath,
  runId,
  onClose,
}: {
  open: boolean;
  repoPath: string;
  runId: number | null;
  onClose: () => void;
}) {
  const t = useTranslation();
  const refreshIntervalMs = useSettings(
    (s) => s.settings.github.refreshIntervalMs,
  );
  const [listing, setListing] = useState<WorkflowRunDetailListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || runId == null) {
      setListing(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const fetchDetail = (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      return api
        .getWorkflowRunDetail(repoPath, runId)
        .then((result) => {
          if (cancelled) return result;
          setListing(result);
          setError(null);
          return result;
        })
        .catch((e) => {
          if (cancelled) return null;
          setError(String(e));
          return null;
        })
        .finally(() => {
          if (!cancelled && showSpinner) setLoading(false);
        });
    };

    setListing(null);
    setError(null);
    void fetchDetail(true);

    // Poll while the run is still going. Stops automatically once a
    // completed status lands so finished runs don't keep hitting `gh`.
    const handle = window.setInterval(() => {
      setListing((current) => {
        const stillRunning =
          current?.kind !== "ok" ||
          current.detail.status.toLowerCase() !== "completed";
        if (stillRunning) void fetchDetail(false);
        return current;
      });
    }, refreshIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [open, repoPath, runId, refreshIntervalMs]);

  useDialogShortcuts(open, { onCancel: onClose });

  const detail = listing?.kind === "ok" ? listing.detail : null;
  const title =
    detail?.display_title.trim().length
      ? detail.display_title
      : detail?.workflow_name ?? rt(t, "rightPanel.actions.workflowRun");
  const showSkeleton = !error && (loading || !listing);

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      className="flex h-[36rem] flex-col"
    >
      {showSkeleton ? (
        <WorkflowRunDetailSkeleton onClose={onClose} />
      ) : (
        <>
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="mt-0.5 flex shrink-0">
                  {detail ? (
                    <WorkflowRunStatusIcon
                      status={detail.status}
                      conclusion={detail.conclusion}
                    />
                  ) : (
                    <Activity size={14} className="text-fg-muted" />
                  )}
                </span>
                <Tooltip
                  label={title}
                  side="bottom"
                  multiline
                  className="min-w-0 flex-1"
                >
                  <h3 className="truncate text-sm font-semibold leading-5 tracking-tight text-fg">
                    {title}
                  </h3>
                </Tooltip>
              </div>
              {detail ? (
                <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-muted">
                  <span>{detail.workflow_name}</span>
                  <span className="opacity-50">·</span>
                  <span>{detail.event}</span>
                  {detail.head_branch ? (
                    <>
                      <span className="opacity-50">·</span>
                      <span className="font-mono">{detail.head_branch}</span>
                    </>
                  ) : null}
                  {detail.attempt > 1 ? (
                    <>
                      <span className="opacity-50">·</span>
                      <span>
                        {rtf(t, "rightPanel.actions.retryAttempt", {
                          attempt: detail.attempt,
                        })}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {detail?.url ? (
                <Tooltip
                  label={rt(t, "rightPanel.tooltips.openOnGitHub")}
                  side="bottom"
                >
                  <button
                    type="button"
                    onClick={() => void openUrl(detail.url)}
                    className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
                  >
                    <ExternalLink size={14} />
                  </button>
                </Tooltip>
              ) : null}
              <button
                type="button"
                aria-label={t("dialogs.common.close")}
                onClick={onClose}
                className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
              >
                <X size={16} />
              </button>
            </div>
          </header>
          <div className="acorn-no-scrollbar min-h-0 flex-1 overflow-y-auto text-xs">
            <div className="px-4 py-3">
              {error ? (
                <div className="p-2 text-danger">{error}</div>
              ) : listing?.kind === "not_github" ? (
                <Empty msg={rt(t, "rightPanel.errors.originNotGitHub")} />
              ) : listing?.kind === "no_access" ? (
                <NoAccessBanner
                  slug={listing.slug}
                  accounts={listing.accounts}
                  repoPath={repoPath}
                />
              ) : listing?.kind === "ok" ? (
                <WorkflowRunDetailBody detail={listing.detail} />
              ) : null}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function WorkflowRunDetailSkeleton({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  return (
    <>
      <header
        className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3"
        data-workflow-run-detail-skeleton="header"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <SkeletonCircle className="h-3.5 w-3.5 shrink-0 bg-fg-muted/20" />
            <SkeletonBlock className="h-3.5 w-[58%] min-w-0 bg-fg-muted/15" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <SkeletonBlock className="h-2.5 w-20 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-14 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-24 shrink-0" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SkeletonBlock className="h-6 w-6 rounded bg-fg-muted/10" />
          <button
            type="button"
            aria-label={t("dialogs.common.close")}
            onClick={onClose}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="acorn-no-scrollbar min-h-0 flex-1 overflow-y-auto text-xs">
        <div
          className="space-y-3 px-4 py-3"
          data-workflow-run-detail-skeleton="body"
        >
          <section className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[11px]">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="contents">
                  <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/15" />
                  <SkeletonBlock
                    className="h-2.5 bg-fg-muted/10"
                    style={{ width: `${38 + ((index * 29) % 42)}%` }}
                  />
                </div>
              ))}
            </div>
          </section>
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/15" />
              <SkeletonBlock className="h-4 w-8 rounded-full bg-fg-muted/10" />
            </div>
            <ul className="space-y-1.5">
              {Array.from({ length: 3 }).map((_, index) => (
                <li
                  key={index}
                  className="overflow-hidden rounded-md border border-border bg-bg-elevated/40"
                >
                  <div className="flex items-center gap-2 px-2.5 py-2">
                    <SkeletonBlock className="h-3 w-3 shrink-0 rounded-sm bg-fg-muted/10" />
                    <SkeletonCircle className="h-3.5 w-3.5 shrink-0 bg-fg-muted/15" />
                    <SkeletonBlock
                      className="h-3 min-w-0 flex-1 bg-fg-muted/15"
                      style={{ width: `${48 + ((index * 17) % 30)}%` }}
                    />
                    <SkeletonBlock className="ml-auto h-2.5 w-12 shrink-0" />
                  </div>
                  {index === 0 ? (
                    <div className="border-t border-border/40 px-2.5 py-2">
                      <SkeletonText
                        className="gap-1.5"
                        lineClassName="h-2.5"
                        lines={3}
                        widths={["64%", "52%", "40%"]}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}

function WorkflowRunDetailBody({ detail }: { detail: WorkflowRunDetail }) {
  const t = useTranslation();
  const nowUnix = useLiveUnixSeconds(
    detail.status.toLowerCase() !== "completed" ||
      detail.jobs.some(
        (job) => job.status.toLowerCase() !== "completed" && !!job.started_at,
      ),
  );
  const created = toUnixSeconds(detail.created_at);
  const updated = toUnixSeconds(detail.updated_at);
  const totalDuration = formatRunDuration(
    detail.started_at ?? detail.created_at,
    detail.status,
    detail.updated_at,
    t,
    nowUnix,
  );
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[var(--acorn-pane-radius)] bg-bg-sidebar/40 p-3 text-[11px] text-fg-muted">
        <dt className="opacity-70">{rt(t, "rightPanel.actions.status")}</dt>
        <dd className="text-fg">
          {detail.status}
          {detail.conclusion ? ` · ${detail.conclusion}` : ""}
        </dd>
        {totalDuration ? (
          <>
            <dt className="opacity-70">
              {rt(t, "rightPanel.actions.totalDuration")}
            </dt>
            <dd className="text-fg">
              {totalDuration}
              {detail.status.toLowerCase() !== "completed" ? (
                <span className="ml-1 text-fg-muted">
                  {rt(t, "rightPanel.actions.runningParenthetical")}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt className="opacity-70">{rt(t, "rightPanel.actions.attempt")}</dt>
        <dd className="text-fg">
          #{detail.attempt}
          {detail.attempt > 1 ? (
            <span className="ml-1 text-fg-muted">
              {rt(t, "rightPanel.actions.retriedParenthetical")}
            </span>
          ) : null}
        </dd>
        <dt className="opacity-70">{rt(t, "rightPanel.actions.commit")}</dt>
        <dd className="font-mono text-fg">{detail.head_sha.slice(0, 7)}</dd>
        {created > 0 ? (
          <>
            <dt className="opacity-70">{rt(t, "rightPanel.actions.created")}</dt>
            <dd className="text-fg">{absoluteTime(created)}</dd>
          </>
        ) : null}
        {updated > 0 ? (
          <>
            <dt className="opacity-70">{rt(t, "rightPanel.actions.updated")}</dt>
            <dd className="text-fg">{absoluteTime(updated)}</dd>
          </>
        ) : null}
      </dl>
      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          {rtf(t, "rightPanel.actions.jobsCount", {
            count: detail.jobs.length,
          })}
        </div>
        {detail.jobs.length === 0 ? (
          <div className="text-[11px] text-fg-muted">
            {rt(t, "rightPanel.actions.noJobs")}
          </div>
        ) : (
          <ul className="space-y-1">
            {detail.jobs.map((job) => (
              <WorkflowJobRow key={job.id} job={job} nowUnix={nowUnix} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WorkflowJobRow({ job, nowUnix }: { job: WorkflowJob; nowUnix: number }) {
  const t = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const duration = formatJobDuration(
    job.started_at,
    job.completed_at,
    job.status,
    t,
    nowUnix,
  );
  return (
    <li className="overflow-hidden rounded-md border border-border bg-bg-elevated/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left transition hover:bg-bg-elevated",
          expanded ? "border-b border-border/40" : "",
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn(
            "shrink-0 text-fg-muted transition-transform",
            expanded && "rotate-90",
          )}
        />
        <WorkflowRunStatusIcon
          status={job.status}
          conclusion={job.conclusion}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-fg">
          {job.name}
        </span>
        {duration ? (
          <span className="shrink-0 text-[11px] text-fg-muted">{duration}</span>
        ) : null}
        {job.url ? (
          <Tooltip
            label={rt(t, "rightPanel.actions.openJobOnGitHub")}
            side="top"
          >
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                void openUrl(job.url);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  void openUrl(job.url);
                }
              }}
              className="shrink-0 cursor-pointer rounded p-0.5 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
            >
              <ExternalLink size={11} />
            </span>
          </Tooltip>
        ) : null}
      </button>
      {expanded && job.steps.length > 0 ? (
        <ol className="space-y-0.5 px-2.5 py-2 text-xs">
          {job.steps.map((step) => (
            <WorkflowStepRow key={`${step.number}-${step.name}`} step={step} />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function WorkflowStepRow({ step }: { step: WorkflowJobStep }) {
  return (
    <li className="flex items-center gap-2">
      <span className="w-5 shrink-0 text-right font-mono text-[11px] text-fg-muted">
        {step.number}
      </span>
      <WorkflowRunStatusIcon
        status={step.status}
        conclusion={step.conclusion}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-fg">
        {step.name}
      </span>
    </li>
  );
}

function formatRunDuration(
  startedAt: string,
  status: string,
  updatedAt: string,
  t: Translator,
  nowUnix = Math.floor(Date.now() / 1000),
): string {
  const start = toUnixSeconds(startedAt);
  if (start <= 0) return "";
  const completed = status.toLowerCase() === "completed";
  const end = completed
    ? toUnixSeconds(updatedAt) || nowUnix
    : nowUnix;
  return formatDurationSeconds(Math.max(0, end - start), t);
}

function formatDurationSeconds(seconds: number, t: Translator): string {
  if (seconds < 60) {
    return rtf(t, "rightPanel.duration.seconds", { count: seconds });
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) {
    return rem === 0
      ? rtf(t, "rightPanel.duration.minutes", { count: minutes })
      : rtf(t, "rightPanel.duration.minutesSeconds", {
          minutes,
          seconds: rem,
        });
  }
  const hours = Math.floor(minutes / 60);
  const minRem = minutes % 60;
  return minRem === 0
    ? rtf(t, "rightPanel.duration.hours", { count: hours })
    : rtf(t, "rightPanel.duration.hoursMinutes", {
        hours,
        minutes: minRem,
      });
}

function formatJobDuration(
  startedAt: string | null,
  completedAt: string | null,
  status: string,
  t: Translator,
  nowUnix = Math.floor(Date.now() / 1000),
): string {
  if (!startedAt) return "";
  const start = toUnixSeconds(startedAt);
  if (start <= 0) return "";
  const completed = status.toLowerCase() === "completed";
  const end = completed && completedAt ? toUnixSeconds(completedAt) : nowUnix;
  return formatDurationSeconds(Math.max(0, end - start), t);
}

function WorkflowRunStatusIcon({
  status,
  conclusion,
}: {
  status: string;
  conclusion: string | null;
}) {
  const s = status.toLowerCase();
  if (s !== "completed") {
    if (s === "queued" || s === "pending" || s === "waiting" || s === "requested") {
      return (
        <CircleDashed size={14} className="shrink-0 text-fg-muted" />
      );
    }
    // in_progress and anything else still running
    return (
      <Loader2
        size={14}
        className="shrink-0 animate-spin text-accent"
      />
    );
  }
  switch ((conclusion ?? "").toLowerCase()) {
    case "success":
      return <CircleCheck size={14} className="shrink-0 text-emerald-400" />;
    case "failure":
    case "timed_out":
    case "startup_failure":
      return <CircleX size={14} className="shrink-0 text-rose-400" />;
    case "cancelled":
      return <MinusCircle size={14} className="shrink-0 text-fg-muted" />;
    case "action_required":
      return <CircleAlert size={14} className="shrink-0 text-amber-400" />;
    case "skipped":
    case "neutral":
      return <MinusCircle size={14} className="shrink-0 text-fg-muted" />;
    default:
      return <CircleDashed size={14} className="shrink-0 text-fg-muted" />;
  }
}

function NoAccessBanner({
  slug,
  accounts,
  repoPath,
}: {
  slug: string;
  accounts: AccountSummary[];
  repoPath: string;
}) {
  const t = useTranslation();
  const tried = accounts.map((a) => `@${a.login}`).join(", ");
  return (
    <div className="space-y-2 p-3 text-xs text-fg-muted">
      <p className="text-fg">
        {rtf(t, "rightPanel.noAccess.noGhAccountCanAccess", { slug })}
      </p>
      {accounts.length > 0 ? (
        <p>
          <span className="opacity-70">
            {rt(t, "rightPanel.noAccess.tried")}
          </span>{" "}
          {tried}
        </p>
      ) : (
        <p>{rt(t, "rightPanel.noAccess.noAccounts")}</p>
      )}
      <p className="flex flex-wrap items-center gap-1.5 opacity-70">
        {rt(t, "rightPanel.noAccess.run")}
        <CommandHint command="gh auth login" repoPath={repoPath} />
        {rt(t, "rightPanel.noAccess.withAccess")}
      </p>
    </div>
  );
}

type GitHubRowSurface = "panel" | "dialog";
function GitHubListRow({
  number,
  title,
  author,
  updatedAt,
  labels,
  numberClassName,
  meta,
  onOpen,
  onContextMenu,
  surface = "panel",
  rowDensity = "default",
  showAvatar = false,
  showLabels = true,
}: {
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  labels: PullRequestLabel[];
  numberClassName: string;
  meta?: ReactNode;
  onOpen: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  surface?: GitHubRowSurface;
  rowDensity?: ListRowDensity;
  showAvatar?: boolean;
  showLabels?: boolean;
}) {
  const t = useTranslation();
  const titleSize = showAvatar ? "text-[13px]" : "text-xs";
  const metaSize = showAvatar ? "text-[11px]" : "text-[10px]";

  return (
    <ListActionRow
      onOpen={onOpen}
      onContextMenu={onContextMenu}
      surface={surface === "dialog" ? "dialog" : "subtle"}
      density={rowDensity}
      className="flex flex-col items-start gap-0.5 text-left"
    >
      <span className={cn("flex w-full min-w-0 items-center gap-2", titleSize)}>
        <span className={cn("shrink-0 font-mono", numberClassName)}>
          #{number}
        </span>
        <Tooltip
          label={title}
          side="top"
          multiline
          className="flex! min-w-0 flex-1"
        >
          <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
        </Tooltip>
        {showLabels && labels.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {labels.slice(0, 3).map((label) => (
              <GitHubLabelChip key={label.name} label={label} />
            ))}
            {labels.length > 3 ? (
              <span className="text-[9px] text-fg-muted">
                +{labels.length - 3}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex w-full min-w-0 items-center gap-2 text-fg-muted",
          metaSize,
        )}
      >
        <span className="flex min-w-0 shrink-0 items-center gap-1.5">
          {showAvatar ? <AuthorAvatar login={author} size={14} /> : null}
          <span className="truncate">{author}</span>
        </span>
        {meta ? (
          <>
            <span className="shrink-0 opacity-50">·</span>
            {meta}
          </>
        ) : null}
        <span className="shrink-0 opacity-50">·</span>
        <Tooltip
          label={absoluteTime(toUnixSeconds(updatedAt))}
          side="top"
          className="shrink-0"
        >
          <span className="whitespace-nowrap font-mono">
            {relativeTime(toUnixSeconds(updatedAt), t)}
          </span>
        </Tooltip>
      </span>
    </ListActionRow>
  );
}

function PrChecksBadge({
  checks,
}: {
  checks: PullRequestChecksSummary | null;
}) {
  const t = useTranslation();
  if (!checks) return null;
  // Effective total mirrors the PR detail modal: NEUTRAL/SKIPPED/CANCELLED
  // are already excluded by the backend, so passed+failed+pending is what
  // actually carries pass/fail signal.
  const effective = checks.passed + checks.failed + checks.pending;
  if (effective === 0) return null;

  const allPassed = checks.passed === effective;
  const allFailed = checks.failed === effective;

  if (allPassed) {
    return (
      <Tooltip
        label={rtf(t, "rightPanel.checks.allPassed", { count: effective })}
        side="top"
      >
        <Check
          size={10}
          strokeWidth={3}
          className="shrink-0 text-emerald-400"
        />
      </Tooltip>
    );
  }
  if (allFailed) {
    return (
      <Tooltip
        label={rtf(t, "rightPanel.checks.allFailed", { count: effective })}
        side="top"
      >
        <X size={10} strokeWidth={3} className="shrink-0 text-rose-400" />
      </Tooltip>
    );
  }
  // Partial: tiny inline `passed/total` next to the branch name, no pill.
  return (
    <Tooltip
      label={rtf(t, "rightPanel.checks.summary", {
        passed: checks.passed,
        failed: checks.failed,
        pending: checks.pending,
      })}
      side="top"
    >
      <span className="shrink-0 font-mono tabular-nums opacity-80">
        {checks.passed}/{effective}
      </span>
    </Tooltip>
  );
}

function IssueRow({
  issue,
  onOpen,
  onContextMenu,
  surface = "panel",
  showAvatar = false,
  showLabels = true,
}: {
  issue: IssueInfo;
  onOpen: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  surface?: GitHubRowSurface;
  showAvatar?: boolean;
  showLabels?: boolean;
}) {
  const upper = issue.state.toUpperCase();
  const numberColor = upper === "OPEN" ? "text-emerald-400" : "text-purple-400";
  return (
    <GitHubListRow
      number={issue.number}
      title={issue.title}
      author={issue.author}
      updatedAt={issue.updated_at}
      labels={issue.labels}
      numberClassName={numberColor}
      surface={surface}
      showAvatar={showAvatar}
      showLabels={showLabels}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
      meta={
        issue.comments > 0 ? (
          <span className="flex shrink-0 items-center gap-1 font-mono tabular-nums">
            <MessageSquare size={10} />
            {issue.comments}
          </span>
        ) : undefined
      }
    />
  );
}

function toUnixSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return Math.floor(Date.now() / 1000);
  return Math.floor(ms / 1000);
}

/**
 * Shared row used by the PRs tab and the PR search modal. Keeps the visual
 * shape identical across both surfaces so the search modal feels like a
 * filtered view of the same list.
 */
function PrRow({
  pr,
  onOpen,
  onContextMenu,
  surface = "panel",
  showAvatar = false,
  showLabels = true,
  showBranches = true,
  showChecks = true,
}: {
  pr: PullRequestInfo;
  onOpen: () => void;
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  /**
   * Background context the row sits on. `panel` is the right-panel
   * (`bg-bg`), `dialog` is the modal surface (`bg-bg-elevated`) — each
   * needs a different hover color to actually feel interactive.
   */
  surface?: GitHubRowSurface;
  /**
   * Render the author's GitHub avatar to the left of the row. Bumps the
   * row's vertical footprint slightly in exchange for at-a-glance author
   * recognition. Controlled by the `github.showAvatars` setting.
   */
  showAvatar?: boolean;
  /** Render GitHub label chips next to the title. */
  showLabels?: boolean;
  /** Render head/base branch names in the metadata row. */
  showBranches?: boolean;
  /** Render CI/check status in the metadata row. */
  showChecks?: boolean;
}) {
  const upper = pr.state.toUpperCase();
  const isDraft = pr.is_draft && upper === "OPEN";
  const numberColor = isDraft
    ? "text-fg-muted"
    : upper === "OPEN"
      ? "text-emerald-400"
      : upper === "MERGED"
        ? "text-purple-400"
        : "text-rose-400";
  const meta =
    showBranches || showChecks ? (
      <span className="flex min-w-0 items-center gap-1">
        {showBranches ? (
          <Tooltip
            label={`${pr.head_branch} → ${pr.base_branch}`}
            side="top"
            multiline
            className="min-w-0"
          >
            <span className="flex min-w-0 items-center gap-1 font-mono">
              <span className="truncate">{pr.head_branch}</span>
              <span className="shrink-0">→</span>
              <span className="truncate">{pr.base_branch}</span>
            </span>
          </Tooltip>
        ) : null}
        {showChecks ? <PrChecksBadge checks={pr.checks} /> : null}
      </span>
    ) : undefined;

  return (
    <GitHubListRow
      number={pr.number}
      title={pr.title}
      author={pr.author}
      updatedAt={pr.updated_at}
      labels={pr.labels}
      numberClassName={numberColor}
      meta={meta}
      surface={surface}
      showAvatar={showAvatar}
      showLabels={showLabels}
      onOpen={onOpen}
      onContextMenu={onContextMenu}
    />
  );
}

const PR_SEARCH_STATE_OPTIONS: { value: PrStateFilter }[] = [
  { value: "all" },
  { value: "open" },
  { value: "closed" },
  { value: "merged" },
];

/**
 * Modal-scoped PR search. Uses the backend list endpoint rather than
 * filtering the PRs tab's capped list, so backend search and fallback logic
 * stay in one place. Empty query → no fetch; results paginate by growing
 * `limit` on scroll, mirroring the main tab's pattern.
 */
function PullRequestSearchModal({
  open,
  detailOpen,
  onClose,
  onOpenDetail,
}: {
  open: { repoPath: string } | null;
  /**
   * True while the PR detail modal stacks on top. Used to suppress this
   * modal's ESC handler so the top-of-stack closes first.
   */
  detailOpen: boolean;
  onClose: () => void;
  onOpenDetail: (number: number) => void;
}) {
  const t = useTranslation();
  const repoPath = open?.repoPath ?? null;
  const showAvatars = useSettings((s) => s.settings.github.showAvatars);
  const showLabels = useSettings((s) => s.settings.github.showLabels);
  const showBranches = useSettings((s) => s.settings.github.showBranches);
  const showChecks = useSettings((s) => s.settings.github.showChecks);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<PrStateFilter>("all");
  const [listing, setListing] = useState<PullRequestListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(PR_PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Refetch trigger used by row actions after a merge/close so the modal
  // updates without the user reopening it.
  const [refetchTick, setRefetchTick] = useState(0);
  const rowActions = usePrRowActions(
    repoPath ?? "",
    onOpenDetail,
    () => setRefetchTick((v) => v + 1),
  );

  useDialogShortcuts(open !== null && !detailOpen, { onCancel: onClose });

  // Wipe transient state every time the modal opens so a reopen never shows
  // results from the previous session.
  useEffect(() => {
    if (!open) return;
    setRawQuery("");
    setDebouncedQuery("");
    setStateFilter("all");
    setListing(null);
    setError(null);
    setLimit(PR_PAGE_SIZE);
    // Defer focus until after the portal mounts so autoFocus on the input
    // wins over Modal's own focus handling.
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  // Debounce the input so typing doesn't fire a `gh` spawn per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(rawQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // Reset pagination when the search inputs change — a new query starts at
  // the first page rather than inheriting the previous query's growth.
  useEffect(() => {
    setLimit(PR_PAGE_SIZE);
    setListing(null);
  }, [debouncedQuery, stateFilter]);

  useEffect(() => {
    if (!open || !repoPath) return;
    if (!debouncedQuery) {
      setListing(null);
      setError(null);
      setLoading(false);
      return;
    }
    const signal = { cancelled: false };
    setLoading(true);
    api
      .listPullRequests(repoPath, stateFilter, limit, debouncedQuery)
      .then((result) => {
        if (signal.cancelled) return;
        setListing(result);
        setError(null);
      })
      .catch((e) => {
        if (signal.cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false);
      });
    return () => {
      signal.cancelled = true;
    };
  }, [open, repoPath, debouncedQuery, stateFilter, limit, refetchTick]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (loading) return;
    if (!listing || listing.kind !== "ok") return;
    if (listing.items.length < limit) return;
    if (limit >= PR_PAGE_MAX) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setLimit((prev) => Math.min(prev + PR_PAGE_SIZE, PR_PAGE_MAX));
    }
  }

  const reachedMax =
    listing?.kind === "ok" &&
    listing.items.length >= limit &&
    limit >= PR_PAGE_MAX;

  return (
    <Modal
      open={open !== null}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabel={rt(t, "rightPanel.search.aria")}
    >
      <ModalHeader
        title={rt(t, "rightPanel.search.aria")}
        icon={<Search size={14} className="text-fg-muted" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <TextInput
          ref={inputRef}
          value={rawQuery}
          onChange={(e) => setRawQuery(e.currentTarget.value)}
          placeholder={rt(t, "rightPanel.search.placeholder")}
          autoFocus
        />
        <div className="flex items-center gap-1 text-[11px]">
          <div className="flex items-center gap-0.5 rounded-md bg-bg p-0.5">
            {PR_SEARCH_STATE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStateFilter(opt.value)}
              className={cn(
                "rounded px-2 py-0.5 transition",
                stateFilter === opt.value
                  ? "bg-bg-elevated text-fg shadow-sm"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {rt(t, prStateLabelKey(opt.value))}
            </button>
            ))}
          </div>
          {loading ? (
            <span className="ml-auto text-fg-muted">
              {rt(t, "rightPanel.search.searching")}
            </span>
          ) : listing?.kind === "ok" ? (
            <span className="ml-auto font-mono text-fg-muted">
              {listing.items.length}
              {listing.items.length >= limit && limit < PR_PAGE_MAX ? "+" : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="acorn-no-scrollbar h-[60vh] overflow-y-auto"
        onScroll={handleScroll}
      >
        {!debouncedQuery ? (
          <Empty msg={rt(t, "rightPanel.search.typeToSearch")} />
        ) : error || rowActions.error ? (
          <div className="p-3 text-xs text-danger">
            {error ?? rowActions.error}
          </div>
        ) : !listing ? (
          <PrSkeletonList count={6} />
        ) : listing.kind === "not_github" ? (
          <Empty msg={rt(t, "rightPanel.errors.originNotGitHub")} />
        ) : listing.kind === "no_access" ? (
          <div className="p-3 text-xs text-fg-muted">
            {rt(t, "rightPanel.search.noGhAccessThisRepo")}
          </div>
        ) : listing.items.length === 0 ? (
          <Empty msg={rt(t, "rightPanel.search.noMatches")} />
        ) : (
          <ListBox>
            {listing.items.map((pr) => (
              <PrRow
                key={pr.number}
                pr={pr}
                surface="dialog"
                showAvatar={showAvatars}
                showLabels={showLabels}
                showBranches={showBranches}
                showChecks={showChecks}
                onOpen={() => onOpenDetail(pr.number)}
                onContextMenu={(e) => rowActions.openContextMenu(e, pr)}
              />
            ))}
            {loading && listing.items.length >= limit ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rt(t, "rightPanel.loading.more")}
              </li>
            ) : null}
            {reachedMax ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rtf(t, "rightPanel.search.reachedMax", {
                  count: PR_PAGE_MAX,
                })}
              </li>
            ) : null}
          </ListBox>
        )}
      </div>
      {rowActions.overlays}
    </Modal>
  );
}

function IssueSearchModal({
  open,
  detailOpen,
  onClose,
  onOpenDetail,
}: {
  open: { repoPath: string } | null;
  detailOpen: boolean;
  onClose: () => void;
  onOpenDetail: (number: number) => void;
}) {
  const t = useTranslation();
  const repoPath = open?.repoPath ?? null;
  const showAvatars = useSettings((s) => s.settings.github.showAvatars);
  const showLabels = useSettings((s) => s.settings.github.showLabels);
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<IssueStateFilter>("all");
  const [listing, setListing] = useState<IssueListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(ISSUE_PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowActions = useIssueRowActions(onOpenDetail);

  useDialogShortcuts(open !== null && !detailOpen, { onCancel: onClose });

  useEffect(() => {
    if (!open) return;
    setRawQuery("");
    setDebouncedQuery("");
    setStateFilter("all");
    setListing(null);
    setError(null);
    setLimit(ISSUE_PAGE_SIZE);
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(rawQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [rawQuery]);

  useEffect(() => {
    setLimit(ISSUE_PAGE_SIZE);
    setListing(null);
  }, [debouncedQuery, stateFilter]);

  useEffect(() => {
    if (!open || !repoPath) return;
    if (!debouncedQuery) {
      setListing(null);
      setError(null);
      setLoading(false);
      return;
    }
    const signal = { cancelled: false };
    setLoading(true);
    api
      .listIssues(repoPath, stateFilter, limit, debouncedQuery)
      .then((result) => {
        if (signal.cancelled) return;
        setListing(result);
        setError(null);
      })
      .catch((e) => {
        if (signal.cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false);
      });
    return () => {
      signal.cancelled = true;
    };
  }, [open, repoPath, debouncedQuery, stateFilter, limit]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (loading) return;
    if (!listing || listing.kind !== "ok") return;
    if (listing.items.length < limit) return;
    if (limit >= ISSUE_PAGE_MAX) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      setLimit((prev) => Math.min(prev + ISSUE_PAGE_SIZE, ISSUE_PAGE_MAX));
    }
  }

  const reachedMax =
    listing?.kind === "ok" &&
    listing.items.length >= limit &&
    limit >= ISSUE_PAGE_MAX;

  return (
    <Modal
      open={open !== null}
      onClose={onClose}
      variant="dialog"
      size="2xl"
      ariaLabel={rt(t, "rightPanel.issueSearch.aria")}
    >
      <ModalHeader
        title={rt(t, "rightPanel.issueSearch.aria")}
        icon={<Search size={14} className="text-fg-muted" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
        <TextInput
          ref={inputRef}
          value={rawQuery}
          onChange={(e) => setRawQuery(e.currentTarget.value)}
          placeholder={rt(t, "rightPanel.issueSearch.placeholder")}
          autoFocus
        />
        <div className="flex items-center gap-1 text-[11px]">
          <div className="flex items-center gap-0.5 rounded-md bg-bg p-0.5">
            {ISSUE_STATE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStateFilter(opt.value)}
              className={cn(
                "rounded px-2 py-0.5 transition",
                stateFilter === opt.value
                  ? "bg-bg-elevated text-fg shadow-sm"
                  : "text-fg-muted hover:text-fg",
              )}
            >
              {rt(t, issueStateLabelKey(opt.value))}
            </button>
            ))}
          </div>
          {loading ? (
            <span className="ml-auto text-fg-muted">
              {rt(t, "rightPanel.issueSearch.searching")}
            </span>
          ) : listing?.kind === "ok" ? (
            <span className="ml-auto font-mono text-fg-muted">
              {listing.items.length}
              {listing.items.length >= limit && limit < ISSUE_PAGE_MAX
                ? "+"
                : ""}
            </span>
          ) : null}
        </div>
      </div>
      <div
        className="acorn-no-scrollbar h-[60vh] overflow-y-auto"
        onScroll={handleScroll}
      >
        {!debouncedQuery ? (
          <Empty msg={rt(t, "rightPanel.issueSearch.typeToSearch")} />
        ) : error || rowActions.error ? (
          <div className="p-3 text-xs text-danger">
            {error ?? rowActions.error}
          </div>
        ) : !listing ? (
          <PrSkeletonList count={6} />
        ) : listing.kind === "not_github" ? (
          <Empty msg={rt(t, "rightPanel.errors.originNotGitHub")} />
        ) : listing.kind === "no_access" ? (
          <div className="p-3 text-xs text-fg-muted">
            {rt(t, "rightPanel.issueSearch.noGhAccessThisRepo")}
          </div>
        ) : listing.items.length === 0 ? (
          <Empty msg={rt(t, "rightPanel.issueSearch.noMatches")} />
        ) : (
          <ListBox>
            {listing.items.map((issue) => (
              <IssueRow
                key={issue.number}
                issue={issue}
                surface="dialog"
                showAvatar={showAvatars}
                showLabels={showLabels}
                onOpen={() => onOpenDetail(issue.number)}
                onContextMenu={(e) => rowActions.openContextMenu(e, issue)}
              />
            ))}
            {loading && listing.items.length >= limit ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rt(t, "rightPanel.loading.more")}
              </li>
            ) : null}
            {reachedMax ? (
              <li className="px-3 py-2 text-[10px] text-fg-muted">
                {rtf(t, "rightPanel.issueSearch.reachedMax", {
                  count: ISSUE_PAGE_MAX,
                })}
              </li>
            ) : null}
          </ListBox>
        )}
      </div>
      {rowActions.overlays}
    </Modal>
  );
}
