import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLastMergeMethod, saveLastMergeMethod } from "./merge-prefs";

const STORAGE_KEY = "acorn:pr-merge-method:v1";

describe("merge-prefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to squash when nothing is stored", () => {
    expect(loadLastMergeMethod()).toBe("squash");
  });

  it("round-trips a saved method", () => {
    saveLastMergeMethod("merge");
    expect(loadLastMergeMethod()).toBe("merge");
    saveLastMergeMethod("rebase");
    expect(loadLastMergeMethod()).toBe("rebase");
  });

  it("ignores unknown stored values and falls back to squash", () => {
    localStorage.setItem(STORAGE_KEY, "fast-forward");
    expect(loadLastMergeMethod()).toBe("squash");
  });
});
