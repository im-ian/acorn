import type { TranslationKey } from "./i18n";
import type { HotkeyId } from "./hotkeys";
import type { SessionKind, SessionMode } from "./types";

type SidebarActionKey = Extract<TranslationKey, `sidebar.actions.${string}`>;
type SidebarAriaKey = Extract<TranslationKey, `sidebar.aria.${string}`>;

export type ProjectSessionCreateActionId =
  | "goal"
  | "terminal"
  | "isolated"
  | "chat"
  | "control";

interface ProjectSessionCreateActionBase {
  id: ProjectSessionCreateActionId;
  labelKey: SidebarActionKey;
  ariaKey: SidebarAriaKey;
  hotkeyId?: HotkeyId;
}

export interface DirectProjectSessionCreateAction
  extends ProjectSessionCreateActionBase {
  flow: "direct";
  id: Exclude<ProjectSessionCreateActionId, "goal">;
  isolated: boolean;
  kind: SessionKind;
  mode: SessionMode;
}

export interface GoalProjectSessionCreateAction
  extends ProjectSessionCreateActionBase {
  flow: "goal";
  id: "goal";
}

export type ProjectSessionCreateAction =
  | DirectProjectSessionCreateAction
  | GoalProjectSessionCreateAction;

const GOAL_ACTION = {
  flow: "goal",
  id: "goal",
  labelKey: "sidebar.actions.newAutonomousGoalSession",
  ariaKey: "sidebar.aria.newAutonomousGoalSession",
  hotkeyId: undefined,
} as const satisfies GoalProjectSessionCreateAction;

const TERMINAL_ACTION = {
  flow: "direct",
  id: "terminal",
  labelKey: "sidebar.actions.newSession",
  ariaKey: "sidebar.aria.newSessionInProject",
  isolated: false,
  kind: "regular",
  mode: "terminal",
  hotkeyId: "newSession",
} as const satisfies DirectProjectSessionCreateAction;

const ISOLATED_ACTION = {
  flow: "direct",
  id: "isolated",
  labelKey: "sidebar.actions.newIsolatedSessionWorktree",
  ariaKey: "sidebar.aria.newIsolatedSessionInProject",
  isolated: true,
  kind: "regular",
  mode: "terminal",
  hotkeyId: "newIsolatedSession",
} as const satisfies DirectProjectSessionCreateAction;

const CHAT_ACTION = {
  flow: "direct",
  id: "chat",
  labelKey: "sidebar.actions.newChatSession",
  ariaKey: "sidebar.aria.newChatSessionInProject",
  isolated: false,
  kind: "regular",
  mode: "chat",
  hotkeyId: undefined,
} as const satisfies DirectProjectSessionCreateAction;

const CONTROL_ACTION = {
  flow: "direct",
  id: "control",
  labelKey: "sidebar.actions.newControlSession",
  ariaKey: "sidebar.aria.newControlSessionInProject",
  isolated: false,
  kind: "control",
  mode: "terminal",
  hotkeyId: "newControlSession",
} as const satisfies DirectProjectSessionCreateAction;

export const PROJECT_SESSION_CREATE_ACTIONS = [
  GOAL_ACTION,
  TERMINAL_ACTION,
  ISOLATED_ACTION,
  CHAT_ACTION,
  CONTROL_ACTION,
] as const satisfies readonly ProjectSessionCreateAction[];

export type ProjectSessionCreateMenuItem =
  | { type: "action"; action: ProjectSessionCreateAction }
  | { type: "separator" };

export const PROJECT_SESSION_CREATE_MENU = [
  { type: "action", action: GOAL_ACTION },
  { type: "separator" },
  { type: "action", action: TERMINAL_ACTION },
  { type: "action", action: ISOLATED_ACTION },
  { type: "action", action: CHAT_ACTION },
  { type: "separator" },
  { type: "action", action: CONTROL_ACTION },
] as const satisfies readonly ProjectSessionCreateMenuItem[];
