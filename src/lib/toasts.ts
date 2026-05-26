import { create } from "zustand";

type ToastAction = () => void | Promise<void>;

interface ToastOptions {
  action?: ToastAction;
}

export interface ToastItem {
  id: number;
  message: string;
  durationMs: number;
  action: ToastAction | null;
  paused: boolean;
}

/**
 * Lightweight toast stack store. `show` appends a transient message,
 * each with its own TTL so simultaneous background completions don't
 * overwrite each other.
 */
interface ToastState {
  toasts: ToastItem[];
  show: (message: string, options?: ToastOptions) => void;
  hide: (id?: number) => void;
  pause: (id: number) => void;
  resume: (id: number) => void;
}

export const TOAST_TTL_MS = 5_000;

const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
const startedAt = new Map<number, number>();
const remainingMs = new Map<number, number>();

let nextToastId = 0;

function clearDismissTimer(id: number) {
  const timer = dismissTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    dismissTimers.delete(id);
  }
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message: string, options?: ToastOptions) => {
    const id = ++nextToastId;
    startedAt.set(id, Date.now());
    remainingMs.set(id, TOAST_TTL_MS);
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          id,
          message,
          durationMs: TOAST_TTL_MS,
          action: options?.action ?? null,
          paused: false,
        },
      ],
    }));
    dismissTimers.set(
      id,
      setTimeout(() => {
        get().hide(id);
      }, TOAST_TTL_MS),
    );
  },
  hide: (id?: number) => {
    if (id === undefined) {
      for (const toast of get().toasts) {
        clearDismissTimer(toast.id);
        startedAt.delete(toast.id);
        remainingMs.delete(toast.id);
      }
      set({ toasts: [] });
      return;
    }
    clearDismissTimer(id);
    startedAt.delete(id);
    remainingMs.delete(id);
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }));
  },
  pause: (id: number) => {
    const toast = get().toasts.find((item) => item.id === id);
    if (!toast || toast.paused) return;
    clearDismissTimer(id);
    const started = startedAt.get(id) ?? Date.now();
    const remaining = remainingMs.get(id) ?? TOAST_TTL_MS;
    remainingMs.set(id, Math.max(0, remaining - (Date.now() - started)));
    set((state) => ({
      toasts: state.toasts.map((item) =>
        item.id === id ? { ...item, paused: true } : item,
      ),
    }));
  },
  resume: (id: number) => {
    const toast = get().toasts.find((item) => item.id === id);
    if (!toast || !toast.paused) return;
    const remaining = remainingMs.get(id) ?? 0;
    if (remaining <= 0) {
      get().hide(id);
      return;
    }
    startedAt.set(id, Date.now());
    set((state) => ({
      toasts: state.toasts.map((item) =>
        item.id === id ? { ...item, paused: false } : item,
      ),
    }));
    dismissTimers.set(
      id,
      setTimeout(() => {
        get().hide(id);
      }, remaining),
    );
  },
}));
