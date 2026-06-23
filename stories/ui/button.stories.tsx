import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  Button,
  IconButton,
  buttonClassName,
  type ButtonSize,
  type ButtonSurface,
  type ButtonVariant,
  type IconButtonSize,
  type IconButtonVariant,
} from "../../src/components/ui/Button";
import { cn } from "../../src/lib/cn";

const buttonVariants = [
  "ghost",
  "neutral",
  "outline",
  "primary",
  "accentSoft",
  "dangerSoft",
  "danger",
  "dangerGhost",
] satisfies ButtonVariant[];

const buttonSizes = ["xs", "sm", "md"] satisfies ButtonSize[];
const buttonSurfaces = ["panel", "dialog"] satisfies ButtonSurface[];

const iconButtonVariants = [
  "ghost",
  "neutral",
  "outline",
  "primary",
  "dangerGhost",
  "dangerSoft",
] satisfies IconButtonVariant[];

const iconButtonSizes = ["xs", "sm", "md", "lg"] satisfies IconButtonSize[];

const meta = {
  title: "UI/Button",
  component: Button,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    variant: {
      control: "select",
      options: buttonVariants,
    },
    size: {
      control: "select",
      options: buttonSizes,
    },
    surface: {
      control: "select",
      options: buttonSurfaces,
    },
    disabled: {
      control: "boolean",
    },
  },
  args: {
    variant: "primary",
    size: "sm",
    surface: "panel",
    disabled: false,
    children: "Run",
  },
  decorators: [
    (Story) => (
      <div className="w-[760px] rounded-lg border border-border bg-bg-elevated p-5 text-fg shadow-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Button {...args}>
      <Play size={13} />
      {args.children}
    </Button>
  ),
};

export const ButtonVariants: Story = {
  render: () => (
    <div className="grid gap-5">
      {buttonSurfaces.map((surface) => (
        <SurfaceFrame key={surface} surface={surface}>
          <div className="grid gap-3">
            {buttonSizes.map((size) => (
              <div
                key={size}
                className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3"
              >
                <div className="font-mono text-[11px] text-fg-muted">
                  {size}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {buttonVariants.map((variant) => (
                    <Button
                      key={variant}
                      variant={variant}
                      size={size}
                      surface={surface}
                    >
                      {buttonIcon(variant)}
                      {variant}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SurfaceFrame>
      ))}
    </div>
  ),
};

export const IconButtonVariants: Story = {
  render: () => (
    <div className="grid gap-5">
      {buttonSurfaces.map((surface) => (
        <SurfaceFrame key={surface} surface={surface}>
          <div className="grid gap-3">
            {iconButtonSizes.map((size) => (
              <div
                key={size}
                className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3"
              >
                <div className="font-mono text-[11px] text-fg-muted">
                  {size}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {iconButtonVariants.map((variant) => (
                    <IconButton
                      key={variant}
                      aria-label={`${variant} ${size}`}
                      title={`${variant} ${size}`}
                      variant={variant}
                      size={size}
                      surface={surface}
                    >
                      {iconButtonIcon(variant)}
                    </IconButton>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SurfaceFrame>
      ))}
    </div>
  ),
};

export const DisabledStates: Story = {
  render: () => (
    <div className="grid gap-5">
      {buttonSurfaces.map((surface) => (
        <SurfaceFrame key={surface} surface={surface}>
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {buttonVariants.map((variant) => (
                <Button
                  key={variant}
                  disabled
                  variant={variant}
                  size="md"
                  surface={surface}
                >
                  {buttonIcon(variant)}
                  {variant}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {iconButtonVariants.map((variant) => (
                <IconButton
                  key={variant}
                  disabled
                  aria-label={`${variant} disabled`}
                  title={`${variant} disabled`}
                  variant={variant}
                  size="md"
                  surface={surface}
                >
                  {iconButtonIcon(variant)}
                </IconButton>
              ))}
            </div>
          </div>
        </SurfaceFrame>
      ))}
    </div>
  ),
};

export const LinkClassNameHelper: Story = {
  render: () => (
    <div className="grid gap-5">
      {buttonSurfaces.map((surface) => (
        <SurfaceFrame key={surface} surface={surface}>
          <div className="flex flex-wrap items-center gap-2">
            {buttonVariants.map((variant) => (
              <a
                key={variant}
                href="#"
                onClick={(event) => event.preventDefault()}
                className={buttonClassName({
                  variant,
                  size: "sm",
                  surface,
                })}
              >
                <ExternalLink size={12} />
                {variant}
              </a>
            ))}
          </div>
        </SurfaceFrame>
      ))}
    </div>
  ),
};

function SurfaceFrame({
  surface,
  children,
}: {
  surface: ButtonSurface;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-md border border-border p-3",
        surface === "dialog" ? "bg-bg-elevated" : "bg-bg",
      )}
    >
      <div className="mb-3 font-mono text-[11px] uppercase tracking-wide text-fg-muted">
        {surface}
      </div>
      {children}
    </section>
  );
}

function buttonIcon(variant: ButtonVariant): ReactNode {
  switch (variant) {
    case "primary":
    case "accentSoft":
      return <Play size={12} />;
    case "danger":
    case "dangerSoft":
    case "dangerGhost":
      return <Trash2 size={12} />;
    case "outline":
      return <Download size={12} />;
    case "neutral":
      return <Copy size={12} />;
    case "ghost":
      return <ExternalLink size={12} />;
  }
}

function iconButtonIcon(variant: IconButtonVariant): ReactNode {
  switch (variant) {
    case "primary":
      return <Check size={14} />;
    case "dangerSoft":
    case "dangerGhost":
      return <X size={14} />;
    case "outline":
      return <RefreshCw size={14} />;
    case "neutral":
      return <Copy size={14} />;
    case "ghost":
      return <Settings size={14} />;
  }
}
