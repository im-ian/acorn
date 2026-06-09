import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  FS_CHANGED_EVENT,
  type FsChangePayload,
  type FsPrepareAssetResult,
} from "../lib/api";
import { basenameFromPath, type MediaFileKind } from "../lib/mediaFiles";
import { cn } from "../lib/cn";
import { useTranslation } from "../lib/useTranslation";

interface MediaViewerProps {
  path: string;
  kind: MediaFileKind;
  isActive: boolean;
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

export function MediaViewer({ path, kind, isActive }: MediaViewerProps) {
  const t = useTranslation();
  const [state, setState] = useState<MediaState>(EMPTY_STATE);
  const loadSeqRef = useRef(0);
  const title = basenameFromPath(path);

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
        "flex h-full w-full items-center justify-center overflow-hidden bg-bg",
        isActive ? "" : "pointer-events-none",
      )}
      data-acorn-media-viewer={kind}
      data-acorn-media-size={state.asset?.size ?? undefined}
    >
      {renderMedia(kind, state.src, title)}
    </div>
  );
}

function renderMedia(kind: MediaFileKind, src: string, title: string) {
  if (kind === "image") {
    return (
      <img
        src={src}
        alt={title}
        className="max-h-full max-w-full object-contain"
        draggable={false}
      />
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
      className="h-full w-full border-0 bg-white"
    />
  );
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
