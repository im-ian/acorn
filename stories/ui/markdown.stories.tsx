import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Markdown } from "../../src/components/ui/Markdown";

const sampleMarkdown = [
  "### Pull request summary",
  "",
  "- [x] Add Storybook",
  "- [ ] Review component coverage",
  "",
  "| Area | Status |",
  "| --- | --- |",
  "| UI | Ready |",
  "| Build | Verified |",
  "",
  "> Markdown uses the same compact rendering as Acorn review panels.",
  "",
  "`pnpm run build:storybook`",
].join("\n");

const meta = {
  title: "UI/Markdown",
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

export const Content: Story = {
  render: () => <Markdown content={sampleMarkdown} />,
};

export const TaskList: Story = {
  render: () => {
    const [content, setContent] = useState(sampleMarkdown);
    return (
      <Markdown
        content={content}
        onTaskToggle={(index, checked) => {
          let current = -1;
          setContent((value) =>
            value.replace(/- \[[ x]\]/g, (match) => {
              current += 1;
              if (current !== index) return match;
              return checked ? "- [x]" : "- [ ]";
            }),
          );
        }}
      />
    );
  },
};
