import { describe, expect, it } from "vitest";
import {
  addGraphNode,
  cloneSessionGraph,
  connectGraphNodes,
  createGraphSessionDraft,
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
    expect(draft.canvas.node_positions.goal).toEqual({ x: 560, y: 220 });
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

  it("deep-clones graph definition, positions, and viewport", () => {
    const original = createGraphSessionDraft();
    const copy = cloneSessionGraph(original);

    copy.canvas.node_positions.goal.x = 999;
    copy.canvas.viewport!.zoom = 2;

    expect(original.canvas.node_positions.goal.x).toBe(560);
    expect(original.canvas.viewport?.zoom).toBe(1);
  });
});
