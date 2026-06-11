import type { Meta, StoryObj } from "@storybook/react-vite";
import { Search } from "lucide-react";
import { Field } from "../../src/components/ui/Field";
import { IconInput } from "../../src/components/ui/IconInput";
import { TextInput } from "../../src/components/ui/TextInput";

const meta = {
  title: "UI/Field",
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

export const WithHint: Story = {
  render: () => (
    <Field label="Project path" hint="Shown with Acorn's compact form spacing.">
      <TextInput defaultValue="/Users/acorn/workspace" />
    </Field>
  ),
};

export const Stacked: Story = {
  render: () => (
    <div className="grid gap-4">
      <Field label="Repository">
        <TextInput defaultValue="im-ian/acorn" />
      </Field>
      <Field label="Filter" hint="Use the same wrapper for icon inputs.">
        <IconInput leading={<Search size={13} />} placeholder="Changed files" />
      </Field>
    </div>
  ),
};
