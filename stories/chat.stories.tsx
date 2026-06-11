import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatCodeBlock } from "../src/components/chat/ChatCodeBlock";
import { ChatMessageBody } from "../src/components/chat/ChatMessageBody";

const meta = {
  title: "Components/Chat",
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[720px] rounded-lg border border-border bg-bg-elevated p-4 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const MessageBody: Story = {
  render: () => (
    <ChatMessageBody
      content={[
        "I added a compact Storybook setup and kept it separate from the app build.",
        "",
        "```tsx",
        "export function Example() {",
        "  return <button type=\"button\">Run</button>;",
        "}",
        "```",
        "",
        "- Existing Vite build remains unchanged",
        "- Stories render Acorn UI components in isolation",
      ].join("\n")}
    />
  ),
};

export const CodeBlock: Story = {
  render: () => (
    <ChatCodeBlock
      language="tsx"
      code={[
        "import { TextInput } from './TextInput';",
        "",
        "export function SearchField() {",
        "  return <TextInput placeholder=\"Search\" />;",
        "}",
      ].join("\n")}
    />
  ),
};

export const DiffBlock: Story = {
  render: () => (
    <ChatCodeBlock
      language="diff"
      code={[
        "diff --git a/package.json b/package.json",
        "@@ -1,4 +1,5 @@",
        " {",
        "+  \"storybook\": \"storybook dev -p 6006\",",
        "   \"build\": \"tsc && vite build\"",
        " }",
      ].join("\n")}
    />
  ),
};
