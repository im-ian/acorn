import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CANVAS_DEFAULT_NODE_HEIGHT,
  WORKSPACE_CANVAS_DEFAULT_NODE_WIDTH,
  WORKSPACE_CANVAS_GRID_SIZE,
  WORKSPACE_CANVAS_MAX_ZOOM,
  WORKSPACE_CANVAS_MIN_NODE_HEIGHT,
  WORKSPACE_CANVAS_MIN_NODE_WIDTH,
  WORKSPACE_CANVAS_MIN_ZOOM,
  alignWorkspaceCanvasNode,
  findWorkspaceCanvasMinimapNodeAtPoint,
  fitWorkspaceCanvasViewport,
  centerWorkspaceCanvasViewportFromMinimapPoint,
  layoutWorkspaceCanvasMinimap,
  normalizeWorkspaceCanvasState,
  reconcileWorkspaceCanvasState,
  revealWorkspaceCanvasNode,
  resetWorkspaceCanvasState,
  snapWorkspaceCanvasValue,
  workspaceCanvasStatesEqual,
  zoomWorkspaceCanvasAtPoint,
} from "./workspaceCanvas";

describe("workspaceCanvas", () => {
  it("repairs persisted bounds and discards malformed nodes", () => {
    expect(
      normalizeWorkspaceCanvasState({
        viewport: { offset: { x: 10, y: 20 }, zoom: 99 },
        nodes: {
          good: { x: 1, y: 2, width: 10, height: 20, zIndex: 3.8 },
          broken: { x: "nope", y: 2, width: 600, height: 400, zIndex: 2 },
        },
      }),
    ).toEqual({
      viewport: {
        offset: { x: 10, y: 20 },
        zoom: WORKSPACE_CANVAS_MAX_ZOOM,
      },
      nodes: {
        good: {
          x: 1,
          y: 2,
          width: WORKSPACE_CANVAS_MIN_NODE_WIDTH,
          height: WORKSPACE_CANVAS_MIN_NODE_HEIGHT,
          zIndex: 3,
        },
      },
    });
  });

  it("preserves known nodes, removes stale ones, and places new sessions", () => {
    const result = reconcileWorkspaceCanvasState(
      {
        viewport: { offset: { x: -10, y: 25 }, zoom: 0.8 },
        nodes: {
          first: { x: 100, y: 120, width: 500, height: 320, zIndex: 4 },
          stale: { x: 0, y: 0, width: 500, height: 320, zIndex: 2 },
        },
      },
      ["first", "second", "second"],
    );

    expect(result.viewport).toEqual({
      offset: { x: -10, y: 25 },
      zoom: 0.8,
    });
    expect(Object.keys(result.nodes)).toEqual(["first", "second"]);
    expect(result.nodes.first).toMatchObject({ x: 100, y: 120, zIndex: 4 });
    expect(result.nodes.second.zIndex).toBe(5);
    expect(result.nodes.second).not.toMatchObject({ x: 100, y: 120 });
  });

  it("resets sessions into a deterministic two-column layout", () => {
    const result = resetWorkspaceCanvasState(["a", "b", "c"]);
    expect(result.nodes.a.x).toBe(result.nodes.c.x);
    expect(result.nodes.a.y).toBeLessThan(result.nodes.c.y);
    expect(result.nodes.b.x).toBeGreaterThan(result.nodes.a.x);
  });

  it("places new sessions on exact grid cells with a grid-sized default", () => {
    const result = resetWorkspaceCanvasState(["a", "b", "c"]);

    expect(result.nodes.a).toMatchObject({
      x: 40,
      y: 40,
      width: 620,
      height: 420,
    });
    expect(WORKSPACE_CANVAS_DEFAULT_NODE_WIDTH).toBe(620);
    expect(WORKSPACE_CANVAS_DEFAULT_NODE_HEIGHT).toBe(420);
    for (const node of Object.values(result.nodes)) {
      expect(node.x % WORKSPACE_CANVAS_GRID_SIZE).toBe(0);
      expect(node.y % WORKSPACE_CANVAS_GRID_SIZE).toBe(0);
      expect(node.width % WORKSPACE_CANVAS_GRID_SIZE).toBe(0);
      expect(node.height % WORKSPACE_CANVAS_GRID_SIZE).toBe(0);
    }
  });

  it("places a new grid-sized session beside the preserved legacy default", () => {
    const result = reconcileWorkspaceCanvasState(
      {
        viewport: { offset: { x: 48, y: 48 }, zoom: 1 },
        nodes: {
          legacy: { x: 48, y: 48, width: 620, height: 400, zIndex: 1 },
        },
      },
      ["legacy", "new"],
    );

    expect(result.nodes.legacy).toEqual({
      x: 48,
      y: 48,
      width: 620,
      height: 400,
      zIndex: 1,
    });
    expect(result.nodes.new).toEqual({
      x: 720,
      y: 40,
      width: 620,
      height: 420,
      zIndex: 2,
    });
  });

  it("keeps the world point under the cursor fixed while zooming", () => {
    const viewport = zoomWorkspaceCanvasAtPoint(
      { offset: { x: 50, y: 20 }, zoom: 1 },
      1.5,
      { x: 250, y: 120 },
    );
    expect(viewport).toEqual({
      offset: { x: -50, y: -30 },
      zoom: 1.5,
    });
  });

  it("fits all nodes into the viewport and respects the minimum zoom", () => {
    const viewport = fitWorkspaceCanvasViewport(
      {
        first: { x: 0, y: 0, width: 620, height: 400, zIndex: 1 },
        second: { x: 0, y: 8_000, width: 620, height: 400, zIndex: 2 },
      },
      { width: 1_000, height: 700 },
    );
    expect(viewport.zoom).toBe(WORKSPACE_CANVAS_MIN_ZOOM);
  });

  it("compares persisted layouts by value and snaps committed geometry", () => {
    const state = resetWorkspaceCanvasState(["a"]);
    expect(workspaceCanvasStatesEqual(structuredClone(state), state)).toBe(
      true,
    );
    expect(snapWorkspaceCanvasValue(31)).toBe(40);
    expect(snapWorkspaceCanvasValue(-9)).toBe(0);
  });

  it("magnetically aligns matching node edges while moving", () => {
    const result = alignWorkspaceCanvasNode(
      { x: 95, y: 204, width: 500, height: 300, zIndex: 3 },
      [{ x: 100, y: 200, width: 620, height: 400, zIndex: 1 }],
      "move",
      8,
    );

    expect(result.node).toEqual({
      x: 100,
      y: 200,
      width: 500,
      height: 300,
      zIndex: 3,
    });
    expect(result.matches).toEqual({
      x: true,
      y: true,
      width: false,
      height: false,
    });
    expect(result.guides).toEqual([
      { axis: "x", position: 100, start: 200, end: 600 },
      { axis: "y", position: 200, start: 100, end: 720 },
    ]);
  });

  it("aligns node centers when their outer edges differ", () => {
    const result = alignWorkspaceCanvasNode(
      { x: 347, y: 259, width: 100, height: 80, zIndex: 3 },
      [{ x: 300, y: 200, width: 200, height: 200, zIndex: 1 }],
      "move",
      8,
    );

    expect(result.node.x).toBe(350);
    expect(result.node.y).toBe(260);
    expect(result.guides).toEqual([
      { axis: "x", position: 400, start: 200, end: 400 },
      { axis: "y", position: 300, start: 300, end: 500 },
    ]);
  });

  it("matches peer dimensions while resizing and releases outside the threshold", () => {
    const target = { x: 900, y: 300, width: 620, height: 400, zIndex: 1 };
    const matched = alignWorkspaceCanvasNode(
      { x: 80, y: 100, width: 614, height: 407, zIndex: 3 },
      [target],
      "resize",
      8,
    );

    expect(matched.node).toMatchObject({ width: 620, height: 400 });
    expect(matched.matches).toEqual({
      x: false,
      y: false,
      width: true,
      height: true,
    });
    expect(matched.guides).toEqual([]);

    const released = alignWorkspaceCanvasNode(
      { x: 80, y: 100, width: 629, height: 409, zIndex: 3 },
      [target],
      "resize",
      8,
    );
    expect(released.node).toMatchObject({ width: 629, height: 409 });
    expect(released.matches).toEqual({
      x: false,
      y: false,
      width: false,
      height: false,
    });
  });

  it("keeps pointer-driven movement and resizing on whole pixels", () => {
    const moved = alignWorkspaceCanvasNode(
      { x: 95.49, y: 204.51, width: 500, height: 300, zIndex: 3 },
      [],
      "move",
      8,
    );
    expect(moved.node).toMatchObject({ x: 95, y: 205 });

    const resized = alignWorkspaceCanvasNode(
      { x: 80, y: 100, width: 614.49, height: 407.51, zIndex: 3 },
      [],
      "resize",
      8,
    );
    expect(resized.node).toMatchObject({ width: 614, height: 408 });
  });

  it("skips alignments that whole-pixel geometry cannot represent exactly", () => {
    const moved = alignWorkspaceCanvasNode(
      { x: 347, y: 259, width: 100, height: 80, zIndex: 3 },
      [{ x: 300, y: 200, width: 201, height: 201, zIndex: 1 }],
      "move",
      8,
    );

    expect(moved.node).toMatchObject({ x: 347, y: 259 });
    expect(moved.matches).toEqual({
      x: false,
      y: false,
      width: false,
      height: false,
    });
    expect(moved.guides).toEqual([]);

    const resized = alignWorkspaceCanvasNode(
      { x: 80, y: 100, width: 614, height: 407, zIndex: 3 },
      [{ x: 900, y: 300, width: 620.5, height: 400.5, zIndex: 1 }],
      "resize",
      8,
    );
    expect(resized.node).toMatchObject({ width: 614, height: 407 });
    expect(resized.matches).toEqual({
      x: false,
      y: false,
      width: false,
      height: false,
    });
  });

  it("pans only enough to reveal a selected node", () => {
    expect(
      revealWorkspaceCanvasNode(
        { offset: { x: 0, y: 0 }, zoom: 1 },
        { x: 900, y: 100, width: 400, height: 300, zIndex: 1 },
        { width: 1_000, height: 700 },
      ),
    ).toEqual({ offset: { x: -348, y: 0 }, zoom: 1 });
  });

  it("keeps an accessible oversized node header stationary", () => {
    const node = { x: 100, y: 100, width: 620, height: 400, zIndex: 1 };
    const viewport = revealWorkspaceCanvasNode(
      { offset: { x: 0, y: 0 }, zoom: 1.3 },
      node,
      { width: 700, height: 400 },
    );

    expect(node.y * viewport.zoom + viewport.offset.y).toBe(130);
  });

  it("clamps an oversized node header back inside the reveal padding", () => {
    const node = { x: 100, y: 100, width: 620, height: 400, zIndex: 1 };
    const viewport = revealWorkspaceCanvasNode(
      { offset: { x: 0, y: -300 }, zoom: 1 },
      node,
      { width: 700, height: 400 },
    );

    expect(node.y * viewport.zoom + viewport.offset.y).toBe(48);
  });

  it("maps nodes and the viewport into a minimap and recenters from it", () => {
    const viewport = { offset: { x: 0, y: 0 }, zoom: 1 };
    const layout = layoutWorkspaceCanvasMinimap(
      {
        first: { x: 0, y: 0, width: 100, height: 100, zIndex: 1 },
        second: { x: 300, y: 200, width: 100, height: 100, zIndex: 2 },
      },
      viewport,
      { width: 200, height: 100 },
      { width: 200, height: 100 },
      0,
    );

    expect(layout.bounds).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(layout.scale).toBeCloseTo(1 / 3);
    expect(layout.nodeRects.first.x).toBeCloseTo(100 / 3);
    expect(layout.nodeRects.first.width).toBeCloseTo(100 / 3);
    expect(layout.nodeRects.second.x).toBeCloseTo(400 / 3);
    expect(layout.nodeRects.second.y).toBeCloseTo(200 / 3);
    expect(layout.viewportRect.width).toBeCloseTo(200 / 3);
    expect(layout.viewportRect.height).toBeCloseTo(100 / 3);

    const centered = centerWorkspaceCanvasViewportFromMinimapPoint(
      viewport,
      { width: 200, height: 100 },
      layout,
      { x: 150, y: 250 / 3 },
    );
    expect(centered).toEqual({
      offset: { x: -250, y: -200 },
      zoom: 1,
    });
  });

  it("includes a distant viewport in minimap bounds and stays finite before measurement", () => {
    const nodes = {
      first: { x: -200, y: -100, width: 100, height: 100, zIndex: 1 },
    };
    const viewport = { offset: { x: -1_000, y: -500 }, zoom: 1 };
    const distant = layoutWorkspaceCanvasMinimap(
      nodes,
      viewport,
      { width: 200, height: 100 },
      { width: 160, height: 96 },
    );

    expect(distant.bounds).toEqual({
      x: -200,
      y: -100,
      width: 1_400,
      height: 700,
    });

    const unmeasured = layoutWorkspaceCanvasMinimap(
      nodes,
      viewport,
      { width: 0, height: 0 },
      { width: 160, height: 96 },
    );
    const centered = centerWorkspaceCanvasViewportFromMinimapPoint(
      viewport,
      { width: 0, height: 0 },
      unmeasured,
      { x: 80, y: 48 },
    );
    expect(
      [
        unmeasured.scale,
        unmeasured.origin.x,
        unmeasured.origin.y,
        unmeasured.viewportRect.x,
        unmeasured.viewportRect.y,
        centered.offset.x,
        centered.offset.y,
      ].every(Number.isFinite),
    ).toBe(true);
  });

  it("chooses the nearest visible marker when dense minimap targets overlap", () => {
    const nodes = {
      first: { x: 0, y: 0, width: 620, height: 400, zIndex: 1 },
      second: { x: 660, y: 0, width: 620, height: 400, zIndex: 2 },
      top: { x: 0, y: 440, width: 620, height: 400, zIndex: 4 },
      underneath: { x: 0, y: 440, width: 620, height: 400, zIndex: 3 },
    };
    const rects = {
      first: { x: 20, y: 20, width: 4, height: 4 },
      second: { x: 30, y: 20, width: 4, height: 4 },
      top: { x: 50, y: 50, width: 6, height: 6 },
      underneath: { x: 50, y: 50, width: 6, height: 6 },
    };

    expect(
      findWorkspaceCanvasMinimapNodeAtPoint(
        ["first", "second"],
        nodes,
        rects,
        { x: 22, y: 22 },
      ),
    ).toBe("first");
    expect(
      findWorkspaceCanvasMinimapNodeAtPoint(
        ["first", "second"],
        nodes,
        rects,
        { x: 32, y: 22 },
      ),
    ).toBe("second");
    expect(
      findWorkspaceCanvasMinimapNodeAtPoint(
        ["underneath", "top"],
        nodes,
        rects,
        { x: 53, y: 53 },
      ),
    ).toBe("top");
    expect(
      findWorkspaceCanvasMinimapNodeAtPoint(
        ["first", "second"],
        nodes,
        rects,
        { x: 100, y: 80 },
      ),
    ).toBeNull();
  });
});
