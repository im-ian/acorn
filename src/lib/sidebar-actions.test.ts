// @vitest-environment node
import { describe, expect, it } from "vitest";
import { planChevronClick, planTitleClick } from "./sidebar-actions";

describe("planTitleClick", () => {
  it("inactive + collapsed → activates, preserves collapse state", () => {
    expect(planTitleClick({ wasActive: false, wasCollapsed: true })).toEqual({
      shouldActivate: true,
      collapseChange: null,
    });
  });

  it("inactive + expanded → activates, no collapse change", () => {
    expect(planTitleClick({ wasActive: false, wasCollapsed: false })).toEqual({
      shouldActivate: true,
      collapseChange: null,
    });
  });

  it("active + collapsed → expands, does not re-activate", () => {
    expect(planTitleClick({ wasActive: true, wasCollapsed: true })).toEqual({
      shouldActivate: false,
      collapseChange: "expand",
    });
  });

  it("active + expanded → no-op", () => {
    expect(planTitleClick({ wasActive: true, wasCollapsed: false })).toEqual({
      shouldActivate: false,
      collapseChange: null,
    });
  });
});

describe("planChevronClick", () => {
  it("inactive + collapsed → activates and expands", () => {
    expect(planChevronClick({ wasActive: false, wasCollapsed: true })).toEqual({
      shouldActivate: true,
      collapseChange: "expand",
    });
  });

  it("inactive + expanded → collapses without activating", () => {
    expect(planChevronClick({ wasActive: false, wasCollapsed: false })).toEqual(
      {
        shouldActivate: false,
        collapseChange: "collapse",
      },
    );
  });

  it("active + collapsed → expands, no re-activate", () => {
    expect(planChevronClick({ wasActive: true, wasCollapsed: true })).toEqual({
      shouldActivate: false,
      collapseChange: "expand",
    });
  });

  it("active + expanded → collapses", () => {
    expect(planChevronClick({ wasActive: true, wasCollapsed: false })).toEqual({
      shouldActivate: false,
      collapseChange: "collapse",
    });
  });
});
