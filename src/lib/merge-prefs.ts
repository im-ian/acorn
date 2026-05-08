import type { MergeMethod } from "./types";

const STORAGE_KEY = "acorn:pr-merge-method:v1";
const VALID: ReadonlySet<MergeMethod> = new Set<MergeMethod>([
  "squash",
  "merge",
  "rebase",
]);

const DEFAULT_METHOD: MergeMethod = "squash";

export function loadLastMergeMethod(): MergeMethod {
  if (typeof localStorage === "undefined") return DEFAULT_METHOD;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && VALID.has(raw as MergeMethod)) {
      return raw as MergeMethod;
    }
  } catch {
    // localStorage access can throw in some sandboxes — fall through to default.
  }
  return DEFAULT_METHOD;
}

export function saveLastMergeMethod(method: MergeMethod): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, method);
  } catch {
    // Quota / sandbox failures are non-fatal — the prefs are an
    // ergonomic memory, not a correctness requirement.
  }
}
