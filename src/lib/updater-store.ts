import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { checkForUpdate, getCurrentVersion, installUpdate, type Update } from "./updater";

/**
 * App-wide updater state.
 *
 * We split persistent fields (last-check timestamp, dismissed-version
 * memo) from in-memory transient fields (live `Update` handle, busy
 * flag, error) so reloading or remounting the app does not lose the
 * "user already saw this version's banner" record.
 *
 * The dismissed banner is keyed by *version string*, not by id — once
 * the user clicks "Later" on `0.2.0` we don't pester them again about
 * `0.2.0`, but a later `0.3.0` release shows the banner fresh.
 */
interface UpdaterState {
  /** Current running app version (cached after first read). */
  currentVersion: string | null;
  /** Live Update handle if a newer version is available; null otherwise. */
  available: Update | null;
  /** True while a check or install is in flight. */
  busy: boolean;
  /** User-facing error message from the most recent operation. */
  error: string | null;
  /** Epoch ms when the last successful check completed. */
  lastCheckedAt: number | null;
  /** Last update version the user explicitly dismissed via "Later". */
  dismissedVersion: string | null;

  init: () => Promise<void>;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
  clearError: () => void;
}

const STORAGE_KEY = "acorn:updater:v1";

interface PersistedShape {
  lastCheckedAt: number | null;
  dismissedVersion: string | null;
}

export const useUpdater = create<UpdaterState>()(
  persist(
    (set, get) => ({
      currentVersion: null,
      available: null,
      busy: false,
      error: null,
      lastCheckedAt: null,
      dismissedVersion: null,

      async init() {
        if (get().currentVersion === null) {
          try {
            const v = await getCurrentVersion();
            set({ currentVersion: v });
          } catch (err) {
            console.warn("[updater] getCurrentVersion failed", err);
          }
        }
      },

      async check() {
        if (get().busy) return;
        set({ busy: true, error: null });
        try {
          const update = await checkForUpdate();
          set({
            available: update,
            lastCheckedAt: Date.now(),
            busy: false,
          });
        } catch (err) {
          // Connectivity / signature / config issues land here. We keep
          // the previous `available` value so a transient network blip
          // does not make a known-pending update vanish from the UI.
          set({
            error: err instanceof Error ? err.message : String(err),
            busy: false,
          });
        }
      },

      async install() {
        const update = get().available;
        if (!update || get().busy) return;
        set({ busy: true, error: null });
        try {
          await installUpdate(update, (event) => {
            // Log progress markers so a stuck download / install leaves
            // a breadcrumb trail in the renderer console for debugging.
            // We deliberately don't surface bytes-per-chunk to the UI —
            // the banner is intentionally compact.
            if (event.event === "Started" || event.event === "Finished") {
              console.info("[updater]", event.event, event);
            }
          });
          // installUpdate now ends with relaunch(), so control rarely
          // returns here. If it does (e.g. the relaunch is briefly
          // queued before the OS tears the process down), keep busy=true
          // so the UI stays disabled until the relaunch lands.
        } catch (err) {
          console.error("[updater] install failed", err);
          set({
            error: err instanceof Error ? err.message : String(err),
            busy: false,
          });
        }
      },

      dismiss() {
        const update = get().available;
        if (!update) return;
        set({ dismissedVersion: update.version });
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedShape => ({
        lastCheckedAt: state.lastCheckedAt,
        dismissedVersion: state.dismissedVersion,
      }),
    },
  ),
);

/**
 * True when an update is available AND the user hasn't already
 * dismissed this exact version. Used by the App-level banner so
 * "Later" hides the banner without forgetting the update entirely
 * (the Settings panel still shows it).
 */
export function selectShouldNotify(state: UpdaterState): boolean {
  if (!state.available) return false;
  if (state.dismissedVersion === state.available.version) return false;
  return true;
}
