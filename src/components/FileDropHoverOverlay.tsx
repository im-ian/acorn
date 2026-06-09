import { FileInput, Files, Terminal } from "lucide-react";
import { cn } from "../lib/cn";
import { useTranslation } from "../lib/useTranslation";

type FileDropHoverPurpose = "preview" | "terminal" | "tab";

interface FileDropHoverOverlayProps {
  purpose: FileDropHoverPurpose;
  path?: string;
  scope?: "pane" | "global" | "tabStrip";
}

function fileNameFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const name = path.split(/[\\/]/u).filter(Boolean).pop();
  return name || path;
}

export function FileDropHoverOverlay({
  purpose,
  path,
  scope = "pane",
}: FileDropHoverOverlayProps) {
  const t = useTranslation();
  const fileName = fileNameFromPath(path);
  const Icon =
    purpose === "terminal" ? Terminal : purpose === "tab" ? Files : FileInput;

  if (scope === "tabStrip") {
    return (
      <div
        className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg/55 px-2 backdrop-blur-[1px]"
        data-file-drop-hover={purpose}
        role="status"
        aria-live="polite"
      >
        <div className="inline-flex h-7 max-w-full items-center gap-2 rounded-md border border-accent/55 bg-bg-elevated/95 px-2.5 text-left shadow-lg shadow-black/25 ring-1 ring-accent/10">
          <span className="flex size-5 shrink-0 items-center justify-center rounded border border-accent/40 bg-accent/15 text-accent">
            <Icon size={13} strokeWidth={2} />
          </span>
          <span className="min-w-0 truncate text-xs font-medium leading-none text-fg">
            {t("fileDropHover.tabTitle")}
          </span>
          {fileName ? (
            <span className="hidden max-w-40 truncate text-[11px] leading-none text-fg-muted sm:inline">
              {fileName}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "pointer-events-none flex items-center justify-center",
        scope === "global"
          ? "fixed inset-0 z-50 bg-bg/15 backdrop-blur-[1px]"
          : "absolute inset-0 z-30 bg-bg/45 backdrop-blur-[1px]",
      )}
      data-file-drop-hover={purpose}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-60 max-w-[min(26rem,calc(100%-2rem))] items-center gap-3 rounded-md border border-accent/55 bg-bg-elevated/95 px-3.5 py-3 text-left shadow-xl shadow-black/30 ring-1 ring-accent/10 backdrop-blur">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-accent/45 bg-accent/15 text-accent">
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium leading-5 text-fg">
            {purpose === "terminal"
              ? t("fileDropHover.terminalTitle")
              : purpose === "tab"
                ? t("fileDropHover.tabTitle")
                : t("fileDropHover.previewTitle")}
          </span>
          <span className="block truncate text-xs leading-5 text-fg-muted">
            {fileName ??
              (purpose === "terminal"
                ? t("fileDropHover.terminalHint")
                : purpose === "tab"
                  ? t("fileDropHover.tabHint")
                : t("fileDropHover.previewHint"))}
          </span>
        </span>
      </div>
    </div>
  );
}
