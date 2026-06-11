import type { Meta, StoryObj } from "@storybook/react-vite";
import { AuthorAvatar } from "../src/components/AuthorAvatar";
import { AuthorTag } from "../src/components/AuthorTag";

const meta = {
  title: "Components/Identity",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[360px] rounded-lg border border-border bg-bg-elevated p-4 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Authors: Story = {
  render: () => (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-2">
        <AuthorAvatar login="octocat" size={28} />
        <AuthorTag login="octocat" size={28} />
      </div>
      <div className="flex items-center gap-2">
        <AuthorTag login="dependabot[bot]" size={24} />
      </div>
      <div className="flex items-center gap-2">
        <AuthorTag login={null} fallbackName="Local Author" />
      </div>
    </div>
  ),
};

export const AvatarOnly: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <AuthorTag login="octocat" avatarOnly />
      <AuthorTag login="github-actions[bot]" avatarOnly />
      <AuthorAvatar login="im-ian" size={32} />
    </div>
  ),
};
