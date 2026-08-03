import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_GRAPH_PROMPT_PLAN,
  createEmptyWorkGraph,
  isGraphPromptPlanContinuation,
  markGraphPromptPlanContinuation,
  serializeWorkGraphToMermaid,
  validateGraphPromptPlan,
  validateWorkGraph,
  type WorkGraph,
} from "./workGraph";

function validGraph(): WorkGraph {
  return {
    version: 1,
    nodes: [
      { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      {
        id: "build",
        kind: "agent",
        title: "Build feature",
        instruction: "Implement the requested feature.",
      },
      {
        id: "check",
        kind: "validator",
        title: "Verify",
        instruction: "Return PASS or FAIL with a concrete critique.",
      },
    ],
    edges: [
      { id: "build-check", from: "build", to: "check" },
      { id: "check-goal", from: "check", to: "goal" },
    ],
  };
}

describe("work graph validation", () => {
  it("accepts a DAG where every executable node reaches GOAL", () => {
    expect(validateWorkGraph(validGraph())).toEqual({ valid: true, errors: [] });
  });

  it("rejects an empty manual graph", () => {
    const result = validateWorkGraph(createEmptyWorkGraph());
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "A manual work graph needs at least one executable node.",
        "A manual work graph needs at least one execution edge.",
      ]),
    );
  });

  it("rejects cycles, unreachable nodes, and outgoing GOAL edges", () => {
    const graph = validGraph();
    graph.nodes.push({
      id: "orphan",
      kind: "human",
      title: "Approve",
      instruction: "Approve or request a revision.",
    });
    graph.edges.push(
      { id: "check-build", from: "check", to: "build" },
      { id: "goal-orphan", from: "goal", to: "orphan" },
    );
    const result = validateWorkGraph(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/DAG/);
    expect(result.errors).toContain("GOAL cannot have outgoing edges.");
  });

  it("rejects node kinds injected outside the versioned contract", () => {
    const graph = validGraph();
    graph.nodes[1].kind = "router" as never;

    const result = validateWorkGraph(graph);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported node kind for build: router");
  });
});

describe("graph prompt continuation", () => {
  it("marks a plan with a versioned continuation contract", () => {
    const continuation = markGraphPromptPlanContinuation(
      AUTOMATIC_GRAPH_PROMPT_PLAN,
    );

    expect(continuation).toEqual({
      version: 1,
      mode: "automatic",
      continuation: { version: 1 },
    });
    expect(isGraphPromptPlanContinuation(continuation)).toBe(true);
    expect(validateGraphPromptPlan(continuation)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("rejects unknown continuation versions at runtime", () => {
    const result = validateGraphPromptPlan({
      version: 1,
      mode: "automatic",
      continuation: { version: 2 },
    } as never);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("continuation version: 2");
  });
});

describe("work graph Mermaid", () => {
  it("is deterministic regardless of input array order", () => {
    const graph = validGraph();
    const reordered: WorkGraph = {
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    };
    expect(serializeWorkGraphToMermaid(reordered)).toBe(
      serializeWorkGraphToMermaid(graph),
    );
    expect(serializeWorkGraphToMermaid(graph)).toBe(
      [
        "flowchart TD",
        '  n0["build<br/>[agent] Build feature<br/>Implement the requested feature."]',
        '  n1["check<br/>[validator] Verify<br/>Return PASS or FAIL with a concrete critique."]',
        "  n2((GOAL))",
        "  n0 --> n1",
        "  n1 --> n2",
      ].join("\n"),
    );
  });
});
