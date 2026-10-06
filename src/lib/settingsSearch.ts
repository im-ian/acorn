import {
  createTranslator,
  type TranslationKey,
  type Translator,
} from "./i18n";

export type SettingsSearchTab =
  | "interface"
  | "appearance"
  | "themes"
  | "terminal"
  | "sessions"
  | "agents"
  | "github"
  | "integrations"
  | "editor"
  | "notifications"
  | "shortcuts"
  | "storage"
  | "permissions"
  | "experiments"
  | "about";

export type SettingsSearchPlatform = "mac" | "mac-power";

export type SettingsSearchTarget = {
  id: string;
  tab: SettingsSearchTab;
  labelKey: TranslationKey;
  detailKeys?: readonly TranslationKey[];
  /** `mac` follows the Permissions tab. `mac-power` follows the power section. */
  platform?: SettingsSearchPlatform;
};

export type SettingsSearchHit = {
  key: string;
  id: string;
  tab: SettingsSearchTab;
  label: string;
  detail: string;
  tabLabel: string;
};

export type SettingsSearchOptions = {
  showMacPermissions: boolean;
  showMacPower: boolean;
};

const TAB_LABEL_KEYS: Record<SettingsSearchTab, TranslationKey> = {
  interface: "settings.tabs.interface",
  appearance: "settings.tabs.appearance",
  themes: "settings.tabs.themes",
  terminal: "settings.tabs.terminal",
  sessions: "settings.tabs.sessions",
  agents: "settings.tabs.agents",
  github: "settings.tabs.github",
  integrations: "settings.tabs.integrations",
  editor: "settings.tabs.editor",
  notifications: "settings.tabs.notifications",
  shortcuts: "settings.tabs.shortcuts",
  storage: "settings.tabs.storage",
  permissions: "settings.tabs.permissions",
  experiments: "settings.tabs.experiments",
  about: "settings.tabs.about",
};

const RESULT_LIMIT = 40;
const english = createTranslator("en");

/**
 * Labels the settings search can jump to. `id` is the DOM id of the control.
 */
export const SETTINGS_SEARCH_TARGETS: readonly SettingsSearchTarget[] = [
  {
    id: "setting-language",
    tab: "interface",
    labelKey: "settings.language.label",
    detailKeys: ["settings.language.hint"],
  },
  {
    id: "setting-ui-scale",
    tab: "interface",
    labelKey: "settings.appearance.uiScale.label",
    detailKeys: ["settings.appearance.uiScale.hint"],
  },
  {
    id: "setting-default-workspace",
    tab: "interface",
    labelKey: "settings.interface.defaultWorkspaceViewMode.label",
    detailKeys: [
      "settings.interface.defaultWorkspaceViewMode.hint",
      "workspace.mode.panes",
      "workspace.mode.kanban",
      "workspace.mode.canvas",
    ],
  },
  {
    id: "setting-project-tabs",
    tab: "interface",
    labelKey: "settings.interface.projectTabs.label",
    detailKeys: ["settings.interface.projectTabs.hint"],
  },
  {
    id: "setting-project-tab-priority",
    tab: "interface",
    labelKey: "settings.interface.projectTabs.priority.label",
    detailKeys: ["settings.interface.projectTabs.priority.description"],
  },
  {
    id: "setting-kanban-popover",
    tab: "interface",
    labelKey: "settings.interface.kanbanTerminalPopover.title",
    detailKeys: ["settings.interface.kanbanTerminalPopover.description"],
  },
  {
    id: "setting-kanban-popover-open",
    tab: "interface",
    labelKey: "settings.interface.kanbanTerminalPopover.openOnCreate.label",
    detailKeys: [
      "settings.interface.kanbanTerminalPopover.openOnCreate.description",
    ],
  },
  {
    id: "setting-kanban-popover-placement",
    tab: "interface",
    labelKey: "settings.interface.kanbanTerminalPopover.placement.label",
    detailKeys: [
      "settings.interface.kanbanTerminalPopover.placement.hint",
      "settings.interface.kanbanTerminalPopover.placement.card.label",
      "settings.interface.kanbanTerminalPopover.placement.center.label",
    ],
  },
  {
    id: "setting-kanban-popover-size",
    tab: "interface",
    labelKey: "settings.interface.kanbanTerminalPopover.defaultSize.label",
    detailKeys: [
      "settings.interface.kanbanTerminalPopover.defaultSize.hint",
      "settings.interface.kanbanTerminalPopover.defaultSize.custom.label",
      "settings.interface.kanbanTerminalPopover.defaultSize.fullscreen.label",
    ],
  },
  {
    id: "setting-session-title",
    tab: "appearance",
    labelKey: "settings.appearance.sessionDisplay.title.label",
    detailKeys: [
      "settings.appearance.sessionDisplay.title.hint",
      "settings.appearance.sessionDisplay.title.options.name.label",
      "settings.appearance.sessionDisplay.title.options.workingDirectory.label",
      "settings.appearance.sessionDisplay.title.options.branch.label",
    ],
  },
  {
    id: "setting-session-metadata",
    tab: "appearance",
    labelKey: "settings.appearance.sessionDisplay.metadata.label",
    detailKeys: ["settings.appearance.sessionDisplay.metadata.hint"],
  },
  {
    id: "setting-session-metadata-branch",
    tab: "appearance",
    labelKey: "settings.appearance.sessionDisplay.metadata.branch.label",
    detailKeys: [
      "settings.appearance.sessionDisplay.metadata.branch.description",
    ],
  },
  {
    id: "setting-session-metadata-directory",
    tab: "appearance",
    labelKey:
      "settings.appearance.sessionDisplay.metadata.workingDirectory.label",
    detailKeys: [
      "settings.appearance.sessionDisplay.metadata.workingDirectory.description",
    ],
  },
  {
    id: "setting-session-metadata-status",
    tab: "appearance",
    labelKey: "settings.appearance.sessionDisplay.metadata.status.label",
    detailKeys: [
      "settings.appearance.sessionDisplay.metadata.status.description",
    ],
  },
  {
    id: "setting-session-hover",
    tab: "appearance",
    labelKey: "settings.appearance.sessionDisplay.hover.label",
    detailKeys: ["settings.appearance.sessionDisplay.hover.hint"],
  },
  {
    id: "setting-status-bar",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.label",
    detailKeys: ["settings.appearance.statusBar.hint"],
  },
  {
    id: "setting-status-session-activity",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.sessionActivity.label",
    detailKeys: ["settings.appearance.statusBar.sessionActivity.description"],
  },
  {
    id: "setting-status-session-count",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.sessionCount.label",
    detailKeys: ["settings.appearance.statusBar.sessionCount.description"],
  },
  {
    id: "setting-status-active-session",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.activeSessionStatus.label",
    detailKeys: [
      "settings.appearance.statusBar.activeSessionStatus.description",
    ],
  },
  {
    id: "setting-status-github",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.githubAccount.label",
    detailKeys: ["settings.appearance.statusBar.githubAccount.description"],
  },
  {
    id: "setting-status-directory",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.workingDirectory.label",
    detailKeys: ["settings.appearance.statusBar.workingDirectory.description"],
  },
  {
    id: "setting-status-tokens",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.agentTokenUsage.label",
    detailKeys: ["settings.appearance.statusBar.agentTokenUsage.description"],
  },
  {
    id: "setting-status-memory",
    tab: "appearance",
    labelKey: "settings.appearance.statusBar.memoryUsage.label",
    detailKeys: ["settings.appearance.statusBar.memoryUsage.description"],
  },
  {
    id: "setting-toast-position",
    tab: "appearance",
    labelKey: "settings.appearance.toastPosition.label",
    detailKeys: [
      "settings.appearance.toastPosition.hint",
      "settings.appearance.toastPosition.options.top",
      "settings.appearance.toastPosition.options.bottom",
    ],
  },
  {
    id: "setting-background",
    tab: "appearance",
    labelKey: "settings.appearance.background.label",
    detailKeys: ["settings.appearance.background.hint"],
  },
  {
    id: "setting-background-app",
    tab: "appearance",
    labelKey: "settings.appearance.background.applyToApp",
  },
  {
    id: "setting-background-terminal",
    tab: "appearance",
    labelKey: "settings.appearance.background.applyToTerminal",
  },
  {
    id: "setting-background-fit",
    tab: "appearance",
    labelKey: "settings.appearance.background.fit.label",
    detailKeys: [
      "settings.appearance.background.fit.cover",
      "settings.appearance.background.fit.contain",
      "settings.appearance.background.fit.tile",
    ],
  },
  {
    id: "setting-background-opacity",
    tab: "appearance",
    labelKey: "settings.appearance.background.opacity.label",
    detailKeys: ["settings.appearance.background.opacity.hint"],
  },
  {
    id: "setting-background-blur",
    tab: "appearance",
    labelKey: "settings.appearance.background.blur",
  },
  {
    id: "setting-theme",
    tab: "themes",
    labelKey: "settings.appearance.theme.label",
    detailKeys: ["settings.appearance.theme.hint"],
  },
  {
    id: "setting-theme-library",
    tab: "themes",
    labelKey: "settings.appearance.theme.library.title",
    detailKeys: ["settings.appearance.theme.library.description"],
  },
  {
    id: "setting-font-preset",
    tab: "terminal",
    labelKey: "settings.terminal.fontPreset.label",
    detailKeys: ["settings.terminal.fontPreset.hint"],
  },
  {
    id: "setting-font-family",
    tab: "terminal",
    labelKey: "settings.terminal.fontFamily.label",
    detailKeys: ["settings.terminal.fontFamily.hint"],
  },
  {
    id: "setting-font-size",
    tab: "terminal",
    labelKey: "settings.terminal.fontSize.label",
    detailKeys: ["settings.terminal.fontSize.hint"],
  },
  {
    id: "setting-letter-spacing",
    tab: "terminal",
    labelKey: "settings.terminal.letterSpacing.label",
    detailKeys: ["settings.terminal.letterSpacing.hint"],
  },
  {
    id: "setting-font-smoothing",
    tab: "terminal",
    labelKey: "settings.terminal.fontSmoothing.label",
    detailKeys: [
      "settings.terminal.fontSmoothing.hint",
      "settings.terminal.fontSmoothing.options.grayscale",
      "settings.terminal.fontSmoothing.options.subpixel",
      "settings.terminal.fontSmoothing.options.system",
      "settings.terminal.fontSmoothing.options.none",
    ],
  },
  {
    id: "setting-font-weight",
    tab: "terminal",
    labelKey: "settings.terminal.fontWeight.label",
    detailKeys: ["settings.terminal.fontWeight.hint"],
  },
  {
    id: "setting-bold-font-weight",
    tab: "terminal",
    labelKey: "settings.terminal.boldFontWeight.label",
    detailKeys: ["settings.terminal.boldFontWeight.hint"],
  },
  {
    id: "setting-line-height",
    tab: "terminal",
    labelKey: "settings.terminal.lineHeight.label",
    detailKeys: ["settings.terminal.lineHeight.hint"],
  },
  {
    id: "setting-cursor-style",
    tab: "terminal",
    labelKey: "settings.terminal.cursorStyle.label",
    detailKeys: [
      "settings.terminal.cursorStyle.hint",
      "settings.terminal.cursorStyle.options.block",
      "settings.terminal.cursorStyle.options.bar",
      "settings.terminal.cursorStyle.options.underline",
      "settings.terminal.cursorStyle.options.outline",
      "settings.terminal.cursorStyle.options.pill",
    ],
  },
  {
    id: "setting-scroll-speed",
    tab: "terminal",
    labelKey: "settings.terminal.scrollSpeed.label",
    detailKeys: ["settings.terminal.scrollSpeed.hint"],
  },
  {
    id: "setting-canvas-refresh",
    tab: "terminal",
    labelKey: "settings.terminal.canvasInactiveRefreshRate.label",
    detailKeys: ["settings.terminal.canvasInactiveRefreshRate.hint"],
  },
  {
    id: "setting-open-links",
    tab: "terminal",
    labelKey: "settings.terminal.openLinksOn.label",
    detailKeys: [
      "settings.terminal.openLinksOn.hint",
      "settings.terminal.openLinksOn.click.label",
    ],
  },
  {
    id: "setting-right-click-paste",
    tab: "terminal",
    labelKey: "settings.terminal.rightClickPasteSelection.label",
    detailKeys: ["settings.terminal.rightClickPasteSelection.description"],
  },
  {
    id: "setting-confirm-remove",
    tab: "sessions",
    labelKey: "settings.sessions.confirmRemove.label",
    detailKeys: ["settings.sessions.confirmRemove.hint"],
  },
  {
    id: "setting-warn-close-running",
    tab: "sessions",
    labelKey: "settings.sessions.warnBeforeClosingRunning.label",
    detailKeys: ["settings.sessions.warnBeforeClosingRunning.hint"],
  },
  {
    id: "setting-confirm-delete-worktrees",
    tab: "sessions",
    labelKey: "settings.sessions.confirmDeleteIsolatedWorktrees.label",
    detailKeys: ["settings.sessions.confirmDeleteIsolatedWorktrees.hint"],
  },
  {
    id: "setting-confirm-delete-empty-workspaces",
    tab: "sessions",
    labelKey: "settings.sessions.confirmDeleteEmptyWorktreeWorkspaces.label",
    detailKeys: [
      "settings.sessions.confirmDeleteEmptyWorktreeWorkspaces.hint",
    ],
  },
  {
    id: "setting-restart-prompt",
    tab: "sessions",
    labelKey: "settings.sessions.showRestartPromptOnExit.label",
    detailKeys: ["settings.sessions.showRestartPromptOnExit.hint"],
  },
  {
    id: "setting-auto-resume",
    tab: "sessions",
    labelKey: "settings.sessions.autoResume.label",
    detailKeys: ["settings.sessions.autoResume.hint"],
  },
  {
    id: "setting-detach-offscreen",
    tab: "sessions",
    labelKey: "settings.terminal.detachOffscreenTerminals.label",
    detailKeys: ["settings.terminal.detachOffscreenTerminals.hint"],
  },
  {
    id: "setting-max-mounted-terminals",
    tab: "sessions",
    labelKey: "settings.terminal.maxMountedTerminals.label",
    detailKeys: ["settings.terminal.maxMountedTerminals.hint"],
  },
  {
    id: "setting-prevent-sleep",
    tab: "sessions",
    labelKey: "settings.power.preventSleep.label",
    detailKeys: [
      "settings.power.preventSleep.description",
      "settings.power.title",
    ],
    platform: "mac-power",
  },
  {
    id: "setting-control-cli",
    tab: "sessions",
    labelKey: "settings.sessions.controlCli.label",
    detailKeys: ["settings.sessions.controlCli.hint"],
  },
  {
    id: "setting-background-daemon",
    tab: "sessions",
    labelKey: "backgroundSessions.daemon.label",
    detailKeys: [
      "backgroundSessions.daemon.hint",
      "backgroundSessions.daemon.enableLabel",
    ],
  },
  {
    id: "setting-github-refresh",
    tab: "github",
    labelKey: "settings.github.refreshInterval.label",
    detailKeys: ["settings.github.refreshInterval.hint"],
  },
  {
    id: "setting-github-density",
    tab: "github",
    labelKey: "settings.github.listDensity.label",
    detailKeys: ["settings.github.listDensity.hint"],
  },
  {
    id: "setting-github-avatars",
    tab: "github",
    labelKey: "settings.github.showAuthorAvatars.label",
    detailKeys: ["settings.github.showAuthorAvatars.description"],
  },
  {
    id: "setting-github-labels",
    tab: "github",
    labelKey: "settings.github.showLabels.label",
    detailKeys: ["settings.github.showLabels.description"],
  },
  {
    id: "setting-github-branches",
    tab: "github",
    labelKey: "settings.github.showBranches.label",
    detailKeys: ["settings.github.showBranches.description"],
  },
  {
    id: "setting-github-checks",
    tab: "github",
    labelKey: "settings.github.showChecks.label",
    detailKeys: ["settings.github.showChecks.description"],
  },
  {
    id: "setting-linear",
    tab: "integrations",
    labelKey: "settings.integrations.linear.title",
    detailKeys: ["settings.integrations.linear.hint"],
  },
  {
    id: "setting-jira",
    tab: "integrations",
    labelKey: "settings.integrations.jira.title",
    detailKeys: ["settings.integrations.jira.hint"],
  },
  {
    id: "setting-editor-command",
    tab: "editor",
    labelKey: "settings.editor.command.label",
    detailKeys: [
      "settings.editor.command.hint",
      "settings.editor.command.description",
    ],
  },
  {
    id: "setting-notifications",
    tab: "notifications",
    labelKey: "settings.notifications.system.label",
    detailKeys: ["settings.notifications.system.hint"],
  },
  {
    id: "setting-notification-waiting",
    tab: "notifications",
    labelKey: "settings.notifications.triggers.waitingForInput.label",
    detailKeys: [
      "settings.notifications.triggers.waitingForInput.description",
    ],
  },
  {
    id: "setting-notification-errored",
    tab: "notifications",
    labelKey: "settings.notifications.triggers.errored.label",
    detailKeys: ["settings.notifications.triggers.errored.description"],
  },
  {
    id: "setting-notification-history",
    tab: "notifications",
    labelKey: "settings.notifications.history.label",
    detailKeys: ["settings.notifications.history.hint"],
  },
  {
    id: "setting-notification-auto-delete",
    tab: "notifications",
    labelKey: "settings.notifications.history.autoDeleteRead.label",
    detailKeys: ["settings.notifications.history.autoDeleteRead.description"],
  },
  {
    id: "setting-notification-test",
    tab: "notifications",
    labelKey: "settings.notifications.test.label",
    detailKeys: ["settings.notifications.test.hint"],
  },
  {
    id: "setting-agent",
    tab: "agents",
    labelKey: "settings.agents.agent.label",
    detailKeys: [
      "settings.agents.agent.hint",
      "settings.agents.customOption.label",
    ],
  },
  {
    id: "setting-custom-command",
    tab: "agents",
    labelKey: "settings.agents.customCommand.label",
    detailKeys: ["settings.agents.customCommand.hint"],
  },
  {
    id: "setting-session-titles",
    tab: "agents",
    labelKey: "settings.agents.sessionTitles.label",
    detailKeys: ["settings.agents.sessionTitles.hint"],
  },
  {
    id: "setting-session-titles",
    tab: "agents",
    labelKey: "settings.agents.sessionTitlePrompt.label",
    detailKeys: ["settings.agents.sessionTitlePrompt.hint"],
  },
  {
    id: "setting-session-title-sync",
    tab: "agents",
    labelKey: "settings.agents.sessionTitleSync.label",
    detailKeys: ["settings.agents.sessionTitleSync.hint"],
  },
  {
    id: "setting-experiment-sticky-prompt",
    tab: "experiments",
    labelKey: "settings.experiments.stickyPrompt.label",
    detailKeys: ["settings.experiments.stickyPrompt.description"],
  },
  {
    id: "setting-experiment-cjk",
    tab: "experiments",
    labelKey: "settings.experiments.cjkCellWidthHeuristic.label",
    detailKeys: ["settings.experiments.cjkCellWidthHeuristic.description"],
  },
  {
    id: "setting-experiment-unicode-spaces",
    tab: "experiments",
    labelKey: "settings.experiments.normalizeTerminalUnicodeSpaces.label",
    detailKeys: [
      "settings.experiments.normalizeTerminalUnicodeSpaces.description",
    ],
  },
  {
    id: "setting-experiment-resume-modal",
    tab: "experiments",
    labelKey: "settings.experiments.resumeModal.label",
    detailKeys: ["settings.experiments.resumeModal.description"],
  },
  {
    id: "setting-permissions",
    tab: "permissions",
    labelKey: "settings.permissions.title",
    detailKeys: ["settings.permissions.description"],
    platform: "mac",
  },
  {
    id: "setting-permission-folder-access",
    tab: "permissions",
    labelKey: "settings.permissions.folderAccess.label",
    detailKeys: ["settings.permissions.folderAccess.description"],
    platform: "mac",
  },
  {
    id: "setting-storage",
    tab: "storage",
    labelKey: "settings.storage.title",
    detailKeys: ["settings.storage.description"],
  },
  {
    id: "setting-about",
    tab: "about",
    labelKey: "settings.about.title",
    detailKeys: ["settings.about.description"],
  },
  {
    id: "setting-check-for-updates",
    tab: "about",
    labelKey: "settings.about.checkForUpdates",
    detailKeys: ["settings.about.description"],
  },
  {
    id: "setting-whats-new",
    tab: "about",
    labelKey: "settings.about.whatsNew",
  },
];

export function searchSettings(
  query: string,
  targets: readonly SettingsSearchTarget[],
  translate: Translator,
  options: SettingsSearchOptions,
): SettingsSearchHit[] {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  const ranked: Array<{
    hit: SettingsSearchHit;
    score: number;
    index: number;
  }> = [];

  targets.forEach((target, index) => {
    if (target.platform === "mac" && !options.showMacPermissions) return;
    if (target.platform === "mac-power" && !options.showMacPower) return;

    const label = translate(target.labelKey);
    const details = (target.detailKeys ?? []).map((key) => translate(key));
    const tabLabel = translate(TAB_LABEL_KEYS[target.tab]);
    const englishLabel = english(target.labelKey);
    const englishDetails = (target.detailKeys ?? []).map((key) => english(key));
    const englishTab = english(TAB_LABEL_KEYS[target.tab]);
    const labelHay = normalize(`${label} ${englishLabel}`);
    const detailHay = normalize(
      [details.join(" "), englishDetails.join(" "), tabLabel, englishTab].join(
        " ",
      ),
    );
    const haystack = `${labelHay} ${detailHay}`;
    if (!tokens.every((token) => haystack.includes(token))) return;

    const phrase = tokens.join(" ");
    let score = 0;
    if (labelHay.startsWith(phrase)) score += 50;
    else if (labelHay.includes(phrase)) score += 30;
    score += tokens.every((token) => labelHay.includes(token)) ? 20 : 5;
    score -= labelHay.length / 100;

    ranked.push({
      hit: {
        key: `${target.id}:${target.labelKey}`,
        id: target.id,
        tab: target.tab,
        label,
        detail: details[0] ?? "",
        tabLabel,
      },
      score,
      index,
    });
  });

  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, RESULT_LIMIT).map((item) => item.hit);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}
