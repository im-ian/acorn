import { describe, expect, it } from "vitest";
import { pullRequestNumberClassName } from "./pullRequestPresentation";

describe("pull request presentation", () => {
  it("uses the right-panel number colors for PR states", () => {
    expect(
      pullRequestNumberClassName({ state: "OPEN", is_draft: false }),
    ).toBe("text-emerald-400");
    expect(
      pullRequestNumberClassName({ state: "OPEN", is_draft: true }),
    ).toBe("text-fg-muted");
    expect(
      pullRequestNumberClassName({ state: "MERGED", is_draft: false }),
    ).toBe("text-purple-400");
    expect(
      pullRequestNumberClassName({ state: "CLOSED", is_draft: false }),
    ).toBe("text-rose-400");
  });
});
