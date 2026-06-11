import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Eye, FolderOpen, Search, X } from "lucide-react";
import { Field } from "../../src/components/ui/Field";
import { IconInput } from "../../src/components/ui/IconInput";
import { TextInput } from "../../src/components/ui/TextInput";

const meta = {
  title: "UI/Input",
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

export const TextInputs: Story = {
  render: () => (
    <div className="grid gap-4">
      <Field label="Project path" hint="Compact mono input used in dialogs.">
        <TextInput defaultValue="/Users/acorn/workspace" />
      </Field>
      <Field label="Session title">
        <TextInput placeholder="New session name" />
      </Field>
      <Field label="Readonly">
        <TextInput readOnly defaultValue="generated-title" />
      </Field>
      <Field label="Disabled">
        <TextInput disabled defaultValue="disabled value" />
      </Field>
    </div>
  ),
};

export const IconInputs: Story = {
  render: () => {
    const [query, setQuery] = useState("storybook");
    return (
      <div className="grid gap-4">
        <Field label="Search">
          <IconInput
            leading={<Search size={13} />}
            trailing={
              query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="rounded p-0.5 text-fg-muted hover:bg-bg-sidebar hover:text-fg"
                >
                  <X size={12} />
                </button>
              ) : null
            }
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter sessions"
          />
        </Field>
        <Field label="Location">
          <IconInput
            leading={<FolderOpen size={13} />}
            trailing={<Eye size={13} />}
            defaultValue="/Users/acorn/workspace"
          />
        </Field>
        <Field label="Invalid">
          <IconInput
            leading={<Search size={13} />}
            invalid
            defaultValue="missing path"
          />
        </Field>
      </div>
    );
  },
};

export const DenseForm: Story = {
  render: () => (
    <div className="grid gap-3">
      <Field label="Repository">
        <TextInput defaultValue="im-ian/acorn" />
      </Field>
      <Field label="Branch">
        <TextInput defaultValue="feat/storybook-components" />
      </Field>
      <Field label="Filter">
        <IconInput leading={<Search size={13} />} placeholder="Changed files" />
      </Field>
    </div>
  ),
};
