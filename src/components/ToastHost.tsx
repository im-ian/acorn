import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { useSettings } from "../lib/settings";
import { useToasts, type ToastItem } from "../lib/toasts";

const TOAST_EXIT_MS = 180;

type RenderedToast = ToastItem & { exiting: boolean };

/**
 * Renders the active toast (if any) at the top-center of the viewport.
 * The viewport overlay ignores pointer events; the toast itself accepts
 * hover and click so users can pause the TTL or dismiss/activate it.
 */
export function ToastHost(): ReactElement | null {
  const toasts = useToasts((s) => s.toasts);
  const hide = useToasts((s) => s.hide);
  const pause = useToasts((s) => s.pause);
  const resume = useToasts((s) => s.resume);
  const position = useSettings((s) => s.settings.appearance.toastPosition);
  const [rendered, setRendered] = useState<RenderedToast[]>([]);
  const [mounted, setMounted] = useState(false);
  const [stackPaused, setStackPaused] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setRendered((previous) => {
      const currentById = new Map(toasts.map((toast) => [toast.id, toast]));
      const previousIds = new Set(previous.map((toast) => toast.id));
      const next = previous.map((toast) => {
        const current = currentById.get(toast.id);
        if (current) return { ...current, exiting: false };
        return toast.exiting ? toast : { ...toast, exiting: true };
      });
      for (const toast of toasts) {
        if (!previousIds.has(toast.id)) {
          next.push({ ...toast, exiting: false });
        }
      }
      return next;
    });
  }, [toasts]);

  useEffect(() => {
    const exitingIds = rendered
      .filter((toast) => toast.exiting)
      .map((toast) => toast.id);
    if (exitingIds.length === 0) return;
    const timeout = window.setTimeout(() => {
      setRendered((previous) =>
        previous.filter((toast) => !exitingIds.includes(toast.id)),
      );
    }, TOAST_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [rendered]);

  useEffect(() => {
    if (toasts.length === 0) {
      setStackPaused(false);
      return;
    }
    if (!stackPaused) return;
    for (const toast of toasts) {
      pause(toast.id);
    }
  }, [pause, stackPaused, toasts]);

  if (rendered.length === 0 || !mounted) return null;
  const pauseAll = () => {
    setStackPaused(true);
    for (const toast of toasts) {
      pause(toast.id);
    }
  };
  const resumeAll = () => {
    setStackPaused(false);
    for (const toast of toasts) {
      resume(toast.id);
    }
  };
  const handleClick = (toast: RenderedToast) => {
    if (toast.exiting) return;
    try {
      if (toast.action) {
        void Promise.resolve(toast.action()).catch((err: unknown) => {
          console.error("[ToastHost] toast action failed", err);
        });
      }
    } catch (err) {
      console.error("[ToastHost] toast action failed", err);
    } finally {
      hide(toast.id);
    }
  };
  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[120] flex justify-center gap-2",
        position === "top"
          ? "top-6 flex-col items-center"
          : "bottom-6 flex-col-reverse items-center",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex gap-2",
          position === "top"
            ? "flex-col items-center"
            : "flex-col-reverse items-center",
        )}
        onMouseEnter={pauseAll}
        onMouseLeave={resumeAll}
        onFocus={pauseAll}
        onBlur={resumeAll}
      >
        {rendered.map((toast) => {
          const progressStyle = {
            "--toast-duration": `${toast.durationMs}ms`,
          } as CSSProperties;
          return (
            <button
              key={toast.id}
              type="button"
              role="status"
              aria-live="polite"
              onClick={() => handleClick(toast)}
              data-position={position}
              data-state={toast.exiting ? "exit" : "enter"}
              className="acorn-toast-motion relative cursor-pointer overflow-hidden rounded-full border border-border bg-bg-elevated px-4 py-2 text-xs text-fg shadow-md transition-[background-color,border-color,box-shadow] duration-200 ease-out hover:border-accent/60 hover:bg-bg-elevated/95 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent/50"
            >
              {toast.message}
              <div
                aria-hidden="true"
                className="acorn-toast-progress absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent/80"
                data-paused={
                  toast.paused && !toast.exiting ? "true" : undefined
                }
                style={progressStyle}
              />
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
