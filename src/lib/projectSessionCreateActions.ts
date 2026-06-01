import type { TranslationKey } from "./i18n";
import type { SessionKind, SessionMode } from "./types";

type SidebarActionKey = Extract<TranslationKey, `sidebar.actions.${string}`>;
type SidebarAriaKey = Extract<TranslationKey, `sidebar.aria.${string}`>;

export type ProjectSessionCreateActionId =
  | "terminal"
  | "isolated"
  | "chat"
  | "control";

export interface ProjectSessionCreateAction {
  id: ProjectSessionCreateActionId;
  labelKey: SidebarActionKey;
  ariaKey: SidebarAriaKey;
  isolated: boolean;
  kind: SessionKind;
  mode: SessionMode;
}

const TERMINAL_ACTION = {
  id: "terminal",
  labelKey: "sidebar.actions.newSession",
  ariaKey: "sidebar.aria.newSessionInProject",
  isolated: false,
  kind: "regular",
  mode: "terminal",
} as const satisfies ProjectSessionCreateAction;

const ISOLATED_ACTION = {
  id: "isolated",
  labelKey: "sidebar.actions.newIsolatedSessionWorktree",
  ariaKey: "sidebar.aria.newIsolatedSessionInProject",
  isolated: true,
  kind: "regular",
  mode: "terminal",
} as const satisfies ProjectSessionCreateAction;

const CHAT_ACTION = {
  id: "chat",
  labelKey: "sidebar.actions.newChatSession",
  ariaKey: "sidebar.aria.newChatSessionInProject",
  isolated: false,
  kind: "regular",
  mode: "chat",
} as const satisfies ProjectSessionCreateAction;

const CONTROL_ACTION = {
  id: "control",
  labelKey: "sidebar.actions.newControlSession",
  ariaKey: "sidebar.aria.newControlSessionInProject",
  isolated: false,
  kind: "control",
  mode: "terminal",
} as const satisfies ProjectSessionCreateAction;

export const PROJECT_SESSION_CREATE_ACTIONS = [
  TERMINAL_ACTION,
  ISOLATED_ACTION,
  CHAT_ACTION,
  CONTROL_ACTION,
] as const satisfies readonly ProjectSessionCreateAction[];

export type ProjectSessionCreateMenuItem =
  | { type: "action"; action: ProjectSessionCreateAction }
  | { type: "separator" };

export const PROJECT_SESSION_CREATE_MENU = [
  { type: "action", action: TERMINAL_ACTION },
  { type: "action", action: ISOLATED_ACTION },
  { type: "action", action: CHAT_ACTION },
  { type: "separator" },
  { type: "action", action: CONTROL_ACTION },
] as const satisfies readonly ProjectSessionCreateMenuItem[];
