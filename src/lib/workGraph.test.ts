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

  it("accepts group boundary edges and defaults execution to parallel", () => {
    const graph: WorkGraph = {
      version: 2,
      execution_mode: "parallel",
      groups: [
        {
          id: "research",
          title: "Research",
          direction: "LR",
          execution_mode: "parallel",
          generation: { mode: "fixed", count: 2, max_nodes: 12 },
        },
      ],
      nodes: [
        { id: "start", kind: "agent", title: "Start", instruction: "Start." },
        {
          id: "research-a",
          kind: "agent",
          title: "Research A",
          instruction: "Research A.",
          group_id: "research",
        },
        {
          id: "research-b",
          kind: "agent",
          title: "Research B",
          instruction: "Research B.",
          group_id: "research",
        },
        { id: "merge", kind: "merge", title: "Merge", instruction: "Merge." },
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [
        { id: "start-research", from: "start", to: "research" },
        { id: "research-merge", from: "research", to: "merge" },
        { id: "merge-goal", from: "merge", to: "goal" },
      ],
    };

    expect(validateWorkGraph(graph)).toEqual({ valid: true, errors: [] });
    const mermaid = serializeWorkGraphToMermaid(graph);
    expect(mermaid).toContain('subgraph g0["Research"]');
    expect(mermaid.match(/n4 --> n[23]/g)).toHaveLength(2);
    expect(mermaid.match(/n[23] --> n1/g)).toHaveLength(2);
  });

  it("requires prompt-generated group edges to use the stable group boundary", () => {
    const graph: WorkGraph = {
      version: 2,
      execution_mode: "parallel",
      groups: [
        {
          id: "research",
          title: "Research",
          direction: "LR",
          execution_mode: "parallel",
          generation: {
            mode: "prompt",
            count: null,
            prompt: "Choose useful research tasks.",
            max_nodes: 12,
          },
        },
      ],
      nodes: [
        {
          id: "research-template",
          kind: "agent",
          title: "Research task",
          instruction: "Generate this task from the group prompt.",
          group_id: "research",
        },
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [
        { id: "template-goal", from: "research-template", to: "goal" },
      ],
    };

    expect(validateWorkGraph(graph).errors).toContain(
      "Prompt-generated group research must connect through its group boundary.",
    );
  });

  it("allows bounded retry transitions without making the dependency graph cyclic", () => {
    const graph = validGraph();
    graph.version = 2;
    graph.edges.push({
      id: "check-build-retry",
      from: "check",
      to: "build",
      kind: "retry",
      condition: "fail",
      label: "try again",
      retry_limit: 3,
    });

    expect(validateWorkGraph(graph)).toEqual({ valid: true, errors: [] });
    expect(serializeWorkGraphToMermaid(graph)).toContain(
      "-.->|try again / fail|",
    );
  });

  it("allows one raw retry rule to expand across a group boundary", () => {
    const graph: WorkGraph = {
      version: 2,
      execution_mode: "parallel",
      groups: [
        {
          id: "workers",
          title: "Workers",
          direction: "LR",
          execution_mode: "parallel",
          generation: { mode: "fixed", count: 2, max_nodes: 12 },
        },
      ],
      nodes: [
        {
          id: "worker-a",
          kind: "agent",
          title: "Worker A",
          instruction: "Implement branch A.",
          group_id: "workers",
        },
        {
          id: "worker-b",
          kind: "agent",
          title: "Worker B",
          instruction: "Implement branch B.",
          group_id: "workers",
        },
        {
          id: "check",
          kind: "validator",
          title: "Check",
          instruction: "Return PASS or FAIL.",
        },
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [
        { id: "workers-check", from: "workers", to: "check" },
        { id: "check-goal", from: "check", to: "goal", condition: "pass" },
        {
          id: "check-workers-retry",
          from: "check",
          to: "workers",
          kind: "retry",
          condition: "fail",
          retry_limit: 2,
        },
      ],
    };

    expect(validateWorkGraph(graph)).toEqual({ valid: true, errors: [] });
  });

  it("rejects success conditions on validator and Human retry rules", () => {
    const validatorGraph = validGraph();
    validatorGraph.version = 2;
    validatorGraph.edges[1].condition = "pass";
    validatorGraph.edges.push({
      id: "check-build-retry",
      from: "check",
      to: "build",
      kind: "retry",
      condition: "pass",
      retry_limit: 2,
    });
    expect(validateWorkGraph(validatorGraph).errors).toContain(
      "Retry edge check-build-retry from check must use the fail condition.",
    );

    const humanGraph: WorkGraph = {
      version: 2,
      nodes: [
        { id: "build", kind: "agent", title: "Build", instruction: "Build." },
        {
          id: "approve",
          kind: "human",
          title: "Approve",
          instruction: "Approve or reject.",
        },
        { id: "goal", kind: "goal_sink", title: "GOAL", instruction: "" },
      ],
      edges: [
        { id: "build-approve", from: "build", to: "approve" },
        {
          id: "approve-goal",
          from: "approve",
          to: "goal",
          condition: "approved",
        },
        {
          id: "approve-build-retry",
          from: "approve",
          to: "build",
          kind: "retry",
          condition: "approved",
          retry_limit: 2,
        },
      ],
    };
    expect(validateWorkGraph(humanGraph).errors).toContain(
      "Retry edge approve-build-retry from approve must use the rejected condition.",
    );
  });

  it("rejects conditions on incompatible sources and retries outside an upstream path", () => {
    const invalidCondition = validGraph();
    invalidCondition.edges[0].condition = "pass";
    expect(validateWorkGraph(invalidCondition).errors.join("\n")).toMatch(
      /condition is incompatible/,
    );

    const invalidRetry = validGraph();
    invalidRetry.version = 2;
    invalidRetry.edges.push({
      id: "build-retry-check",
      from: "build",
      to: "check",
      kind: "retry",
      condition: "fail",
    });
    const errors = validateWorkGraph(invalidRetry).errors.join("\n");
    expect(errors).toMatch(/must start at a validator or human/);
    expect(errors).toMatch(/must target an agent or merge/);
  });

  it("requires a dependency path to GOAL instead of counting a retry transition", () => {
    const graph = validGraph();
    graph.version = 2;
    graph.edges = [
      { id: "build-check", from: "build", to: "check" },
      { id: "build-goal", from: "build", to: "goal" },
      {
        id: "check-build-retry",
        from: "check",
        to: "build",
        kind: "retry",
        condition: "fail",
        retry_limit: 2,
      },
    ];

    expect(validateWorkGraph(graph).errors).toContain(
      "Node check has no path to GOAL.",
    );
  });

  it("keeps version 1 graphs on the original execution contract", () => {
    const graph = validGraph();
    graph.execution_mode = "sequential";

    expect(validateWorkGraph(graph).errors).toContain(
      "Work graph version 1 cannot contain version 2 execution fields.",
    );
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
