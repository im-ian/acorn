import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CheckCircle2,
  GitCommit,
  GitPullRequest,
  MessagesSquare,
} from "lucide-react";
import {
  SkeletonBlock,
  SkeletonCircle,
  SkeletonList,
  SkeletonRow,
  SkeletonText,
} from "../../src/components/ui/Skeleton";

const meta = {
  title: "UI/Skeleton",
  component: SkeletonBlock,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[720px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SkeletonBlock>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primitives: Story = {
  render: () => (
    <div className="grid gap-5">
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
        <div className="font-mono text-[11px] text-fg-muted">block</div>
        <div className="flex items-center gap-2">
          <SkeletonBlock className="h-3 w-20 bg-fg-muted/15" />
          <SkeletonBlock className="h-3 w-36" />
          <SkeletonBlock className="h-5 w-12 rounded-full bg-fg-muted/15" />
        </div>
      </div>
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3">
        <div className="font-mono text-[11px] text-fg-muted">circle</div>
        <div className="flex items-center gap-2">
          <SkeletonCircle className="size-5" />
          <SkeletonCircle />
          <SkeletonCircle className="size-9 bg-fg-muted/20" />
        </div>
      </div>
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
        <div className="font-mono text-[11px] text-fg-muted">text</div>
        <SkeletonText
          className="max-w-md gap-2"
          lines={4}
          widths={["88%", "72%", "94%", "48%"]}
        />
      </div>
    </div>
  ),
};

export const RowsAndLists: Story = {
  render: () => (
    <div className="grid gap-4">
      <SkeletonRow />
      <SkeletonList count={5} />
    </div>
  ),
};

export const PullRequestRows: Story = {
  render: () => (
    <SkeletonList
      count={4}
      renderRow={(index) => {
        const titleWidths = ["55%", "72%", "40%", "65%"];
        const branchWidths = ["38%", "52%", "30%", "44%"];
        return (
          <div className="rounded-md px-3 py-2">
            <div className="flex w-full items-center gap-2">
              <SkeletonBlock className="h-3 w-8 shrink-0 bg-fg-muted/15" />
              <SkeletonBlock className="h-4 w-12 shrink-0 rounded-full bg-fg-muted/15" />
              <SkeletonBlock
                className="h-3 min-w-0 flex-1"
                style={{ width: titleWidths[index % titleWidths.length] }}
              />
            </div>
            <div className="mt-1.5 flex w-full items-center gap-2">
              <SkeletonBlock className="h-2.5 w-16 shrink-0" />
              <span className="text-[10px] text-fg-muted/40">·</span>
              <SkeletonBlock
                className="h-2.5"
                style={{ width: branchWidths[index % branchWidths.length] }}
              />
              <span className="text-[10px] text-fg-muted/40">·</span>
              <SkeletonBlock className="h-2.5 w-10 shrink-0" />
            </div>
          </div>
        );
      }}
    />
  ),
};

export const DetailLayout: Story = {
  render: () => (
    <div className="overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="h-3.5 w-3.5 bg-fg-muted/20" />
            <span className="font-mono text-xs text-fg-muted">#128</span>
            <SkeletonBlock className="h-3.5 w-[55%] bg-fg-muted/15" />
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <SkeletonBlock className="h-2.5 w-16" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-40" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-14" />
          </div>
        </div>
      </header>
      <div className="border-b border-border bg-bg-sidebar/40 px-4 py-3">
        <SkeletonText
          className="gap-2"
          lines={5}
          widths={["85%", "72%", "40%", "60%", "78%"]}
        />
      </div>
      <nav className="flex gap-0.5 border-b border-border px-1.5 py-1">
        {[
          { icon: <MessagesSquare size={13} />, w: "w-20" },
          { icon: <GitCommit size={13} />, w: "w-14" },
          { icon: <CheckCircle2 size={13} />, w: "w-12" },
          { icon: <GitPullRequest size={13} />, w: "w-10" },
        ].map((tab, index) => (
          <div
            key={index}
            className="flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs text-fg-muted/60"
          >
            {tab.icon}
            <SkeletonBlock className={["h-2.5 bg-fg-muted/15", tab.w]} />
          </div>
        ))}
      </nav>
      <div className="space-y-3 px-4 py-3">
        {[0, 1].map((index) => (
          <div
            key={index}
            className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <SkeletonCircle className="h-7 w-7 bg-fg-muted/15" />
              <SkeletonBlock className="h-3 w-28 bg-fg-muted/15" />
              <SkeletonBlock className="h-2.5 w-14" />
            </div>
            <SkeletonText lines={3} widths={["95%", "82%", "60%"]} />
          </div>
        ))}
      </div>
    </div>
  ),
};
