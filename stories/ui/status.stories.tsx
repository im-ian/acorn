import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  StatusBadge,
  StatusDot,
  type StatusBadgeSize,
  type StatusDotSize,
  type StatusTone,
} from "../../src/components/ui";

const tones = [
  "neutral",
  "success",
  "warning",
  "danger",
  "accent",
] satisfies StatusTone[];

const dotSizes = ["xs", "sm", "md", "lg"] satisfies StatusDotSize[];
const badgeSizes = ["xs", "sm", "md"] satisfies StatusBadgeSize[];

const meta = {
  title: "UI/Status",
  component: StatusBadge,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[680px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatusBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Dots: Story = {
  render: () => (
    <div className="grid gap-4">
      {dotSizes.map((size) => (
        <div
          key={size}
          className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-4"
        >
          <span className="font-mono text-[11px] text-fg-muted">{size}</span>
          <div className="flex items-center gap-4">
            {tones.map((tone) => (
              <div key={tone} className="flex items-center gap-2">
                <StatusDot tone={tone} size={size} />
                <span className="font-mono text-[11px] text-fg-muted">
                  {tone}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div className="grid gap-4">
      {badgeSizes.map((size) => (
        <div
          key={size}
          className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-4"
        >
          <span className="font-mono text-[11px] text-fg-muted">{size}</span>
          <div className="flex flex-wrap items-center gap-2">
            {tones.map((tone) => (
              <StatusBadge key={tone} tone={tone} size={size}>
                {tone}
              </StatusBadge>
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
};

export const BadgeForms: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {tones.map((tone) => (
        <StatusBadge key={`${tone}-dot`} tone={tone} dot>
          {tone}
        </StatusBadge>
      ))}
      {tones.map((tone) => (
        <StatusBadge key={`${tone}-icon`} tone={tone} icon={toneIcon(tone)}>
          {tone}
        </StatusBadge>
      ))}
      {tones.map((tone) => (
        <StatusBadge
          key={`${tone}-icon-only`}
          tone={tone}
          icon={toneIcon(tone)}
          aria-label={`${tone} status`}
        />
      ))}
    </div>
  ),
};

export const Pulse: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      {tones.map((tone) => (
        <div key={tone} className="flex items-center gap-2">
          <StatusDot tone={tone} size="lg" pulse />
          <StatusBadge tone={tone} icon={<Loader2 size={12} />} pulse>
            {tone}
          </StatusBadge>
        </div>
      ))}
    </div>
  ),
};

function toneIcon(tone: StatusTone): ReactNode {
  switch (tone) {
    case "success":
      return <CheckCircle2 size={12} />;
    case "warning":
      return <AlertTriangle size={12} />;
    case "danger":
      return <XCircle size={12} />;
    case "accent":
      return <Sparkles size={12} />;
    case "neutral":
      return <Circle size={12} />;
  }
}
