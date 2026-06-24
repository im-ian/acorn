import { useState } from "react";
import { Eye, PencilLine, Save, X } from "lucide-react";
import { Button, Markdown, SegmentedControl } from "./ui";

interface GitHubCommentEditFormProps {
  initialBody: string;
  ariaLabel: string;
  writeLabel: string;
  previewLabel: string;
  previewEmptyLabel: string;
  saveLabel: string;
  savingLabel: string;
  cancelLabel: string;
  errorPrefix: string;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}

type EditMode = "write" | "preview";

export function GitHubCommentEditForm({
  initialBody,
  ariaLabel,
  writeLabel,
  previewLabel,
  previewEmptyLabel,
  saveLabel,
  savingLabel,
  cancelLabel,
  errorPrefix,
  onSave,
  onCancel,
}: GitHubCommentEditFormProps) {
  const [body, setBody] = useState(initialBody);
  const [mode, setMode] = useState<EditMode>("write");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = body.trim();
  const canSave = trimmed.length > 0 && trimmed !== initialBody.trim() && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="inline-flex rounded-md border border-border bg-bg p-0.5">
        <SegmentedControl
          size="xs"
          surface="subtle"
          activeId={mode}
          onChange={setMode}
          items={[
            { id: "write", label: writeLabel, icon: <PencilLine size={11} /> },
            { id: "preview", label: previewLabel, icon: <Eye size={11} /> },
          ]}
        />
      </div>
      {mode === "write" ? (
        <textarea
          aria-label={ariaLabel}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            if (error) setError(null);
          }}
          rows={4}
          disabled={saving}
          className="w-full resize-none rounded-md border border-input-border bg-input p-2 font-mono text-[11px] leading-relaxed text-fg outline-none transition placeholder:text-fg-muted/70 focus:border-accent/60 focus:bg-input-hover disabled:opacity-60"
        />
      ) : (
        <div
          aria-label={`${ariaLabel} ${previewLabel}`}
          className="min-h-[96px] max-h-56 overflow-y-auto rounded-md border border-border bg-bg p-2"
        >
          {body.trim().length > 0 ? (
            <Markdown content={body} softBreaks />
          ) : (
            <div className="flex min-h-[76px] items-center text-[11px] text-fg-muted">
              {previewEmptyLabel}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-[10.5px] text-danger">
          {error ? `${errorPrefix} ${error}` : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            onClick={onCancel}
            disabled={saving}
            size="xs"
            variant="ghost"
          >
            <X size={12} />
            {cancelLabel}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!canSave}
            size="xs"
            variant="accentSoft"
          >
            <Save size={12} />
            {saving ? savingLabel : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
