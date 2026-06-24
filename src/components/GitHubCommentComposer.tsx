import { useState } from "react";
import { Eye, PencilLine, SendHorizontal } from "lucide-react";
import { cn } from "../lib/cn";
import { Button, Markdown, SegmentedControl } from "./ui";

interface GitHubCommentComposerProps {
  body: string;
  onBodyChange: (body: string) => void;
  ariaLabel: string;
  placeholder: string;
  writeLabel: string;
  previewLabel: string;
  previewEmptyLabel: string;
  submitLabel: string;
  submittingLabel: string;
  errorPrefix: string;
  onSubmit: (body: string) => Promise<void>;
  className?: string;
}

type ComposerMode = "write" | "preview";

export function GitHubCommentComposer({
  body,
  onBodyChange,
  ariaLabel,
  placeholder,
  writeLabel,
  previewLabel,
  previewEmptyLabel,
  submitLabel,
  submittingLabel,
  errorPrefix,
  onSubmit,
  className,
}: GitHubCommentComposerProps) {
  const [mode, setMode] = useState<ComposerMode>("write");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = body.trim().length > 0 && !submitting;

  async function handleSubmit() {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onBodyChange("");
      setMode("write");
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border/50 bg-bg-sidebar/60 p-3",
        className,
      )}
    >
      <div className="mb-1.5 inline-flex rounded-md border border-border bg-bg p-0.5">
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
            onBodyChange(event.target.value);
            if (error) setError(null);
          }}
          placeholder={placeholder}
          rows={3}
          disabled={submitting}
          className="w-full resize-none rounded-md border border-input-border bg-input p-2 font-mono text-[11px] leading-relaxed text-fg outline-none transition placeholder:text-fg-muted/70 focus:border-accent/60 focus:bg-input-hover disabled:opacity-60"
        />
      ) : (
        <div
          aria-label={`${ariaLabel} ${previewLabel}`}
          className="min-h-[78px] max-h-48 overflow-y-auto rounded-md border border-border bg-bg p-2"
        >
          {body.trim().length > 0 ? (
            <Markdown content={body} softBreaks />
          ) : (
            <div className="flex min-h-[58px] items-center text-[11px] text-fg-muted">
              {previewEmptyLabel}
            </div>
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0 text-[10.5px] text-danger">
          {error ? `${errorPrefix} ${error}` : null}
        </div>
        <Button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          variant="accentSoft"
          size="xs"
        >
          <SendHorizontal size={12} />
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </div>
  );
}
