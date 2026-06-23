import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Info,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Notice,
  type NoticeDensity,
  type NoticeTone,
} from "../../src/components/ui/Notice";

const tones = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] satisfies NoticeTone[];

const densities = ["default", "compact"] satisfies NoticeDensity[];

const meta = {
  title: "UI/Notice",
  component: Notice,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    tone: {
      control: "select",
      options: tones,
    },
    density: {
      control: "select",
      options: densities,
    },
  },
  args: {
    tone: "info",
    density: "default",
    children: "Project settings could not be saved. Try again in a moment.",
  },
  decorators: [
    (Story) => (
      <div className="w-[620px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Notice>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <Notice {...args} icon={<Info size={14} />} />,
};

export const ToneDensityMatrix: Story = {
  render: () => (
    <div className="grid gap-5">
      {densities.map((density) => (
        <section key={density} className="grid gap-2">
          <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
            {density}
          </div>
          <div className="grid gap-2">
            {tones.map((tone) => (
              <Notice key={tone} tone={tone} density={density}>
                <NoticeText tone={tone} />
              </Notice>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

export const IconVariants: Story = {
  render: () => (
    <div className="grid gap-5">
      {densities.map((density) => (
        <section key={density} className="grid gap-2">
          <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
            {density}
          </div>
          <div className="grid gap-2">
            {tones.map((tone) => (
              <Notice
                key={tone}
                tone={tone}
                density={density}
                icon={noticeIcon(tone)}
              >
                <NoticeText tone={tone} />
              </Notice>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

function NoticeText({ tone }: { tone: NoticeTone }) {
  return (
    <span>
      <span className="font-medium">{tone}</span>
      <span className="text-fg-muted"> {noticeMessage(tone)}</span>
    </span>
  );
}

function noticeMessage(tone: NoticeTone): string {
  switch (tone) {
    case "danger":
      return "Project settings could not be saved.";
    case "info":
      return "A new update will be installed after restart.";
    case "neutral":
      return "No worktrees have been created for this project.";
    case "success":
      return "The test notification was sent.";
    case "warning":
      return "Checks are still pending before merge.";
  }
}

function noticeIcon(tone: NoticeTone): ReactNode {
  switch (tone) {
    case "danger":
      return <AlertCircle size={14} />;
    case "info":
      return <Info size={14} />;
    case "neutral":
      return <Circle size={14} />;
    case "success":
      return <CheckCircle2 size={14} />;
    case "warning":
      return <AlertTriangle size={14} />;
  }
}
