import {
  Download,
  FolderOpen,
  ImagePlus,
  Keyboard,
  Loader2,
  RefreshCcw,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  importBackgroundImage,
  removeBackgroundImage,
  type BackgroundFit,
} from "../lib/background";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import {
  DEFAULT_HOTKEYS,
  formatHotkey,
  hotkeyBindingsFor,
  recordHotkeyFromEvent,
  setShortcutRecordingActive,
  type HotkeyConfig,
  type HotkeyId,
} from "../lib/hotkeys";
import {
  LANGUAGE_OPTIONS,
  type Language,
  type TranslationKey,
  type Translator,
} from "../lib/i18n";
import { sendTestNotification } from "../lib/notifications";
import {
  fetchLatestReleaseNotes,
  fetchReleaseNotes,
  type ReleaseNotes,
} from "../lib/releases";
import { useUpdater } from "../lib/updater-store";
import { BackgroundSessionsSettings } from "./BackgroundSessionsSettings";
import { WhatsNewModal } from "./WhatsNewModal";
import { Tooltip } from "./Tooltip";
import {
  AGENT_OPTIONS,
  DEFAULT_SESSION_TITLE_PROMPT,
  MOUNTED_TERMINAL_LIMIT_MAX,
  MOUNTED_TERMINAL_LIMIT_MIN,
  NOTIFICATION_HISTORY_LIMIT_MAX,
  NOTIFICATION_HISTORY_LIMIT_MIN,
  PR_REFRESH_INTERVAL_OPTIONS,
  resolveAiExecutionRequest,
  resolveSessionTitlePrompt,
  SESSION_TITLE_PROMPT_PREVIEW_MESSAGE,
  SESSION_TITLE_PROMPT_MAX_CHARS,
  SESSION_TITLE_OPTIONS,
  TOAST_POSITION_OPTIONS,
  type SelectedAgent,
  type SessionTitleSource,
  type AcornSettings,
  type TerminalFontWeight,
  type TerminalLinkActivation,
  type ToastPosition,
  TERMINAL_FONT_WEIGHTS,
  useSettings,
} from "../lib/settings";
import {
  revealThemesFolder,
  useThemes,
  type AcornTheme,
} from "../lib/themes";
import { useToasts } from "../lib/toasts";
import { useTranslation } from "../lib/useTranslation";
import { useAppStore } from "../store";
import {
  CheckboxRow,
  CommandHint,
  Field,
  Modal,
  ModalHeader,
  RadioCard,
  Select,
  Stepper,
  TextInput,
  type SelectItem,
  type SelectOptionGroup,
} from "./ui";

type Tab =
  | "interface"
  | "appearance"
  | "terminal"
  | "agents"
  | "sessions"
  | "services"
  | "github"
  | "editor"
  | "notifications"
  | "shortcuts"
  | "storage"
  | "experiments"
  | "about";

const TABS: Array<{ id: Tab; labelKey: TranslationKey }> = [
  { id: "interface", labelKey: "settings.tabs.interface" },
  { id: "appearance", labelKey: "settings.tabs.appearance" },
  { id: "terminal", labelKey: "settings.tabs.terminal" },
  { id: "agents", labelKey: "settings.tabs.agents" },
  { id: "sessions", labelKey: "settings.tabs.sessions" },
  { id: "services", labelKey: "settings.tabs.services" },
  { id: "github", labelKey: "settings.tabs.github" },
  { id: "editor", labelKey: "settings.tabs.editor" },
  { id: "notifications", labelKey: "settings.tabs.notifications" },
  { id: "shortcuts", labelKey: "settings.tabs.shortcuts" },
  { id: "storage", labelKey: "settings.tabs.storage" },
  { id: "experiments", labelKey: "settings.tabs.experiments" },
  { id: "about", labelKey: "settings.tabs.about" },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));
type SettingsTranslator = Translator;

type ShortcutItem = {
  id: HotkeyId;
  labelKey: TranslationKey;
  descriptionKey?: TranslationKey;
};

type ShortcutGroup = {
  titleKey: TranslationKey;
  items: ShortcutItem[];
};

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: "settings.shortcuts.groups.general",
    items: [
      {
        id: "openPalette",
        labelKey: "settings.shortcuts.items.openPalette.label",
      },
      {
        id: "openSettings",
        labelKey: "settings.shortcuts.items.openSettings.label",
      },
      {
        id: "newSession",
        labelKey: "settings.shortcuts.items.newSession.label",
      },
      {
        id: "newIsolatedSession",
        labelKey: "settings.shortcuts.items.newIsolatedSession.label",
      },
      {
        id: "newControlSession",
        labelKey: "settings.shortcuts.items.newControlSession.label",
      },
      {
        id: "addProject",
        labelKey: "settings.shortcuts.items.addProject.label",
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.groups.navigation",
    items: [
      {
        id: "focusSidebar",
        labelKey: "settings.shortcuts.items.focusSidebar.label",
      },
      {
        id: "focusMain",
        labelKey: "settings.shortcuts.items.focusMain.label",
      },
      {
        id: "focusRight",
        labelKey: "settings.shortcuts.items.focusRight.label",
      },
      {
        id: "nextTab",
        labelKey: "settings.shortcuts.items.nextTab.label",
      },
      {
        id: "prevTab",
        labelKey: "settings.shortcuts.items.prevTab.label",
      },
      {
        id: "nextProject",
        labelKey: "settings.shortcuts.items.nextProject.label",
      },
      {
        id: "prevProject",
        labelKey: "settings.shortcuts.items.prevProject.label",
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.groups.layout",
    items: [
      {
        id: "toggleSidebar",
        labelKey: "settings.shortcuts.items.toggleSidebar.label",
      },
      {
        id: "toggleRightPanel",
        labelKey: "settings.shortcuts.items.toggleRightPanel.label",
      },
      {
        id: "splitVertical",
        labelKey: "settings.shortcuts.items.splitVertical.label",
      },
      {
        id: "splitHorizontal",
        labelKey: "settings.shortcuts.items.splitHorizontal.label",
      },
      {
        id: "equalizePanes",
        labelKey: "settings.shortcuts.items.equalizePanes.label",
      },
      {
        id: "closeTab",
        labelKey: "settings.shortcuts.items.closeTab.label",
      },
      {
        id: "closeEmptyPane",
        labelKey: "settings.shortcuts.items.closeEmptyPane.label",
        descriptionKey: "settings.shortcuts.items.closeEmptyPane.description",
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.groups.rightPanel",
    items: [
      {
        id: "toggleTodos",
        labelKey: "settings.shortcuts.items.toggleTodos.label",
      },
      {
        id: "toggleCommits",
        labelKey: "settings.shortcuts.items.toggleCommits.label",
      },
      {
        id: "toggleStaged",
        labelKey: "settings.shortcuts.items.toggleStaged.label",
      },
      {
        id: "togglePrs",
        labelKey: "settings.shortcuts.items.togglePrs.label",
      },
      {
        id: "toggleFiles",
        labelKey: "settings.shortcuts.items.toggleFiles.label",
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.groups.terminal",
    items: [
      {
        id: "clearTerminal",
        labelKey: "settings.shortcuts.items.clearTerminal.label",
      },
      {
        id: "previousConversation",
        labelKey: "settings.shortcuts.items.previousConversation.label",
      },
      {
        id: "nextConversation",
        labelKey: "settings.shortcuts.items.nextConversation.label",
      },
      {
        id: "toggleMultiInput",
        labelKey: "settings.shortcuts.items.toggleMultiInput.label",
      },
      {
        id: "reloadShellEnv",
        labelKey: "settings.shortcuts.items.reloadShellEnv.label",
      },
    ],
  },
  {
    titleKey: "settings.shortcuts.groups.view",
    items: [
      {
        id: "uiScaleDown",
        labelKey: "settings.shortcuts.items.uiScaleDown.label",
      },
      {
        id: "uiScaleUp",
        labelKey: "settings.shortcuts.items.uiScaleUp.label",
      },
      {
        id: "uiScaleReset",
        labelKey: "settings.shortcuts.items.uiScaleReset.label",
      },
    ],
  },
];

function shortcutLabel(t: SettingsTranslator, id: HotkeyId): string {
  for (const group of SHORTCUT_GROUPS) {
    const item = group.items.find((candidate) => candidate.id === id);
    if (item) return st(t, item.labelKey);
  }
  return id;
}

function findShortcutConflict(
  shortcuts: HotkeyConfig,
  currentId: HotkeyId,
  binding: string,
): HotkeyId | null {
  for (const group of SHORTCUT_GROUPS) {
    for (const item of group.items) {
      if (item.id === currentId) continue;
      if (hotkeyBindingsFor(shortcuts, item.id).includes(binding)) {
        return item.id;
      }
    }
  }
  return null;
}

function st(t: SettingsTranslator, key: TranslationKey): string {
  return t(key);
}

function stf(
  t: SettingsTranslator,
  key: TranslationKey,
  values: Record<string, string | number>,
): string {
  return st(t, key).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

function messageFromUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

export function SettingsModal() {
  const open = useSettings((s) => s.open);
  const setOpen = useSettings((s) => s.setOpen);
  const reset = useSettings((s) => s.reset);
  const pendingTab = useSettings((s) => s.pendingTab);
  const consumePendingTab = useSettings((s) => s.consumePendingTab);
  const [tab, setTab] = useState<Tab>("interface");
  const [sessionTitlePromptOpen, setSessionTitlePromptOpen] = useState(false);
  const t = useTranslation();

  // When the store reports a pending tab (e.g. StatusBar daemon button
  // dispatched `acorn:open-settings` with `tab: "services"`),
  // jump there on the next render and clear the flag so subsequent
  // opens restore the user's manual tab choice. Subscribing to
  // `pendingTab` (not just `open`) makes the deep-link work even when
  // the modal is already open — without it the effect would only fire
  // on the open-flag transition and a repeat click would no-op.
  useEffect(() => {
    if (!open || pendingTab === null) return;
    const pending = consumePendingTab();
    if (pending && TAB_IDS.has(pending)) {
      setTab(pending as Tab);
    }
  }, [open, pendingTab, consumePendingTab]);

  useEffect(() => {
    if (!open) setSessionTitlePromptOpen(false);
  }, [open]);

  // Esc cancels, Enter (outside inputs) closes — settings autosave on every
  // change so there is no separate confirm step. While a child settings dialog
  // is open, let that dialog own Escape.
  useDialogShortcuts(open && !sessionTitlePromptOpen, {
    onCancel: () => setOpen(false),
    onConfirm: () => setOpen(false),
  });

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      variant="dialog"
      size="2xl"
      ariaLabelledBy="acorn-settings-title"
    >
      <ModalHeader
        title={t("settings.title")}
        titleId="acorn-settings-title"
        icon={<SettingsIcon size={14} className="text-fg-muted" />}
        variant="dialog"
        onClose={() => setOpen(false)}
      />
      <div className="flex h-[28rem]">
        <nav className="flex w-40 shrink-0 flex-col border-r border-border bg-bg-sidebar/40 py-2">
          {TABS.map((tabMeta) => (
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
              {t(tabMeta.labelKey)}
            </button>
          ))}
          <div className="mt-auto px-4 pb-2">
            <button
              type="button"
              onClick={reset}
              className="text-[11px] text-fg-muted transition hover:text-danger"
            >
              {t("settings.reset")}
            </button>
          </div>
        </nav>
        <div className="flex-1 overflow-y-auto p-4">
          {tab === "interface" ? (
            <InterfaceSettings t={t} />
          ) : tab === "appearance" ? (
            <AppearanceSettings />
          ) : tab === "terminal" ? (
            <TerminalSettings />
          ) : tab === "agents" ? (
            <AgentSettings
              sessionTitlePromptOpen={sessionTitlePromptOpen}
              onSessionTitlePromptOpenChange={setSessionTitlePromptOpen}
            />
          ) : tab === "sessions" ? (
            <SessionSettings />
          ) : tab === "services" ? (
            <ServicesSettings />
          ) : tab === "github" ? (
            <GithubSettings />
          ) : tab === "editor" ? (
            <EditorSettings />
          ) : tab === "notifications" ? (
            <NotificationSettings />
          ) : tab === "shortcuts" ? (
            <ShortcutsSettings />
          ) : tab === "storage" ? (
            <StorageSettings />
          ) : tab === "experiments" ? (
            <ExperimentsSettings />
          ) : (
            <AboutSettings />
          )}
        </div>
      </div>
    </Modal>
  );
}

function TerminalSettings() {
  const settings = useSettings((s) => s.settings);
  const patchTerminal = useSettings((s) => s.patchTerminal);
  const t = useTranslation();

  return (
    <section className="space-y-4">
      <Field
        label={st(t, "settings.terminal.fontFamily.label")}
        hint={st(t, "settings.terminal.fontFamily.hint")}
      >
        <TerminalFontFamilyInput
          value={settings.terminal.fontFamily}
          onCommit={(fontFamily) => patchTerminal({ fontFamily })}
        />
      </Field>
      <Field
        label={st(t, "settings.terminal.fontSize.label")}
        hint={st(t, "settings.terminal.fontSize.hint")}
      >
        <Stepper
          value={settings.terminal.fontSize}
          min={8}
          max={32}
          unit="px"
          onChange={(n) => patchTerminal({ fontSize: n })}
        />
      </Field>
      <Field
        label={st(t, "settings.terminal.fontWeight.label")}
        hint={st(t, "settings.terminal.fontWeight.hint")}
      >
        <WeightSelect
          value={settings.terminal.fontWeight}
          onChange={(v) => patchTerminal({ fontWeight: v })}
        />
      </Field>
      <Field
        label={st(t, "settings.terminal.boldFontWeight.label")}
        hint={st(t, "settings.terminal.boldFontWeight.hint")}
      >
        <WeightSelect
          value={settings.terminal.fontWeightBold}
          onChange={(v) => patchTerminal({ fontWeightBold: v })}
        />
      </Field>
      <Field
        label={st(t, "settings.terminal.lineHeight.label")}
        hint={st(t, "settings.terminal.lineHeight.hint")}
      >
        <Stepper
          value={settings.terminal.lineHeight}
          min={1.0}
          max={2.0}
          step={0.05}
          format={(n) => n.toFixed(2)}
          onChange={(n) => patchTerminal({ lineHeight: n })}
        />
      </Field>
      <Field
        label={st(t, "settings.terminal.maxMountedTerminals.label")}
        hint={st(t, "settings.terminal.maxMountedTerminals.hint")}
      >
        <Stepper
          value={settings.terminal.maxMountedTerminals}
          min={MOUNTED_TERMINAL_LIMIT_MIN}
          max={MOUNTED_TERMINAL_LIMIT_MAX}
          onChange={(n) => patchTerminal({ maxMountedTerminals: n })}
        />
      </Field>
      <Field
        label={st(t, "settings.terminal.openLinksOn.label")}
        hint={st(t, "settings.terminal.openLinksOn.hint")}
      >
        <div className="flex flex-col gap-1.5">
          <RadioCard<TerminalLinkActivation>
            name="terminal-link-activation"
            value="click"
            current={settings.terminal.linkActivation}
            label={st(t, "settings.terminal.openLinksOn.click.label")}
            description={st(
              t,
              "settings.terminal.openLinksOn.click.description",
            )}
            onSelect={(v) => patchTerminal({ linkActivation: v })}
          />
          <RadioCard<TerminalLinkActivation>
            name="terminal-link-activation"
            value="modifier-click"
            current={settings.terminal.linkActivation}
            label={`${MODIFIER_LABEL}-click`}
            description={stf(
              t,
              "settings.terminal.openLinksOn.modifierClick.description",
              { modifier: MODIFIER_LABEL },
            )}
            onSelect={(v) => patchTerminal({ linkActivation: v })}
          />
        </div>
      </Field>
    </section>
  );
}

function TerminalFontFamilyInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    valueRef.current = value;
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  const commitDraft = useCallback(() => {
    const next = draftRef.current;
    if (next === valueRef.current) return;
    valueRef.current = next;
    onCommitRef.current(next);
  }, []);

  useEffect(() => () => commitDraft(), [commitDraft]);

  return (
    <TextInput
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        draftRef.current = next;
        setDraft(next);
      }}
      onBlur={commitDraft}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commitDraft();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|od|ad)/.test(navigator.platform);
const MODIFIER_LABEL = IS_MAC ? "⌘" : "Ctrl";

interface WeightSelectProps {
  value: TerminalFontWeight;
  onChange: (v: TerminalFontWeight) => void;
}

function WeightSelect({ value, onChange }: WeightSelectProps) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as TerminalFontWeight)}
      className="w-48"
    >
      {TERMINAL_FONT_WEIGHTS.map((w) => (
        <option key={w.value} value={w.value}>
          {w.label}
        </option>
      ))}
    </Select>
  );
}

function SessionSettings() {
  const settings = useSettings((s) => s.settings);
  const patchSessions = useSettings((s) => s.patchSessions);
  const t = useTranslation();

  return (
    <section className="space-y-4">
      <Field
        label={st(t, "settings.sessions.confirmRemove.label")}
        hint={st(t, "settings.sessions.confirmRemove.hint")}
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={settings.sessions.confirmRemove}
            onChange={(e) =>
              patchSessions({ confirmRemove: e.target.checked })
            }
            className="accent-[var(--color-accent)]"
          />
          {st(t, "settings.sessions.confirmRemove.checkbox")}
        </label>
      </Field>
      <Field
        label={st(t, "settings.sessions.autoDeleteWorktrees.label")}
        hint={st(t, "settings.sessions.autoDeleteWorktrees.hint")}
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={settings.sessions.autoDeleteWorktrees}
            onChange={(e) =>
              patchSessions({ autoDeleteWorktrees: e.target.checked })
            }
            className="accent-[var(--color-accent)]"
          />
          {st(t, "settings.sessions.autoDeleteWorktrees.checkbox")}
        </label>
      </Field>
      <Field
        label={st(
          t,
          "settings.sessions.autoDeleteEmptyWorktreeWorkspaces.label",
        )}
        hint={st(
          t,
          "settings.sessions.autoDeleteEmptyWorktreeWorkspaces.hint",
        )}
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={settings.sessions.autoDeleteEmptyWorktreeWorkspaces}
            onChange={(e) =>
              patchSessions({
                autoDeleteEmptyWorktreeWorkspaces: e.target.checked,
              })
            }
            className="accent-[var(--color-accent)]"
          />
          {st(
            t,
            "settings.sessions.autoDeleteEmptyWorktreeWorkspaces.checkbox",
          )}
        </label>
      </Field>
      <Field
        label={st(t, "settings.sessions.closeOnExit.label")}
        hint={st(t, "settings.sessions.closeOnExit.hint")}
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={settings.sessions.closeOnExit}
            onChange={(e) => patchSessions({ closeOnExit: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          {st(t, "settings.sessions.closeOnExit.checkbox")}
        </label>
      </Field>
    </section>
  );
}

function ServicesSettings() {
  const t = useTranslation();

  return (
    <section className="space-y-6">
      <SettingsGroup
        title={st(t, "settings.power.title")}
        description={st(t, "settings.power.description")}
      >
        <PowerSettings />
      </SettingsGroup>
      <ControlSessionInstallSection />
      <SettingsGroup
        title={st(t, "settings.sessions.background.title")}
        description={st(t, "settings.sessions.background.description")}
      >
        <BackgroundSessionsSettings />
      </SettingsGroup>
    </section>
  );
}

function PowerSettings() {
  const preventSleep = useSettings((s) => s.settings.power.preventSleep);
  const patchPower = useSettings((s) => s.patchPower);
  const t = useTranslation();

  return (
    <CheckboxRow
      label={st(t, "settings.power.preventSleep.label")}
      description={st(t, "settings.power.preventSleep.description")}
      checked={preventSleep}
      onChange={(v) => patchPower({ preventSleep: v })}
    />
  );
}

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 border-t border-border pt-5">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {title}
        </h3>
        {description ? (
          <p className="mt-0.5 text-[11px] text-fg-muted/80">{description}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function ControlSessionInstallSection() {
  const [status, setStatus] = useState<
    import("../lib/types").AcornIpcStatus | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslation();

  const refresh = useCallback(async () => {
    try {
      const next = await api.getAcornIpcStatus();
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <Field
        label={st(t, "settings.sessions.controlCli.label")}
        hint={st(t, "settings.sessions.controlCli.errorHint")}
      >
        <p className="text-[11px] text-danger">{error}</p>
      </Field>
    );
  }

  if (!status) {
    return (
      <Field
        label={st(t, "settings.sessions.controlCli.label")}
        hint={st(t, "settings.sessions.controlCli.loadingHint")}
      >
        <p className="text-[11px] text-fg-muted">…</p>
      </Field>
    );
  }

  const activeShim = status.shim_paths.find((s) => s.exists) ?? null;
  const installTarget =
    status.shim_paths[0]?.path ?? "/usr/local/bin/acorn-ipc";
  const installCommand = status.bundled_path
    ? `sudo ln -sf "${status.bundled_path}" "${installTarget}"`
    : "";

  return (
    <Field
      label={st(t, "settings.sessions.controlCli.label")}
      hint={st(t, "settings.sessions.controlCli.hint")}
    >
      <div className="space-y-2">
        <div className="rounded-md border border-border bg-bg px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">
              {st(t, "settings.sessions.controlCli.bundledBinary")}
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                status.bundled_exists
                  ? "bg-accent/15 text-accent"
                  : "bg-warning/15 text-warning",
              )}
            >
              {status.bundled_exists
                ? st(t, "settings.sessions.controlCli.found")
                : st(t, "settings.sessions.controlCli.missing")}
            </span>
          </div>
          <code className="mt-1 block truncate font-mono text-fg">
            {status.bundled_path || "(unknown)"}
          </code>
        </div>
        <div className="rounded-md border border-border bg-bg px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">
              {st(t, "settings.sessions.controlCli.installedShim")}
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                activeShim
                  ? "bg-accent/15 text-accent"
                  : "bg-bg-elevated text-fg-muted",
              )}
            >
              {activeShim
                ? st(t, "settings.sessions.controlCli.installed")
                : st(t, "settings.sessions.controlCli.notInstalled")}
            </span>
          </div>
          <code className="mt-1 block truncate font-mono text-fg">
            {activeShim ? activeShim.path : installTarget}
          </code>
        </div>
        {!activeShim && status.bundled_exists && installCommand ? (
          <CommandHint command={installCommand} repoPath={null} />
        ) : null}
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[11px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
        >
          {st(t, "settings.sessions.controlCli.recheck")}
        </button>
      </div>
    </Field>
  );
}

function GithubSettings() {
  const settings = useSettings((s) => s.settings);
  const patchGithub = useSettings((s) => s.patchGithub);
  const t = useTranslation();

  return (
    <section className="space-y-4">
      <Field
        label={st(t, "settings.github.refreshInterval.label")}
        hint={st(t, "settings.github.refreshInterval.hint")}
      >
        <Select
          value={settings.github.refreshIntervalMs}
          onChange={(e) =>
            patchGithub({
              refreshIntervalMs: Number(e.target.value),
            })
          }
          className="w-48"
          aria-label={st(t, "settings.github.refreshInterval.label")}
        >
          {PR_REFRESH_INTERVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-[11px] text-fg-muted">
        {st(t, "settings.github.manualRefresh")}
      </p>
      <Field
        label={st(t, "settings.github.listDensity.label")}
        hint={st(t, "settings.github.listDensity.hint")}
      >
        <CheckboxRow
          label={st(t, "settings.github.showAuthorAvatars.label")}
          description={st(t, "settings.github.showAuthorAvatars.description")}
          checked={settings.github.showAvatars}
          onChange={(v) => patchGithub({ showAvatars: v })}
        />
        <CheckboxRow
          label={st(t, "settings.github.showLabels.label")}
          description={st(t, "settings.github.showLabels.description")}
          checked={settings.github.showLabels}
          onChange={(v) => patchGithub({ showLabels: v })}
        />
        <CheckboxRow
          label={st(t, "settings.github.showBranches.label")}
          description={st(t, "settings.github.showBranches.description")}
          checked={settings.github.showBranches}
          onChange={(v) => patchGithub({ showBranches: v })}
        />
        <CheckboxRow
          label={st(t, "settings.github.showChecks.label")}
          description={st(t, "settings.github.showChecks.description")}
          checked={settings.github.showChecks}
          onChange={(v) => patchGithub({ showChecks: v })}
        />
      </Field>
    </section>
  );
}

function InterfaceSettings({ t }: { t: SettingsTranslator }) {
  const settings = useSettings((s) => s.settings);
  const patchLanguage = useSettings((s) => s.patchLanguage);
  const patchStatusBar = useSettings((s) => s.patchStatusBar);
  const patchSessionDisplay = useSettings((s) => s.patchSessionDisplay);
  const patchAppearance = useSettings((s) => s.patchAppearance);
  const sessionDisplay = settings.sessionDisplay;

  return (
    <section className="space-y-6">
      <LanguageSection
        language={settings.language}
        onChange={patchLanguage}
        t={t}
      />
      <UiScaleSection
        value={settings.appearance.uiScalePercent}
        onChange={(uiScalePercent) => patchAppearance({ uiScalePercent })}
      />
      <SessionDisplaySection
        sessionDisplay={sessionDisplay}
        patch={patchSessionDisplay}
      />
      <StatusBarSection
        statusBar={settings.statusBar}
        patch={patchStatusBar}
      />
    </section>
  );
}

function AppearanceSettings() {
  const appearance = useSettings((s) => s.settings.appearance);
  const patchAppearance = useSettings((s) => s.patchAppearance);

  return (
    <section className="space-y-6">
      <ThemeSection
        themeId={appearance.themeId}
        onChange={(themeId) => patchAppearance({ themeId })}
      />
      <ToastPositionSection
        value={appearance.toastPosition}
        onChange={(toastPosition) => patchAppearance({ toastPosition })}
      />
      <BackgroundSection
        state={appearance.background}
        onChange={(background) => patchAppearance({ background })}
      />
    </section>
  );
}

function LanguageSection({
  language,
  onChange,
  t,
}: {
  language: Language;
  onChange: (language: Language) => void;
  t: SettingsTranslator;
}) {
  return (
    <Field
      label={t("settings.language.label")}
      hint={t("settings.language.hint")}
    >
      <Select
        value={language}
        onChange={(e) => onChange(e.target.value as Language)}
        className="w-48"
        aria-label={t("settings.language.label")}
      >
        {LANGUAGE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.nativeLabel}
          </option>
        ))}
      </Select>
    </Field>
  );
}

const UI_SCALE_PRESETS = [75, 80, 90, 100, 110, 125, 150] as const;

function UiScaleSection({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const t = useTranslation();
  const presets = UI_SCALE_PRESETS.includes(
    value as (typeof UI_SCALE_PRESETS)[number],
  )
    ? UI_SCALE_PRESETS
    : [...UI_SCALE_PRESETS, value].sort((a, b) => a - b);

  const commitValue = (next: number) => {
    if (!Number.isFinite(next)) return;
    onChange(next);
  };

  return (
    <Field
      label={st(t, "settings.appearance.uiScale.label")}
      hint={st(t, "settings.appearance.uiScale.hint")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(value)}
          onChange={(e) => commitValue(Number(e.target.value))}
          className="w-32"
          aria-label={st(t, "settings.appearance.uiScale.label")}
        >
          {presets.map((preset) => (
            <option key={preset} value={preset}>
              {preset}%
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

function buildThemeSelectItems(
  themes: ReadonlyArray<AcornTheme>,
  t: SettingsTranslator,
): Array<SelectItem | SelectOptionGroup> {
  const customLabel = st(t, "settings.appearance.theme.custom");
  const acornBuiltIns = themes.filter(isAcornBuiltInTheme);
  const otherBuiltInDark = themes.filter(
    (theme) =>
      theme.source === "builtin" &&
      theme.mode === "dark" &&
      !isAcornBuiltInTheme(theme),
  );
  const otherBuiltInLight = themes.filter(
    (theme) =>
      theme.source === "builtin" &&
      theme.mode === "light" &&
      !isAcornBuiltInTheme(theme),
  );
  const userThemes = themes.filter((theme) => theme.source === "user");

  const sections: SelectOptionGroup[] = [
    {
      label: st(t, "settings.appearance.theme.groups.acorn"),
      options: acornBuiltIns.map((theme) => themeToSelectOption(theme)),
    },
    {
      label: st(t, "settings.appearance.theme.groups.dark"),
      options: otherBuiltInDark.map((theme) => themeToSelectOption(theme)),
    },
    {
      label: st(t, "settings.appearance.theme.groups.light"),
      options: otherBuiltInLight.map((theme) => themeToSelectOption(theme)),
    },
    {
      label: st(t, "settings.appearance.theme.groups.custom"),
      options: userThemes.map((theme) =>
        themeToSelectOption(theme, customLabel),
      ),
    },
  ].filter((section) => section.options.length > 0);

  const items: Array<SelectItem | SelectOptionGroup> = [];
  for (const [index, section] of sections.entries()) {
    if (index > 0) {
      items.push({ type: "separator" });
    }
    items.push(section);
  }
  return items;
}

function isAcornBuiltInTheme(theme: AcornTheme): boolean {
  return (
    theme.source === "builtin" &&
    (theme.id.startsWith("acorn-") || theme.label.startsWith("Acorn "))
  );
}

function themeToSelectOption(theme: AcornTheme, suffix?: string) {
  const label = suffix ? `${theme.label} ${suffix}` : theme.label;
  return {
    value: theme.id,
    label,
    searchText: [theme.id, theme.label, suffix].filter(Boolean).join(" "),
  };
}

function ThemeSection({
  themeId,
  onChange,
}: {
  themeId: string;
  onChange: (id: string) => void;
}) {
  const themes = useThemes((s) => s.themes);
  const refresh = useThemes((s) => s.refresh);
  const t = useTranslation();
  const themeOptions = buildThemeSelectItems(themes, t);

  return (
    <Field
      label={st(t, "settings.appearance.theme.label")}
      hint={st(t, "settings.appearance.theme.hint")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={themeId}
          onValueChange={onChange}
          options={themeOptions}
          searchable
          searchPlaceholder={st(
            t,
            "settings.appearance.theme.searchPlaceholder",
          )}
          className="min-w-[14rem]"
          aria-label={st(t, "settings.appearance.theme.label")}
        />
        <Tooltip
          label={st(t, "settings.appearance.theme.rescanTitle")}
          side="bottom"
        >
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-fg"
          >
            <RefreshCcw size={12} />{" "}
            {st(t, "settings.appearance.theme.refresh")}
          </button>
        </Tooltip>
        <button
          type="button"
          onClick={() => void revealThemesFolder()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-fg"
        >
          <FolderOpen size={12} />{" "}
          {st(t, "settings.appearance.theme.revealFolder")}
        </button>
      </div>
    </Field>
  );
}

function ToastPositionSection({
  value,
  onChange,
}: {
  value: ToastPosition;
  onChange: (value: ToastPosition) => void;
}) {
  const t = useTranslation();

  return (
    <Field
      label={st(t, "settings.appearance.toastPosition.label")}
      hint={st(t, "settings.appearance.toastPosition.hint")}
    >
      <div className="grid max-w-md grid-cols-2 gap-2">
        {TOAST_POSITION_OPTIONS.map((option) => (
          <RadioCard<ToastPosition>
            key={option.value}
            name="toast-position"
            value={option.value}
            current={value}
            label={st(
              t,
              `settings.appearance.toastPosition.options.${option.value}`,
            )}
            onSelect={onChange}
          />
        ))}
      </div>
    </Field>
  );
}

type BackgroundSettings = AcornSettings["appearance"]["background"];

function BackgroundSection({
  state,
  onChange,
}: {
  state: BackgroundSettings;
  onChange: (patch: Partial<BackgroundSettings>) => void;
}) {
  const [pickError, setPickError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const t = useTranslation();
  const showToast = useToasts((s) => s.show);

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setPickError(null);
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await importBackgroundImage(file.name, bytes);
      onChange({
        relativePath: result.relativePath,
        fileName: result.fileName,
        applyToApp: true,
        applyToTerminal: true,
      });
      showToast(st(t, "settings.appearance.background.toasts.imported"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPickError(message);
      showToast(
        `${st(t, "settings.appearance.background.toasts.importFailed")} ${message}`,
      );
    }
  };

  const remove = async () => {
    try {
      if (state.relativePath) {
        await removeBackgroundImage(state.relativePath);
      }
      onChange({
        relativePath: null,
        fileName: null,
        applyToApp: false,
        applyToTerminal: false,
      });
      showToast(st(t, "settings.appearance.background.toasts.removed"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPickError(message);
      showToast(
        `${st(t, "settings.appearance.background.toasts.removeFailed")} ${message}`,
      );
    }
  };

  return (
    <Field
      label={st(t, "settings.appearance.background.label")}
      hint={st(t, "settings.appearance.background.hint")}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => void handleFileChange(event)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg transition hover:bg-bg-elevated"
          >
            <ImagePlus size={12} />{" "}
            {state.relativePath
              ? st(t, "settings.appearance.background.replace")
              : st(t, "settings.appearance.background.pickImage")}
          </button>
          <span className="min-w-0 truncate text-[11px] text-fg-muted">
            {state.fileName ?? st(t, "settings.appearance.background.noImage")}
          </span>
          {state.relativePath ? (
            <button
              type="button"
              onClick={() => void remove()}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-danger"
            >
              <Trash2 size={12} />{" "}
              {st(t, "settings.appearance.background.remove")}
            </button>
          ) : null}
        </div>
        {pickError ? (
          <div className="text-[11px] text-danger">{pickError}</div>
        ) : null}
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label={st(t, "settings.appearance.background.applyToApp")}
            checked={state.applyToApp}
            disabled={!state.relativePath}
            onChange={(checked) => onChange({ applyToApp: checked })}
          />
          <CheckboxRow
            label={st(t, "settings.appearance.background.applyToTerminal")}
            checked={state.applyToTerminal}
            disabled={!state.relativePath}
            onChange={(checked) => onChange({ applyToTerminal: checked })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-fg-muted">
            {st(t, "settings.appearance.background.fit.label")}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {(["cover", "contain", "tile"] as BackgroundFit[]).map((fit) => (
              <RadioCard<BackgroundFit>
                key={fit}
                name="acorn-bg-fit"
                value={fit}
                current={state.fit}
                label={st(t, `settings.appearance.background.fit.${fit}`)}
                onSelect={(value) => onChange({ fit: value })}
              />
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={st(t, "settings.appearance.background.opacity.label")}
            hint={st(t, "settings.appearance.background.opacity.hint")}
          >
            <Stepper
              value={Math.round(state.opacity * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(value) => onChange({ opacity: value / 100 })}
            />
          </Field>
          <Field label={st(t, "settings.appearance.background.blur")}>
            <Stepper
              value={state.blur}
              min={0}
              max={24}
              step={1}
              unit="px"
              onChange={(value) => onChange({ blur: value })}
            />
          </Field>
        </div>
      </div>
    </Field>
  );
}

function SessionDisplaySection({
  sessionDisplay,
  patch,
}: {
  sessionDisplay: AcornSettings["sessionDisplay"];
  patch: (
    patch: Partial<
      Omit<AcornSettings["sessionDisplay"], "metadata" | "icons">
    > & {
      metadata?: Partial<AcornSettings["sessionDisplay"]["metadata"]>;
      icons?: Partial<AcornSettings["sessionDisplay"]["icons"]>;
    },
  ) => void;
}) {
  const t = useTranslation();

  return (
    <>
      <Field
        label={st(t, "settings.appearance.sessionDisplay.title.label")}
        hint={st(t, "settings.appearance.sessionDisplay.title.hint")}
      >
        <div className="flex flex-col gap-1.5">
          {SESSION_TITLE_OPTIONS.map((opt) => (
            <RadioCard<SessionTitleSource>
              key={opt.value}
              name="acorn-session-title"
              value={opt.value}
              current={sessionDisplay.title}
              label={st(
                t,
                `settings.appearance.sessionDisplay.title.options.${opt.value}.label`,
              )}
              description={st(
                t,
                `settings.appearance.sessionDisplay.title.options.${opt.value}.description`,
              )}
              onSelect={(v) => patch({ title: v })}
            />
          ))}
        </div>
      </Field>
      <Field
        label={st(t, "settings.appearance.sessionDisplay.metadata.label")}
        hint={st(t, "settings.appearance.sessionDisplay.metadata.hint")}
      >
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label={st(
              t,
              "settings.appearance.sessionDisplay.metadata.branch.label",
            )}
            description={st(
              t,
              "settings.appearance.sessionDisplay.metadata.branch.description",
            )}
            checked={sessionDisplay.metadata.branch}
            onChange={(v) => patch({ metadata: { branch: v } })}
          />
          <CheckboxRow
            label={st(
              t,
              "settings.appearance.sessionDisplay.metadata.workingDirectory.label",
            )}
            description={st(
              t,
              "settings.appearance.sessionDisplay.metadata.workingDirectory.description",
            )}
            checked={sessionDisplay.metadata.workingDirectory}
            onChange={(v) => patch({ metadata: { workingDirectory: v } })}
          />
          <CheckboxRow
            label={st(
              t,
              "settings.appearance.sessionDisplay.metadata.status.label",
            )}
            description={st(
              t,
              "settings.appearance.sessionDisplay.metadata.status.description",
            )}
            checked={sessionDisplay.metadata.status}
            onChange={(v) => patch({ metadata: { status: v } })}
          />
        </div>
      </Field>
      <Field
        label={st(t, "settings.appearance.sessionDisplay.icons.label")}
        hint={st(t, "settings.appearance.sessionDisplay.icons.hint")}
      >
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label={st(
              t,
              "settings.appearance.sessionDisplay.icons.statusDot.label",
            )}
            description={st(
              t,
              "settings.appearance.sessionDisplay.icons.statusDot.description",
            )}
            checked={sessionDisplay.icons.statusDot}
            onChange={(v) => patch({ icons: { statusDot: v } })}
          />
          <CheckboxRow
            label={st(
              t,
              "settings.appearance.sessionDisplay.icons.agentProvider.label",
            )}
            description={st(
              t,
              "settings.appearance.sessionDisplay.icons.agentProvider.description",
            )}
            checked={sessionDisplay.icons.agentProvider}
            onChange={(v) => patch({ icons: { agentProvider: v } })}
          />
          <CheckboxRow
            label={st(
              t,
              "settings.appearance.sessionDisplay.icons.sessionKind.label",
            )}
            description={st(
              t,
              "settings.appearance.sessionDisplay.icons.sessionKind.description",
            )}
            checked={sessionDisplay.icons.sessionKind}
            onChange={(v) => patch({ icons: { sessionKind: v } })}
          />
        </div>
      </Field>
      <Field
        label={st(t, "settings.appearance.sessionDisplay.hover.label")}
        hint={st(t, "settings.appearance.sessionDisplay.hover.hint")}
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={sessionDisplay.showDetailsOnHover}
            onChange={(e) => patch({ showDetailsOnHover: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          {st(t, "settings.appearance.sessionDisplay.hover.checkbox")}
        </label>
      </Field>
    </>
  );
}

function StatusBarSection({
  statusBar,
  patch,
}: {
  statusBar: AcornSettings["statusBar"];
  patch: (patch: Partial<AcornSettings["statusBar"]>) => void;
}) {
  const t = useTranslation();

  return (
    <Field
      label={st(t, "settings.appearance.statusBar.label")}
      hint={st(t, "settings.appearance.statusBar.hint")}
    >
      <div className="flex flex-col gap-1">
        <CheckboxRow
          label={st(t, "settings.appearance.statusBar.sessionActivity.label")}
          description={st(
            t,
            "settings.appearance.statusBar.sessionActivity.description",
          )}
          checked={statusBar.showSessionActivity !== false}
          onChange={(v) => patch({ showSessionActivity: v })}
        />
        <CheckboxRow
          label={st(t, "settings.appearance.statusBar.sessionCount.label")}
          description={st(
            t,
            "settings.appearance.statusBar.sessionCount.description",
          )}
          checked={statusBar.showSessionCount}
          onChange={(v) => patch({ showSessionCount: v })}
        />
        <CheckboxRow
          label={st(
            t,
            "settings.appearance.statusBar.activeSessionStatus.label",
          )}
          description={st(
            t,
            "settings.appearance.statusBar.activeSessionStatus.description",
          )}
          checked={statusBar.showSessionStatus}
          onChange={(v) => patch({ showSessionStatus: v })}
        />
        <CheckboxRow
          label={st(t, "settings.appearance.statusBar.githubAccount.label")}
          description={st(
            t,
            "settings.appearance.statusBar.githubAccount.description",
          )}
          checked={statusBar.showGithubAccount}
          onChange={(v) => patch({ showGithubAccount: v })}
        />
        <CheckboxRow
          label={st(t, "settings.appearance.statusBar.workingDirectory.label")}
          description={st(
            t,
            "settings.appearance.statusBar.workingDirectory.description",
          )}
          checked={statusBar.showWorkingDirectory}
          onChange={(v) => patch({ showWorkingDirectory: v })}
        />
        <CheckboxRow
          label={st(t, "settings.appearance.statusBar.agentTokenUsage.label")}
          description={st(
            t,
            "settings.appearance.statusBar.agentTokenUsage.description",
          )}
          checked={statusBar.showAgentTokenUsage}
          onChange={(v) => patch({ showAgentTokenUsage: v })}
        />
        <CheckboxRow
          label={st(t, "settings.appearance.statusBar.memoryUsage.label")}
          description={st(
            t,
            "settings.appearance.statusBar.memoryUsage.description",
          )}
          checked={statusBar.showMemory}
          onChange={(v) => patch({ showMemory: v })}
        />
      </div>
    </Field>
  );
}

function EditorSettings() {
  const settings = useSettings((s) => s.settings);
  const patchEditor = useSettings((s) => s.patchEditor);
  const t = useTranslation();

  return (
    <section className="space-y-4">
      <Field
        label={st(t, "settings.editor.command.label")}
        hint={st(t, "settings.editor.command.hint")}
      >
        <TextInput
          value={settings.editor.command}
          onChange={(e) => patchEditor({ command: e.target.value })}
          placeholder={st(t, "settings.editor.command.placeholder")}
        />
      </Field>
      <p className="text-[11px] text-fg-muted">
        {st(t, "settings.editor.command.description")}
      </p>
    </section>
  );
}

function NotificationSettings() {
  const settings = useSettings((s) => s.settings);
  const patchNotifications = useSettings((s) => s.patchNotifications);
  const t = useTranslation();
  const enabled = settings.notifications.enabled;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { tone: "success" | "warning" | "danger"; text: string }
    | null
  >(null);
  const showToast = useToasts((s) => s.show);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTestNotification();
      if (result === "sent") {
        const text = st(t, "settings.notifications.test.result.sent");
        setTestResult({
          tone: "success",
          text,
        });
        showToast(text);
      } else if (result === "denied") {
        const text = st(t, "settings.notifications.test.result.denied");
        setTestResult({
          tone: "warning",
          text,
        });
        showToast(text);
      } else {
        const text = st(t, "settings.notifications.test.result.failed");
        setTestResult({
          tone: "danger",
          text,
        });
        showToast(text);
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="space-y-4">
      <Field
        label={st(t, "settings.notifications.system.label")}
        hint={st(t, "settings.notifications.system.hint")}
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) =>
              patchNotifications({ enabled: e.target.checked })
            }
            className="accent-[var(--color-accent)]"
          />
          {st(t, "settings.notifications.system.enable")}
        </label>
      </Field>
      <Field label={st(t, "settings.notifications.triggers.label")}>
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label={st(t, "settings.notifications.triggers.needsInput.label")}
            description={st(
              t,
              "settings.notifications.triggers.needsInput.description",
            )}
            checked={settings.notifications.events.needsInput}
            disabled={!enabled}
            onChange={(v) =>
              patchNotifications({ events: { needsInput: v } })
            }
          />
          <CheckboxRow
            label={st(t, "settings.notifications.triggers.failed.label")}
            description={st(
              t,
              "settings.notifications.triggers.failed.description",
            )}
            checked={settings.notifications.events.failed}
            disabled={!enabled}
            onChange={(v) => patchNotifications({ events: { failed: v } })}
          />
          <CheckboxRow
            label={st(t, "settings.notifications.triggers.completed.label")}
            description={st(
              t,
              "settings.notifications.triggers.completed.description",
            )}
            checked={settings.notifications.events.completed}
            disabled={!enabled}
            onChange={(v) =>
              patchNotifications({ events: { completed: v } })
            }
          />
        </div>
      </Field>
      <Field
        label={st(t, "settings.notifications.history.label")}
        hint={st(t, "settings.notifications.history.hint")}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-fg">
              {st(t, "settings.notifications.history.maxCount")}
            </span>
            <Stepper
              value={settings.notifications.maxHistory}
              min={NOTIFICATION_HISTORY_LIMIT_MIN}
              max={NOTIFICATION_HISTORY_LIMIT_MAX}
              step={5}
              onChange={(maxHistory) => patchNotifications({ maxHistory })}
            />
          </div>
          <CheckboxRow
            label={st(t, "settings.notifications.history.autoDeleteRead.label")}
            description={st(
              t,
              "settings.notifications.history.autoDeleteRead.description",
            )}
            checked={settings.notifications.autoDeleteRead}
            onChange={(autoDeleteRead) =>
              patchNotifications({ autoDeleteRead })
            }
          />
        </div>
      </Field>
      <Field
        label={st(t, "settings.notifications.test.label")}
        hint={st(t, "settings.notifications.test.hint")}
      >
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-fg transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testing
              ? st(t, "settings.notifications.test.sending")
              : st(t, "settings.notifications.test.send")}
          </button>
          {testResult ? (
            <p
              className={cn(
                "rounded-md border px-3 py-1.5 text-[11px]",
                testResult.tone === "success" &&
                  "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
                testResult.tone === "warning" &&
                  "border-warning/40 bg-warning/10 text-warning",
                testResult.tone === "danger" &&
                  "border-danger/40 bg-danger/10 text-danger",
              )}
            >
              {testResult.text}
            </p>
          ) : null}
        </div>
      </Field>
      <p className="text-[11px] text-fg-muted">
        {st(t, "settings.notifications.permissionHint")}
      </p>
    </section>
  );
}

interface AgentSettingsProps {
  sessionTitlePromptOpen: boolean;
  onSessionTitlePromptOpenChange: (open: boolean) => void;
}

function AgentSettings({
  sessionTitlePromptOpen,
  onSessionTitlePromptOpenChange,
}: AgentSettingsProps) {
  const settings = useSettings((s) => s.settings);
  const patchAgents = useSettings((s) => s.patchAgents);
  const t = useTranslation();
  const selected = settings.agents.selected;

  return (
    <section className="space-y-4">
      <p className="rounded-md border border-border bg-bg-sidebar/40 px-3 py-2 text-[11px] text-fg-muted">
        {st(t, "settings.agents.intro.before")}
        <em>{st(t, "settings.agents.intro.action")}</em>
        {st(t, "settings.agents.intro.after")}
      </p>
      <Field
        label={st(t, "settings.agents.agent.label")}
        hint={st(t, "settings.agents.agent.hint")}
      >
        <div className="flex flex-col gap-1.5">
          {AGENT_OPTIONS.map((opt) => (
            <RadioCard<SelectedAgent>
              key={opt.value}
              name="acorn-agent"
              value={opt.value}
              current={selected}
              label={opt.label}
              description={opt.oneshotHint}
              onSelect={(v) => patchAgents({ selected: v })}
            />
          ))}
          <RadioCard<SelectedAgent>
            name="acorn-agent"
            value="custom"
            current={selected}
            label={st(t, "settings.agents.customOption.label")}
            description={st(t, "settings.agents.customOption.description")}
            onSelect={(v) => patchAgents({ selected: v })}
          />
        </div>
      </Field>
      {selected === "custom" ? (
        <Field
          label={st(t, "settings.agents.customCommand.label")}
          hint={st(t, "settings.agents.customCommand.hint")}
        >
          <TextInput
            value={settings.agents.customCommand}
            onChange={(e) =>
              patchAgents({ customCommand: e.target.value })
            }
            placeholder="e.g. codex --reply"
          />
        </Field>
      ) : null}
      <Field
        label={st(t, "settings.agents.sessionTitles.label")}
        hint={st(t, "settings.agents.sessionTitles.hint")}
      >
        <div className="flex items-center justify-between gap-3">
          <label className="flex min-w-0 items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              checked={settings.agents.autoGenerateSessionTitles}
              onChange={(e) =>
                patchAgents({ autoGenerateSessionTitles: e.target.checked })
              }
              className="accent-[var(--color-accent)]"
            />
            <span className="truncate">
              {st(t, "settings.agents.sessionTitles.checkbox")}
            </span>
          </label>
          <Tooltip
            label={st(t, "settings.agents.sessionTitlePrompt.open")}
            side="bottom"
          >
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={sessionTitlePromptOpen}
              aria-label={st(t, "settings.agents.sessionTitlePrompt.open")}
              onClick={() => onSessionTitlePromptOpenChange(true)}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2 text-[11px] font-medium text-fg-muted transition hover:border-accent/60 hover:bg-bg-elevated hover:text-fg"
            >
              <SettingsIcon size={12} />
              {st(t, "settings.agents.sessionTitlePrompt.shortButton")}
            </button>
          </Tooltip>
        </div>
      </Field>
      <SessionTitlePromptModal
        open={sessionTitlePromptOpen}
        onClose={() => onSessionTitlePromptOpenChange(false)}
      />
      <p className="text-[11px] text-fg-muted">
        {st(t, "settings.agents.requirement")}
      </p>
    </section>
  );
}

type SessionTitlePreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; title: string }
  | { status: "error"; message?: string };

interface SessionTitlePromptModalProps {
  open: boolean;
  onClose: () => void;
}

function SessionTitlePromptModal({
  open,
  onClose,
}: SessionTitlePromptModalProps) {
  const settings = useSettings((s) => s.settings);
  const patchAgents = useSettings((s) => s.patchAgents);
  const activeProject = useAppStore((s) => s.activeProject);
  const t = useTranslation();
  const sessionTitlePromptLength = Array.from(
    settings.agents.sessionTitlePrompt,
  ).length;
  const [titlePreview, setTitlePreview] = useState<SessionTitlePreviewState>({
    status: "idle",
  });

  useDialogShortcuts(open, {
    onCancel: onClose,
  });

  useEffect(() => {
    setTitlePreview({ status: "idle" });
  }, [
    open,
    settings.agents.selected,
    settings.agents.customCommand,
    settings.agents.ollama.model,
    settings.agents.llm.model,
    settings.agents.sessionTitlePrompt,
    activeProject,
  ]);

  async function handlePreviewSessionTitle() {
    setTitlePreview({ status: "loading" });
    const ai = resolveAiExecutionRequest(settings);
    const prompt = resolveSessionTitlePrompt(settings);
    try {
      const title = await api.previewSessionTitle(
        ai,
        prompt,
        SESSION_TITLE_PROMPT_PREVIEW_MESSAGE,
        activeProject,
      );
      setTitlePreview({ status: "success", title });
    } catch (error) {
      setTitlePreview({
        status: "error",
        message: messageFromUnknownError(error),
      });
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="dialog"
      size="xl"
      ariaLabelledBy="session-title-prompt-title"
      className="max-h-[calc(100vh-8rem)]"
    >
      <ModalHeader
        title={st(t, "settings.agents.sessionTitlePrompt.label")}
        subtitle={st(t, "settings.agents.sessionTitlePrompt.hint")}
        titleId="session-title-prompt-title"
        icon={<SettingsIcon size={14} className="text-fg-muted" />}
        variant="dialog"
        onClose={onClose}
      />
      <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-4">
        <Field
          label={st(t, "settings.agents.sessionTitlePrompt.editorLabel")}
        >
          <div className="flex flex-col gap-2">
            <textarea
              aria-label={st(t, "settings.agents.sessionTitlePrompt.label")}
              value={settings.agents.sessionTitlePrompt}
              maxLength={SESSION_TITLE_PROMPT_MAX_CHARS}
              spellCheck={false}
              onChange={(e) =>
                patchAgents({ sessionTitlePrompt: e.target.value })
              }
              className="min-h-40 w-full resize-y rounded-md border border-border bg-bg px-2 py-2 font-mono text-xs leading-relaxed text-fg outline-none focus:border-accent"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-fg-muted">
                {stf(t, "settings.agents.sessionTitlePrompt.count", {
                  count: sessionTitlePromptLength,
                  max: SESSION_TITLE_PROMPT_MAX_CHARS,
                })}
              </span>
              <Tooltip
                label={st(t, "settings.agents.sessionTitlePrompt.reset")}
                side="bottom"
              >
                <button
                  type="button"
                  onClick={() =>
                    patchAgents({
                      sessionTitlePrompt: DEFAULT_SESSION_TITLE_PROMPT,
                    })
                  }
                  disabled={
                    settings.agents.sessionTitlePrompt ===
                    DEFAULT_SESSION_TITLE_PROMPT
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent/60 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RefreshCcw size={11} />
                  {st(t, "settings.agents.sessionTitlePrompt.reset")}
                </button>
              </Tooltip>
            </div>
            <div className="rounded-md border border-border bg-bg-sidebar/30 p-2">
              <div className="mb-1 text-[11px] font-medium text-fg-muted">
                {st(t, "settings.agents.sessionTitlePrompt.preview.sample")}
              </div>
              <p className="font-mono text-[11px] leading-relaxed text-fg">
                {SESSION_TITLE_PROMPT_PREVIEW_MESSAGE}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handlePreviewSessionTitle()}
                  disabled={titlePreview.status === "loading"}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 text-[11px] font-medium text-fg transition hover:border-accent/50 hover:bg-bg-elevated disabled:cursor-wait disabled:bg-bg-sidebar/40 disabled:text-fg-muted"
                >
                  {titlePreview.status === "loading" ? (
                    <Loader2 size={12} className="animate-spin text-fg-muted" />
                  ) : (
                    <Sparkles size={12} className="text-accent" />
                  )}
                  {titlePreview.status === "loading"
                    ? st(
                        t,
                        "settings.agents.sessionTitlePrompt.preview.generating",
                      )
                    : st(
                        t,
                        "settings.agents.sessionTitlePrompt.preview.generate",
                      )}
                </button>
                {titlePreview.status === "success" && titlePreview.title ? (
                  <div className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-bg px-2 text-xs text-fg">
                    <span className="text-[10px] text-fg-muted">
                      {st(
                        t,
                        "settings.agents.sessionTitlePrompt.preview.result",
                      )}
                    </span>
                    <span className="max-w-48 truncate font-medium">
                      {titlePreview.title}
                    </span>
                  </div>
                ) : null}
              </div>
              {titlePreview.status === "error" ? (
                <p className="mt-2 text-[11px] text-danger">
                  {st(t, "settings.agents.sessionTitlePrompt.preview.failed")}
                  {titlePreview.message ? `: ${titlePreview.message}` : ""}
                </p>
              ) : null}
            </div>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Per-category cache descriptor surfaced in the Storage settings tab.
 * `loadSize` returns the on-disk byte total; `clear` deletes everything
 * the category owns and returns the number of items removed (purely for
 * the success message). New cache categories should drop in here as
 * additional entries — the UI iterates the list and renders one row per
 * entry, so no further wiring is required.
 */
interface CacheCategory {
  id: string;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  loadSize: () => Promise<number>;
  clear: () => Promise<number>;
}

const CACHE_CATEGORIES: CacheCategory[] = [
  {
    id: "scrollback-orphans",
    labelKey: "settings.storage.cacheCategories.scrollbackOrphans.label",
    descriptionKey:
      "settings.storage.cacheCategories.scrollbackOrphans.description",
    loadSize: () => api.scrollbackOrphanSize(),
    clear: () => api.scrollbackOrphanClear(),
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function StorageSettings() {
  const t = useTranslation();
  const [sizes, setSizes] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(CACHE_CATEGORIES.map((c) => [c.id, null])),
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const showToast = useToasts((s) => s.show);

  const refreshSizes = useCallback(async () => {
    const results = await Promise.allSettled(
      CACHE_CATEGORIES.map((c) => c.loadSize()),
    );
    setSizes(
      Object.fromEntries(
        CACHE_CATEGORIES.map((c, i) => {
          const r = results[i];
          return [c.id, r.status === "fulfilled" ? r.value : null];
        }),
      ),
    );
  }, []);

  useEffect(() => {
    void refreshSizes();
  }, [refreshSizes]);

  const totalBytes = Object.values(sizes).reduce<number>(
    (sum, n) => sum + (n ?? 0),
    0,
  );

  async function handleClear() {
    setBusy(true);
    setStatus(null);
    try {
      const results = await Promise.allSettled(
        CACHE_CATEGORIES.map((c) => c.clear()),
      );
      const totalRemoved = results.reduce<number>(
        (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
        0,
      );
      const message =
        totalRemoved > 0
          ? stf(
              t,
              totalRemoved === 1
                ? "settings.storage.status.clearedSingular"
                : "settings.storage.status.clearedPlural",
              { count: totalRemoved },
            )
          : st(t, "settings.storage.status.nothingToClear");
      setStatus(message);
      showToast(message);
      await refreshSizes();
    } catch (err) {
      console.error("[Settings] cache clear failed", err);
      const message = st(t, "settings.storage.status.clearFailed");
      setStatus(message);
      showToast(message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h3 className="text-sm font-medium text-fg">
          {st(t, "settings.storage.title")}
        </h3>
        <p className="text-[11px] text-fg-muted">
          {st(t, "settings.storage.description")}
        </p>
      </header>

      <ul className="divide-y divide-border rounded border border-border">
        {CACHE_CATEGORIES.map((cat) => {
          const size = sizes[cat.id];
          return (
            <li key={cat.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-fg">
                  {st(t, cat.labelKey)}
                </span>
                <span className="text-[11px] tabular-nums text-fg-muted">
                  {size === null ? "—" : formatBytes(size)}
                </span>
              </div>
              <p className="text-[11px] text-fg-muted">
                {st(t, cat.descriptionKey)}
              </p>
            </li>
          );
        })}
      </ul>

      {confirming ? (
        <div className="space-y-2 rounded border border-warning/40 bg-warning/10 p-3">
          <p className="text-[11px] text-fg">
            {stf(t, "settings.storage.confirm.message", {
              size: formatBytes(totalBytes),
            })}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:text-fg disabled:opacity-50"
            >
              {st(t, "settings.storage.confirm.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={busy}
              className="rounded bg-danger px-2 py-1 text-[11px] font-medium text-white transition hover:bg-danger/90 disabled:opacity-50"
            >
              {busy
                ? st(t, "settings.storage.clear.clearing")
                : st(t, "settings.storage.clear.button")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-fg-muted">
            {status ??
              stf(t, "settings.storage.total", {
                size: formatBytes(totalBytes),
              })}
          </span>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy || totalBytes === 0}
            className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:border-danger/60 hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={11} />
            {st(t, "settings.storage.clear.button")}
          </button>
        </div>
      )}
    </section>
  );
}

function formatRelative(ts: number | null, t: SettingsTranslator): string {
  if (!ts) return st(t, "settings.about.relative.never");
  const diff = Date.now() - ts;
  if (diff < 60_000) return st(t, "settings.about.relative.justNow");
  if (diff < 3_600_000) {
    return stf(t, "settings.about.relative.minutesAgo", {
      count: Math.floor(diff / 60_000),
    });
  }
  if (diff < 86_400_000) {
    return stf(t, "settings.about.relative.hoursAgo", {
      count: Math.floor(diff / 3_600_000),
    });
  }
  return stf(t, "settings.about.relative.daysAgo", {
    count: Math.floor(diff / 86_400_000),
  });
}

type WhatsNewSource =
  | { kind: "update"; version: string; body: string; htmlUrl?: string }
  | {
      kind: "current";
      version: string;
      body: string;
      htmlUrl: string;
      /**
       * True when the running version doesn't have its own public
       * release and we're showing the latest published one as a
       * fallback. Surfaces a subtitle hint in the modal.
       */
      isFallback: boolean;
    };

function ExperimentsSettings() {
  const experiments = useSettings((s) => s.settings.experiments);
  const patchExperiments = useSettings((s) => s.patchExperiments);
  const t = useTranslation();

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] leading-snug text-fg-muted">
        <Sparkles size={11} className="mr-1 inline align-text-bottom text-warning" />
        {st(t, "settings.experiments.warning")}
      </div>
      <CheckboxRow
        checked={experiments.stickyPrompt}
        onChange={(checked) => patchExperiments({ stickyPrompt: checked })}
        label={st(t, "settings.experiments.stickyPrompt.label")}
        description={st(t, "settings.experiments.stickyPrompt.description")}
      />
      <CheckboxRow
        checked={experiments.cjkCellWidthHeuristic}
        onChange={(checked) =>
          patchExperiments({ cjkCellWidthHeuristic: checked })
        }
        label={st(t, "settings.experiments.cjkCellWidthHeuristic.label")}
        description={st(
          t,
          "settings.experiments.cjkCellWidthHeuristic.description",
        )}
      />
      <CheckboxRow
        checked={experiments.resumeModal}
        onChange={(checked) => patchExperiments({ resumeModal: checked })}
        label={st(t, "settings.experiments.resumeModal.label")}
        description={st(t, "settings.experiments.resumeModal.description")}
      />
    </section>
  );
}

function ShortcutsSettings() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const patchShortcut = useSettings((s) => s.patchShortcut);
  const resetShortcut = useSettings((s) => s.resetShortcut);
  const resetShortcuts = useSettings((s) => s.resetShortcuts);
  const [recordingId, setRecordingId] = useState<HotkeyId | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const t = useTranslation();

  useEffect(() => {
    setShortcutRecordingActive(recordingId !== null);
    return () => setShortcutRecordingActive(false);
  }, [recordingId]);

  const stopRecording = useCallback(() => {
    setShortcutRecordingActive(false);
    setRecordingId(null);
    setRecordingError(null);
  }, []);

  const startRecording = useCallback((id: HotkeyId) => {
    setShortcutRecordingActive(true);
    setRecordingId(id);
    setRecordingError(null);
  }, []);

  useEffect(() => {
    if (recordingId === null) return;

    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const binding = recordHotkeyFromEvent(event);
      if (!binding) {
        setRecordingError(st(t, "settings.shortcuts.errors.modifierOnly"));
        return;
      }

      const conflictId = findShortcutConflict(shortcuts, recordingId, binding);
      if (conflictId) {
        setRecordingError(
          stf(t, "settings.shortcuts.errors.conflict", {
            shortcut: formatHotkey(binding),
            command: shortcutLabel(t, conflictId),
          }),
        );
        return;
      }

      patchShortcut(recordingId, binding);
      stopRecording();
    };

    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [patchShortcut, recordingId, shortcuts, stopRecording, t]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => {
            resetShortcuts();
            stopRecording();
          }}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:border-accent/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <RefreshCcw size={11} />
          {st(t, "settings.shortcuts.resetAll")}
        </button>
      </div>
      {recordingError ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-snug text-danger"
        >
          {recordingError}
        </div>
      ) : null}
      <div className="space-y-3">
        {SHORTCUT_GROUPS.map((group) => (
          <section
            key={group.titleKey}
            className="rounded-md border border-border bg-bg"
          >
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[11px] font-medium uppercase text-fg-muted">
              <Keyboard size={11} />
              {st(t, group.titleKey)}
            </div>
            <div className="divide-y divide-border">
              {group.items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2",
                    recordingId === item.id ? "bg-accent/10" : null,
                  )}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-fg">
                      {st(t, item.labelKey)}
                    </div>
                    {item.descriptionKey ? (
                      <div className="mt-0.5 text-[11px] leading-snug text-fg-muted">
                        {st(t, item.descriptionKey)}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <kbd className="min-w-16 rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-center font-mono text-[11px] leading-5 text-fg">
                      {recordingId === item.id
                        ? st(t, "settings.shortcuts.recording")
                        : formatHotkey(shortcuts[item.id])}
                    </kbd>
                    <Tooltip
                      label={stf(
                        t,
                        recordingId === item.id
                          ? "settings.shortcuts.cancelRecording"
                          : "settings.shortcuts.recordShortcut",
                        { command: shortcutLabel(t, item.id) },
                      )}
                      side="bottom"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          recordingId === item.id
                            ? stopRecording()
                            : startRecording(item.id)
                        }
                        aria-label={stf(
                          t,
                          recordingId === item.id
                            ? "settings.shortcuts.cancelRecording"
                            : "settings.shortcuts.recordShortcut",
                          { command: shortcutLabel(t, item.id) },
                        )}
                        className={cn(
                          "inline-flex h-7 w-[4.75rem] items-center justify-center gap-1 rounded border text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                          recordingId === item.id
                            ? "border-danger/50 bg-danger/10 text-danger hover:bg-danger/15"
                            : "border-border bg-bg text-fg-muted hover:border-accent/60 hover:text-fg",
                        )}
                      >
                        {recordingId === item.id ? (
                          <X size={11} />
                        ) : (
                          <Keyboard size={11} />
                        )}
                        {recordingId === item.id
                          ? st(t, "settings.shortcuts.cancel")
                          : st(t, "settings.shortcuts.record")}
                      </button>
                    </Tooltip>
                    <Tooltip
                      label={stf(t, "settings.shortcuts.resetShortcut", {
                        command: shortcutLabel(t, item.id),
                      })}
                      side="bottom"
                    >
                      <button
                        type="button"
                        onClick={() => resetShortcut(item.id)}
                        disabled={
                          shortcuts[item.id] === DEFAULT_HOTKEYS[item.id]
                        }
                        aria-label={stf(t, "settings.shortcuts.resetShortcut", {
                          command: shortcutLabel(t, item.id),
                        })}
                        className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-bg text-fg-muted transition hover:border-accent/60 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-40 disabled:hover:border-border disabled:hover:text-fg-muted"
                      >
                        <RefreshCcw size={11} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function AboutSettings() {
  const t = useTranslation();
  const currentVersion = useUpdater((s) => s.currentVersion);
  const available = useUpdater((s) => s.available);
  const busy = useUpdater((s) => s.busy);
  const error = useUpdater((s) => s.error);
  const lastCheckedAt = useUpdater((s) => s.lastCheckedAt);
  const check = useUpdater((s) => s.check);
  const install = useUpdater((s) => s.install);
  const init = useUpdater((s) => s.init);
  const [whatsNewSource, setWhatsNewSource] = useState<WhatsNewSource | null>(
    null,
  );
  const [currentNotes, setCurrentNotes] = useState<ReleaseNotes | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const showToast = useToasts((s) => s.show);

  useEffect(() => {
    void init();
  }, [init]);

  const hasNotes = (available?.body?.trim().length ?? 0) > 0;

  const openCurrentNotes = useCallback(async () => {
    if (!currentVersion) return;
    setNotesError(null);
    // Cache: skip the fetch if we already have notes for this version.
    if (currentNotes && currentNotes.version === currentVersion) {
      setWhatsNewSource({
        kind: "current",
        version: currentNotes.version,
        body: currentNotes.body,
        htmlUrl: currentNotes.htmlUrl,
        isFallback: false,
      });
      return;
    }
    setNotesLoading(true);
    try {
      const notes = await fetchReleaseNotes(currentVersion);
      if (notes !== null) {
        setCurrentNotes(notes);
        setWhatsNewSource({
          kind: "current",
          version: notes.version,
          body: notes.body,
          htmlUrl: notes.htmlUrl,
          isFallback: false,
        });
        return;
      }
      // The running version has no matching public release (locally bumped
      // dev build, pre-release tag, or unpublished build). Fall back to the
      // latest published release so the user still sees something meaningful
      // instead of an empty placeholder.
      const latest = await fetchLatestReleaseNotes();
      setWhatsNewSource({
        kind: "current",
        version: latest.version,
        body: latest.body,
        htmlUrl: latest.htmlUrl,
        isFallback: true,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch release notes";
      setNotesError(message);
      showToast(`${st(t, "settings.about.toasts.releaseNotesFailed")} ${message}`);
    } finally {
      setNotesLoading(false);
    }
  }, [currentVersion, currentNotes, showToast, t]);

  const handleCheck = useCallback(async () => {
    await check();
    const next = useUpdater.getState();
    if (next.error) {
      showToast(`${st(t, "settings.about.toasts.checkFailed")} ${next.error}`);
    } else if (next.available) {
      showToast(
        stf(t, "settings.about.toasts.updateAvailable", {
          version: next.available.version,
        }),
      );
    } else {
      showToast(st(t, "settings.about.toasts.upToDate"));
    }
  }, [check, showToast, t]);

  const handleInstall = useCallback(async () => {
    await install();
    const next = useUpdater.getState();
    if (next.error) {
      showToast(`${st(t, "settings.about.toasts.installFailed")} ${next.error}`);
    }
  }, [install, showToast, t]);

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h3 className="text-sm font-medium text-fg">
          {st(t, "settings.about.title")}
        </h3>
        <p className="text-[11px] text-fg-muted">
          {st(t, "settings.about.description")}
        </p>
      </header>

      <div className="rounded border border-border">
        <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
          <span className="text-xs font-medium text-fg">
            {st(t, "settings.about.currentVersion")}
          </span>
          <span className="text-[11px] tabular-nums text-fg-muted">
            {currentVersion ?? st(t, "settings.about.loading")}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-border px-3 py-2.5">
          <span className="text-xs font-medium text-fg">
            {st(t, "settings.about.lastChecked")}
          </span>
          <span className="text-[11px] tabular-nums text-fg-muted">
            {formatRelative(lastCheckedAt, t)}
          </span>
        </div>
        {available ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-border bg-accent/10 px-3 py-2.5">
            <div className="space-y-0.5">
              <div className="text-xs font-medium text-fg">
                {st(t, "settings.about.updateAvailable")}
              </div>
              <div className="text-[11px] text-fg-muted">
                {stf(t, "settings.about.updateReady", {
                  version: available.version,
                })}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hasNotes && available ? (
                <button
                  type="button"
                  onClick={() =>
                    setWhatsNewSource({
                      kind: "update",
                      version: available.version,
                      body: available.body ?? "",
                    })
                  }
                  className="rounded px-2 py-1 text-[11px] text-fg-muted underline-offset-2 transition hover:text-fg hover:underline"
                >
                  {st(t, "settings.about.whatsNew")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleInstall()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
              >
                <Download size={11} />
                {busy
                  ? st(t, "settings.about.installing")
                  : st(t, "settings.about.installRelaunch")}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {error}
        </p>
      ) : null}

      {notesError ? (
        <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {notesError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void openCurrentNotes()}
          disabled={!currentVersion || notesLoading}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent/60 hover:text-fg disabled:opacity-50"
        >
          <Sparkles size={11} className={notesLoading ? "animate-pulse" : ""} />
          {notesLoading
            ? st(t, "settings.about.loading")
            : currentVersion
              ? stf(t, "settings.about.whatsNewInVersion", {
                  version: currentVersion,
                })
              : st(t, "settings.about.whatsNew")}
        </button>
        <button
          type="button"
          onClick={() => void handleCheck()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent/60 hover:text-fg disabled:opacity-50"
        >
          <RefreshCcw size={11} className={busy ? "animate-spin" : ""} />
          {busy
            ? st(t, "settings.about.checking")
            : st(t, "settings.about.checkForUpdates")}
        </button>
      </div>

      <WhatsNewModal
        open={whatsNewSource !== null}
        onClose={() => setWhatsNewSource(null)}
        version={whatsNewSource?.version ?? ""}
        body={whatsNewSource?.body ?? ""}
        currentVersion={currentVersion}
        showInstall={whatsNewSource?.kind === "update"}
        busy={busy}
        error={whatsNewSource?.kind === "update" ? error : null}
        onInstall={
          whatsNewSource?.kind === "update"
            ? () => void handleInstall()
            : undefined
        }
        htmlUrl={
          whatsNewSource?.kind === "current" ? whatsNewSource.htmlUrl : undefined
        }
        isFallback={
          whatsNewSource?.kind === "current" ? whatsNewSource.isFallback : false
        }
      />
    </section>
  );
}
