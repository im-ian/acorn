/**
 * Window-level events used to coordinate workspace layout actions across
 * components without prop-drilling. Kept in a dependency-free module so
 * `Pane` and `LayoutRenderer` can both import from it without forming a
 * circular import.
 */

/** Reset every nested PanelGroup in the active workspace to an even split. */
export const EQUALIZE_PANES_EVENT = "acorn:equalize-panes";

/** Restore the root sidebar/right panel widths and equalize the workspace. */
export const RESET_PANEL_SIZES_EVENT = "acorn:reset-panel-sizes";

/**
 * Request that a specific Panel be expanded to its minSize. Dispatched by
 * `ResizeHandle` on double-click; App.tsx wires it to the matching
 * imperative panel ref.
 */
export const EXPAND_PANEL_EVENT = "acorn:expand-panel";

export interface ExpandPanelDetail {
  panelId: string;
}
