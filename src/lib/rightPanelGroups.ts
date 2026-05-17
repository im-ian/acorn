export type RightGroup = "code" | "github" | "agents";

export type RightTab =
  | "files"
  | "staged"
  | "commits"
  | "prs"
  | "actions"
  | "todos"
  | "history";

export const RIGHT_GROUPS: ReadonlyArray<RightGroup> = ["code", "github", "agents"];

const TABS_BY_GROUP: Record<RightGroup, ReadonlyArray<RightTab>> = {
  code: ["files", "staged", "commits"],
  github: ["prs", "actions"],
  agents: ["todos", "history"],
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
    agents: defaultTabForGroup("agents"),
  };
}

const ALL_TABS = new Set<string>(
  RIGHT_GROUPS.flatMap((g) => TABS_BY_GROUP[g] as ReadonlyArray<string>),
);

export function isRightTab(value: unknown): value is RightTab {
  return typeof value === "string" && ALL_TABS.has(value);
}
