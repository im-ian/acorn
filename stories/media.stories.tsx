import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AcornRain } from "../src/components/AcornRain";
import { ImageLightbox } from "../src/components/ImageLightbox";
import { Button } from "../src/components/ui/Button";

const meta = {
  title: "Components/Media",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Lightbox: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="h-screen bg-bg p-8 text-fg">
        <Button onClick={() => setOpen(true)} variant="primary">
          Open lightbox
        </Button>
        <ImageLightbox
          image={
            open
              ? {
                  src: "https://images.unsplash.com/photo-1515879218367-8466d910aaa4?w=1200&auto=format&fit=crop",
                  alt: "Code on a laptop",
                }
              : null
          }
          onClose={() => setOpen(false)}
        />
      </div>
    );
  },
};

export const TreeShake: Story = {
  render: () => (
    <div className="h-screen bg-bg p-8 text-fg">
      <Button
        onClick={() => window.dispatchEvent(new Event("acorn:shake-tree"))}
        variant="primary"
      >
        Shake tree
      </Button>
      <AcornRain />
    </div>
  ),
};
