/**
 * Window-level events used to coordinate workspace layout actions across
 * components without prop-drilling. Kept in a dependency-free module so
 * `Pane` and `LayoutRenderer` can both import from it without forming a
 * circular import.
 */

/** Reset every nested PanelGroup in the active workspace to an even split. */
export const EQUALIZE_PANES_EVENT = "acorn:equalize-panes";
