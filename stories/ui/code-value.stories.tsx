import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { CodeValue } from "../../src/components/ui/CodeValue";

const command =
  'sudo ln -sf "/Applications/Acorn.app/Contents/MacOS/acorn-ipc" "/usr/local/bin/acorn-ipc"';
const uuid = "0b79dc3e-27b8-49cc-95fb-f33192fda1b2";
const path = "/Users/acorn/Documents/workspaces/acorn";
const longPath =
  "/Users/acorn/Documents/Personal/acorn/.acorn/worktrees/acorn-worktree-fcd211813b9c/src/components/ProjectSettingsModal.tsx";

const meta = {
  title: "UI/CodeValue",
  component: CodeValue,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[640px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeValue>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Command: Story = {
  render: () => (
    <CodeValue
      as="pre"
      surface="muted"
      overflow="scroll"
      className="px-3 py-2 text-[12px]"
    >
      {command}
    </CodeValue>
  ),
};

export const UUID: Story = {
  render: () => (
    <CodeValue surface="elevated" tone="muted">
      {uuid}
    </CodeValue>
  ),
};

export const Path: Story = {
  render: () => <CodeValue overflow="truncate">{path}</CodeValue>,
};

export const LongWrappingPath: Story = {
  render: () => (
    <CodeValue surface="muted" overflow="breakAll" className="px-3 py-2">
      {longPath}
    </CodeValue>
  ),
};

export const Variants: Story = {
  render: () => (
    <div className="grid gap-4">
      <VariantRow label="default">
        <CodeValue>{path}</CodeValue>
      </VariantRow>
      <VariantRow label="muted">
        <CodeValue surface="muted" tone="muted">
          {path}
        </CodeValue>
      </VariantRow>
      <VariantRow label="elevated">
        <CodeValue surface="elevated">{path}</CodeValue>
      </VariantRow>
      <VariantRow label="inline">
        <p className="text-xs text-fg-muted">
          Current value{" "}
          <CodeValue display="inline" surface="muted">
            {uuid}
          </CodeValue>
        </p>
      </VariantRow>
    </div>
  ),
};

function VariantRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
      <div className="font-mono text-[11px] text-fg-muted">{label}</div>
      {children}
    </div>
  );
}
