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
    <div className="h-[36rem] overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <SkeletonCircle className="h-3.5 w-3.5 shrink-0 bg-fg-muted/20" />
            <span className="shrink-0 font-mono text-xs text-fg-muted">
              #128
            </span>
            <SkeletonBlock className="h-3.5 w-[55%] bg-fg-muted/15" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <SkeletonCircle className="h-4 w-4 shrink-0 bg-fg-muted/15" />
            <SkeletonBlock className="h-2.5 w-16 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-40 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-8 shrink-0" />
            <SkeletonBlock className="h-2.5 w-8 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-14 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-4 w-11 shrink-0 rounded-full bg-fg-muted/10" />
            <SkeletonBlock className="h-4 w-14 shrink-0 rounded-full bg-fg-muted/10" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SkeletonBlock className="h-6 w-14 rounded-md bg-fg-muted/10" />
          <SkeletonBlock className="h-6 w-12 rounded-md bg-fg-muted/10" />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <SkeletonBlock className="h-6 w-6 rounded bg-fg-muted/10" />
          <SkeletonBlock className="h-6 w-6 rounded bg-fg-muted/10" />
          <SkeletonBlock className="h-6 w-6 rounded bg-fg-muted/10" />
        </div>
      </header>
      <div
        className="overflow-hidden border-b border-border bg-bg-sidebar/40 px-4 py-3"
        style={{ height: 192 }}
      >
        <div className="mb-3 flex items-center gap-2">
          <SkeletonBlock className="h-3 w-3 rounded-sm bg-fg-muted/15" />
          <SkeletonBlock className="h-3 w-32 bg-fg-muted/15" />
        </div>
        <SkeletonText
          className="gap-2"
          lines={4}
          widths={["86%", "74%", "54%", "42%"]}
        />
        <div className="mt-3 grid gap-1.5">
          {[0, 1].map((item) => (
            <div key={item} className="flex items-center gap-2">
              <SkeletonBlock className="h-3 w-3 rounded-sm bg-fg-muted/15" />
              <SkeletonBlock className="h-3 w-[42%]" />
            </div>
          ))}
        </div>
      </div>
      <div
        aria-hidden
        className="h-1.5 shrink-0 border-b border-border bg-bg-sidebar/40"
      />
      <nav className="flex gap-0.5 border-b border-border px-1.5 py-1">
        {[
          { icon: <MessagesSquare size={13} />, w: "w-20", active: true },
          { icon: <GitCommit size={13} />, w: "w-14", active: false },
          { icon: <CheckCircle2 size={13} />, w: "w-12", active: false },
          { icon: <GitPullRequest size={13} />, w: "w-10", active: false },
        ].map((tab, index) => (
          <div
            key={index}
            className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs ${
              tab.active ? "acorn-tab-active-bg text-fg" : "text-fg-muted/60"
            }`}
          >
            {tab.icon}
            <SkeletonBlock
              className={[
                "h-2.5",
                tab.active ? "bg-fg-muted/20" : "bg-fg-muted/15",
                tab.w,
              ]}
            />
            {index === 0 ? (
              <SkeletonBlock className="h-4 w-5 rounded-full bg-fg-muted/15" />
            ) : null}
          </div>
        ))}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1.5">
          <div className="flex items-center gap-1 rounded px-1.5 py-0.5">
            <SkeletonBlock className="h-3 w-3 shrink-0 rounded-sm bg-fg-muted/15" />
            <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/15" />
          </div>
        </div>
        <div className="space-y-3 px-4 py-3">
          {[
            { titleW: "w-24", metaW: "w-14", lines: ["95%", "82%", "60%"] },
            { titleW: "w-32", metaW: "w-20", lines: ["70%", "45%"] },
            {
              titleW: "w-20",
              metaW: "w-16",
              lines: ["88%", "76%", "52%", "30%"],
            },
          ].map((row, index) => (
            <div
              key={index}
              className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3"
            >
              <div className="mb-2 flex items-center gap-2">
                <SkeletonCircle className="h-7 w-7 shrink-0 bg-fg-muted/15" />
                <SkeletonBlock
                  className={["h-3 bg-fg-muted/15", row.titleW]}
                />
                <SkeletonBlock className={["h-4 rounded-full", row.metaW]} />
                <SkeletonBlock className="h-2.5 w-20" />
              </div>
              <SkeletonText lines={row.lines.length} widths={row.lines} />
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
};

export const ActionsDetailLayout: Story = {
  render: () => (
    <div className="h-[36rem] overflow-hidden rounded-[var(--acorn-pane-radius)] border border-border bg-bg">
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <SkeletonCircle className="h-3.5 w-3.5 shrink-0 bg-fg-muted/20" />
            <SkeletonBlock className="h-3.5 w-[58%] min-w-0 bg-fg-muted/15" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <SkeletonBlock className="h-2.5 w-20 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-14 shrink-0" />
            <span className="text-[10px] text-fg-muted/40">·</span>
            <SkeletonBlock className="h-2.5 w-24 shrink-0" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SkeletonBlock className="h-6 w-6 rounded bg-fg-muted/10" />
          <SkeletonBlock className="h-6 w-6 rounded bg-fg-muted/10" />
        </div>
      </header>
      <div className="space-y-3 px-4 py-3">
        <section className="rounded-[var(--acorn-pane-radius)] border border-border bg-bg-sidebar/40 p-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[11px]">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="contents">
                <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/15" />
                <SkeletonBlock
                  className="h-2.5 bg-fg-muted/10"
                  style={{ width: `${38 + ((index * 29) % 42)}%` }}
                />
              </div>
            ))}
          </div>
        </section>
        <section>
          <div className="mb-1.5 flex items-center gap-2">
            <SkeletonBlock className="h-2.5 w-16 bg-fg-muted/15" />
            <SkeletonBlock className="h-4 w-8 rounded-full bg-fg-muted/10" />
          </div>
          <ul className="space-y-1.5">
            {Array.from({ length: 3 }).map((_, index) => (
              <li
                key={index}
                className="overflow-hidden rounded-md border border-border bg-bg-elevated/40"
              >
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <SkeletonBlock className="h-3 w-3 shrink-0 rounded-sm bg-fg-muted/10" />
                  <SkeletonCircle className="h-3.5 w-3.5 shrink-0 bg-fg-muted/15" />
                  <SkeletonBlock
                    className="h-3 min-w-0 flex-1 bg-fg-muted/15"
                    style={{ width: `${48 + ((index * 17) % 30)}%` }}
                  />
                  <SkeletonBlock className="ml-auto h-2.5 w-12 shrink-0" />
                </div>
                {index === 0 ? (
                  <div className="border-t border-border/40 px-2.5 py-2">
                    <SkeletonText
                      className="gap-1.5"
                      lineClassName="h-2.5"
                      lines={3}
                      widths={["64%", "52%", "40%"]}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  ),
};
