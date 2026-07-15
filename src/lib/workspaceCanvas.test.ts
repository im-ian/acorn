import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CANVAS_MAX_ZOOM,
  WORKSPACE_CANVAS_MIN_NODE_HEIGHT,
  WORKSPACE_CANVAS_MIN_NODE_WIDTH,
  WORKSPACE_CANVAS_MIN_ZOOM,
  fitWorkspaceCanvasViewport,
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

  it("pans only enough to reveal a selected node", () => {
    expect(
      revealWorkspaceCanvasNode(
        { offset: { x: 0, y: 0 }, zoom: 1 },
        { x: 900, y: 100, width: 400, height: 300, zIndex: 1 },
        { width: 1_000, height: 700 },
      ),
    ).toEqual({ offset: { x: -348, y: 0 }, zoom: 1 });
  });
});
