import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../../src/lib/cn";

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

interface ButtonExampleProps {
  tone?: ButtonTone;
  size?: ButtonSize;
  disabled?: boolean;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}

const toneClass: Record<ButtonTone, string> = {
  primary:
    "bg-accent px-3 py-1.5 font-medium text-bg hover:opacity-90 focus-visible:ring-accent/60",
  secondary:
    "border border-border bg-bg-elevated px-3 py-1.5 text-fg hover:bg-bg-sidebar focus-visible:ring-accent/50",
  ghost:
    "px-3 py-1.5 text-fg-muted hover:bg-bg-sidebar hover:text-fg focus-visible:ring-accent/50",
  danger:
    "bg-danger/15 px-3 py-1.5 font-medium text-danger hover:bg-danger/25 focus-visible:ring-danger/50",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-7 rounded-md text-xs",
  md: "h-8 rounded-md text-sm",
  icon: "size-7 rounded",
};

function ButtonExample({
  tone = "secondary",
  size = "sm",
  disabled = false,
  children,
  icon,
}: ButtonExampleProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 transition focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        toneClass[tone],
        sizeClass[size],
      )}
    >
      {icon}
      {size === "icon" ? null : children}
    </button>
  );
}

const meta = {
  title: "UI/Button",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[520px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <ButtonExample tone="primary" icon={<Play size={13} />}>
        Run
      </ButtonExample>
      <ButtonExample tone="secondary" icon={<Download size={13} />}>
        Export
      </ButtonExample>
      <ButtonExample tone="ghost" icon={<ExternalLink size={13} />}>
        Open
      </ButtonExample>
      <ButtonExample tone="danger" icon={<Trash2 size={13} />}>
        Remove
      </ButtonExample>
    </div>
  ),
};

export const IconButtons: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <ButtonExample size="icon" tone="ghost" icon={<Settings size={14} />} />
      <ButtonExample size="icon" tone="secondary" icon={<RefreshCw size={14} />} />
      <ButtonExample size="icon" tone="secondary" icon={<Copy size={14} />} />
      <ButtonExample size="icon" tone="danger" icon={<X size={14} />} />
    </div>
  ),
};

export const States: Story = {
  render: () => (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <ButtonExample tone="primary" icon={<Check size={13} />}>
          Ready
        </ButtonExample>
        <ButtonExample tone="primary" disabled icon={<Play size={13} />}>
          Disabled
        </ButtonExample>
      </div>
      <div className="flex items-center gap-3">
        <ButtonExample tone="secondary" icon={<RefreshCw size={13} />}>
          Refresh
        </ButtonExample>
        <ButtonExample tone="secondary" disabled icon={<RefreshCw size={13} />}>
          Refreshing
        </ButtonExample>
      </div>
      <div className="flex items-center gap-3">
        <ButtonExample tone="danger" icon={<Trash2 size={13} />}>
          Delete
        </ButtonExample>
        <ButtonExample tone="danger" disabled icon={<Trash2 size={13} />}>
          Locked
        </ButtonExample>
      </div>
    </div>
  ),
};
