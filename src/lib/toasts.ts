import { create } from "zustand";

/**
 * Lightweight one-shot toast store. A single message at a time — calling
 * `show` while another is visible replaces it and resets the timer. Used
 * for transient confirmations that don't deserve a full dialog (e.g.
 * "Shell environment reloaded"). Mount [`ToastHost`] once near the app
 * root for these to render.
 */
interface ToastState {
  message: string | null;
  show: (message: string) => void;
  hide: () => void;
}

const TOAST_TTL_MS = 3000;

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export const useToasts = create<ToastState>((set) => ({
  message: null,
  show: (message: string) => {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
    }
    set({ message });
    dismissTimer = setTimeout(() => {
      set({ message: null });
      dismissTimer = null;
    }, TOAST_TTL_MS);
  },
  hide: () => {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    set({ message: null });
  },
}));
