import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bot,
  CheckCircle2,
  Eye,
  GitPullRequest,
  Search,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import {
  Button,
  CheckboxRow,
  CodeValue,
  Field,
  IconInput,
  Markdown,
  Modal,
  ModalFooter,
  ModalHeader,
  Notice,
  RadioCard,
  SegmentedControl,
  Select,
  SkeletonBlock,
  StatusBadge,
  Stepper,
  TextInput,
} from "../../src/components/ui";

const meta = {
  title: "UI/Overview",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
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
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Project path"
          hint="Compact field styling used by Acorn dialogs."
        >
          <TextInput defaultValue="/Users/acorn/workspace" />
        </Field>
        <Field label="Default agent">
          <Select defaultValue="codex" className="w-full">
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
            <option value="antigravity">Antigravity</option>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <Field label="Search">
          <IconInput
            leading={<Search size={13} />}
            trailing={<Eye size={13} />}
            placeholder="Filter sessions"
          />
        </Field>
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
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            setRefreshing(true);
            window.setTimeout(() => setRefreshing(false), 700);
          }}
        >
          <Sparkles size={13} />
          Generate
        </Button>
        <Button disabled={refreshing}>
          <Terminal size={13} />
          {refreshing ? "Running" : "Run command"}
        </Button>
      </div>

      <CheckboxRow
        label="Keep sessions running in the background"
        description="Session output and notifications continue while panes are hidden."
        checked={backgroundSessions}
        onChange={setBackgroundSessions}
      />

      <div className="grid grid-cols-2 gap-2">
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

export const Controls: Story = {
  render: () => <FormControlsExample />,
};

export const FeedbackAndValues: Story = {
  render: () => (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="success" icon={<CheckCircle2 size={12} />}>
          CI passed
        </StatusBadge>
        <StatusBadge tone="warning" dot>
          Pending checks
        </StatusBadge>
        <StatusBadge tone="danger" icon={<XCircle size={12} />}>
          Merge blocked
        </StatusBadge>
      </div>
      <Notice tone="info" icon={<GitPullRequest size={14} />}>
        Pull request detail tabs now use the shared segmented-control surface.
      </Notice>
      <CodeValue surface="muted" overflow="breakAll">
        /Users/acorn/workspace/.acorn/worktrees/feature-ui-polish
      </CodeValue>
      <div className="grid gap-1.5 rounded-md border border-border bg-bg-sidebar/40 p-3">
        <SkeletonBlock className="h-3 w-48 bg-fg-muted/15" />
        <SkeletonBlock className="h-3 w-3/4" />
        <SkeletonBlock className="h-3 w-1/2" />
      </div>
    </div>
  ),
};

export const TabsAndMarkdown: Story = {
  render: () => {
    const [tab, setTab] = useState<"summary" | "checks" | "files">("summary");
    return (
      <div className="grid gap-3">
        <SegmentedControl
          activeId={tab}
          onChange={setTab}
          ariaLabel="Overview tabs"
          items={[
            { id: "summary", label: "Summary", icon: <Bot size={13} /> },
            {
              id: "checks",
              label: "Checks",
              icon: <CheckCircle2 size={13} />,
              badge: 2,
            },
            {
              id: "files",
              label: "Files",
              icon: <GitPullRequest size={13} />,
              badge: 8,
            },
          ]}
        />
        <div className="rounded-md border border-border bg-bg-sidebar/40 p-3">
          <Markdown
            content={[
              "### Pull request summary",
              "",
              "- [x] Centralize list row density",
              "- [x] Add shared surface primitives",
              "- [x] Cover new variants in Storybook",
              "",
              "| Area | Status |",
              "| --- | --- |",
              "| UI | Ready |",
              "| Storybook | Updated |",
              "",
              "`pnpm run build:storybook`",
            ].join("\n")}
            onTaskToggle={() => undefined}
          />
        </div>
      </div>
    );
  },
};

export const DialogShell: Story = {
  parameters: {
    layout: "fullscreen",
  },
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="h-screen bg-bg p-8 text-fg">
        <Button onClick={() => setOpen(true)} variant="primary">
          Open modal
        </Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          variant="dialog"
          size="md"
        >
          <ModalHeader
            title="Run command"
            subtitle="Shared modal header, footer, and code value"
            icon={<Terminal size={15} className="text-accent" />}
            variant="dialog"
            onClose={() => setOpen(false)}
          />
          <div className="space-y-3 px-4 py-4 text-sm">
            <Notice tone="neutral" density="compact">
              Command dialogs use the same footer and value treatment.
            </Notice>
            <CodeValue as="pre" surface="muted" overflow="scroll">
              pnpm run storybook
            </CodeValue>
          </div>
          <ModalFooter variant="sidebar">
            <Button onClick={() => setOpen(false)} surface="dialog">
              Cancel
            </Button>
            <Button variant="primary" surface="dialog">
              <Bot size={12} />
              Run
            </Button>
          </ModalFooter>
        </Modal>
      </div>
    );
  },
};
