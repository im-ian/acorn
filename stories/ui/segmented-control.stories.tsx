import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bell,
  Check,
  CheckCircle2,
  Files,
  GitCommit,
  GitPullRequest,
  MessagesSquare,
  Palette,
  Settings,
  Shield,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  SegmentedControl,
  type SegmentedControlItem,
  type SegmentedControlProps,
} from "../../src/components/ui";

const meta = {
  title: "UI/SegmentedControl",
  component: SegmentedControl,
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
} satisfies Meta<typeof SegmentedControl>;

export default meta;

type Story = StoryObj<typeof meta>;

type PlainTab = "overview" | "activity" | "settings";
type DetailTab = "conversation" | "commits" | "checks" | "files";
type SettingsTab = "interface" | "security" | "notifications" | "advanced";

const plainItems = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
] satisfies SegmentedControlItem<PlainTab>[];

const iconItems = [
  {
    id: "conversation",
    label: "Conversation",
    icon: <MessagesSquare size={13} />,
  },
  { id: "commits", label: "Commits", icon: <GitCommit size={13} /> },
  { id: "checks", label: "Checks", icon: <CheckCircle2 size={13} /> },
  { id: "files", label: "Files", icon: <GitPullRequest size={13} /> },
] satisfies SegmentedControlItem<DetailTab>[];

const badgeItems = [
  {
    id: "conversation",
    label: "Conversation",
    icon: <MessagesSquare size={13} />,
    badge: 12,
  },
  {
    id: "commits",
    label: "Commits",
    icon: <GitCommit size={13} />,
    badge: 4,
  },
  {
    id: "checks",
    label: "Checks",
    icon: <CheckCircle2 size={13} />,
    badge: <Check size={11} strokeWidth={3} />,
    badgeTone: "success",
  },
  {
    id: "files",
    label: "Files",
    icon: <GitPullRequest size={13} />,
    badge: 8,
  },
] satisfies SegmentedControlItem<DetailTab>[];

const disabledItems = [
  { id: "interface", label: "Interface", icon: <Palette size={13} /> },
  { id: "security", label: "Security", icon: <Shield size={13} /> },
  {
    id: "notifications",
    label: "Notifications",
    icon: <Bell size={13} />,
    badge: 3,
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: <Settings size={13} />,
    badge: <X size={11} strokeWidth={3} />,
    badgeTone: "danger",
    disabled: true,
  },
] satisfies SegmentedControlItem<SettingsTab>[];

export const PlainTabs: Story = {
  render: () => (
    <StatefulSegmentedControl
      activeIdInitial="overview"
      items={plainItems}
      ariaLabel="Plain tabs"
    />
  ),
};

export const IconTabs: Story = {
  render: () => (
    <StatefulSegmentedControl
      activeIdInitial="conversation"
      items={iconItems}
      ariaLabel="Icon tabs"
    />
  ),
};

export const Badges: Story = {
  render: () => (
    <StatefulSegmentedControl
      activeIdInitial="checks"
      items={badgeItems}
      ariaLabel="Badge tabs"
    />
  ),
};

export const CompactDetailVariants: Story = {
  render: () => (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
          compact
        </h3>
        <div className="rounded-md border border-border bg-bg-sidebar/40 px-1.5 py-1">
          <StatefulSegmentedControl
            activeIdInitial="conversation"
            items={badgeItems}
            size="xs"
            surface="subtle"
            ariaLabel="Compact detail tabs"
          />
        </div>
      </section>
      <section className="grid gap-2">
        <h3 className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
          dialog sidebar
        </h3>
        <div className="flex h-44 overflow-hidden rounded-md border border-border bg-bg">
          <StatefulSegmentedControl
            activeIdInitial="interface"
            items={disabledItems}
            orientation="vertical"
            surface="dialog"
            ariaLabel="Dialog tabs"
            className="w-44 shrink-0 border-r border-border bg-bg-sidebar/40 px-1.5 py-2"
          />
          <div className="flex min-w-0 flex-1 items-start gap-2 p-4 text-xs text-fg-muted">
            <Files size={14} className="mt-0.5 shrink-0" />
            <span>Selected content panel</span>
          </div>
        </div>
      </section>
    </div>
  ),
};

export const DisabledItems: Story = {
  render: () => (
    <StatefulSegmentedControl
      activeIdInitial="interface"
      items={disabledItems}
      ariaLabel="Disabled tab example"
    />
  ),
};

function StatefulSegmentedControl<TId extends string>({
  activeIdInitial,
  ...props
}: Omit<SegmentedControlProps<TId>, "activeId" | "onChange"> & {
  activeIdInitial: TId;
}) {
  const [activeId, setActiveId] = useState<TId>(activeIdInitial);
  return (
    <SegmentedControl {...props} activeId={activeId} onChange={setActiveId} />
  );
}
