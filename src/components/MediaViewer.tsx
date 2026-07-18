import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type UIEventHandler,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
  api,
  FS_CHANGED_EVENT,
  type FsChangePayload,
  type FsPrepareAssetResult,
} from "../lib/api";
import { basenameFromPath, type MediaFileKind } from "../lib/mediaFiles";
import { cn } from "../lib/cn";
import type { ScrollPosition } from "../lib/scrollPosition";
import { useTranslation } from "../lib/useTranslation";
import { Tooltip } from "./Tooltip";
import { FloatingToolbar, IconButton } from "./ui";
import type { CodeWorkspaceTabViewState } from "../lib/workspaceTabs";
import {
  scrollPositionFromEventTarget,
  useDeferredScrollReporter,
  useRestoredScrollRef,
} from "./useScrollViewState";

interface MediaViewerProps {
  path: string;
  kind: MediaFileKind;
  isActive: boolean;
  viewState?: CodeWorkspaceTabViewState;
  onViewStateChange?: (patch: CodeWorkspaceTabViewState) => void;
}

interface MediaState {
  src: string | null;
  asset: FsPrepareAssetResult | null;
  error: string | null;
  loading: boolean;
}

const EMPTY_STATE: MediaState = {
  src: null,
  asset: null,
  error: null,
  loading: true,
};

const IMAGE_ZOOM_MIN = 0.25;
const IMAGE_ZOOM_MAX = 5;
const IMAGE_ZOOM_STEP = 0.25;

export function MediaViewer({
  path,
  kind,
  isActive,
  viewState,
  onViewStateChange,
}: MediaViewerProps) {
  const t = useTranslation();
  const [state, setState] = useState<MediaState>(EMPTY_STATE);
  const [imageZoom, setImageZoom] = useState(() =>
    clampImageZoom(viewState?.media?.imageZoom ?? 1),
  );
  const loadSeqRef = useRef(0);
  const title = basenameFromPath(path);
  const reportMediaScrollPosition = useDeferredScrollReporter(
    useCallback(
      (position: ScrollPosition) => onViewStateChange?.({ media: position }),
      [onViewStateChange],
    ),
  );
  const restoreMediaScrollRef = useRestoredScrollRef<HTMLDivElement>(
    viewState?.media,
  );

  const refreshAsset = useCallback(
    async ({ reset = false }: { reset?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      if (reset) setState(EMPTY_STATE);
      try {
        const asset = await api.fsPrepareAsset(path);
        if (seq !== loadSeqRef.current) return;
        const baseSrc = convertFileSrc(path);
        const separator = baseSrc.includes("?") ? "&" : "?";
        setState({
          src: `${baseSrc}${separator}v=${seq}`,
          asset,
          error: null,
          loading: false,
        });
      } catch (err: unknown) {
        if (seq !== loadSeqRef.current) return;
        setState({
          src: null,
          asset: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      }
    },
    [path],
  );

  useEffect(() => {
    void refreshAsset({ reset: true });
    return () => {
      loadSeqRef.current += 1;
    };
  }, [refreshAsset]);

  useEffect(() => {
    setImageZoom(clampImageZoom(viewState?.media?.imageZoom ?? 1));
  }, [path, kind]);

  const updateImageZoom = useCallback(
    (updater: (value: number) => number) => {
      const next = clampImageZoom(updater(imageZoom));
      setImageZoom(next);
      onViewStateChange?.({ media: { imageZoom: next } });
    },
    [imageZoom, onViewStateChange],
  );

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listen<FsChangePayload>(FS_CHANGED_EVENT, (event) => {
      if (cancelled) return;
      if (mediaFileChanged(path, event.payload)) {
        void refreshAsset();
      }
    }).then((cancel) => {
      if (cancelled) {
        cancel();
        return;
      }
      unlisten = cancel;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [path, refreshAsset]);

  if (state.loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-fg-muted">
        {t("codeViewer.loading")}
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-fg-muted">
        {state.error}
      </div>
    );
  }

  if (!state.src) return null;

  return (
    <div
      className={cn(
        "relative flex h-full w-full items-center justify-center overflow-hidden bg-bg",
        isActive ? "" : "pointer-events-none",
      )}
      data-acorn-media-viewer={kind}
      data-acorn-media-size={state.asset?.size ?? undefined}
      data-acorn-media-zoom={kind === "image" ? imageZoom : undefined}
    >
      {kind === "image" ? (
        <>
          <ImageZoomControls
            zoom={imageZoom}
            onZoomIn={() => updateImageZoom((value) => nextImageZoom(value, 1))}
            onZoomOut={() =>
              updateImageZoom((value) => nextImageZoom(value, -1))
            }
            onReset={() => updateImageZoom(() => 1)}
          />
          {renderMedia(
            kind,
            state.src,
            title,
            imageZoom,
            restoreMediaScrollRef,
            (event) =>
              reportMediaScrollPosition(
                scrollPositionFromEventTarget(event.currentTarget),
              ),
          )}
        </>
      ) : (
        renderMedia(kind, state.src, title)
      )}
    </div>
  );
}

function renderMedia(
  kind: MediaFileKind,
  src: string,
  title: string,
  imageZoom = 1,
  imageScrollRef?: (node: HTMLDivElement | null) => void,
  onImageScroll?: UIEventHandler<HTMLDivElement>,
) {
  if (kind === "image") {
    return (
      <div
        ref={imageScrollRef}
        onScroll={onImageScroll}
        data-acorn-media-scroll="image"
        className="h-full w-full overflow-auto"
      >
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          <img
            src={src}
            alt={title}
            className="max-h-full max-w-full object-contain will-change-transform"
            style={{
              transform: `scale(${imageZoom})`,
              transformOrigin: "center center",
            }}
            draggable={false}
          />
        </div>
      </div>
    );
  }
  if (kind === "video") {
    return (
      <video
        key={src}
        src={src}
        controls
        className="max-h-full max-w-full bg-black"
      />
    );
  }
  if (kind === "audio") {
    return (
      <div className="w-full max-w-xl px-6">
        <audio key={src} src={src} controls className="w-full" />
      </div>
    );
  }
  return (
    <iframe
      key={src}
      src={src}
      title={title}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}

interface ImageZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

function ImageZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
}: ImageZoomControlsProps) {
  const t = useTranslation();
  const zoomInLabel = t("mediaViewer.zoomIn");
  const zoomOutLabel = t("mediaViewer.zoomOut");
  const resetLabel = t("mediaViewer.resetZoom");

  return (
    <FloatingToolbar aria-label={t("mediaViewer.zoomControls")}>
      <Tooltip label={zoomOutLabel} side="bottom">
        <IconButton
          aria-label={zoomOutLabel}
          title={zoomOutLabel}
          onClick={onZoomOut}
          disabled={zoom <= IMAGE_ZOOM_MIN}
          size="md"
          surface="dialog"
          className="disabled:cursor-default disabled:opacity-40"
        >
          <ZoomOut size={14} />
        </IconButton>
      </Tooltip>
      <span className="flex h-7 w-12 shrink-0 items-center justify-center font-mono text-[11px] tabular-nums text-fg-muted">
        {formatImageZoom(zoom)}
      </span>
      <Tooltip label={zoomInLabel} side="bottom">
        <IconButton
          aria-label={zoomInLabel}
          title={zoomInLabel}
          onClick={onZoomIn}
          disabled={zoom >= IMAGE_ZOOM_MAX}
          size="md"
          surface="dialog"
          className="disabled:cursor-default disabled:opacity-40"
        >
          <ZoomIn size={14} />
        </IconButton>
      </Tooltip>
      <Tooltip label={resetLabel} side="bottom">
        <IconButton
          aria-label={resetLabel}
          title={resetLabel}
          onClick={onReset}
          disabled={zoom === 1}
          size="md"
          surface="dialog"
          className="disabled:cursor-default disabled:opacity-40"
        >
          <RotateCcw size={14} />
        </IconButton>
      </Tooltip>
    </FloatingToolbar>
  );
}

function nextImageZoom(value: number, direction: 1 | -1): number {
  const next = value + direction * IMAGE_ZOOM_STEP;
  return clampImageZoom(roundZoom(next));
}

function clampImageZoom(value: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, value));
}

function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatImageZoom(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function mediaFileChanged(filePath: string, payload: FsChangePayload): boolean {
  if (
    payload.paths.some((changedPath) => pathsOverlap(changedPath, filePath))
  ) {
    return true;
  }
  if (!payload.overflow) return false;
  if (!payload.refresh) return true;
  return isSameOrInside(payload.refresh.path, filePath);
}

function normalizeFsPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function isSameOrInside(parent: string, child: string): boolean {
  const normalizedParent = normalizeFsPath(parent);
  const normalizedChild = normalizeFsPath(child);
  if (normalizedParent === "/") return normalizedChild.startsWith("/");
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
}

function pathsOverlap(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}
