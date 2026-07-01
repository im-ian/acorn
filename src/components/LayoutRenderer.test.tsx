import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNode } from "../lib/layout";
import { EQUALIZE_PANES_EVENT } from "../lib/layoutEvents";

vi.mock("./Pane", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Pane: ({ paneId }: { paneId: string }) =>
      React.createElement("div", { "data-testid": "pane", "data-pane": paneId }),
  };
});

// react-resizable-panels measures real DOM; in jsdom its imperative setLayout
// throws "Invalid 0 panel layout" because no panels register. Stub it to a
// passthrough with a no-op imperative handle so the test exercises only the
// equalize event wiring and its effect on the persisted store layout.
vi.mock("react-resizable-panels", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    PanelGroup: React.forwardRef(
      (
        { children }: { children?: React.ReactNode },
        ref: React.Ref<{ setLayout: (sizes: number[]) => void }>,
      ) => {
        React.useImperativeHandle(ref, () => ({ setLayout: () => {} }));
        return React.createElement("div", { "data-testid": "panel-group" }, children);
      },
    ),
    Panel: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    PanelResizeHandle: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});

import { LayoutRenderer } from "./LayoutRenderer";
import { useAppStore } from "../store";

const REPO = "/Users/me/repo";

function splitLayout(sizes: [number, number]): LayoutNode {
  return {
    kind: "split",
    id: "s1",
    direction: "horizontal",
    a: { kind: "pane", id: "root" },
    b: { kind: "pane", id: "side" },
    sizes,
  };
}

function setup(viewMode: "panes" | "kanban", sizes: [number, number]): void {
  const layout = splitLayout(sizes);
  useAppStore.setState(
    {
      workspaces: {
        [REPO]: { layout, panes: {}, focusedPaneId: "root" },
      },
      activeProject: REPO,
      activeProjectFolderId: null,
      layout,
      workspaceViewMode: viewMode,
    },
    false,
  );
}

function activeSizes(): readonly number[] | undefined {
  const layout = useAppStore.getState().workspaces[REPO].layout;
  return layout.kind === "split" ? layout.sizes : undefined;
}

describe("LayoutRenderer equalize-panes guard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(): void {
    act(() => {
      root.render(<LayoutRenderer node={useAppStore.getState().layout} />);
    });
  }

  it("equalizes pane splits when the panes view is active", () => {
    setup("panes", [70, 30]);
    render();

    act(() => {
      window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
    });

    const sizes = activeSizes();
    expect(sizes?.[0]).toBeCloseTo(50, 1);
    expect(sizes?.[1]).toBeCloseTo(50, 1);
  });

  it("ignores the equalize event while the kanban view hides the panes", () => {
    setup("kanban", [70, 30]);
    render();

    act(() => {
      window.dispatchEvent(new CustomEvent(EQUALIZE_PANES_EVENT));
    });

    expect(activeSizes()).toEqual([70, 30]);
  });
});
