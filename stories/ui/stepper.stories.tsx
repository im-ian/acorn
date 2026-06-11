import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field } from "../../src/components/ui/Field";
import { Stepper } from "../../src/components/ui/Stepper";

const meta = {
  title: "UI/Stepper",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[320px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Percent: Story = {
  render: () => {
    const [scale, setScale] = useState(100);
    return (
      <Field label="UI scale">
        <Stepper
          value={scale}
          min={75}
          max={150}
          step={5}
          unit="%"
          onChange={setScale}
        />
      </Field>
    );
  },
};

export const Fractional: Story = {
  render: () => {
    const [opacity, setOpacity] = useState(0.8);
    return (
      <Field label="Opacity">
        <Stepper
          value={opacity}
          min={0}
          max={1}
          step={0.05}
          format={(value) => value.toFixed(2)}
          onChange={setOpacity}
        />
      </Field>
    );
  },
};
