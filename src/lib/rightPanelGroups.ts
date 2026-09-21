export type RightGroup = "code" | "github" | "linear" | "jira" | "agents";

export type RightTab =
  | "files"
  | "staged"
  | "commits"
  | "prs"
  | "issues"
  | "actions"
  | "linearIssues"
  | "jiraIssues"
  | "todos"
  | "history";

export const RIGHT_GROUPS: ReadonlyArray<RightGroup> = [
  "code",
  "github",
  "linear",
  "jira",
  "agents",
];

const TABS_BY_GROUP: Record<RightGroup, ReadonlyArray<RightTab>> = {
  code: ["files", "staged", "commits"],
  github: ["prs", "issues", "actions"],
  linear: ["linearIssues"],
  jira: ["jiraIssues"],
  agents: ["history", "todos"],
};

export function tabsForGroup(group: RightGroup): ReadonlyArray<RightTab> {
  return TABS_BY_GROUP[group];
}

export function groupOfTab(tab: RightTab): RightGroup {
  for (const group of RIGHT_GROUPS) {
    if (TABS_BY_GROUP[group].includes(tab)) return group;
  }
  return "code";
}

export function defaultTabForGroup(group: RightGroup): RightTab {
  return TABS_BY_GROUP[group][0];
}

export function defaultTabByGroup(): Record<RightGroup, RightTab> {
  return {
    code: defaultTabForGroup("code"),
    github: defaultTabForGroup("github"),
    linear: defaultTabForGroup("linear"),
    jira: defaultTabForGroup("jira"),
    agents: defaultTabForGroup("agents"),
  };
}

const ALL_TABS = new Set<string>(
  RIGHT_GROUPS.flatMap((g) => TABS_BY_GROUP[g] as ReadonlyArray<string>),
);

export function isRightTab(value: unknown): value is RightTab {
  return typeof value === "string" && ALL_TABS.has(value);
}
