import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExternalLink, Terminal } from "lucide-react";
import { Button } from "../../src/components/ui/Button";
import { CodeValue } from "../../src/components/ui/CodeValue";
import { Modal } from "../../src/components/ui/Modal";
import { ModalFooter } from "../../src/components/ui/ModalFooter";
import { ModalHeader } from "../../src/components/ui/ModalHeader";
import { Notice } from "../../src/components/ui/Notice";

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
        <Button onClick={() => setOpen(true)} variant="primary">
          Open dialog
        </Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          variant="dialog"
          size="md"
        >
          <ModalHeader
            title="Run command"
            subtitle="Preview of the shared dialog shell"
            icon={<Terminal size={15} className="text-accent" />}
            variant="dialog"
            onClose={() => setOpen(false)}
          />
          <div className="space-y-3 px-4 py-4 text-sm">
            <Notice tone="neutral" density="compact">
              Dialog modals use the elevated surface and compact header.
            </Notice>
            <CodeValue as="pre" surface="muted" overflow="scroll">
              pnpm run storybook
            </CodeValue>
          </div>
          <ModalFooter variant="sidebar">
            <Button onClick={() => setOpen(false)} surface="dialog">
              Cancel
            </Button>
            <Button variant="primary" surface="dialog">
              Run
            </Button>
          </ModalFooter>
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
        <Button onClick={() => setOpen(true)} variant="primary">
          Open panel
        </Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          variant="panel"
          size="3xl"
        >
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
