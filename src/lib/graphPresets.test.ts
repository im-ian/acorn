import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphSessionDraft } from "./graphSession";
import {
  APPROVAL_GATE_GRAPH_PRESET_ID,
  BUILTIN_GRAPH_NODE_PROMPT_PRESETS,
  BUILTIN_GRAPH_PRESETS,
  DEFAULT_GRAPH_PRESET_ID,
  GRAPH_PRESET_STORAGE_KEY,
  IMPLEMENT_VERIFY_GRAPH_PRESET_ID,
  LEGACY_GRAPH_PRESET_STORAGE_KEY,
  applyGraphNodePromptPreset,
  applyGraphPreset,
  createCustomGraphPreset,
  deleteCustomGraphPreset,
  duplicateGraphPreset,
  findGraphPreset,
  listGraphNodePromptPresets,
  loadGraphPresetPreferences,
  markGraphPresetApplied,
  resolveInitialGraphPresetId,
  saveCustomGraphPreset,
  saveGraphPresetPreferences,
  updateCustomGraphPreset,
  type GraphPresetPreferences,
} from "./graphPresets";
import { validateWorkGraph } from "./workGraph";

function freshPreferences(): GraphPresetPreferences {
  return {
    schemaVersion: 2,
    customPresets: [],
    lastPresetId: null,
  };
}

function sessionFromBuiltin(presetId = IMPLEMENT_VERIFY_GRAPH_PRESET_ID) {
  const preset = BUILTIN_GRAPH_PRESETS.find(
    (candidate) => candidate.id === presetId,
  );
  if (!preset) throw new Error(`Missing test preset: ${presetId}`);
  return applyGraphPreset(createGraphSessionDraft("claude"), preset);
}

describe("graph preset catalogs", () => {
  beforeEach(() => window.localStorage.clear());

  it("ships three deeply immutable and executable graph presets", () => {
    expect(BUILTIN_GRAPH_PRESETS).toHaveLength(3);
    expect(Object.isFrozen(BUILTIN_GRAPH_PRESETS)).toBe(true);
    expect(new Set(BUILTIN_GRAPH_PRESETS.map((preset) => preset.id)).size).toBe(
      BUILTIN_GRAPH_PRESETS.length,
    );

    for (const preset of BUILTIN_GRAPH_PRESETS) {
      expect(preset).toMatchObject({ builtIn: true, groupId: "built_in" });
      expect(preset.snapshot.definition.execution_mode).toBe("parallel");
      expect(Object.isFrozen(preset.snapshot.definition.nodes)).toBe(true);
      expect(Object.isFrozen(preset.snapshot.canvas.node_positions)).toBe(true);
      expect(validateWorkGraph(preset.snapshot.definition)).toEqual({
        valid: true,
        errors: [],
      });
      expect(
        Object.keys(preset.snapshot.canvas.node_positions).sort(),
      ).toEqual(preset.snapshot.definition.nodes.map((node) => node.id).sort());
      for (const validator of preset.snapshot.definition.nodes.filter(
        (node) => node.kind === "validator",
      )) {
        const outgoing = preset.snapshot.definition.edges.filter(
          (edge) => edge.from === validator.id,
        );
        expect(outgoing).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ condition: "pass" }),
            expect.objectContaining({ kind: "retry", condition: "fail" }),
          ]),
        );
      }
    }
    expect(
      BUILTIN_GRAPH_PRESETS.some((preset) =>
        preset.snapshot.definition.groups?.some(
          (group) =>
            group.execution_mode === "parallel" &&
            group.generation.mode === "fixed" &&
            group.generation.count === 3,
        ),
      ),
    ).toBe(true);
  });

  it("ships compatible node prompts and preserves stable node and edge ids", () => {
    expect(BUILTIN_GRAPH_NODE_PROMPT_PRESETS).toHaveLength(5);
    expect(
      new Set(BUILTIN_GRAPH_NODE_PROMPT_PRESETS.map((preset) => preset.id)).size,
    ).toBe(BUILTIN_GRAPH_NODE_PROMPT_PRESETS.length);
    expect(listGraphNodePromptPresets("validator")).toHaveLength(1);

    const source = BUILTIN_GRAPH_PRESETS[0].snapshot.definition;
    const preset = listGraphNodePromptPresets("agent")[0];
    const next = applyGraphNodePromptPreset(source, "implement", preset);

    expect(next).not.toBe(source);
    expect(next.nodes.find((node) => node.id === "implement")).toMatchObject({
      id: "implement",
      kind: "agent",
      title: preset.title,
      instruction: preset.instruction,
    });
    expect(next.edges.map((edge) => edge.id)).toEqual(
      source.edges.map((edge) => edge.id),
    );
    expect(applyGraphNodePromptPreset(source, "goal", preset)).toBe(source);
  });
});

describe("graph preset operations", () => {
  beforeEach(() => window.localStorage.clear());

  it("applies only a deeply cloned graph and canvas", () => {
    const current = createGraphSessionDraft("codex");
    current.objective = "Keep this objective";
    current.agent = { provider: "codex", model: "gpt-test", effort: "high" };
    current.revision = 17;
    const preset = BUILTIN_GRAPH_PRESETS[0];

    const applied = applyGraphPreset(current, preset);

    expect(applied).toMatchObject({
      objective: "Keep this objective",
      agent: { provider: "codex", model: "gpt-test", effort: "high" },
      revision: 17,
    });
    expect(applied.agent).not.toBe(current.agent);
    expect(applied.definition).not.toBe(preset.snapshot.definition);
    expect(applied.definition.nodes[0]).not.toBe(
      preset.snapshot.definition.nodes[0],
    );
    expect(applied.canvas).not.toBe(preset.snapshot.canvas);
    expect(applied.canvas.node_positions.implement).not.toBe(
      preset.snapshot.canvas.node_positions.implement,
    );

    applied.definition.nodes[0].title = "Changed after apply";
    applied.canvas.node_positions.implement.x = 999;
    expect(preset.snapshot.definition.nodes[0].title).toBe("Implement");
    expect(preset.snapshot.canvas.node_positions.implement.x).toBe(80);
  });

  it("saves, duplicates, updates, selects, and deletes independent custom presets", () => {
    const source = sessionFromBuiltin();
    let preferences = saveCustomGraphPreset(
      freshPreferences(),
      source,
      "custom:graph:first",
      " First graph ",
    );
    preferences = duplicateGraphPreset(
      preferences,
      "custom:graph:first",
      "custom:graph:copy",
      "Copy",
    );

    expect(preferences.customPresets.map((preset) => preset.name)).toEqual([
      "First graph",
      "Copy",
    ]);
    expect(preferences.customPresets[1].snapshot).not.toBe(
      preferences.customPresets[0].snapshot,
    );
    expect(preferences.customPresets[1].snapshot.definition.nodes[0]).not.toBe(
      preferences.customPresets[0].snapshot.definition.nodes[0],
    );

    const approval = sessionFromBuiltin(APPROVAL_GATE_GRAPH_PRESET_ID);
    preferences = updateCustomGraphPreset(
      preferences,
      "custom:graph:first",
      approval,
      "Approval copy",
    );
    expect(
      preferences.customPresets[0].snapshot.definition.nodes.some(
        (node) => node.kind === "human",
      ),
    ).toBe(true);
    expect(
      preferences.customPresets[1].snapshot.definition.nodes.some(
        (node) => node.kind === "human",
      ),
    ).toBe(false);

    preferences = markGraphPresetApplied(preferences, "custom:graph:first");
    expect(resolveInitialGraphPresetId(preferences)).toBe("custom:graph:first");
    preferences = deleteCustomGraphPreset(preferences, "custom:graph:first");
    expect(preferences.customPresets).toHaveLength(1);
    expect(preferences.lastPresetId).toBe(DEFAULT_GRAPH_PRESET_ID);
    expect(deleteCustomGraphPreset(preferences, DEFAULT_GRAPH_PRESET_ID)).toBe(
      preferences,
    );
  });

  it("rejects invalid or colliding custom identities", () => {
    const source = sessionFromBuiltin();
    expect(() =>
      createCustomGraphPreset(source, IMPLEMENT_VERIFY_GRAPH_PRESET_ID, "No"),
    ).toThrow(/unique custom id/);
    expect(() =>
      createCustomGraphPreset(source, "spaces are invalid", "No"),
    ).toThrow(/unique custom id/);
    expect(() =>
      saveCustomGraphPreset(
        saveCustomGraphPreset(
          freshPreferences(),
          source,
          "custom:graph:same",
          "First",
        ),
        source,
        "custom:graph:same",
        "Second",
      ),
    ).toThrow(/already exists/);
  });
});

describe("graph preset persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("sanitizes malformed siblings, collisions, duplicates, and canvas data", () => {
    const source = sessionFromBuiltin();
    const valid = createCustomGraphPreset(
      source,
      "custom:graph:valid",
      "Valid",
    );
    const damagedCanvas = structuredClone(valid);
    damagedCanvas.builtIn = false;
    damagedCanvas.groupId = "custom";
    damagedCanvas.snapshot.canvas.node_positions = {
      implement: { x: 20, y: 30 },
      unknown: { x: 40, y: 50 },
    };
    damagedCanvas.snapshot.canvas.viewport = {
      x: 0,
      y: 0,
      zoom: Number.NaN,
    };

    window.localStorage.setItem(
      GRAPH_PRESET_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        customPresets: [
          { ...damagedCanvas, builtIn: true, groupId: "built_in" },
          damagedCanvas,
          {
            ...valid,
            id: IMPLEMENT_VERIFY_GRAPH_PRESET_ID,
            name: "Collision",
          },
          {
            id: "custom:graph:broken",
            name: "Broken",
            snapshot: {
              ...valid.snapshot,
              definition: {
                ...valid.snapshot.definition,
                nodes: valid.snapshot.definition.nodes.filter(
                  (node) => node.id !== "goal",
                ),
              },
            },
          },
        ],
        lastPresetId: "custom:graph:valid",
      }),
    );

    const loaded = loadGraphPresetPreferences();

    expect(loaded.customPresets).toHaveLength(1);
    expect(loaded.customPresets[0]).toMatchObject({
      id: "custom:graph:valid",
      builtIn: false,
      groupId: "custom",
    });
    expect(
      Object.keys(loaded.customPresets[0].snapshot.canvas.node_positions).sort(),
    ).toEqual(["goal", "implement", "verify"]);
    expect(
      loaded.customPresets[0].snapshot.canvas.node_positions.implement,
    ).toEqual({ x: 20, y: 30 });
    expect(
      loaded.customPresets[0].snapshot.canvas.node_positions.verify,
    ).toEqual({ x: 310, y: 80 });
    expect(loaded.customPresets[0].snapshot.canvas.viewport).toBeNull();
  });

  it("migrates a v1 full session without retaining objective, agent, or revision", () => {
    const legacyGraph = sessionFromBuiltin(APPROVAL_GATE_GRAPH_PRESET_ID);
    legacyGraph.objective = "Legacy objective must not become a preset field";
    legacyGraph.agent = { provider: "codex", model: "legacy-model" };
    legacyGraph.revision = 91;
    window.localStorage.setItem(
      LEGACY_GRAPH_PRESET_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        customPresets: [
          {
            id: "custom:graph:legacy",
            name: "Legacy",
            graph: legacyGraph,
          },
        ],
        lastPresetId: "custom:graph:legacy",
      }),
    );

    const loaded = loadGraphPresetPreferences();
    const migrated = findGraphPreset(loaded, "custom:graph:legacy");
    expect(migrated).not.toBeNull();
    expect(migrated).not.toHaveProperty("objective");
    expect(migrated).not.toHaveProperty("agent");
    expect(migrated).not.toHaveProperty("revision");

    const current = createGraphSessionDraft("claude");
    current.objective = "Current objective";
    current.agent = { provider: "claude", model: "current-model" };
    current.revision = 4;
    const applied = applyGraphPreset(current, migrated!);
    expect(applied).toMatchObject({
      objective: "Current objective",
      agent: { provider: "claude", model: "current-model" },
      revision: 4,
    });
    expect(applied.definition.nodes.some((node) => node.kind === "human")).toBe(
      true,
    );

    saveGraphPresetPreferences(loaded);
    const saved = JSON.parse(
      window.localStorage.getItem(GRAPH_PRESET_STORAGE_KEY) ?? "null",
    );
    expect(saved.schemaVersion).toBe(2);
    expect(saved.customPresets[0]).toHaveProperty("snapshot");
    expect(saved.customPresets[0]).not.toHaveProperty("graph");
  });

  it("returns an empty preference set for invalid JSON and prefers v2 storage", () => {
    window.localStorage.setItem(GRAPH_PRESET_STORAGE_KEY, "{not-json");
    expect(loadGraphPresetPreferences()).toEqual(freshPreferences());

    window.localStorage.clear();
    const legacy = sessionFromBuiltin();
    window.localStorage.setItem(
      LEGACY_GRAPH_PRESET_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        customPresets: [
          { id: "custom:graph:legacy", name: "Legacy", graph: legacy },
        ],
      }),
    );
    window.localStorage.setItem(
      GRAPH_PRESET_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 2, customPresets: [] }),
    );
    expect(loadGraphPresetPreferences().customPresets).toEqual([]);
  });

  it("does not block graph creation when local storage rejects a write", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });

    expect(() => saveGraphPresetPreferences(freshPreferences())).not.toThrow();
    setItem.mockRestore();
  });
});
