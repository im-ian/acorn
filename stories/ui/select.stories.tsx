import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Field } from "../../src/components/ui/Field";
import {
  Select,
  type SelectOptionGroup,
} from "../../src/components/ui/Select";

const agentOptions = [
  {
    value: "codex",
    label: "Codex",
    description: "Default coding agent",
  },
  {
    value: "claude",
    label: "Claude Code",
    description: "Alternative terminal agent",
  },
  {
    value: "antigravity",
    label: "Antigravity",
    description: "Experimental agent",
  },
];

const themeGroups: SelectOptionGroup[] = [
  {
    label: "Acorn themes",
    options: [
      { value: "acorn-dark", label: "Acorn Dark Green" },
      { value: "acorn-pink", label: "Acorn Dark Pink" },
      { value: "acorn-light", label: "Acorn Light Green" },
      { value: "acorn-light-pink", label: "Acorn Light Pink" },
    ],
  },
  {
    label: "Built-in dark",
    options: [
      { value: "one-dark-pro", label: "One Dark Pro" },
      { value: "tokyo-night", label: "Tokyo Night" },
      { value: "catppuccin-mocha", label: "Catppuccin Mocha" },
    ],
  },
  {
    label: "Built-in light",
    options: [
      { value: "github-light", label: "GitHub Light" },
      { value: "one-light", label: "One Light" },
      { value: "gruvbox-light", label: "Gruvbox Light" },
    ],
  },
];

const meta = {
  title: "UI/Select",
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

export const Basic: Story = {
  render: () => {
    const [agent, setAgent] = useState("codex");
    return (
      <Field label="Default agent">
        <Select
          value={agent}
          options={agentOptions}
          onValueChange={setAgent}
        />
      </Field>
    );
  },
};

export const SearchableGroups: Story = {
  render: () => {
    const [theme, setTheme] = useState("acorn-dark");
    return (
      <Field label="Theme" hint="Searchable grouped select from #430.">
        <Select
          value={theme}
          options={themeGroups}
          searchable
          searchPlaceholder="Search themes"
          onValueChange={setTheme}
        />
      </Field>
    );
  },
};

export const Multiple: Story = {
  render: () => {
    const [metadata, setMetadata] = useState(["branch", "status"]);
    return (
      <Field label="Session metadata">
        <Select
          multiple
          value={metadata}
          options={[
            { value: "branch", label: "Branch" },
            { value: "status", label: "Status" },
            { value: "agent", label: "Agent" },
            { value: "worktree", label: "Worktree" },
          ]}
          onValuesChange={setMetadata}
        />
      </Field>
    );
  },
};

export const SeparatorsAndDisabled: Story = {
  render: () => {
    const [value, setValue] = useState("run");
    return (
      <Field label="Command">
        <Select
          value={value}
          options={[
            { type: "separator", label: "Common" },
            { value: "run", label: "Run command" },
            { value: "copy", label: "Copy command" },
            { type: "separator", label: "Danger" },
            { value: "delete", label: "Delete session", disabled: true },
          ]}
          onValueChange={setValue}
        />
      </Field>
    );
  },
};
