// @vitest-environment node
import { describe, expect, it } from "vitest";
import { planChevronClick, planTitleClick } from "./sidebar-actions";
import SIDEBAR_SOURCE from "../components/Sidebar.tsx?raw";

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

describe("Sidebar source contract", () => {
  it("empty-state row routes click through onActivate (which activates + expands + selects)", () => {
    // The empty-state <li> must call onActivate, not onTitleClick — onActivate
    // forces an expand so the session list region remains visible after the
    // user creates their first session in this project.
    expect(SIDEBAR_SOURCE).toMatch(
      /role="button"[\s\S]{0,400}onClick=\{onActivate\}/,
    );
    expect(SIDEBAR_SOURCE).toMatch(
      /onActivate=\{\(\) => \{[\s\S]{0,200}setActiveProject\(project\.repoPath\);[\s\S]{0,80}expandProject\(project\.repoPath\);/,
    );
  });

  it("session row classes are tightened (py-1, gap-1.5, status dot 1.5, name 13px, subtitle 11px)", () => {
    expect(SIDEBAR_SOURCE).toContain("gap-1.5 rounded-md px-2 py-1 text-left");
    expect(SIDEBAR_SOURCE).toContain("size-1.5 shrink-0 rounded-full");
    expect(SIDEBAR_SOURCE).toContain("truncate text-[13px] font-medium text-fg");
    expect(SIDEBAR_SOURCE).toContain("block truncate text-[11px] text-fg-muted");
  });

  it("chevron is rendered as its own padded button with hover background", () => {
    expect(SIDEBAR_SOURCE).toMatch(
      /aria-label=\{\s*collapsed\s*\?\s*sidebarText\(t, "sidebar\.actions\.expandProject"\)\s*:\s*sidebarText\(t, "sidebar\.actions\.collapseProject"\)\s*\}/,
    );
    expect(SIDEBAR_SOURCE).toMatch(
      /flex shrink-0 items-center justify-center rounded p-1 text-fg-muted transition hover:bg-bg-elevated hover:text-fg/,
    );
  });

  it("title click target is the entire project row, not a thin button", () => {
    // The title click handler is wired to the row container (<div role="button">),
    // so the click area is the full row width minus chevron + action buttons.
    expect(SIDEBAR_SOURCE).toMatch(
      /role="button"[\s\S]{0,400}onClick=\{onTitleClick\}/,
    );
  });
});
