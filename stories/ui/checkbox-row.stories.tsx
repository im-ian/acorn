import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CheckboxRow } from "../../src/components/ui/CheckboxRow";

const meta = {
  title: "UI/CheckboxRow",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [checked, setChecked] = useState(true);
    return (
      <CheckboxRow
        label="Keep sessions running in the background"
        description="Session output and notifications continue while panes are hidden."
        checked={checked}
        onChange={setChecked}
      />
    );
  },
};

export const States: Story = {
  render: () => (
    <div className="grid gap-3">
      <CheckboxRow
        label="Enabled"
        description="The option can be toggled."
        checked
        onChange={() => undefined}
      />
      <CheckboxRow
        label="Unchecked"
        description="A regular inactive state."
        checked={false}
        onChange={() => undefined}
      />
      <CheckboxRow
        label="Disabled"
        description="Unavailable options stay visible but muted."
        checked={false}
        disabled
        onChange={() => undefined}
      />
    </div>
  ),
};
