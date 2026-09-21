import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { parseIssueKey } from "../lib/issueKey";
import type { TranslationKey, Translator } from "../lib/i18n";
import { useSettings } from "../lib/settings";
import { emitTrackerAccountsChanged } from "../lib/trackerEvents";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import type {
  IssueStateFilter,
  JiraProjectInfo,
  LinearTeam,
  ProjectSettings,
  TrackerIssue,
  TrackerListing,
  TrackerProvider,
} from "../lib/types";
import { openExternalUrlWithFeedback } from "../lib/externalOpener";
import { GitHubLabelChip } from "./GitHubLabelChip";
import {
  TrackerIssueDetailModal,
  type TrackerIssueDetailOpen,
} from "./TrackerIssueDetailModal";
import { Tooltip } from "./Tooltip";
import {
  Button,
  ListActionRow,
  ListBox,
  ListEmptyState,
  RefreshButton,
  Select,
} from "./ui";

type PanelKey = Extract<TranslationKey, `rightPanel.${string}`>;

function rt(t: Translator, key: PanelKey): string {
  return t(key);
}

function rtf(
  t: Translator,
  key: PanelKey,
  values: Record<string, string | number>,
): string {
  return rt(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

const STATE_OPTIONS: IssueStateFilter[] = ["open", "closed", "all"];
const PAGE_SIZE = 50;

function toUnixSeconds(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function relativeTime(unixSeconds: number, t: Translator): string {
  const diffSec = Math.round(Date.now() / 1000) - unixSeconds;
  if (diffSec < 60) return rtf(t, "rightPanel.time.secondsAgo", { count: diffSec });
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

export function TrackerIssuesTab({
  provider,
  repoPath,
}: {
  provider: TrackerProvider;
  repoPath: string;
}) {
  const t = useTranslation();
  const refreshIntervalMs = useSettings((s) => s.settings.github.refreshIntervalMs);
  const showLabels = useSettings((s) => s.settings.github.showLabels);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const openSettingsTab = useSettings((s) => s.openTab);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [listing, setListing] = useState<TrackerListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [stateFilter, setStateFilter] = useState<IssueStateFilter>("open");
  const [detail, setDetail] = useState<TrackerIssueDetailOpen | null>(null);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [projects, setProjects] = useState<JiraProjectInfo[]>([]);
  const [mappingSaving, setMappingSaving] = useState(false);

  const mapped =
    provider === "linear"
      ? Boolean(settings?.linear?.team_id)
      : Boolean(settings?.jira?.project_key);
  const activeBranch =
    sessions.find((session) => session.id === activeSessionId)?.branch ?? "";
  const currentKey = useMemo(() => {
    const prefixes =
      provider === "linear"
        ? [settings?.linear?.team_key ?? ""]
        : [settings?.jira?.project_key ?? ""];
    return parseIssueKey(activeBranch, prefixes);
  }, [activeBranch, provider, settings]);

  const loadSettings = useCallback(async () => {
    const record = await api.getProjectSettings(repoPath);
    setSettings(record.settings);
    return record.settings;
  }, [repoPath]);

  const fetchIssues = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setLoading(true);
      try {
        const result =
          provider === "linear"
            ? await api.listLinearIssues(repoPath, stateFilter, PAGE_SIZE)
            : await api.listJiraIssues(repoPath, stateFilter, PAGE_SIZE);
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
    [provider, repoPath, stateFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    setError(null);
    void loadSettings().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [loadSettings]);

  useEffect(() => {
    if (!mapped) return;
    const signal = { cancelled: false };
    void fetchIssues(signal);
    const handle = window.setInterval(() => {
      void fetchIssues(signal);
    }, refreshIntervalMs);
    return () => {
      signal.cancelled = true;
      window.clearInterval(handle);
    };
  }, [fetchIssues, mapped, refreshIntervalMs]);

  useEffect(() => {
    if (mapped) return;
    let cancelled = false;
    if (provider === "linear") {
      void api
        .listLinearTeams()
        .then((items) => {
          if (!cancelled) setTeams(items);
        })
        .catch(() => {
          if (!cancelled) setTeams([]);
        });
    } else {
      void api
        .listJiraProjects()
        .then((items) => {
          if (!cancelled) setProjects(items);
        })
        .catch(() => {
          if (!cancelled) setProjects([]);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [mapped, provider]);

  async function saveLinearTeam(teamId: string) {
    const team = teams.find((item) => item.id === teamId);
    if (!team || !settings) return;
    setMappingSaving(true);
    try {
      const next: ProjectSettings = {
        ...settings,
        linear: {
          team_id: team.id,
          team_key: team.key,
          team_name: team.name,
        },
        jira: settings.jira ?? { project_key: null, project_name: null },
      };
      const record = await api.updateProjectSettings(repoPath, next);
      setSettings(record.settings);
      emitTrackerAccountsChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setMappingSaving(false);
    }
  }

  async function saveJiraProject(projectKey: string) {
    const project = projects.find((item) => item.key === projectKey);
    if (!project || !settings) return;
    setMappingSaving(true);
    try {
      const next: ProjectSettings = {
        ...settings,
        linear: settings.linear ?? {
          team_id: null,
          team_key: null,
          team_name: null,
        },
        jira: {
          project_key: project.key,
          project_name: project.name,
        },
      };
      const record = await api.updateProjectSettings(repoPath, next);
      setSettings(record.settings);
      emitTrackerAccountsChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setMappingSaving(false);
    }
  }

  const items = listing?.kind === "ok" ? listing.items : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {STATE_OPTIONS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStateFilter(value)}
            className={cn(
              "rounded-md px-2 py-0.5 text-[11px] transition",
              stateFilter === value
                ? "bg-bg-elevated text-fg"
                : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
            )}
          >
            {rt(t, `rightPanel.issueStates.${value}`)}
          </button>
        ))}
        <RefreshButton
          onClick={() => void fetchIssues()}
          loading={loading}
          size={12}
          className="ml-auto"
        />
      </div>
      <div className="acorn-no-scrollbar flex-1 overflow-x-hidden overflow-y-auto">
        {error ? (
          <div className="p-3 text-xs text-danger">{error}</div>
        ) : !settings ? (
          <ListEmptyState>{rt(t, "rightPanel.trackers.loading")}</ListEmptyState>
        ) : listing?.kind === "needs_auth" ? (
          <div className="space-y-2 p-3 text-xs text-fg-muted">
            <p className="text-fg">{rt(t, "rightPanel.trackers.needsAuth")}</p>
            <Button size="sm" onClick={() => openSettingsTab("integrations")}>
              {rt(t, "rightPanel.trackers.openSettings")}
            </Button>
          </div>
        ) : listing?.kind === "needs_mapping" || !mapped ? (
          <MappingPanel
            provider={provider}
            teams={teams}
            projects={projects}
            saving={mappingSaving}
            onSaveLinear={saveLinearTeam}
            onSaveJira={saveJiraProject}
          />
        ) : listing?.kind === "no_access" ? (
          <ListEmptyState>{listing.message}</ListEmptyState>
        ) : !listing ? (
          <ListEmptyState>{rt(t, "rightPanel.trackers.loading")}</ListEmptyState>
        ) : items.length === 0 ? (
          <ListEmptyState>
            {rtf(t, "rightPanel.issues.emptyByState", {
              state: rt(t, `rightPanel.issueStates.${stateFilter}`).toLowerCase(),
            })}
          </ListEmptyState>
        ) : (
          <ListBox>
            {items.map((issue) => (
              <TrackerIssueRow
                key={issue.id}
                issue={issue}
                current={currentKey === issue.identifier.toUpperCase()}
                showLabels={showLabels}
                onOpen={() =>
                  setDetail({
                    provider,
                    repoPath,
                    id: issue.id,
                    identifier: issue.identifier,
                  })
                }
              />
            ))}
          </ListBox>
        )}
      </div>
      <TrackerIssueDetailModal
        open={detail}
        onClose={() => setDetail(null)}
        onMutated={() => void fetchIssues()}
      />
    </div>
  );
}

function MappingPanel({
  provider,
  teams,
  projects,
  saving,
  onSaveLinear,
  onSaveJira,
}: {
  provider: TrackerProvider;
  teams: LinearTeam[];
  projects: JiraProjectInfo[];
  saving: boolean;
  onSaveLinear: (teamId: string) => void;
  onSaveJira: (projectKey: string) => void;
}) {
  const t = useTranslation();
  if (provider === "linear") {
    return (
      <div className="space-y-2 p-3 text-xs text-fg-muted">
        <p className="text-fg">{rt(t, "rightPanel.trackers.needsLinearTeam")}</p>
        {teams.length === 0 ? (
          <p>{rt(t, "rightPanel.trackers.noTeams")}</p>
        ) : (
          <Select
            value=""
            onValueChange={(value) => onSaveLinear(value)}
            disabled={saving}
            options={teams.map((team) => ({
              value: team.id,
              label: `${team.key} · ${team.name}`,
            }))}
            placeholder={rt(t, "rightPanel.trackers.chooseTeam")}
          />
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 p-3 text-xs text-fg-muted">
      <p className="text-fg">{rt(t, "rightPanel.trackers.needsJiraProject")}</p>
      {projects.length === 0 ? (
        <p>{rt(t, "rightPanel.trackers.noProjects")}</p>
      ) : (
        <Select
          value=""
          onValueChange={(value) => onSaveJira(value)}
          disabled={saving}
          options={projects.map((project) => ({
            value: project.key,
            label: `${project.key} · ${project.name}`,
          }))}
          placeholder={rt(t, "rightPanel.trackers.chooseProject")}
        />
      )}
    </div>
  );
}

function TrackerIssueRow({
  issue,
  current,
  showLabels,
  onOpen,
}: {
  issue: TrackerIssue;
  current: boolean;
  showLabels: boolean;
  onOpen: () => void;
}) {
  const t = useTranslation();
  const closed =
    issue.state_type === "completed" || issue.state_type === "canceled";
  return (
    <ListActionRow
      onOpen={onOpen}
      surface="subtle"
      className={cn(
        "flex flex-col items-start gap-0.5 text-left",
        current && "bg-accent/10",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-xs">
        <span
          className={cn(
            "shrink-0 font-mono",
            closed ? "text-purple-400" : "text-emerald-400",
          )}
        >
          {issue.identifier}
        </span>
        <Tooltip label={issue.title} side="top" multiline className="flex! min-w-0 flex-1">
          <span className="min-w-0 flex-1 truncate text-fg">{issue.title}</span>
        </Tooltip>
        {showLabels && issue.labels.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {issue.labels.slice(0, 3).map((label) => (
              <GitHubLabelChip key={label.name} label={label} />
            ))}
          </span>
        ) : null}
        <button
          type="button"
          className="rounded p-0.5 text-fg-muted hover:text-fg"
          onClick={(event) => {
            event.stopPropagation();
            void openExternalUrlWithFeedback(issue.url);
          }}
        >
          <ExternalLink size={11} />
        </button>
      </span>
      <span className="flex w-full min-w-0 items-center gap-2 text-[10px] text-fg-muted">
        <span className="truncate">{issue.author}</span>
        <span className="opacity-50">·</span>
        <span>{issue.state}</span>
        {issue.assignee ? (
          <>
            <span className="opacity-50">·</span>
            <span className="truncate">{issue.assignee}</span>
          </>
        ) : null}
        <span className="opacity-50">·</span>
        <span className="font-mono">
          {relativeTime(toUnixSeconds(issue.updated_at), t)}
        </span>
      </span>
    </ListActionRow>
  );
}
