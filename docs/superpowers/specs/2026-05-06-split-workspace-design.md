# Split Workspace + Drag-and-Drop Tabs — Design

**Date:** 2026-05-06
**Project:** acorn
**Status:** Draft

## Goal

Allow the user to split the main pane area into multiple terminal panes (vertical and horizontal), and to move existing session tabs between panes via drag-and-drop. Bring acorn's workspace ergonomics in line with VSCode / Zed terminal-pane behavior.

## Non-Goals

- Mirroring the same session into multiple panes simultaneously. Each session lives in exactly one pane (move semantics, not copy).
- Splitting the sidebar or right panel. Only the main pane area splits.
- Persistent layout across app restarts. Layout is in-memory for this iteration. (Persistence can be added later if needed.)

## User-Facing Behavior

### Hotkeys

| Binding | Action |
|---------|--------|
| `Cmd+D` | Split focused pane vertically (left/right) |
| `Cmd+Shift+D` | Split focused pane horizontally (top/bottom) |
| `Cmd+W` | Close active tab; if pane becomes empty, remove pane and merge sibling |

On split, the new pane starts empty (no active session) and becomes the focused pane. The originating pane keeps its current active session.

Empty panes show a placeholder ("Drop a tab here or pick from sidebar") and disappear automatically when their last tab moves out.

### Drag-and-Drop

A tab in the tab strip is draggable. Three valid drop targets:

1. **Tab strip of another pane** — appends the tab to that pane's tab list, removes it from source. No new split.
2. **Pane body edge zone** — the outer 25% of the pane body in any of the four directions (top/bottom/left/right). Dropping here splits that pane in the corresponding direction and places the moved tab in the new sibling pane.
3. **Pane body center zone** — the inner 50% area. Behaves identically to tab strip drop on that pane (move tab into pane).

Visual feedback during dragover:
- Edge zone: a translucent accent overlay on that edge half (or quarter) of the pane.
- Center zone: a translucent accent overlay covering the full pane body.
- Tab strip: a thin accent insertion bar between tabs indicating the drop position.

Dropping a tab onto its current pane's tab strip is allowed (reorders within pane). Dropping a tab onto its current pane's center is a no-op. Dropping the only tab from a pane onto an edge of the same pane is a no-op (would create empty source pane that immediately collapses back).

## Architecture

### Layout Tree

The main area is represented as a binary tree:

```ts
type Direction = "horizontal" | "vertical"; // resizable-panels orientation
type PaneId = string;

interface PaneNode {
  kind: "pane";
  id: PaneId;
}

interface SplitNode {
  kind: "split";
  id: string;             // stable id for autoSaveId / keying
  direction: Direction;
  a: LayoutNode;
  b: LayoutNode;
  // optional: sizes hint for initial split (50/50)
}

type LayoutNode = PaneNode | SplitNode;

interface PaneState {
  id: PaneId;
  sessionIds: string[];   // ordered tab list
  activeSessionId: string | null;
}
```

Store additions:

```ts
layout: LayoutNode;                       // root
panes: Record<PaneId, PaneState>;
focusedPaneId: PaneId;
```

`activeSessionId` (the existing top-level field) becomes a derived getter:
`useActiveSession()` reads `panes[focusedPaneId].activeSessionId`.

### Pure Layout Operations

A new `src/lib/layout.ts` module exposes pure functions over `LayoutNode`:

- `findPane(layout, paneId): { node, parent, side } | null`
- `splitPane(layout, paneId, direction, newPaneId, newSide: "before"|"after"): LayoutNode`
- `removePane(layout, paneId): { layout: LayoutNode, removed: boolean }` — collapses the surviving sibling into the parent's slot
- `replacePane(layout, paneId, newNode): LayoutNode`

All operations are immutable (return new tree). Pane state (tabs/active) lives in the `panes` map keyed by `PaneId`, not in tree nodes.

### Store Operations

```ts
splitFocusedPane(direction: Direction): void
closePane(paneId: PaneId): void           // also called when last tab leaves
moveTab(args: {
  sessionId: string;
  fromPaneId: PaneId;
  toPaneId: PaneId;
  toIndex?: number;                        // for tab strip drops
  splitDirection?: Direction;              // for edge drops
  splitSide?: "before" | "after";
}): void
setFocusedPane(paneId: PaneId): void
selectSession(id: string | null): void    // back-compat: locates pane, sets focus + active
```

`createSession` places the new session into the focused pane (or root pane if focus is on an empty pane). `removeSession` removes from whichever pane holds the session and collapses the pane if empty.

### Rendering

```
App
└─ <PanelGroup horizontal>     // sidebar | main | right
   ├─ Sidebar
   ├─ <LayoutRenderer node={layout} />   // recursive
   │     ├─ SplitNode  → <PanelGroup direction>
   │     │                 ├─ LayoutRenderer(a)
   │     │                 ├─ ResizeHandle
   │     │                 └─ LayoutRenderer(b)
   │     └─ PaneNode   → <Pane paneId={id}/>
   └─ RightPanel
```

`<Pane>` is the renamed/refactored existing `MainPane`, parameterized by `paneId`. It reads its tabs and active session from `panes[paneId]` instead of the global `activeSessionId`. Terminal mounting (lazy + persisted) stays per-pane.

`react-resizable-panels` is already in use; nested `PanelGroup` is supported.

### Drag-and-Drop

Native HTML5 DnD. No new dependency.

**Drag source — tab `<div>`:**
- `draggable={true}`
- `onDragStart`: `dataTransfer.setData("application/x-acorn-tab", JSON.stringify({ sessionId, fromPaneId }))`
- `effectAllowed = "move"`

**Drop target — tab strip:**
- `onDragOver`: if payload type matches, `preventDefault()`; compute insertion index from clientX vs tab midpoints; render insertion bar
- `onDrop`: dispatch `moveTab({ toPaneId, toIndex })`

**Drop target — pane body:**
- `<PaneDropOverlay paneId>` covering the body during a drag. Uses pointer position relative to body bounds to classify zone:
  - top 25% h → splitDirection "horizontal", splitSide "before"
  - bottom 25% h → splitDirection "horizontal", splitSide "after"
  - left 25% w → splitDirection "vertical", splitSide "before"
  - right 25% w → splitDirection "vertical", splitSide "after"
  - else → center (move into pane, append)
- Render the highlight overlay for the active zone.
- `onDrop`: dispatch `moveTab` with the corresponding params.

A small `useDragPayload()` hook tracks whether a tab drag is in progress (via `dragstart`/`dragend` on `window`) so the overlay only renders/intercepts pointer events during a drag.

### Edge Cases

- **Drop on origin pane center / origin tab strip with same index** → no-op.
- **Last tab leaves a pane** → that pane is removed, sibling collapses into parent slot. If that pane was the focused pane, focus moves to the sibling.
- **Drop creates a split in a pane that holds the dragged tab and only that tab** → no-op (would immediately collapse).
- **Cmd+W on the only tab of the only pane** → leaves the root pane empty (placeholder shown). Root pane never collapses.
- **Removing a session via session deletion** → identical handling to drag-out: remove from pane, collapse if empty.

## Files

| File | Change |
|------|--------|
| `src/lib/layout.ts` | NEW — pure layout tree ops |
| `src/lib/dnd.ts` | NEW — drag payload helpers (`MIME_TAB`, encode/decode, `useDragPayload`) |
| `src/lib/hotkeys.ts` | ADD `splitV`, `splitH`, `closePane` bindings |
| `src/store.ts` | EXTEND with `layout`, `panes`, `focusedPaneId`, ops; refactor `activeSessionId` to derived |
| `src/components/LayoutRenderer.tsx` | NEW — recursive renderer |
| `src/components/Pane.tsx` | RENAMED from `MainPane.tsx`; takes `paneId` prop; tab `draggable`; renders `PaneDropOverlay` |
| `src/components/PaneDropOverlay.tsx` | NEW — edge/center drop zones with visual feedback |
| `src/components/TabStrip.tsx` | EXTRACTED from `Pane.tsx` (was inline in MainPane); supports drop reorder |
| `src/App.tsx` | Replace `<MainPane/>` with `<LayoutRenderer node={layout}/>`; add Cmd+D / Cmd+Shift+D / Cmd+W bindings |
| `src/components/Sidebar.tsx` | Update calls that read/write `activeSessionId` to use focused-pane API |

## Testing

- Unit tests for `src/lib/layout.ts`: split, remove (with sibling collapse), find, replace. Cover degenerate trees.
- Manual: split V, split H, nested splits, drag tab between panes, drag tab to all 4 edges + center, drag tab into empty pane, close last tab in pane, close last pane.
- Visual regression deferred (not currently set up in repo).

## Open Questions

None — all resolved during brainstorming.

## Out of Scope (Future)

- Persisting layout to disk (Tauri store).
- Maximize/restore pane (Cmd+Shift+M).
- Drag pane group (move whole pane to another location).
- Split direction inference based on aspect ratio (smart-split).
