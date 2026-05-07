/**
 * Planners for the project-row click behaviors in the sidebar accordion.
 * Returned as plain descriptors so the click matrix can be unit-tested
 * without rendering the whole sidebar tree.
 *
 * Behavior contract:
 * - Title click never collapses an expanded project.
 * - Title click on an inactive project preserves its collapse state.
 * - Title click on an active collapsed project expands it.
 * - Chevron click toggles expand/collapse.
 * - Chevron click activates only when expanding an inactive project; collapsing
 *   an inactive project must not steal focus from the active one.
 */

export type CollapseChange = "expand" | "collapse" | null;

export interface ProjectClickPlan {
  shouldActivate: boolean;
  collapseChange: CollapseChange;
}

export interface ProjectClickState {
  wasActive: boolean;
  wasCollapsed: boolean;
}

export function planTitleClick(state: ProjectClickState): ProjectClickPlan {
  if (!state.wasActive) {
    return { shouldActivate: true, collapseChange: null };
  }
  return {
    shouldActivate: false,
    collapseChange: state.wasCollapsed ? "expand" : null,
  };
}

export function planChevronClick(state: ProjectClickState): ProjectClickPlan {
  const collapseChange: CollapseChange = state.wasCollapsed
    ? "expand"
    : "collapse";
  const shouldActivate =
    collapseChange === "expand" && !state.wasActive;
  return { shouldActivate, collapseChange };
}
