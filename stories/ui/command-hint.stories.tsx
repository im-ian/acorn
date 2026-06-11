import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommandHint } from "../../src/components/ui/CommandHint";

const meta = {
  title: "UI/CommandHint",
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

export const Default: Story = {
  render: () => (
    <div className="text-xs text-fg-muted">
      Run <CommandHint command="gh auth login" repoPath={null} /> before
      refreshing pull requests.
    </div>
  ),
};

export const LongCommand: Story = {
  render: () => (
    <CommandHint
      command="pnpm exec vitest run src/components/ui/Select.test.tsx src/components/SettingsModal.test.tsx"
      repoPath="/Users/acorn/workspace"
      className="w-full"
    />
  ),
};
