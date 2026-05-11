import { Download, RefreshCcw, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import { sendTestNotification } from "../lib/notifications";
import { useUpdater } from "../lib/updater-store";
import { WhatsNewModal } from "./WhatsNewModal";
import {
  AGENT_OPTIONS,
  PR_REFRESH_INTERVAL_OPTIONS,
  type SelectedAgent,
  type SessionStartupMode,
  type TerminalFontWeight,
  TERMINAL_FONT_WEIGHTS,
  selectedAgentLabel,
  useSettings,
} from "../lib/settings";
import type { PrStateFilter } from "../lib/types";
import {
  CheckboxRow,
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
      <Field
        label="Font family"
        hint="Comma-separated stack. First family that resolves wins."
      >
        <TextInput
          value={settings.terminal.fontFamily}
          onChange={(e) => patchTerminal({ fontFamily: e.target.value })}
        />
      </Field>
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
    </section>
  );
}

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
  const patchSessionStartup = useSettings((s) => s.patchSessionStartup);
  const patchSessions = useSettings((s) => s.patchSessions);
  const mode = settings.sessionStartup.mode;
  const agentName = selectedAgentLabel(settings);

  return (
    <section className="space-y-4">
      <Field
        label="Default session startup"
        hint="What to launch when you create a new session tab."
      >
        <div className="flex flex-col gap-1.5">
          <RadioCard<SessionStartupMode>
            name="session-startup"
            value="terminal"
            current={mode}
            label="Terminal (default)"
            description="Launch a plain shell using $SHELL."
            onSelect={(v) => patchSessionStartup({ mode: v })}
          />
          <RadioCard<SessionStartupMode>
            name="session-startup"
            value="agent"
            current={mode}
            label="Agent"
            description={`Launch the agent selected under Agents — currently ${agentName}.`}
            onSelect={(v) => patchSessionStartup({ mode: v })}
          />
          <RadioCard<SessionStartupMode>
            name="session-startup"
            value="custom"
            current={mode}
            label="Custom command"
            description="Run any executable. Whitespace-separated args supported."
            onSelect={(v) => patchSessionStartup({ mode: v })}
          />
        </div>
      </Field>
      {mode === "custom" ? (
        <Field label="Custom command" hint="Falls back to $SHELL when blank.">
          <TextInput
            value={settings.sessionStartup.customCommand}
            onChange={(e) =>
              patchSessionStartup({ customCommand: e.target.value })
            }
            placeholder="e.g. claude --resume"
          />
        </Field>
      ) : null}
      <p className="text-[11px] text-fg-muted">
        Changes apply to <em>new</em> session tabs. Existing terminals keep
        their current process.
      </p>
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
    </section>
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
    </section>
  );
}

function AppearanceSettings() {
  const settings = useSettings((s) => s.settings);
  const patchStatusBar = useSettings((s) => s.patchStatusBar);

  return (
    <section className="space-y-4">
      <Field
        label="Status bar"
        hint="Choose which optional badges show in the bottom status bar."
      >
        <div className="flex flex-col gap-1">
          <CheckboxRow
            label="GitHub account"
            description="The `gh` account used to list pull requests for the active repo."
            checked={settings.statusBar.showGithubAccount}
            onChange={(v) => patchStatusBar({ showGithubAccount: v })}
          />
          <CheckboxRow
            label="Memory usage"
            description="Live memory readout for acorn and its child shells. Disabling also stops the 2-second polling loop, so it costs nothing when hidden."
            checked={settings.statusBar.showMemory}
            onChange={(v) => patchStatusBar({ showMemory: v })}
          />
        </div>
      </Field>
    </section>
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
        The selected agent powers every AI feature in acorn — the merge
        dialog's <em>Generate with AI</em> button and Sessions startup's
        <em> Agent</em> mode both run whichever CLI is picked here.
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
              description={`${opt.interactiveHint} · ${opt.oneshotHint}`}
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

function AboutSettings() {
  const currentVersion = useUpdater((s) => s.currentVersion);
  const available = useUpdater((s) => s.available);
  const busy = useUpdater((s) => s.busy);
  const error = useUpdater((s) => s.error);
  const lastCheckedAt = useUpdater((s) => s.lastCheckedAt);
  const check = useUpdater((s) => s.check);
  const install = useUpdater((s) => s.install);
  const init = useUpdater((s) => s.init);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const hasNotes = (available?.body?.trim().length ?? 0) > 0;

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
              {hasNotes ? (
                <button
                  type="button"
                  onClick={() => setWhatsNewOpen(true)}
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

      <div className="flex justify-end">
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
        open={whatsNewOpen}
        onClose={() => setWhatsNewOpen(false)}
      />
    </section>
  );
}
