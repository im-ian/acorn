import {
  Download,
  FolderOpen,
  ImagePlus,
  RefreshCcw,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
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
import {
  AGENT_OPTIONS,
  PR_REFRESH_INTERVAL_OPTIONS,
  SESSION_TITLE_OPTIONS,
  type SelectedAgent,
  type SessionTitleSource,
  type AcornSettings,
  type TerminalFontWeight,
  type TerminalLinkActivation,
  TERMINAL_FONT_WEIGHTS,
  useSettings,
} from "../lib/settings";
import { revealThemesFolder, useThemes } from "../lib/themes";
import { useTranslation } from "../lib/useTranslation";
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
  TextSwap,
} from "./ui";

type Tab =
  | "terminal"
  | "agents"
  | "sessions"
  | "github"
  | "appearance"
  | "editor"
  | "notifications"
  | "storage"
  | "experiments"
  | "about";

const TABS: Array<{ id: Tab; labelKey: TranslationKey }> = [
  { id: "terminal", labelKey: "settings.tabs.terminal" },
  { id: "agents", labelKey: "settings.tabs.agents" },
  { id: "sessions", labelKey: "settings.tabs.sessions" },
  { id: "github", labelKey: "settings.tabs.github" },
  { id: "appearance", labelKey: "settings.tabs.appearance" },
  { id: "editor", labelKey: "settings.tabs.editor" },
  { id: "notifications", labelKey: "settings.tabs.notifications" },
  { id: "storage", labelKey: "settings.tabs.storage" },
  { id: "experiments", labelKey: "settings.tabs.experiments" },
  { id: "about", labelKey: "settings.tabs.about" },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));
type SettingsTranslator = Translator;

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

export function SettingsModal() {
  const open = useSettings((s) => s.open);
  const setOpen = useSettings((s) => s.setOpen);
  const reset = useSettings((s) => s.reset);
  const pendingTab = useSettings((s) => s.pendingTab);
  const consumePendingTab = useSettings((s) => s.consumePendingTab);
  const [tab, setTab] = useState<Tab>("terminal");
  const t = useTranslation();

  // When the store reports a pending tab (e.g. StatusBar daemon button
  // dispatched `acorn:open-settings` with `tab: "background-sessions"`),
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

  // Esc cancels, Enter (outside inputs) closes — settings autosave on every
  // change so there is no separate confirm step.
  useDialogShortcuts(open, {
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
          {tab === "terminal" ? (
            <TerminalSettings />
          ) : tab === "agents" ? (
            <AgentSettings />
          ) : tab === "sessions" ? (
            <SessionSettings />
          ) : tab === "github" ? (
            <GithubSettings />
          ) : tab === "appearance" ? (
            <AppearanceSettings t={t} />
          ) : tab === "editor" ? (
            <EditorSettings />
          ) : tab === "notifications" ? (
            <NotificationSettings />
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
    <section className="space-y-6">
      <div className="space-y-4">
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
          label={st(t, "settings.sessions.closeOnExit.label")}
          hint={st(t, "settings.sessions.closeOnExit.hint")}
        >
          <label className="flex items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              checked={settings.sessions.closeOnExit}
              onChange={(e) =>
                patchSessions({ closeOnExit: e.target.checked })
              }
              className="accent-[var(--color-accent)]"
            />
            {st(t, "settings.sessions.closeOnExit.checkbox")}
          </label>
        </Field>
        <ControlSessionInstallSection />
      </div>
      <SettingsGroup
        title={st(t, "settings.sessions.background.title")}
        description={st(t, "settings.sessions.background.description")}
      >
        <BackgroundSessionsSettings />
      </SettingsGroup>
    </section>
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
      </Field>
    </section>
  );
}

function AppearanceSettings({ t }: { t: SettingsTranslator }) {
  const settings = useSettings((s) => s.settings);
  const patchLanguage = useSettings((s) => s.patchLanguage);
  const patchStatusBar = useSettings((s) => s.patchStatusBar);
  const patchSessionDisplay = useSettings((s) => s.patchSessionDisplay);
  const patchAppearance = useSettings((s) => s.patchAppearance);
  const sessionDisplay = settings.sessionDisplay;
  const appearance = settings.appearance;

  return (
    <section className="space-y-6">
      <LanguageSection
        language={settings.language}
        onChange={patchLanguage}
        t={t}
      />
      <ThemeSection
        themeId={appearance.themeId}
        onChange={(themeId) => patchAppearance({ themeId })}
      />
      <UiScaleSection
        value={appearance.uiScalePercent}
        onChange={(uiScalePercent) => patchAppearance({ uiScalePercent })}
      />
      <BackgroundSection
        state={appearance.background}
        onChange={(background) => patchAppearance({ background })}
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

  return (
    <Field
      label={st(t, "settings.appearance.theme.label")}
      hint={st(t, "settings.appearance.theme.hint")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={themeId}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-[14rem]"
        >
          {themes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.label}
              {theme.source === "user"
                ? ` ${st(t, "settings.appearance.theme.custom")}`
                : ""}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-fg"
          title={st(t, "settings.appearance.theme.rescanTitle")}
        >
          <RefreshCcw size={12} /> {st(t, "settings.appearance.theme.refresh")}
        </button>
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
    } catch (err) {
      setPickError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    if (state.relativePath) {
      await removeBackgroundImage(state.relativePath).catch(() => {});
    }
    onChange({
      relativePath: null,
      fileName: null,
      applyToApp: false,
      applyToTerminal: false,
    });
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

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await sendTestNotification();
      if (result === "sent") {
        setTestResult({
          tone: "success",
          text: st(t, "settings.notifications.test.result.sent"),
        });
      } else if (result === "denied") {
        setTestResult({
          tone: "warning",
          text: st(t, "settings.notifications.test.result.denied"),
        });
      } else {
        setTestResult({
          tone: "danger",
          text: st(t, "settings.notifications.test.result.failed"),
        });
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

function AgentSettings() {
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
      {selected === "ollama" ? (
        <Field
          label={st(t, "settings.agents.ollamaModel.label")}
          hint={st(t, "settings.agents.ollamaModel.hint")}
        >
          <TextInput
            value={settings.agents.ollama.model}
            onChange={(e) =>
              patchAgents({ ollama: { model: e.target.value } })
            }
            placeholder="e.g. llama3:8b"
          />
        </Field>
      ) : null}
      {selected === "llm" ? (
        <Field
          label={st(t, "settings.agents.llmModel.label")}
          hint={st(t, "settings.agents.llmModel.hint")}
        >
          <TextInput
            value={settings.agents.llm.model}
            onChange={(e) => patchAgents({ llm: { model: e.target.value } })}
            placeholder="e.g. gpt-4o-mini"
          />
        </Field>
      ) : null}
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
      <p className="text-[11px] text-fg-muted">
        {st(t, "settings.agents.requirement")}
      </p>
    </section>
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
      setStatus(
        totalRemoved > 0
          ? stf(
              t,
              totalRemoved === 1
                ? "settings.storage.status.clearedSingular"
                : "settings.storage.status.clearedPlural",
              { count: totalRemoved },
            )
          : st(t, "settings.storage.status.nothingToClear"),
      );
      await refreshSizes();
    } catch (err) {
      console.error("[Settings] cache clear failed", err);
      setStatus(st(t, "settings.storage.status.clearFailed"));
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
              <TextSwap>
                {busy
                  ? st(t, "settings.storage.clear.clearing")
                  : st(t, "settings.storage.clear.button")}
              </TextSwap>
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
      setNotesError(
        err instanceof Error ? err.message : "Failed to fetch release notes",
      );
    } finally {
      setNotesLoading(false);
    }
  }, [currentVersion, currentNotes]);

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
                onClick={() => void install()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white transition hover:bg-accent/90 disabled:opacity-50"
              >
                <Download size={11} />
                <TextSwap>
                  {busy
                    ? st(t, "settings.about.installing")
                    : st(t, "settings.about.installRelaunch")}
                </TextSwap>
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
          <TextSwap>
            {notesLoading
              ? st(t, "settings.about.loading")
              : currentVersion
                ? stf(t, "settings.about.whatsNewInVersion", {
                    version: currentVersion,
                  })
                : st(t, "settings.about.whatsNew")}
          </TextSwap>
        </button>
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent/60 hover:text-fg disabled:opacity-50"
        >
          <RefreshCcw size={11} className={busy ? "animate-spin" : ""} />
          <TextSwap>
            {busy
              ? st(t, "settings.about.checking")
              : st(t, "settings.about.checkForUpdates")}
          </TextSwap>
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
          whatsNewSource?.kind === "update" ? () => void install() : undefined
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
