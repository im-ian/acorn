import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  Button,
  FloatingToolbar,
  IconButton,
  type FloatingToolbarPosition,
} from "../../src/components/ui";

const positions = [
  "top-right",
  "bottom-right",
] satisfies FloatingToolbarPosition[];

const meta = {
  title: "UI/FloatingToolbar",
  component: FloatingToolbar,
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
} satisfies Meta<typeof FloatingToolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Positions: Story = {
  render: () => (
    <div className="grid gap-4">
      {positions.map((position) => (
        <ToolbarFrame key={position}>
          <FloatingToolbar
            aria-label={`${position} floating toolbar`}
            position={position}
          >
            <IconButton aria-label="Previous match" size="md" surface="dialog">
              <ChevronUp size={14} />
            </IconButton>
            <IconButton aria-label="Next match" size="md" surface="dialog">
              <ChevronDown size={14} />
            </IconButton>
            <IconButton aria-label="Close" size="md" surface="dialog">
              <X size={14} />
            </IconButton>
          </FloatingToolbar>
        </ToolbarFrame>
      ))}
    </div>
  ),
};

export const MixedControls: Story = {
  render: () => (
    <ToolbarFrame>
      <FloatingToolbar aria-label="Find toolbar" zIndex={30}>
        <Search size={13} className="ml-1 text-fg-muted" />
        <input
          aria-label="Find in file"
          readOnly
          value="selectedProject"
          className="h-7 w-52 min-w-0 bg-transparent px-1 text-xs text-fg outline-none placeholder:text-fg-muted"
        />
        <span className="min-w-[4.5rem] text-center text-[11px] tabular-nums text-fg-muted">
          2/8
        </span>
        <IconButton aria-label="Previous match" size="md" surface="dialog">
          <ChevronUp size={14} />
        </IconButton>
        <IconButton aria-label="Next match" size="md" surface="dialog">
          <ChevronDown size={14} />
        </IconButton>
        <Button
          aria-pressed="false"
          size="xs"
          surface="dialog"
          variant="outline"
        >
          <Eye size={13} />
          Preview
        </Button>
      </FloatingToolbar>
    </ToolbarFrame>
  ),
};

export const DisabledIconButtons: Story = {
  render: () => (
    <ToolbarFrame>
      <FloatingToolbar
        aria-label="Image zoom controls"
        position="bottom-right"
      >
        <IconButton
          aria-label="Zoom out"
          disabled
          size="md"
          surface="dialog"
          className="disabled:cursor-default disabled:opacity-40"
        >
          <ZoomOut size={14} />
        </IconButton>
        <span className="flex h-7 w-12 shrink-0 items-center justify-center font-mono text-[11px] tabular-nums text-fg-muted">
          25%
        </span>
        <IconButton aria-label="Zoom in" size="md" surface="dialog">
          <ZoomIn size={14} />
        </IconButton>
        <IconButton
          aria-label="Reset zoom"
          disabled
          size="md"
          surface="dialog"
          className="disabled:cursor-default disabled:opacity-40"
        >
          <RotateCcw size={14} />
        </IconButton>
      </FloatingToolbar>
    </ToolbarFrame>
  ),
};

function ToolbarFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative h-40 overflow-hidden rounded-md border border-border bg-bg">
      <div className="grid h-full content-start gap-2 p-4 font-mono text-[12px] leading-5 text-fg-muted">
        <div>function FloatingToolbarExample() {"{"}</div>
        <div className="pl-4">return &lt;ToolbarControls /&gt;;</div>
        <div>{"}"}</div>
      </div>
      {children}
    </div>
  );
}
