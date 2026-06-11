import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RefreshButton } from "../../src/components/ui/RefreshButton";

const meta = {
  title: "UI/RefreshButton",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [loading, setLoading] = useState(false);
    return (
      <RefreshButton
        loading={loading}
        title="Refresh pull requests"
        onClick={() => {
          setLoading(true);
          window.setTimeout(() => setLoading(false), 900);
        }}
      />
    );
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <RefreshButton loading={false} size={12} onClick={() => undefined} />
      <RefreshButton loading={false} size={14} onClick={() => undefined} />
      <RefreshButton loading={false} size={18} onClick={() => undefined} />
      <RefreshButton loading size={14} onClick={() => undefined} />
    </div>
  ),
};
