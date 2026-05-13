import {
  Download,
  FolderOpen,
  ImagePlus,
  RefreshCcw,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  importBackgroundImage,
  removeBackgroundImage,
  type BackgroundFit,
} from "../lib/background";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import {
  CURATED_MONOSPACE_FONTS,
  fontFamilyOptions,
  type FontOptionScope,
} from "../lib/fonts";
import { sendTestNotification } from "../lib/notifications";
import {
  fetchLatestReleaseNotes,
  fetchReleaseNotes,
  type ReleaseNotes,
} from "../lib/releases";
import { useUpdater } from "../lib/updater-store";
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
import type { PrStateFilter } from "../lib/types";
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
  | "pull-requests"
  | "appearance"
  | "editor"
  | "notifications"
  | "storage"
  | "about";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "pull-requests", label: "Pull Requests" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "notifications", label: "Notifications" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "About" },
];

export function SettingsModal() {
  const open = useSettings((s) => s.open);
  const setOpen = useSettings((s) => s.setOpen);
  const reset = useSettings((s) => s.reset);
  const [tab, setTab] = useState<Tab>("terminal");

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
        title="Settings"
        titleId="acorn-settings-title"
        icon={<SettingsIcon size={14} className="text-fg-muted" />}
        variant="dialog"
        onClose={() => setOpen(false)}
      />
      <div className="flex h-[28rem]">
        <nav className="flex w-40 shrink-0 flex-col border-r border-border bg-bg-sidebar/40 py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "px-4 py-1.5 text-left text-xs transition",
                tab === t.id
                  ? "bg-bg-elevated text-fg"
                  : "text-fg-muted hover:bg-bg-elevated/50 hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
          <div className="mt-auto px-4 pb-2">
            <button
              type="button"
              onClick={reset}
              className="text-[11px] text-fg-muted transition hover:text-danger"
            >
              Reset to defaults
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
          ) : tab === "pull-requests" ? (
            <PullRequestsSettings />
          ) : tab === "appearance" ? (
            <AppearanceSettings />
          ) : tab === "editor" ? (
            <EditorSettings />
          ) : tab === "notifications" ? (
            <NotificationSettings />
          ) : tab === "storage" ? (
            <StorageSettings />
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

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-border bg-bg px-3 py-2 text-[11px] text-fg-muted">
        Font family is selected in <strong>Appearance → Terminal font</strong>.
      </div>
      <Field label="Font size" hint="In CSS pixels. Range 8–32.">
        <Stepper
          value={settings.terminal.fontSize}
          min={8}
          max={32}
          unit="px"
          onChange={(n) => patchTerminal({ fontSize: n })}
        />
      </Field>
      <Field
        label="Font weight"
        hint="Weight for normal text. Effective values depend on the chosen font's available weights."
      >
        <WeightSelect
          value={settings.terminal.fontWeight}
          onChange={(v) => patchTerminal({ fontWeight: v })}
        />
      </Field>
      <Field
        label="Bold font weight"
        hint="Weight used when the terminal renders bold cells."
      >
        <WeightSelect
          value={settings.terminal.fontWeightBold}
          onChange={(v) => patchTerminal({ fontWeightBold: v })}
        />
      </Field>
      <Field
        label="Line height"
        hint="Cell-height multiplier. 1.00 packs rows flush; raise for more vertical breathing room. Range 1.00–2.00."
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
        label="Open links on"
        hint="How to follow URLs that xterm detects in terminal output."
      >
        <div className="flex flex-col gap-1.5">
          <RadioCard<TerminalLinkActivation>
            name="terminal-link-activation"
            value="click"
            current={settings.terminal.linkActivation}
            label="Click (default)"
            description="A single mouse click opens the URL in your default browser."
            onSelect={(v) => patchTerminal({ linkActivation: v })}
          />
          <RadioCard<TerminalLinkActivation>
            name="terminal-link-activation"
            value="modifier-click"
            current={settings.terminal.linkActivation}
            label={`${MODIFIER_LABEL}-click`}
            description={`Hold ${MODIFIER_LABEL} while clicking to open. Stops stray clicks on output containing URLs from yanking focus to the browser.`}
            onSelect={(v) => patchTerminal({ linkActivation: v })}
          />
        </div>
      </Field>
    </section>
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

  return (
    <section className="space-y-4">
      <Field
        label="Confirm before removing a session"
        hint="Isolated worktrees always prompt because the delete-worktree choice still matters."
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
          Show confirmation dialog
        </label>
      </Field>
      <Field
        label="Close tab when the process exits"
        hint="When the session's shell or agent exits (e.g. you type `exit`), close the tab automatically instead of showing the press-Enter restart prompt. The worktree is preserved either way."
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
          Auto-close on exit
        </label>
      </Field>
      <ControlSessionInstallSection />
    </section>
  );
}

function ControlSessionInstallSection() {
  const [status, setStatus] = useState<
    import("../lib/types").AcornIpcStatus | null
  >(null);
  const [error, setError] = useState<string | null>(null);

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
        label="Control sessions (acorn-ipc CLI)"
        hint="Could not query install status."
      >
        <p className="text-[11px] text-danger">{error}</p>
      </Field>
    );
  }

  if (!status) {
    return (
      <Field
        label="Control sessions (acorn-ipc CLI)"
        hint="Loading install status…"
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
      label="Control sessions (acorn-ipc CLI)"
      hint="Control sessions can dispatch commands to siblings via the acorn-ipc CLI. The CLI ships next to the app; symlink it into your $PATH to use it from any terminal."
    >
      <div className="space-y-2">
        <div className="rounded-md border border-border bg-bg px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Bundled binary</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                status.bundled_exists
                  ? "bg-accent/15 text-accent"
                  : "bg-warning/15 text-warning",
              )}
            >
              {status.bundled_exists ? "found" : "missing"}
            </span>
          </div>
          <code className="mt-1 block truncate font-mono text-fg">
            {status.bundled_path || "(unknown)"}
          </code>
        </div>
        <div className="rounded-md border border-border bg-bg px-3 py-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Installed shim</span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                activeShim
                  ? "bg-accent/15 text-accent"
                  : "bg-bg-elevated text-fg-muted",
              )}
            >
              {activeShim ? "installed" : "not installed"}
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
          Re-check
        </button>
      </div>
    </Field>
  );
}

function PullRequestsSettings() {
  const settings = useSettings((s) => s.settings);
  const patchPullRequests = useSettings((s) => s.patchPullRequests);

  return (
    <section className="space-y-4">
      <Field
        label="Default tab"
        hint="Filter pre-selected when the PRs panel first opens for a repo. Switching tabs by hand still works as before."
      >
        <Select
          value={settings.pullRequests.defaultState}
          onChange={(e) =>
            patchPullRequests({
              defaultState: e.target.value as PrStateFilter,
            })
          }
          className="w-48"
        >
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="merged">Merged</option>
          <option value="all">All</option>
        </Select>
      </Field>
      <Field
        label="Refresh interval"
        hint="How often the PRs tab auto-refetches from gh. Lower values feel snappier but spend more API budget."
      >
        <Select
          value={settings.pullRequests.refreshIntervalMs}
          onChange={(e) =>
            patchPullRequests({
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
        Manual refresh (the icon in the PRs tab) always works regardless of
        this interval.
      </p>
      <Field
        label="List density"
        hint="Author avatars make rows easier to scan at a glance, but each row gets thicker."
      >
        <CheckboxRow
          label="Show author avatars"
          description="Render the GitHub avatar next to each PR row."
          checked={settings.pullRequests.showAvatars}
          onChange={(v) => patchPullRequests({ showAvatars: v })}
        />
      </Field>
    </section>
  );
}

function AppearanceSettings() {
  const settings = useSettings((s) => s.settings);
  const patchStatusBar = useSettings((s) => s.patchStatusBar);
  const patchSessionDisplay = useSettings((s) => s.patchSessionDisplay);
  const patchAppearance = useSettings((s) => s.patchAppearance);
  const sessionDisplay = settings.sessionDisplay;
  const appearance = settings.appearance;

  return (
    <section className="space-y-6">
      <ThemeSection
        themeId={appearance.themeId}
        onChange={(themeId) => patchAppearance({ themeId })}
      />
      <BackgroundSection
        state={appearance.background}
        onChange={(background) => patchAppearance({ background })}
      />
      <FontSection
        slots={appearance.fontSlots}
        onChange={(fontSlots) => patchAppearance({ fontSlots })}
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

function ThemeSection({
  themeId,
  onChange,
}: {
  themeId: string;
  onChange: (id: string) => void;
}) {
  const themes = useThemes((s) => s.themes);
  const refresh = useThemes((s) => s.refresh);

  return (
    <Field
      label="Theme"
      hint="Built-in palettes and valid CSS files from the themes folder."
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
              {theme.source === "user" ? " (custom)" : ""}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-fg"
          title="Rescan themes folder"
        >
          <RefreshCcw size={12} /> Refresh
        </button>
        <button
          type="button"
          onClick={() => void revealThemesFolder()}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-fg"
        >
          <FolderOpen size={12} /> Reveal folder
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
      label="Background image"
      hint="One image can be applied to the app area, terminal area, or both."
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
            <ImagePlus size={12} /> {state.relativePath ? "Replace" : "Pick image"}
          </button>
          <span className="min-w-0 truncate text-[11px] text-fg-muted">
            {state.fileName ?? "No image selected"}
          </span>
          {state.relativePath ? (
            <button
              type="button"
              onClick={() => void remove()}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 text-[11px] text-fg-muted transition hover:text-danger"
            >
              <Trash2 size={12} /> Remove
            </button>
          ) : null}
        </div>
        {pickError ? (
          <div className="text-[11px] text-danger">{pickError}</div>
        ) : null}
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label="Apply to app background"
            checked={state.applyToApp}
            disabled={!state.relativePath}
            onChange={(checked) => onChange({ applyToApp: checked })}
          />
          <CheckboxRow
            label="Apply to terminal background"
            checked={state.applyToTerminal}
            disabled={!state.relativePath}
            onChange={(checked) => onChange({ applyToTerminal: checked })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-fg-muted">Fit</span>
          <div className="flex flex-wrap gap-1.5">
            {(["cover", "contain", "tile"] as BackgroundFit[]).map((fit) => (
              <RadioCard<BackgroundFit>
                key={fit}
                name="acorn-bg-fit"
                value={fit}
                current={state.fit}
                label={fit[0].toUpperCase() + fit.slice(1)}
                onSelect={(value) => onChange({ fit: value })}
              />
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Opacity" hint="0 is transparent, 100 is opaque.">
            <Stepper
              value={Math.round(state.opacity * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(value) => onChange({ opacity: value / 100 })}
            />
          </Field>
          <Field label="Blur">
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

type FontSlots = AcornSettings["appearance"]["fontSlots"];
type FontSlotDrafts = [string, string, string];

const FONT_SUGGESTION_LIMIT = 40;

function draftsFromFontSlots(slots: FontSlots): FontSlotDrafts {
  return [slots[0] ?? "", slots[1] ?? "", slots[2] ?? ""];
}

function FontSection({
  slots,
  onChange,
}: {
  slots: FontSlots;
  onChange: (slots: FontSlots) => void;
}) {
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<FontSlotDrafts>(() =>
    draftsFromFontSlots(slots),
  );
  const [activeSlot, setActiveSlot] = useState<0 | 1 | 2 | null>(null);
  const [fontScope, setFontScope] = useState<FontOptionScope>("mono");

  const allFontOptions = useMemo(() => {
    return fontFamilyOptions(
      [...CURATED_MONOSPACE_FONTS, ...systemFonts],
      fontScope,
    );
  }, [fontScope, systemFonts]);

  useEffect(() => {
    setDrafts(draftsFromFontSlots(slots));
  }, [slots]);

  const refreshSystemFonts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setSystemFonts(await api.listSystemFonts());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSystemFonts();
  }, [refreshSystemFonts]);

  const optionsForDraft = useCallback(
    (value: string) => {
      const query = value.trim().toLocaleLowerCase();
      const options = query
        ? allFontOptions.filter((font) =>
            font.toLocaleLowerCase().includes(query),
          )
        : allFontOptions;
      return options.slice(0, FONT_SUGGESTION_LIMIT);
    },
    [allFontOptions],
  );

  const setDraft = (index: 0 | 1 | 2, value: string) => {
    setDrafts((current) => {
      const next: FontSlotDrafts = [...current] as FontSlotDrafts;
      next[index] = value;
      return next;
    });
  };

  const commitSlot = (index: 0 | 1 | 2, value: string) => {
    const next: FontSlots = [...slots] as FontSlots;
    const font = value.trim() === "" ? null : value.trim();
    if (index === 0) {
      if (!font) {
        setDraft(0, slots[0]);
        return;
      }
      next[0] = font;
    } else {
      next[index] = font;
    }
    setDrafts(draftsFromFontSlots(next));
    setActiveSlot(null);
    onChange(next);
  };

  const renderSlot = (index: 0 | 1 | 2, label: string, required: boolean) => {
    const listId = `acorn-font-slot-options-${index}`;
    const value = drafts[index];
    const suggestions = optionsForDraft(value);
    const showSuggestions = activeSlot === index && suggestions.length > 0;
    return (
      <Field key={index} label={label}>
        <div className="relative min-w-[14rem]">
          <TextInput
            aria-autocomplete="list"
            aria-controls={showSuggestions ? listId : undefined}
            value={value}
            onBlur={() => {
              commitSlot(index, value);
              setActiveSlot(null);
            }}
            onChange={(e) => {
              setDraft(index, e.target.value);
              setActiveSlot(index);
            }}
            onFocus={() => setActiveSlot(index)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setDrafts(draftsFromFontSlots(slots));
                setActiveSlot(null);
              }
            }}
            placeholder={
              required ? "Search or type a font" : "Optional fallback"
            }
            className={!required && value ? "pr-8" : undefined}
          />
          {!required && value ? (
            <button
              type="button"
              aria-label={`Clear ${label} font`}
              onMouseDown={(e) => {
                e.preventDefault();
                commitSlot(index, "");
              }}
              className="absolute right-1 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-fg-muted transition hover:bg-bg hover:text-fg"
              tabIndex={-1}
            >
              <X size={12} />
            </button>
          ) : null}
          {showSuggestions ? (
            <div
              id={listId}
              role="listbox"
              className="absolute left-0 right-0 top-full z-50 mt-1 max-h-36 overflow-y-auto rounded-md border border-border bg-bg-elevated py-1 shadow-lg"
            >
              {suggestions.map((font) => (
                <button
                  key={font}
                  type="button"
                  role="option"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitSlot(index, font);
                  }}
                  className="block w-full px-2 py-1 text-left font-mono text-xs text-fg-muted transition hover:bg-bg hover:text-fg"
                >
                  {font}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </Field>
    );
  };

  return (
    <Field
      label="Terminal font"
      hint="Search installed system fonts or type any font family. A generic monospace fallback is appended automatically."
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
          <button
            type="button"
            onClick={() => void refreshSystemFonts()}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-bg px-2 transition hover:text-fg disabled:opacity-60"
            disabled={loading}
          >
            <RefreshCcw size={12} /> {loading ? "Scanning..." : "Refresh fonts"}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={fontScope === "all"}
            onClick={() =>
              setFontScope((current) => (current === "mono" ? "all" : "mono"))
            }
            className="inline-flex h-7 items-center gap-2 rounded-md border border-border bg-bg px-2 transition hover:text-fg"
          >
            <span
              className={cn(
                "relative h-3.5 w-6 rounded-full transition",
                fontScope === "all" ? "bg-accent" : "bg-bg-elevated",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-2.5 w-2.5 rounded-full bg-fg transition",
                  fontScope === "all" ? "left-3" : "left-0.5",
                )}
              />
            </span>
            {fontScope === "mono" ? "Mono only" : "All fonts"}
          </button>
          <span>
            {systemFonts.length > 0
              ? `${systemFonts.length} system fonts indexed`
              : "Curated fonts available"}
          </span>
          {loadError ? <span className="text-danger">{loadError}</span> : null}
        </div>
        {renderSlot(0, "Primary", true)}
        {renderSlot(1, "Secondary", false)}
        {renderSlot(2, "Tertiary", false)}
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
  return (
    <>
      <Field
        label="Session title"
        hint="Which field becomes the bold first line of each sidebar session row."
      >
        <div className="flex flex-col gap-1.5">
          {SESSION_TITLE_OPTIONS.map((opt) => (
            <RadioCard<SessionTitleSource>
              key={opt.value}
              name="acorn-session-title"
              value={opt.value}
              current={sessionDisplay.title}
              label={opt.label}
              description={opt.description}
              onSelect={(v) => patch({ title: v })}
            />
          ))}
        </div>
      </Field>
      <Field
        label="Additional metadata"
        hint="Secondary line under the title. Toggle off everything for a single-line row."
      >
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label="Branch"
            description="Active git branch."
            checked={sessionDisplay.metadata.branch}
            onChange={(v) => patch({ metadata: { branch: v } })}
          />
          <CheckboxRow
            label="Working directory"
            description="Worktree directory basename."
            checked={sessionDisplay.metadata.workingDirectory}
            onChange={(v) => patch({ metadata: { workingDirectory: v } })}
          />
          <CheckboxRow
            label="Status"
            description="Idle / Running / Needs input / Failed / Completed."
            checked={sessionDisplay.metadata.status}
            onChange={(v) => patch({ metadata: { status: v } })}
          />
        </div>
      </Field>
      <Field
        label="Inline icons"
        hint="Glyphs that decorate each session row. Hide to make the list denser."
      >
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label="Status dot"
            description="Colored bullet at the row start. Redundant when Status is enabled in metadata."
            checked={sessionDisplay.icons.statusDot}
            onChange={(v) => patch({ icons: { statusDot: v } })}
          />
          <CheckboxRow
            label="Session kind icons"
            description="Branch glyph for isolated worktrees and bot glyph for control sessions."
            checked={sessionDisplay.icons.sessionKind}
            onChange={(v) => patch({ icons: { sessionKind: v } })}
          />
        </div>
      </Field>
      <Field
        label="Show details on hover"
        hint="Pop a tooltip with every field when hovering a session row, regardless of which fields the row itself shows."
      >
        <label className="flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={sessionDisplay.showDetailsOnHover}
            onChange={(e) => patch({ showDetailsOnHover: e.target.checked })}
            className="accent-[var(--color-accent)]"
          />
          Enable hover tooltip
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
  return (
    <Field
      label="Status bar"
      hint="Choose which optional badges show in the bottom status bar."
    >
      <div className="flex flex-col gap-1">
        <CheckboxRow
          label="GitHub account"
          description="The `gh` account used to list pull requests for the active repo."
          checked={statusBar.showGithubAccount}
          onChange={(v) => patch({ showGithubAccount: v })}
        />
        <CheckboxRow
          label="Memory usage"
          description="Live memory readout for acorn and its child shells. Disabling also stops the 2-second polling loop, so it costs nothing when hidden."
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

  return (
    <section className="space-y-4">
      <Field
        label="Editor command"
        hint='Leave blank for the OS default. Examples: "code", "cursor --wait", "subl", "idea". The file path is appended as the last argument.'
      >
        <TextInput
          value={settings.editor.command}
          onChange={(e) => patchEditor({ command: e.target.value })}
          placeholder="(use OS default)"
        />
      </Field>
      <p className="text-[11px] text-fg-muted">
        Used by the "Open in editor" right-click action on diff and staged
        file lists.
      </p>
    </section>
  );
}

function NotificationSettings() {
  const settings = useSettings((s) => s.settings);
  const patchNotifications = useSettings((s) => s.patchNotifications);
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
          text: "Sent. Check your notification center if it didn't appear.",
        });
      } else if (result === "denied") {
        setTestResult({
          tone: "warning",
          text: "Permission denied. Allow Acorn under System Settings → Notifications.",
        });
      } else {
        setTestResult({
          tone: "danger",
          text: "Failed to send. See the console for details.",
        });
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="space-y-4">
      <Field
        label="System notifications"
        hint="Send a macOS notification when a session changes status."
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
          Enable notifications
        </label>
      </Field>
      <Field label="Trigger on">
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label="Needs input"
            description="Claude is waiting on the user."
            checked={settings.notifications.events.needsInput}
            disabled={!enabled}
            onChange={(v) =>
              patchNotifications({ events: { needsInput: v } })
            }
          />
          <CheckboxRow
            label="Failed"
            description="Session terminated with an error."
            checked={settings.notifications.events.failed}
            disabled={!enabled}
            onChange={(v) => patchNotifications({ events: { failed: v } })}
          />
          <CheckboxRow
            label="Completed"
            description="Session reached the completed state."
            checked={settings.notifications.events.completed}
            disabled={!enabled}
            onChange={(v) =>
              patchNotifications({ events: { completed: v } })
            }
          />
        </div>
      </Field>
      <Field
        label="Test"
        hint="Verifies the OS permission and that a notification can actually appear, independent of the Enable / Trigger settings above."
      >
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            className="rounded-md bg-accent/20 px-3 py-1.5 text-xs font-medium text-fg transition hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testing ? "Sending…" : "Send test notification"}
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
        macOS may ask once for permission the first time a notification fires.
      </p>
    </section>
  );
}

function AgentSettings() {
  const settings = useSettings((s) => s.settings);
  const patchAgents = useSettings((s) => s.patchAgents);
  const selected = settings.agents.selected;

  return (
    <section className="space-y-4">
      <p className="rounded-md border border-border bg-bg-sidebar/40 px-3 py-2 text-[11px] text-fg-muted">
        The selected agent powers acorn's AI features — currently the merge
        dialog's <em>Generate with AI</em> button.
      </p>
      <Field label="Agent" hint="Choose which AI CLI acorn uses.">
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
            label="Custom command"
            description="Use any CLI not in the list. Whitespace-separated; no shell expansion."
            onSelect={(v) => patchAgents({ selected: v })}
          />
        </div>
      </Field>
      {selected === "ollama" ? (
        <Field
          label="Ollama model"
          hint="Passed to `ollama run <model>`. Defaults to `llama3` when blank."
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
          label="llm model"
          hint="Passed via `llm -m <model>` (and `llm chat -m <model>` for sessions). Blank uses the llm-configured default."
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
          label="Custom command"
          hint="Used for both interactive sessions and one-shot AI generation. Falls back to Claude Code when blank."
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
        The selected agent's CLI must already be installed and
        authenticated on this machine. Surfaces a clear error when the
        binary is missing.
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
  label: string;
  description: string;
  loadSize: () => Promise<number>;
  clear: () => Promise<number>;
}

const CACHE_CATEGORIES: CacheCategory[] = [
  {
    id: "scrollback-orphans",
    label: "Orphan terminal scrollback",
    description:
      "ANSI scrollback files left behind by sessions that no longer exist (e.g. removed while acorn was offline, or before the prune-on-boot logic existed). Live sessions' scrollback is not touched — only the unreclaimable leftovers are surfaced.",
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
          ? `Cleared ${totalRemoved} cached file${totalRemoved === 1 ? "" : "s"}.`
          : "Nothing to clear.",
      );
      await refreshSizes();
    } catch (err) {
      console.error("[Settings] cache clear failed", err);
      setStatus("Clear failed — see console.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h3 className="text-sm font-medium text-fg">Reclaimable cache</h3>
        <p className="text-[11px] text-fg-muted">
          Disk artifacts that acorn cannot clean up through its normal
          session lifecycle (e.g. files orphaned by a crash or by edits
          made while acorn was offline). Sessions, projects, settings,
          and live terminal scrollback are never touched.
        </p>
      </header>

      <ul className="divide-y divide-border rounded border border-border">
        {CACHE_CATEGORIES.map((cat) => {
          const size = sizes[cat.id];
          return (
            <li key={cat.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium text-fg">
                  {cat.label}
                </span>
                <span className="text-[11px] tabular-nums text-fg-muted">
                  {size === null ? "—" : formatBytes(size)}
                </span>
              </div>
              <p className="text-[11px] text-fg-muted">{cat.description}</p>
            </li>
          );
        })}
      </ul>

      {confirming ? (
        <div className="space-y-2 rounded border border-warning/40 bg-warning/10 p-3">
          <p className="text-[11px] text-fg">
            This will permanently delete the cached data listed above
            ({formatBytes(totalBytes)}). Continue?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={busy}
              className="rounded bg-danger px-2 py-1 text-[11px] font-medium text-white transition hover:bg-danger/90 disabled:opacity-50"
            >
              <TextSwap>{busy ? "Clearing…" : "Clear cache"}</TextSwap>
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-fg-muted">
            {status ?? `Total: ${formatBytes(totalBytes)}`}
          </span>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy || totalBytes === 0}
            className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:border-danger/60 hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={11} />
            Clear cache
          </button>
        </div>
      )}
    </section>
  );
}

function formatRelative(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
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

function AboutSettings() {
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
        <h3 className="text-sm font-medium text-fg">About Acorn</h3>
        <p className="text-[11px] text-fg-muted">
          Acorn checks for updates automatically on startup and once every
          24 hours. You can also check manually below.
        </p>
      </header>

      <div className="rounded border border-border">
        <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
          <span className="text-xs font-medium text-fg">Current version</span>
          <span className="text-[11px] tabular-nums text-fg-muted">
            {currentVersion ?? "loading…"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-border px-3 py-2.5">
          <span className="text-xs font-medium text-fg">Last checked</span>
          <span className="text-[11px] tabular-nums text-fg-muted">
            {formatRelative(lastCheckedAt)}
          </span>
        </div>
        {available ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-border bg-accent/10 px-3 py-2.5">
            <div className="space-y-0.5">
              <div className="text-xs font-medium text-fg">
                Update available
              </div>
              <div className="text-[11px] text-fg-muted">
                Acorn {available.version} is ready to install.
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
                  What&apos;s new
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
                  {busy ? "Installing…" : "Install & relaunch"}
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
              ? "Loading…"
              : currentVersion
                ? `What's new in ${currentVersion}`
                : "What's new"}
          </TextSwap>
        </button>
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-fg-muted transition hover:border-accent/60 hover:text-fg disabled:opacity-50"
        >
          <RefreshCcw size={11} className={busy ? "animate-spin" : ""} />
          <TextSwap>{busy ? "Checking…" : "Check for updates"}</TextSwap>
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
