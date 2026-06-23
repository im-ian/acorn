import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, Download, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../src/components/ui/Button";
import {
  ModalFooter,
  type ModalFooterAlign,
  type ModalFooterVariant,
} from "../../src/components/ui/ModalFooter";

const footerVariants = ["plain", "sidebar"] satisfies ModalFooterVariant[];
const footerAlignments = [
  "start",
  "center",
  "end",
  "between",
] satisfies ModalFooterAlign[];

const meta = {
  title: "UI/ModalFooter",
  component: ModalFooter,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    variant: {
      control: "select",
      options: footerVariants,
    },
    align: {
      control: "select",
      options: footerAlignments,
    },
  },
  args: {
    variant: "sidebar",
    align: "end",
  },
} satisfies Meta<typeof ModalFooter>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <FooterFrame>
      <ModalFooter {...args}>
        <Button surface={args.variant === "sidebar" ? "dialog" : "panel"}>
          Cancel
        </Button>
        <Button
          variant="primary"
          surface={args.variant === "sidebar" ? "dialog" : "panel"}
        >
          <Check size={12} />
          Save
        </Button>
      </ModalFooter>
    </FooterFrame>
  ),
};

export const VariantsAndAlignment: Story = {
  render: () => (
    <div className="grid w-[760px] gap-5 text-fg">
      {footerVariants.map((variant) => (
        <section key={variant} className="grid gap-2">
          <h3 className="font-mono text-[11px] uppercase tracking-wide text-fg-muted">
            {variant}
          </h3>
          <div className="grid gap-3">
            {footerAlignments.map((align) => (
              <FooterFrame key={`${variant}-${align}`} label={align}>
                <ModalFooter variant={variant} align={align}>
                  <FooterActions align={align} variant={variant} />
                </ModalFooter>
              </FooterFrame>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

function FooterFrame({
  label = "content",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-xl">
      <div className="px-4 py-3 text-xs text-fg-muted">{label}</div>
      {children}
    </div>
  );
}

function FooterActions({
  align,
  variant,
}: {
  align: ModalFooterAlign;
  variant: ModalFooterVariant;
}) {
  const surface = variant === "sidebar" ? "dialog" : "panel";
  if (align === "between") {
    return (
      <>
        <span className="text-[11px] text-fg-muted">2 unsaved changes</span>
        <span className="flex items-center gap-2">
          <Button surface={surface}>
            <X size={12} />
            Discard
          </Button>
          <Button variant="primary" surface={surface}>
            <Download size={12} />
            Apply
          </Button>
        </span>
      </>
    );
  }

  return (
    <>
      <Button surface={surface}>Cancel</Button>
      <Button variant="dangerSoft" surface={surface}>
        <Trash2 size={12} />
        Remove
      </Button>
    </>
  );
}
