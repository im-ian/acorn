import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { RadioCard } from "../../src/components/ui/RadioCard";

const meta = {
  title: "UI/RadioCard",
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

export const Group: Story = {
  render: () => {
    const [mode, setMode] = useState<"auto" | "manual" | "off">("auto");
    return (
      <div className="grid gap-2">
        <RadioCard
          name="session-mode"
          value="auto"
          current={mode}
          label="Automatic"
          description="Let Acorn pick the best session behavior."
          onSelect={setMode}
        />
        <RadioCard
          name="session-mode"
          value="manual"
          current={mode}
          label="Manual"
          description="Choose session behavior per project."
          onSelect={setMode}
        />
        <RadioCard
          name="session-mode"
          value="off"
          current={mode}
          label="Off"
          description="Disable this behavior for now."
          onSelect={setMode}
        />
      </div>
    );
  },
};
