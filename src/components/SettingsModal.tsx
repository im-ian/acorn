import { Settings as SettingsIcon, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import {
  type SessionStartupMode,
  useSettings,
} from "../lib/settings";

type Tab = "terminal" | "sessions" | "editor" | "notifications";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "sessions", label: "Sessions" },
  { id: "editor", label: "Editor" },
  { id: "notifications", label: "Notifications" },
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

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="acorn-settings-title"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <SettingsIcon size={14} className="text-fg-muted" />
            <h3
              id="acorn-settings-title"
              className="text-sm font-semibold tracking-tight text-fg"
            >
              Settings
            </h3>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-sidebar hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>
        <div className="flex min-h-[20rem]">
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
            ) : tab === "sessions" ? (
              <SessionSettings />
            ) : tab === "editor" ? (
              <EditorSettings />
            ) : (
              <NotificationSettings />
            )}
          </div>
        </div>
      </div>
    </div>
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
        <input
          type="text"
          value={settings.terminal.fontFamily}
          onChange={(e) => patchTerminal({ fontFamily: e.target.value })}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
        />
      </Field>
      <Field label="Font size" hint="In CSS pixels. Range 8–32.">
        <input
          type="number"
          min={8}
          max={32}
          value={settings.terminal.fontSize}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            patchTerminal({
              fontSize: Math.max(8, Math.min(32, Math.round(n))),
            });
          }}
          className="w-24 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
        />
      </Field>
    </section>
  );
}

function SessionSettings() {
  const settings = useSettings((s) => s.settings);
  const patchSessionStartup = useSettings((s) => s.patchSessionStartup);
  const patchSessions = useSettings((s) => s.patchSessions);
  const mode = settings.sessionStartup.mode;

  return (
    <section className="space-y-4">
      <Field
        label="Default session startup"
        hint="What to launch when you create a new session tab."
      >
        <div className="flex flex-col gap-1.5">
          <ModeRadio
            value="claude"
            current={mode}
            label="Claude"
            description="Launch the `claude` CLI in the session worktree (default)."
            onSelect={(v) => patchSessionStartup({ mode: v })}
          />
          <ModeRadio
            value="terminal"
            current={mode}
            label="Terminal"
            description="Launch a plain shell using $SHELL."
            onSelect={(v) => patchSessionStartup({ mode: v })}
          />
          <ModeRadio
            value="custom"
            current={mode}
            label="Custom command"
            description="Run any executable. Whitespace-separated args supported."
            onSelect={(v) => patchSessionStartup({ mode: v })}
          />
        </div>
      </Field>
      {mode === "custom" ? (
        <Field label="Custom command" hint="Falls back to `claude` when blank.">
          <input
            type="text"
            value={settings.sessionStartup.customCommand}
            onChange={(e) =>
              patchSessionStartup({ customCommand: e.target.value })
            }
            placeholder="e.g. claude --resume"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
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

function EditorSettings() {
  const settings = useSettings((s) => s.settings);
  const patchEditor = useSettings((s) => s.patchEditor);

  return (
    <section className="space-y-4">
      <Field
        label="Editor command"
        hint='Leave blank for the OS default. Examples: "code", "cursor --wait", "subl", "idea". The file path is appended as the last argument.'
      >
        <input
          type="text"
          value={settings.editor.command}
          onChange={(e) => patchEditor({ command: e.target.value })}
          placeholder="(use OS default)"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
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
          <EventCheckbox
            label="Needs input"
            description="Claude is waiting on the user."
            checked={settings.notifications.events.needsInput}
            disabled={!enabled}
            onChange={(v) =>
              patchNotifications({ events: { needsInput: v } })
            }
          />
          <EventCheckbox
            label="Failed"
            description="Session terminated with an error."
            checked={settings.notifications.events.failed}
            disabled={!enabled}
            onChange={(v) => patchNotifications({ events: { failed: v } })}
          />
          <EventCheckbox
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
      <p className="text-[11px] text-fg-muted">
        macOS may ask once for permission the first time a notification fires.
      </p>
    </section>
  );
}

interface EventCheckboxProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}

function EventCheckbox({
  label,
  description,
  checked,
  disabled,
  onChange,
}: EventCheckboxProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg px-3 py-2 transition",
        disabled && "cursor-not-allowed opacity-50",
        !disabled && "hover:border-fg-muted/40",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span className="flex flex-col">
        <span className="text-xs font-medium text-fg">{label}</span>
        <span className="text-[11px] text-fg-muted">{description}</span>
      </span>
    </label>
  );
}

interface ModeRadioProps {
  value: SessionStartupMode;
  current: SessionStartupMode;
  label: string;
  description: string;
  onSelect: (v: SessionStartupMode) => void;
}

function ModeRadio({
  value,
  current,
  label,
  description,
  onSelect,
}: ModeRadioProps) {
  const active = current === value;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 transition",
        active
          ? "border-accent/60 bg-accent/10"
          : "border-border bg-bg hover:border-fg-muted/40",
      )}
    >
      <input
        type="radio"
        name="session-startup"
        checked={active}
        onChange={() => onSelect(value)}
        className="mt-0.5 accent-[var(--color-accent)]"
      />
      <span className="flex flex-col">
        <span className="text-xs font-medium text-fg">{label}</span>
        <span className="text-[11px] text-fg-muted">{description}</span>
      </span>
    </label>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-fg-muted">{hint}</span> : null}
    </div>
  );
}
