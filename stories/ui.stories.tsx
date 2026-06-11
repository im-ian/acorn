import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bot,
  CheckCircle2,
  Eye,
  Search,
  Terminal,
  XCircle,
} from "lucide-react";
import { CheckboxRow } from "../src/components/ui/CheckboxRow";
import { Field } from "../src/components/ui/Field";
import { IconInput } from "../src/components/ui/IconInput";
import { Markdown } from "../src/components/ui/Markdown";
import { Modal } from "../src/components/ui/Modal";
import { ModalHeader } from "../src/components/ui/ModalHeader";
import { RadioCard } from "../src/components/ui/RadioCard";
import { RefreshButton } from "../src/components/ui/RefreshButton";
import { Select } from "../src/components/ui/Select";
import { Stepper } from "../src/components/ui/Stepper";
import { TextInput } from "../src/components/ui/TextInput";

const meta = {
  title: "UI",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] rounded-lg border border-border bg-bg-elevated p-4 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function FormControlsExample() {
  const [backgroundSessions, setBackgroundSessions] = useState(true);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [scale, setScale] = useState(100);
  const [refreshing, setRefreshing] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Project path" hint="Shown with the same compact field styling as Acorn dialogs.">
        <TextInput defaultValue="/Users/acorn/workspace" />
      </Field>

      <Field label="Default agent">
        <Select defaultValue="codex" className="w-full">
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
          <option value="antigravity">Antigravity</option>
        </Select>
      </Field>

      <Field label="Search">
        <IconInput
          leading={<Search size={13} />}
          trailing={<Eye size={13} />}
          placeholder="Filter sessions"
        />
      </Field>

      <div className="flex items-center justify-between gap-3">
        <Field label="UI scale">
          <Stepper
            value={scale}
            min={75}
            max={150}
            step={5}
            unit="%"
            onChange={setScale}
          />
        </Field>
        <RefreshButton
          loading={refreshing}
          onClick={() => {
            setRefreshing(true);
            window.setTimeout(() => setRefreshing(false), 700);
          }}
        />
      </div>

      <CheckboxRow
        label="Keep sessions running in the background"
        description="Session output and notifications continue while panes are hidden."
        checked={backgroundSessions}
        onChange={setBackgroundSessions}
      />

      <div className="grid gap-2">
        <RadioCard
          name="session-mode"
          value="auto"
          current={mode}
          label="Automatic"
          description="Let Acorn pick the best session behavior."
          onSelect={setMode}
        />
        <RadioCard
          name="session-mode"
          value="manual"
          current={mode}
          label="Manual"
          description="Choose session behavior per project."
          onSelect={setMode}
        />
      </div>
    </div>
  );
}

export const FormControls: Story = {
  render: () => <FormControlsExample />,
};

export const ValidationStates: Story = {
  render: () => (
    <div className="grid gap-3">
      <IconInput
        leading={<CheckCircle2 size={13} />}
        defaultValue="acorn-worktree"
      />
      <IconInput
        leading={<XCircle size={13} />}
        defaultValue="missing path"
        invalid
      />
      <TextInput defaultValue="readonly value" readOnly />
    </div>
  ),
};

export const MarkdownContent: Story = {
  render: () => (
    <Markdown
      content={[
        "### Pull request summary",
        "",
        "- [x] Build Storybook with Vite",
        "- [ ] Add component fixtures",
        "",
        "| Area | Status |",
        "| --- | --- |",
        "| UI | Ready |",
        "| Docs | Draft |",
        "",
        "> Markdown uses the same compact rendering as Acorn review panels.",
        "",
        "`pnpm run build:storybook`",
      ].join("\n")}
      onTaskToggle={() => undefined}
    />
  ),
};

export const DialogShell: Story = {
  parameters: {
    layout: "fullscreen",
  },
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="h-screen bg-bg p-8 text-fg">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg"
        >
          Open modal
        </button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          variant="dialog"
          size="md"
        >
          <ModalHeader
            title="Run command"
            subtitle="Preview of the shared modal shell"
            icon={<Terminal size={15} className="text-accent" />}
            variant="dialog"
            onClose={() => setOpen(false)}
          />
          <div className="space-y-3 px-4 py-4 text-sm">
            <p className="text-fg-muted">
              This story renders the shared Modal and ModalHeader components.
            </p>
            <div className="rounded-md border border-border bg-bg-sidebar p-3 font-mono text-xs">
              pnpm run storybook
            </div>
          </div>
          <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              className="rounded px-3 py-1 text-xs text-fg-muted hover:bg-bg-sidebar"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white"
            >
              <Bot size={12} />
              Run
            </button>
          </footer>
        </Modal>
      </div>
    );
  },
};
