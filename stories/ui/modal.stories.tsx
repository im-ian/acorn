import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExternalLink, Terminal } from "lucide-react";
import { Modal } from "../../src/components/ui/Modal";
import { ModalHeader } from "../../src/components/ui/ModalHeader";

const meta = {
  title: "UI/Modal",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Dialog: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="h-screen bg-bg p-8 text-fg">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg"
        >
          Open dialog
        </button>
        <Modal open={open} onClose={() => setOpen(false)} variant="dialog" size="md">
          <ModalHeader
            title="Run command"
            subtitle="Preview of the shared dialog shell"
            icon={<Terminal size={15} className="text-accent" />}
            variant="dialog"
            onClose={() => setOpen(false)}
          />
          <div className="space-y-3 px-4 py-4 text-sm">
            <p className="text-fg-muted">
              Dialog modals use the elevated surface and compact header.
            </p>
            <div className="rounded-md border border-border bg-bg-sidebar p-3 font-mono text-xs">
              pnpm run storybook
            </div>
          </div>
          <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <button
              type="button"
              className="rounded px-3 py-1 text-xs text-fg-muted hover:bg-bg-sidebar"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-accent px-3 py-1 text-xs font-medium text-white"
            >
              Run
            </button>
          </footer>
        </Modal>
      </div>
    );
  },
};

export const Panel: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="h-screen bg-bg p-8 text-fg">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-fg"
        >
          Open panel
        </button>
        <Modal open={open} onClose={() => setOpen(false)} variant="panel" size="3xl">
          <ModalHeader
            title="Pull request details"
            subtitle="Panel variant for larger workflows"
            icon={<ExternalLink size={15} className="text-accent" />}
            onClose={() => setOpen(false)}
          />
          <div className="grid flex-1 grid-cols-[220px_1fr] gap-4 overflow-hidden p-4 text-xs">
            <aside className="rounded-md border border-border bg-bg-sidebar p-3 text-fg-muted">
              Changed files
            </aside>
            <main className="rounded-md border border-border bg-bg-elevated p-3 text-fg">
              Review content
            </main>
          </div>
        </Modal>
      </div>
    );
  },
};
