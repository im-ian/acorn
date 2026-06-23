import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  FileText,
  GitCommit,
  GitPullRequest,
  MoreHorizontal,
  Terminal,
} from "lucide-react";
import {
  IconButton,
  ListActionRow,
  ListBox,
  ListEmptyState,
  ListRow,
  ListRowButton,
  StatusBadge,
  type ListBoxInset,
  type ListBoxLayout,
  type ListBoxSpacing,
  type ListRowDensity,
  type ListRowSurface,
} from "../../src/components/ui";

const rowDensities = [
  "default",
  "balanced",
  "compact",
  "sidebar",
  "none",
] satisfies ListRowDensity[];

const rowSurfaces = [
  "panel",
  "dialog",
  "subtle",
  "sidebar",
] satisfies ListRowSurface[];

const boxInsets = ["default", "sidebar", "nested", "none"] satisfies ListBoxInset[];
const boxLayouts = ["block", "flex"] satisfies ListBoxLayout[];
const boxSpacings = ["tight", "normal", "none"] satisfies ListBoxSpacing[];

const meta = {
  title: "UI/List",
  component: ListBox,
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ListBox>;

export default meta;

type Story = StoryObj<typeof meta>;

const rows = [
  {
    title: "refactor(ui): centralize row density",
    meta: "8 files changed",
    icon: <GitCommit size={14} />,
    tone: "accent",
  },
  {
    title: "src/components/RightPanel.tsx",
    meta: "+42 -31",
    icon: <FileText size={14} />,
    tone: "success",
  },
  {
    title: "feat/ui-floating-card-polish",
    meta: "ready for review",
    icon: <GitPullRequest size={14} />,
    tone: "warning",
  },
] as const;

export const Default: Story = {
  render: () => (
    <ListBox layout="flex">
      {rows.map((row, index) => (
        <ListRow key={row.title} selected={index === 0}>
          <RowContent row={row} />
        </ListRow>
      ))}
    </ListBox>
  ),
};

export const DensityMatrix: Story = {
  render: () => (
    <div className="grid gap-4">
      {rowDensities.map((density) => (
        <section key={density} className="grid gap-2">
          <div className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
            {density}
          </div>
          <ListBox layout="flex" inset="none">
            {rows.map((row, index) => (
              <ListRow
                key={row.title}
                density={density}
                selected={index === 0}
              >
                <RowContent row={row} />
              </ListRow>
            ))}
          </ListBox>
        </section>
      ))}
    </div>
  ),
};

export const InteractiveSurfaces: Story = {
  render: () => {
    const [selected, setSelected] = useState<ListRowSurface>("panel");
    return (
      <ListBox layout="flex">
        {rowSurfaces.map((surface) => (
          <ListRowButton
            key={surface}
            surface={surface}
            selected={selected === surface}
            onClick={() => setSelected(surface)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Terminal size={14} className="shrink-0 text-accent" />
              <span className="font-medium">{surface}</span>
              <span className="ml-auto text-fg-muted">surface</span>
            </div>
          </ListRowButton>
        ))}
      </ListBox>
    );
  },
};

export const BoxInsetsAndSpacing: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-4">
      {boxInsets.map((inset) => (
        <section
          key={inset}
          className="rounded-md border border-border bg-bg-sidebar/40"
        >
          <div className="border-b border-border px-3 py-2 font-mono text-[11px] text-fg-muted">
            inset: {inset}
          </div>
          <ListBox inset={inset} layout="flex" spacing="tight">
            {rows.slice(0, 2).map((row) => (
              <ListRow key={row.title} density="compact">
                <RowContent row={row} />
              </ListRow>
            ))}
          </ListBox>
        </section>
      ))}
      {boxLayouts.map((layout) =>
        boxSpacings.map((spacing) => (
          <section
            key={`${layout}-${spacing}`}
            className="rounded-md border border-border bg-bg-sidebar/40"
          >
            <div className="border-b border-border px-3 py-2 font-mono text-[11px] text-fg-muted">
              {layout} / {spacing}
            </div>
            <ListBox inset="default" layout={layout} spacing={spacing}>
              {rows.slice(0, 2).map((row) => (
                <ListRow key={row.title} density="compact">
                  <RowContent row={row} />
                </ListRow>
              ))}
            </ListBox>
          </section>
        )),
      )}
    </div>
  ),
};

export const ActionRows: Story = {
  render: () => (
    <ListBox layout="flex">
      {rows.map((row, index) => (
        <ListActionRow
          key={row.title}
          onOpen={() => undefined}
          selected={index === 1}
          className="flex items-center gap-2"
        >
          <RowContent row={row} />
          <IconButton aria-label="More" size="xs" variant="ghost">
            <MoreHorizontal size={13} />
          </IconButton>
        </ListActionRow>
      ))}
    </ListBox>
  ),
};

export const Empty: Story = {
  render: () => (
    <div className="h-44 rounded-md border border-border bg-bg-sidebar/40">
      <ListEmptyState>No commits match the current filter.</ListEmptyState>
    </div>
  ),
};

function RowContent({ row }: { row: (typeof rows)[number] }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 text-fg-muted">{row.icon}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
      <StatusBadge tone={row.tone} size="xs">
        {row.meta}
      </StatusBadge>
    </div>
  );
}
