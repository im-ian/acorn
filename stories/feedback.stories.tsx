import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Copy, FolderOpen, RefreshCw, Settings, Trash2 } from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "../src/components/ContextMenu";
import { FileDropHoverOverlay } from "../src/components/FileDropHoverOverlay";
import { SessionTitleGeneratingIndicator } from "../src/components/SessionTitleGeneratingIndicator";
import { StickyUserPrompt } from "../src/components/StickyUserPrompt";
import { Tooltip } from "../src/components/Tooltip";
import { Button } from "../src/components/ui/Button";

const meta = {
  title: "Components/Feedback",
  parameters: {
    layout: "centered",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const menuItems: ContextMenuItem[] = [
  { type: "group-title", label: "Session" },
  { label: "Copy command", icon: <Copy size={12} />, onClick: () => undefined },
  {
    type: "submenu",
    label: "Move to",
    icon: <FolderOpen size={12} />,
    children: [
      { label: "Default", onClick: () => undefined },
      { label: "Feature worktree", onClick: () => undefined },
    ],
  },
  { type: "separator" },
  {
    label: "Remove session",
    icon: <Trash2 size={12} />,
    shortcut: "Del",
    onClick: () => undefined,
  },
];

export const TooltipPlacements: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-5 rounded-lg border border-border bg-bg-elevated p-6 text-xs text-fg">
      <Tooltip label="Appears above" side="top" delay={150}>
        <Button variant="outline">Top</Button>
      </Tooltip>
      <Tooltip label="Appears below" side="bottom" delay={150}>
        <Button variant="outline">Bottom</Button>
      </Tooltip>
      <Tooltip label="Appears left" side="left" delay={150}>
        <Button variant="outline">Left</Button>
      </Tooltip>
      <Tooltip label="Appears right" side="right" delay={150}>
        <Button variant="outline">Right</Button>
      </Tooltip>
    </div>
  ),
};

export const OpenContextMenu: Story = {
  parameters: {
    layout: "fullscreen",
  },
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="h-screen bg-bg p-8 text-fg">
        <Button onClick={() => setOpen(true)} variant="primary">
          Show menu
        </Button>
        <ContextMenu
          open={open}
          x={72}
          y={72}
          items={menuItems}
          onClose={() => setOpen(false)}
        />
      </div>
    );
  },
};

export const Indicators: Story = {
  render: () => (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-bg-elevated p-5 text-xs text-fg">
      <SessionTitleGeneratingIndicator label="Generating title" />
      <span className="text-fg-muted">Generating session title</span>
      <RefreshCw size={14} className="animate-spin text-accent" />
      <Settings size={14} className="text-fg-muted" />
    </div>
  ),
};

export const DropOverlays: Story = {
  parameters: {
    layout: "fullscreen",
  },
  render: () => (
    <div className="grid h-screen grid-cols-3 gap-4 bg-bg p-6 text-fg">
      <div className="relative rounded-lg border border-border bg-bg-elevated">
        <FileDropHoverOverlay purpose="preview" path="/tmp/design.png" />
      </div>
      <div className="relative rounded-lg border border-border bg-bg-elevated">
        <FileDropHoverOverlay purpose="terminal" path="/tmp/script.sh" />
      </div>
      <div className="relative rounded-lg border border-border bg-bg-elevated">
        <FileDropHoverOverlay purpose="tab" path="/tmp/session.log" />
      </div>
    </div>
  ),
};

export const PinnedPrompt: Story = {
  parameters: {
    layout: "fullscreen",
  },
  render: () => {
    useEffect(() => {
      window.dispatchEvent(
        new CustomEvent("acorn:context-prompt", {
          detail: {
            sessionId: "storybook-session",
            prompt:
              "Please add Storybook stories for the existing components.\\nKeep the app build isolated from Storybook config.",
          },
        }),
      );
    }, []);

    return (
      <div className="relative h-screen overflow-hidden bg-bg p-6 text-fg">
        <StickyUserPrompt
          sessionId="storybook-session"
          agentProvider="codex"
        />
        <div className="mt-12 rounded-lg border border-border bg-bg-elevated p-4 text-xs text-fg-muted">
          Terminal content sits under the pinned prompt banner.
        </div>
      </div>
    );
  },
};
