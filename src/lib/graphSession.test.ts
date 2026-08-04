import { describe, expect, it } from "vitest";
import {
  addGraphNode,
  addGraphGroup,
  alignGraphNodePositions,
  cloneSessionGraph,
  connectGraphNodes,
  createGraphSessionDraft,
  GRAPH_CANVAS_GRID_SIZE,
  removeGraphGroup,
  setGraphCanvasDirection,
  setGraphNodePositionLocks,
  updateGraphGroup,
  validateProspectiveGraphEdge,
} from "./graphSession";
import { validateWorkGraph } from "./workGraph";

describe("graphSession", () => {
  it("starts with a fixed GOAL-only invalid draft", () => {
    const draft = createGraphSessionDraft("codex");

    expect(draft.agent.provider).toBe("codex");
    expect(draft.definition.nodes).toEqual([
      { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
    ]);
    expect(draft.canvas.direction).toBe("LR");
    expect(draft.canvas.node_positions.goal).toEqual({ x: 560, y: 80 });
    expect(draft.canvas.locked_node_ids).toEqual([]);
    expect(draft.definition.execution_mode).toBe("sequential");
    expect(validateWorkGraph(draft.definition).valid).toBe(false);
  });

  it("keeps a new node invalid until the user writes an instruction and connects GOAL", () => {
    const draft = createGraphSessionDraft();
    const added = addGraphNode(draft.definition, draft.canvas, "agent");

    expect(
      added.graph.nodes.find((node) => node.id === added.nodeId)?.instruction,
    ).toBe("");
    expect(validateWorkGraph(added.graph).valid).toBe(false);

    const defined = {
      ...added.graph,
      nodes: added.graph.nodes.map((node) =>
        node.id === added.nodeId
          ? { ...node, instruction: "Implement the requested work." }
          : node,
      ),
    };
    const connected = connectGraphNodes(defined, added.nodeId, "goal");

    expect(connected).not.toBeNull();
    expect(validateWorkGraph(connected!).valid).toBe(true);
  });

  it("rejects self, duplicate, GOAL-outgoing, and cyclic connections", () => {
    let draft = createGraphSessionDraft();
    const first = addGraphNode(draft.definition, draft.canvas, "agent");
    const second = addGraphNode(first.graph, first.canvas, "validator");
    const graph = {
      ...second.graph,
      edges: [
        { id: "agent-validator", from: first.nodeId, to: second.nodeId },
      ],
    };

    expect(validateProspectiveGraphEdge(graph, first.nodeId, first.nodeId)).toBe(
      "selfConnection",
    );
    expect(validateProspectiveGraphEdge(graph, "goal", first.nodeId)).toBe(
      "goalOutgoing",
    );
    expect(validateProspectiveGraphEdge(graph, first.nodeId, second.nodeId)).toBe(
      "duplicate",
    );
    expect(validateProspectiveGraphEdge(graph, second.nodeId, first.nodeId)).toBe(
      "cycle",
    );
  });

  it("deep-clones graph definition, positions, locks, and viewport", () => {
    const original = createGraphSessionDraft();
    original.canvas.locked_node_ids = ["goal"];
    const copy = cloneSessionGraph(original);

    copy.canvas.node_positions.goal.x = 999;
    copy.canvas.locked_node_ids!.push("agent-1");
    copy.canvas.viewport!.zoom = 2;

    expect(original.canvas.node_positions.goal.x).toBe(560);
    expect(original.canvas.locked_node_ids).toEqual(["goal"]);
    expect(original.canvas.viewport?.zoom).toBe(1);
  });

  it("locks and unlocks only the selected node positions", () => {
    const draft = createGraphSessionDraft();
    const first = setGraphNodePositionLocks(
      draft.canvas,
      ["goal", "agent-1", "goal"],
      true,
    );
    const second = setGraphNodePositionLocks(first, ["goal"], false);

    expect(first.locked_node_ids).toEqual(["agent-1", "goal"]);
    expect(second.locked_node_ids).toEqual(["agent-1"]);
    expect(draft.canvas.locked_node_ids).toEqual([]);
  });

  it("creates a parallel dynamic group and connects through its boundary", () => {
    const draft = createGraphSessionDraft();
    const grouped = addGraphGroup(draft.definition, draft.canvas, {
      title: "Research",
      count: 3,
      prompt: "Research one independent branch.",
    });
    const connected = connectGraphNodes(grouped.graph, grouped.groupId, "goal");

    expect(grouped.graph.execution_mode).toBe("sequential");
    expect(grouped.graph.groups?.[0]).toMatchObject({
      id: grouped.groupId,
      title: "Research",
      execution_mode: "parallel",
      generation: { mode: "fixed", count: 3 },
    });
    expect(grouped.nodeIds).toHaveLength(3);
    expect(
      grouped.graph.nodes.filter((node) => node.group_id === grouped.groupId),
    ).toHaveLength(3);
    expect(connected).not.toBeNull();
    expect(validateWorkGraph(connected!).valid).toBe(true);
  });

  it("uses a prompt-generated group's prompt as its executable slot instructions", () => {
    const draft = createGraphSessionDraft();
    const grouped = addGraphGroup(draft.definition, draft.canvas, {
      title: "Research",
      count: 3,
    });
    const generated = updateGraphGroup(grouped.graph, grouped.groupId, {
      generation: {
        mode: "prompt",
        prompt: "Create three independent research tasks for the objective.",
      },
    });
    const connected = connectGraphNodes(generated, grouped.groupId, "goal");

    expect(
      generated.nodes
        .filter((node) => node.group_id === grouped.groupId)
        .map((node) => node.instruction),
    ).toEqual([
      "Create three independent research tasks for the objective.",
      "Create three independent research tasks for the objective.",
      "Create three independent research tasks for the objective.",
    ]);
    expect(validateWorkGraph(connected!).valid).toBe(true);
  });

  it("creates an automatic prompt group with one design slot and a runtime node limit", () => {
    const draft = createGraphSessionDraft();
    const grouped = addGraphGroup(draft.definition, draft.canvas, {
      title: "Research",
      generationMode: "prompt",
      prompt: "Choose the useful independent research tasks.",
    });
    const connected = connectGraphNodes(grouped.graph, grouped.groupId, "goal");

    expect(grouped.nodeIds).toHaveLength(1);
    expect(grouped.graph.groups?.[0].generation).toMatchObject({
      mode: "prompt",
      count: null,
      max_nodes: 12,
    });
    expect(validateWorkGraph(connected!).valid).toBe(true);
    expect(
      validateProspectiveGraphEdge(
        grouped.graph,
        grouped.nodeIds[0],
        "goal",
      ),
    ).toBe("dynamicGroupBoundary");
  });

  it("aligns selected nodes to the anchor on either axis", () => {
    const draft = createGraphSessionDraft();
    const first = addGraphNode(draft.definition, draft.canvas, "agent");
    const second = addGraphNode(first.graph, first.canvas, "validator");
    const alignedX = alignGraphNodePositions(
      second.canvas,
      [first.nodeId, second.nodeId],
      "x",
      first.nodeId,
    );
    const alignedY = alignGraphNodePositions(
      alignedX,
      [first.nodeId, second.nodeId],
      "y",
      second.nodeId,
    );

    expect(alignedX.node_positions[second.nodeId].x).toBe(
      alignedX.node_positions[first.nodeId].x,
    );
    expect(alignedY.node_positions[first.nodeId].y).toBe(
      alignedY.node_positions[second.nodeId].y,
    );

    const locked = setGraphNodePositionLocks(
      second.canvas,
      [second.nodeId],
      true,
    );
    const lockedPosition = locked.node_positions[second.nodeId];
    const alignedWithLock = alignGraphNodePositions(
      locked,
      [first.nodeId, second.nodeId],
      "x",
      first.nodeId,
    );
    expect(alignedWithLock.node_positions[second.nodeId]).toEqual(lockedPosition);
  });

  it("keeps generated positions on the visible grid and transposes top-level nodes", () => {
    const draft = createGraphSessionDraft();
    const added = addGraphNode(draft.definition, draft.canvas, "agent");
    const grouped = addGraphGroup(added.graph, added.canvas, { count: 2 });
    const vertical = setGraphCanvasDirection(
      grouped.canvas,
      grouped.graph,
      "TD",
    );

    for (const position of [
      ...Object.values(vertical.node_positions),
      ...Object.values(vertical.group_positions ?? {}),
    ]) {
      expect(position.x % GRAPH_CANVAS_GRID_SIZE).toBe(0);
      expect(position.y % GRAPH_CANVAS_GRID_SIZE).toBe(0);
    }
    expect(vertical.node_positions.goal).toEqual({ x: 80, y: 560 });
    expect(vertical.node_positions[added.nodeId]).toEqual({ x: 80, y: 80 });
    expect(vertical.node_positions[grouped.nodeIds[1]]).toEqual({ x: 304, y: 80 });

    const horizontal = setGraphCanvasDirection(vertical, grouped.graph, "LR");
    expect(horizontal.node_positions.goal).toEqual(
      grouped.canvas.node_positions.goal,
    );
    expect(horizontal.node_positions[grouped.nodeIds[1]]).toEqual(
      grouped.canvas.node_positions[grouped.nodeIds[1]],
    );
  });

  it("keeps locked nodes fixed during layout changes and clears removed locks", () => {
    const draft = createGraphSessionDraft();
    const added = addGraphNode(draft.definition, draft.canvas, "agent");
    const grouped = addGraphGroup(added.graph, added.canvas, { count: 2 });
    const locked = setGraphNodePositionLocks(
      grouped.canvas,
      [added.nodeId, ...grouped.nodeIds],
      true,
    );
    const vertical = setGraphCanvasDirection(locked, grouped.graph, "TD");

    expect(vertical.node_positions[added.nodeId]).toEqual(
      grouped.canvas.node_positions[added.nodeId],
    );

    const removed = removeGraphGroup(grouped.graph, vertical, grouped.groupId);
    expect(removed.canvas.locked_node_ids).toEqual([added.nodeId]);
  });

  it("creates only bounded retry connections from a gate to its upstream producer", () => {
    const draft = createGraphSessionDraft();
    const producer = addGraphNode(draft.definition, draft.canvas, "agent");
    const validator = addGraphNode(producer.graph, producer.canvas, "validator");
    const graph = {
      ...validator.graph,
      nodes: validator.graph.nodes.map((node) =>
        node.kind === "goal_sink"
          ? node
          : { ...node, instruction: `Run ${node.id}.` },
      ),
      edges: [
        { id: "producer-validator", from: producer.nodeId, to: validator.nodeId },
        { id: "validator-goal", from: validator.nodeId, to: "goal" },
      ],
    };

    const retried = connectGraphNodes(graph, validator.nodeId, producer.nodeId, {
      kind: "retry",
      condition: "fail",
      retry_limit: 2,
    });

    expect(retried?.edges[retried.edges.length - 1]).toMatchObject({
      from: validator.nodeId,
      to: producer.nodeId,
      kind: "retry",
      condition: "fail",
      retry_limit: 2,
    });
    expect(validateWorkGraph(retried!).valid).toBe(true);
    expect(
      connectGraphNodes(retried!, validator.nodeId, producer.nodeId, {
        kind: "retry",
        condition: "fail",
      }),
    ).toBeNull();
    expect(
      connectGraphNodes(graph, producer.nodeId, validator.nodeId, {
        kind: "retry",
        condition: "fail",
      }),
    ).toBeNull();
  });
});
