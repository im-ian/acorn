import { BookmarkPlus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  APPROVAL_GATE_GRAPH_PRESET_ID,
  IMPLEMENT_VERIFY_GRAPH_PRESET_ID,
  RESEARCH_BUILD_VERIFY_GRAPH_PRESET_ID,
  applyGraphPreset,
  deleteCustomGraphPreset,
  findGraphPreset,
  listGraphPresets,
  loadGraphPresetPreferences,
  markGraphPresetApplied,
  resolveInitialGraphPresetId,
  saveCustomGraphPreset,
  saveGraphPresetPreferences,
  updateCustomGraphPreset,
  type GraphPresetPreferences,
} from "../lib/graphPresets";
import type { SessionGraph } from "../lib/types";
import type { TranslationKey } from "../lib/i18n";
import { useTranslation } from "../lib/useTranslation";
import { Button, Select, type SelectItem } from "./ui";

interface GraphPresetToolbarProps {
  graph: SessionGraph;
  disabled?: boolean;
  onApply: (graph: SessionGraph) => void;
}

const BUILTIN_PRESET_NAME_KEYS: Record<string, TranslationKey> = {
  [IMPLEMENT_VERIFY_GRAPH_PRESET_ID]:
    "graphSession.presets.builtInNames.implementVerify",
  [RESEARCH_BUILD_VERIFY_GRAPH_PRESET_ID]:
    "graphSession.presets.builtInNames.researchBuildVerify",
  [APPROVAL_GATE_GRAPH_PRESET_ID]:
    "graphSession.presets.builtInNames.approvalGate",
};

function customPresetId(
  name: string,
  preferences: GraphPresetPreferences,
): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 36) || "graph";
  const existing = new Set(listGraphPresets(preferences).map((preset) => preset.id));
  let suffix = Date.now().toString(36);
  let candidate = `custom:graph:${slug}:${suffix}`;
  let attempt = 2;
  while (existing.has(candidate)) {
    suffix = `${Date.now().toString(36)}-${attempt}`;
    candidate = `custom:graph:${slug}:${suffix}`;
    attempt += 1;
  }
  return candidate;
}

export function GraphPresetToolbar({
  graph,
  disabled = false,
  onApply,
}: GraphPresetToolbarProps) {
  const t = useTranslation();
  const [preferences, setPreferences] = useState(loadGraphPresetPreferences);
  const [selectedId, setSelectedId] = useState(() =>
    resolveInitialGraphPresetId(preferences),
  );
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const presets = useMemo(() => listGraphPresets(preferences), [preferences]);
  const selected = findGraphPreset(preferences, selectedId);
  const options = useMemo<Array<SelectItem>>(
    () => [
      ...presets
        .filter((preset) => preset.builtIn)
        .map((preset) => ({
          value: preset.id,
          label: t(BUILTIN_PRESET_NAME_KEYS[preset.id] ?? preset.name),
          description: t("graphSession.presets.builtIn"),
        })),
      { type: "separator", label: t("graphSession.presets.custom") },
      ...(preferences.customPresets.length > 0
        ? preferences.customPresets.map((preset) => ({
            value: preset.id,
            label: preset.name,
            description: t("graphSession.presets.savedByYou"),
          }))
        : [
            {
              value: "custom:empty",
              label: t("graphSession.presets.customEmpty"),
              disabled: true,
            },
          ]),
    ],
    [preferences.customPresets, presets, t],
  );

  function persist(next: GraphPresetPreferences) {
    setPreferences(next);
    saveGraphPresetPreferences(next);
  }

  function applySelected() {
    if (!selected) return;
    const nextPreferences = markGraphPresetApplied(preferences, selected.id);
    persist(nextPreferences);
    onApply(applyGraphPreset(graph, selected));
    setMessage(t("graphSession.presets.applied"));
  }

  function saveCurrent() {
    const presetName = name.trim();
    if (!presetName) return;
    try {
      const id = customPresetId(presetName, preferences);
      const next = markGraphPresetApplied(
        saveCustomGraphPreset(preferences, graph, id, presetName),
        id,
      );
      persist(next);
      setSelectedId(id);
      setName("");
      setMessage(t("graphSession.presets.saved"));
    } catch (error) {
      setMessage(String(error));
    }
  }

  function updateSelected() {
    if (!selected || selected.builtIn) return;
    try {
      const next = updateCustomGraphPreset(
        preferences,
        selected.id,
        graph,
        name.trim() || undefined,
      );
      persist(next);
      setName("");
      setMessage(t("graphSession.presets.updated"));
    } catch (error) {
      setMessage(String(error));
    }
  }

  function deleteSelected() {
    if (!selected || selected.builtIn) return;
    const next = deleteCustomGraphPreset(preferences, selected.id);
    const nextSelectedId = resolveInitialGraphPresetId(next);
    persist(next);
    setSelectedId(nextSelectedId);
    setName("");
    setMessage(t("graphSession.presets.deleted"));
  }

  return (
    <div
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-bg-sidebar/45 px-3 py-2"
      data-graph-presets
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {t("graphSession.presets.label")}
      </span>
      <Select
        aria-label={t("graphSession.presets.select")}
        className="w-52"
        disabled={disabled}
        value={selectedId}
        options={options}
        onValueChange={(value) => {
          setSelectedId(value);
          setMessage(null);
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled || !selected}
        onClick={applySelected}
      >
        <RefreshCw size={11} /> {t("graphSession.presets.apply")}
      </Button>
      <input
        aria-label={t("graphSession.presets.name")}
        className="h-7 min-w-36 flex-1 rounded-md border border-input-border bg-input px-2 text-[11px] text-fg outline-none placeholder:text-fg-muted focus:border-accent"
        disabled={disabled}
        value={name}
        maxLength={80}
        placeholder={t("graphSession.presets.namePlaceholder")}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            saveCurrent();
          }
        }}
      />
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={disabled || !name.trim()}
        onClick={saveCurrent}
      >
        <BookmarkPlus size={11} /> {t("graphSession.presets.saveAs")}
      </Button>
      {!selected?.builtIn ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={updateSelected}
          >
            {t("graphSession.presets.update")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t("graphSession.presets.delete")}
            title={t("graphSession.presets.delete")}
            onClick={deleteSelected}
          >
            <Trash2 size={11} />
          </Button>
        </>
      ) : null}
      {message ? (
        <span role="status" className="truncate text-[10px] text-fg-muted">
          {message}
        </span>
      ) : null}
    </div>
  );
}
