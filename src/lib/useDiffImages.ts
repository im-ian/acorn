import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type {
  DiffFile,
  DiffImageContext,
  DiffImages,
  DiffImageSource,
} from "./types";

interface ImageCacheEntry {
  loading: boolean;
  images: DiffImages | null;
  error: string | null;
}

export interface ResolvedDiffImage {
  file: DiffFile;
  loading: boolean;
  error: string | null;
}

function sourceKey(source: DiffImageSource): string {
  switch (source.kind) {
    case "commit":
    case "pull_request_commit":
      return `${source.kind}:${source.sha}`;
    case "pull_request":
      return `${source.kind}:${source.number}`;
    case "staged":
      return source.kind;
  }
}

function contextKey(context: DiffImageContext | undefined): string {
  if (!context) return "none";
  return `${context.repoPath}\0${sourceKey(context.source)}\0${context.cacheKey ?? ""}`;
}

function fileKey(file: DiffFile): string {
  return `${file.old_path ?? ""}\0${file.new_path ?? ""}`;
}

function hasEmbeddedImages(file: DiffFile): boolean {
  return "old_image" in file || "new_image" in file;
}

export function useDiffImages(context: DiffImageContext | undefined) {
  const scope = contextKey(context);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const generationRef = useRef(0);
  const requestsRef = useRef(new Map<string, Promise<DiffImages>>());
  const contextRef = useRef(context);
  contextRef.current = context;

  const [cache, setCache] = useState<{
    scope: string;
    entries: Record<string, ImageCacheEntry>;
  }>({ scope, entries: {} });
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const entries = cache.scope === scope ? cache.entries : {};

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      requestsRef.current.clear();
    };
  }, []);

  const load = useCallback(
    (file: DiffFile) => {
      const activeContext = contextRef.current;
      if (
        !file.is_image ||
        !activeContext ||
        contextKey(activeContext) !== scope ||
        hasEmbeddedImages(file)
      ) {
        return;
      }

      const key = fileKey(file);
      const requestKey = `${scope}\0${key}`;
      if (requestsRef.current.has(requestKey)) return;
      if (
        cacheRef.current.scope === scope &&
        cacheRef.current.entries[key]?.images
      ) {
        return;
      }

      const generation = generationRef.current;
      setCache((current) => {
        const currentEntries = current.scope === scope ? current.entries : {};
        if (currentEntries[key]?.images) return current;
        const next = {
          scope,
          entries: {
            ...currentEntries,
            [key]: { loading: true, images: null, error: null },
          },
        };
        cacheRef.current = next;
        return next;
      });

      const request = api.loadDiffImages(
        activeContext.repoPath,
        activeContext.source,
        file.old_path,
        file.new_path,
      );
      requestsRef.current.set(requestKey, request);
      void request
        .then((images) => {
          if (
            generationRef.current !== generation ||
            scopeRef.current !== scope
          ) {
            return;
          }
          setCache((current) => {
            const currentEntries = current.scope === scope ? current.entries : {};
            const next = {
              scope,
              entries: {
                ...currentEntries,
                [key]: { loading: false, images, error: null },
              },
            };
            cacheRef.current = next;
            return next;
          });
        })
        .catch((error) => {
          if (
            generationRef.current !== generation ||
            scopeRef.current !== scope
          ) {
            return;
          }
          setCache((current) => {
            const currentEntries = current.scope === scope ? current.entries : {};
            const next = {
              scope,
              entries: {
                ...currentEntries,
                [key]: {
                  loading: false,
                  images: null,
                  error: String(error),
                },
              },
            };
            cacheRef.current = next;
            return next;
          });
        })
        .finally(() => {
          if (requestsRef.current.get(requestKey) === request) {
            requestsRef.current.delete(requestKey);
          }
        });
    },
    [scope],
  );

  const resolve = useCallback(
    (file: DiffFile): ResolvedDiffImage => {
      if (hasEmbeddedImages(file)) {
        return { file, loading: false, error: null };
      }
      const entry = entries[fileKey(file)];
      if (!entry?.images) {
        return {
          file,
          loading: entry?.loading ?? scope !== "none",
          error: entry?.error ?? null,
        };
      }
      return {
        file: {
          ...file,
          old_image: entry.images.old_image ?? null,
          new_image: entry.images.new_image ?? null,
        },
        loading: false,
        error: null,
      };
    },
    [entries, scope],
  );

  return { load, resolve };
}
