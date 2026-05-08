import { Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { useDialogShortcuts } from "../lib/dialog";
import {
  AGENT_OPTIONS,
  type SelectedAgent,
  type SessionStartupMode,
  type TerminalFontWeight,
  TERMINAL_FONT_WEIGHTS,
  selectedAgentLabel,
  useSettings,
} from "../lib/settings";
import {
  CheckboxRow,
  Field,
  Modal,
  ModalHeader,
  RadioCard,
  Select,
  Stepper,
  TextInput,
} from "./ui";

type Tab =
  | "terminal"
  | "agents"
  | "sessions"
  | "editor"
  | "notifications";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "agents", label: "Agents" },
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
          ) : tab === "editor" ? (
            <EditorSettings />
          ) : (
            <NotificationSettings />
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
