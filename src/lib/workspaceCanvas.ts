export interface WorkspaceCanvasPoint {
  x: number;
  y: number;
}

export interface WorkspaceCanvasSize {
  width: number;
  height: number;
}

export interface WorkspaceCanvasViewport {
  offset: WorkspaceCanvasPoint;
  zoom: number;
}

export interface WorkspaceCanvasNode {
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface WorkspaceCanvasState {
  viewport: WorkspaceCanvasViewport;
  nodes: Record<string, WorkspaceCanvasNode>;
}

export interface WorkspaceCanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkspaceCanvasAlignmentGuide {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
}

export interface WorkspaceCanvasAlignmentMatches {
  x: boolean;
  y: boolean;
  width: boolean;
  height: boolean;
}

export interface WorkspaceCanvasAlignmentResult {
  node: WorkspaceCanvasNode;
  matches: WorkspaceCanvasAlignmentMatches;
  guides: WorkspaceCanvasAlignmentGuide[];
}

export type WorkspaceCanvasAlignmentMode = "move" | "resize";

export interface WorkspaceCanvasMinimapLayout {
  bounds: WorkspaceCanvasRect;
  origin: WorkspaceCanvasPoint;
  scale: number;
  nodeRects: Record<string, WorkspaceCanvasRect>;
  viewportRect: WorkspaceCanvasRect;
}

export const WORKSPACE_CANVAS_MIN_ZOOM = 0.35;
export const WORKSPACE_CANVAS_MAX_ZOOM = 2;
export const WORKSPACE_CANVAS_REVEAL_PADDING = 48;
export const WORKSPACE_CANVAS_MIN_NODE_WIDTH = 360;
export const WORKSPACE_CANVAS_MIN_NODE_HEIGHT = 240;
export const WORKSPACE_CANVAS_GRID_SIZE = 20;
export const WORKSPACE_CANVAS_DEFAULT_NODE_WIDTH =
  WORKSPACE_CANVAS_GRID_SIZE * 30;
export const WORKSPACE_CANVAS_DEFAULT_NODE_HEIGHT =
  WORKSPACE_CANVAS_GRID_SIZE * 20;

const WORKSPACE_CANVAS_MAX_NODE_WIDTH = 2_400;
const WORKSPACE_CANVAS_MAX_NODE_HEIGHT = 1_600;
const WORKSPACE_CANVAS_COORDINATE_LIMIT = 100_000;
const WORKSPACE_CANVAS_NODE_GAP = WORKSPACE_CANVAS_GRID_SIZE * 3;
const WORKSPACE_CANVAS_NODE_ORIGIN = WORKSPACE_CANVAS_GRID_SIZE * 2;
const WORKSPACE_CANVAS_DEFAULT_COLUMNS = 2;

export function defaultWorkspaceCanvasViewport(): WorkspaceCanvasViewport {
  return { offset: { x: 48, y: 48 }, zoom: 1 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function normalizePoint(value: unknown): WorkspaceCanvasPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Partial<WorkspaceCanvasPoint>;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  if (x === null || y === null) return null;
  return {
    x: clamp(
      x,
      -WORKSPACE_CANVAS_COORDINATE_LIMIT,
      WORKSPACE_CANVAS_COORDINATE_LIMIT,
    ),
    y: clamp(
      y,
      -WORKSPACE_CANVAS_COORDINATE_LIMIT,
      WORKSPACE_CANVAS_COORDINATE_LIMIT,
    ),
  };
}

export function clampWorkspaceCanvasZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return clamp(zoom, WORKSPACE_CANVAS_MIN_ZOOM, WORKSPACE_CANVAS_MAX_ZOOM);
}

export function clampWorkspaceCanvasNode(
  node: WorkspaceCanvasNode,
): WorkspaceCanvasNode {
  return {
    x: clamp(
      Number.isFinite(node.x) ? node.x : 0,
      -WORKSPACE_CANVAS_COORDINATE_LIMIT,
      WORKSPACE_CANVAS_COORDINATE_LIMIT,
    ),
    y: clamp(
      Number.isFinite(node.y) ? node.y : 0,
      -WORKSPACE_CANVAS_COORDINATE_LIMIT,
      WORKSPACE_CANVAS_COORDINATE_LIMIT,
    ),
    width: clamp(
      Number.isFinite(node.width)
        ? node.width
        : WORKSPACE_CANVAS_DEFAULT_NODE_WIDTH,
      WORKSPACE_CANVAS_MIN_NODE_WIDTH,
      WORKSPACE_CANVAS_MAX_NODE_WIDTH,
    ),
    height: clamp(
      Number.isFinite(node.height)
        ? node.height
        : WORKSPACE_CANVAS_DEFAULT_NODE_HEIGHT,
      WORKSPACE_CANVAS_MIN_NODE_HEIGHT,
      WORKSPACE_CANVAS_MAX_NODE_HEIGHT,
    ),
    zIndex: clamp(
      Number.isFinite(node.zIndex) ? Math.trunc(node.zIndex) : 1,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function normalizeNode(value: unknown): WorkspaceCanvasNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Partial<WorkspaceCanvasNode>;
  const x = finiteNumber(node.x);
  const y = finiteNumber(node.y);
  const width = finiteNumber(node.width);
  const height = finiteNumber(node.height);
  const zIndex = finiteNumber(node.zIndex);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    zIndex === null
  ) {
    return null;
  }
  return clampWorkspaceCanvasNode({ x, y, width, height, zIndex });
}

export function normalizeWorkspaceCanvasState(
  value: unknown,
): WorkspaceCanvasState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<WorkspaceCanvasState>;
  if (!state.viewport || typeof state.viewport !== "object") return undefined;
  const viewport = state.viewport as Partial<WorkspaceCanvasViewport>;
  const offset = normalizePoint(viewport.offset);
  const zoom = finiteNumber(viewport.zoom);
  if (!offset || zoom === null) return undefined;

  const nodes: Record<string, WorkspaceCanvasNode> = {};
  if (state.nodes && typeof state.nodes === "object") {
    for (const [sessionId, rawNode] of Object.entries(state.nodes)) {
      if (!sessionId.trim()) continue;
      const node = normalizeNode(rawNode);
      if (node) nodes[sessionId] = node;
    }
  }

  return {
    viewport: { offset, zoom: clampWorkspaceCanvasZoom(zoom) },
    nodes,
  };
}

function defaultNodeAt(index: number, zIndex: number): WorkspaceCanvasNode {
  const column = index % WORKSPACE_CANVAS_DEFAULT_COLUMNS;
  const row = Math.floor(index / WORKSPACE_CANVAS_DEFAULT_COLUMNS);
  return {
    x:
      WORKSPACE_CANVAS_NODE_ORIGIN +
      column *
        (WORKSPACE_CANVAS_DEFAULT_NODE_WIDTH + WORKSPACE_CANVAS_NODE_GAP),
    y:
      WORKSPACE_CANVAS_NODE_ORIGIN +
      row * (WORKSPACE_CANVAS_DEFAULT_NODE_HEIGHT + WORKSPACE_CANVAS_NODE_GAP),
    width: WORKSPACE_CANVAS_DEFAULT_NODE_WIDTH,
    height: WORKSPACE_CANVAS_DEFAULT_NODE_HEIGHT,
    zIndex,
  };
}

function nodesOverlap(
  first: WorkspaceCanvasNode,
  second: WorkspaceCanvasNode,
): boolean {
  const gap = WORKSPACE_CANVAS_NODE_GAP / 2;
  return !(
    first.x + first.width + gap <= second.x ||
    second.x + second.width + gap <= first.x ||
    first.y + first.height + gap <= second.y ||
    second.y + second.height + gap <= first.y
  );
}

function nextOpenNode(
  existing: readonly WorkspaceCanvasNode[],
  zIndex: number,
): WorkspaceCanvasNode {
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = defaultNodeAt(index, zIndex);
    if (!existing.some((node) => nodesOverlap(candidate, node))) {
      return candidate;
    }
  }
  return defaultNodeAt(existing.length, zIndex);
}

export function reconcileWorkspaceCanvasState(
  value: unknown,
  sessionIds: readonly string[],
): WorkspaceCanvasState {
  const normalized = normalizeWorkspaceCanvasState(value) ?? {
    viewport: defaultWorkspaceCanvasViewport(),
    nodes: {},
  };
  const ids = [...new Set(sessionIds.filter((id) => id.trim().length > 0))];
  const nodes: Record<string, WorkspaceCanvasNode> = {};
  let maxZ = 0;

  for (const id of ids) {
    const existing = normalized.nodes[id];
    if (!existing) continue;
    nodes[id] = existing;
    maxZ = Math.max(maxZ, existing.zIndex);
  }

  for (const id of ids) {
    if (nodes[id]) continue;
    maxZ += 1;
    nodes[id] = nextOpenNode(Object.values(nodes), maxZ);
  }

  return { viewport: normalized.viewport, nodes };
}

export function resetWorkspaceCanvasState(
  sessionIds: readonly string[],
): WorkspaceCanvasState {
  const ids = [...new Set(sessionIds.filter((id) => id.trim().length > 0))];
  return {
    viewport: defaultWorkspaceCanvasViewport(),
    nodes: Object.fromEntries(
      ids.map((id, index) => [id, defaultNodeAt(index, index + 1)]),
    ),
  };
}

export function workspaceCanvasStatesEqual(
  first: WorkspaceCanvasState | undefined,
  second: WorkspaceCanvasState,
): boolean {
  if (!first) return false;
  if (
    first.viewport.zoom !== second.viewport.zoom ||
    first.viewport.offset.x !== second.viewport.offset.x ||
    first.viewport.offset.y !== second.viewport.offset.y
  ) {
    return false;
  }
  const firstIds = Object.keys(first.nodes);
  const secondIds = Object.keys(second.nodes);
  if (firstIds.length !== secondIds.length) return false;
  return secondIds.every((id) => {
    const a = first.nodes[id];
    const b = second.nodes[id];
    return Boolean(
      a &&
        b &&
        a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height &&
        a.zIndex === b.zIndex,
    );
  });
}

export function zoomWorkspaceCanvasAtPoint(
  viewport: WorkspaceCanvasViewport,
  nextZoom: number,
  point: WorkspaceCanvasPoint,
): WorkspaceCanvasViewport {
  const zoom = clampWorkspaceCanvasZoom(nextZoom);
  const currentZoom = clampWorkspaceCanvasZoom(viewport.zoom);
  const worldPoint = {
    x: (point.x - viewport.offset.x) / currentZoom,
    y: (point.y - viewport.offset.y) / currentZoom,
  };
  return {
    zoom,
    offset: {
      x: point.x - worldPoint.x * zoom,
      y: point.y - worldPoint.y * zoom,
    },
  };
}

export function fitWorkspaceCanvasViewport(
  nodes: Readonly<Record<string, WorkspaceCanvasNode>>,
  container: WorkspaceCanvasSize,
  padding = 56,
): WorkspaceCanvasViewport {
  const values = Object.values(nodes);
  if (
    values.length === 0 ||
    !Number.isFinite(container.width) ||
    !Number.isFinite(container.height) ||
    container.width <= 0 ||
    container.height <= 0
  ) {
    return defaultWorkspaceCanvasViewport();
  }

  const minX = Math.min(...values.map((node) => node.x));
  const minY = Math.min(...values.map((node) => node.y));
  const maxX = Math.max(...values.map((node) => node.x + node.width));
  const maxY = Math.max(...values.map((node) => node.y + node.height));
  const contentWidth = Math.max(maxX - minX, 1);
  const contentHeight = Math.max(maxY - minY, 1);
  const availableWidth = Math.max(container.width - padding * 2, 1);
  const availableHeight = Math.max(container.height - padding * 2, 1);
  const zoom = clampWorkspaceCanvasZoom(
    Math.min(availableWidth / contentWidth, availableHeight / contentHeight, 1),
  );

  return {
    zoom,
    offset: {
      x: (container.width - contentWidth * zoom) / 2 - minX * zoom,
      y: (container.height - contentHeight * zoom) / 2 - minY * zoom,
    },
  };
}

export function revealWorkspaceCanvasNode(
  viewport: WorkspaceCanvasViewport,
  node: WorkspaceCanvasNode,
  container: WorkspaceCanvasSize,
  padding = WORKSPACE_CANVAS_REVEAL_PADDING,
): WorkspaceCanvasViewport {
  if (container.width <= 0 || container.height <= 0) return viewport;
  const zoom = clampWorkspaceCanvasZoom(viewport.zoom);
  const left = node.x * zoom + viewport.offset.x;
  const top = node.y * zoom + viewport.offset.y;
  const right = left + node.width * zoom;
  const bottom = top + node.height * zoom;
  const availableWidth = Math.max(container.width - padding * 2, 1);
  const availableHeight = Math.max(container.height - padding * 2, 1);
  let x = viewport.offset.x;
  let y = viewport.offset.y;

  if (node.width * zoom > availableWidth) {
    x += container.width / 2 - (left + right) / 2;
  } else if (left < padding) {
    x += padding - left;
  } else if (right > container.width - padding) {
    x -= right - (container.width - padding);
  }

  if (node.height * zoom > availableHeight) {
    const maxSafeTop = Math.max(container.height - padding, padding);
    if (top < padding) {
      y += padding - top;
    } else if (top > maxSafeTop) {
      y -= top - maxSafeTop;
    }
  } else if (top < padding) {
    y += padding - top;
  } else if (bottom > container.height - padding) {
    y -= bottom - (container.height - padding);
  }

  return { zoom, offset: { x, y } };
}

function rectFromNode(node: WorkspaceCanvasNode): WorkspaceCanvasRect {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  };
}

function unionWorkspaceCanvasRects(
  rects: readonly WorkspaceCanvasRect[],
): WorkspaceCanvasRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1),
  };
}

function mapWorkspaceCanvasRect(
  rect: WorkspaceCanvasRect,
  bounds: WorkspaceCanvasRect,
  origin: WorkspaceCanvasPoint,
  scale: number,
): WorkspaceCanvasRect {
  return {
    x: origin.x + (rect.x - bounds.x) * scale,
    y: origin.y + (rect.y - bounds.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

export function layoutWorkspaceCanvasMinimap(
  nodes: Readonly<Record<string, WorkspaceCanvasNode>>,
  viewport: WorkspaceCanvasViewport,
  canvasSize: WorkspaceCanvasSize,
  minimapSize: WorkspaceCanvasSize,
  padding = 8,
): WorkspaceCanvasMinimapLayout {
  const zoom = clampWorkspaceCanvasZoom(viewport.zoom);
  const nodeWorldRects = Object.fromEntries(
    Object.entries(nodes).map(([id, node]) => [id, rectFromNode(node)]),
  );
  const hasCanvasSize = canvasSize.width > 0 && canvasSize.height > 0;
  const viewportWorldRect: WorkspaceCanvasRect = {
    x: normalizeZero(-viewport.offset.x / zoom),
    y: normalizeZero(-viewport.offset.y / zoom),
    width: hasCanvasSize ? canvasSize.width / zoom : 0,
    height: hasCanvasSize ? canvasSize.height / zoom : 0,
  };
  const bounds = unionWorkspaceCanvasRects([
    ...Object.values(nodeWorldRects),
    ...(hasCanvasSize ? [viewportWorldRect] : []),
  ]);
  const safePadding = Math.max(
    0,
    Math.min(
      Number.isFinite(padding) ? padding : 0,
      Math.max(Math.min(minimapSize.width, minimapSize.height) / 2 - 0.5, 0),
    ),
  );
  const innerWidth = Math.max(minimapSize.width - safePadding * 2, 1);
  const innerHeight = Math.max(minimapSize.height - safePadding * 2, 1);
  const scale = Math.max(
    Math.min(innerWidth / bounds.width, innerHeight / bounds.height),
    Number.EPSILON,
  );
  const origin = {
    x: safePadding + (innerWidth - bounds.width * scale) / 2,
    y: safePadding + (innerHeight - bounds.height * scale) / 2,
  };
  const nodeRects = Object.fromEntries(
    Object.entries(nodeWorldRects).map(([id, rect]) => [
      id,
      mapWorkspaceCanvasRect(rect, bounds, origin, scale),
    ]),
  );

  return {
    bounds,
    origin,
    scale,
    nodeRects,
    viewportRect: mapWorkspaceCanvasRect(
      viewportWorldRect,
      bounds,
      origin,
      scale,
    ),
  };
}

export function findWorkspaceCanvasMinimapNodeAtPoint(
  candidateIds: readonly string[],
  nodes: Readonly<Record<string, WorkspaceCanvasNode>>,
  nodeRects: Readonly<Record<string, WorkspaceCanvasRect>>,
  point: WorkspaceCanvasPoint,
  minimumHitSize = 24,
): string | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const safeMinimumHitSize = Math.max(
    Number.isFinite(minimumHitSize) ? minimumHitSize : 0,
    0,
  );
  let best:
    | {
        id: string;
        distanceSquared: number;
        centerDistanceSquared: number;
        zIndex: number;
      }
    | undefined;

  for (const id of candidateIds) {
    const node = nodes[id];
    const rect = nodeRects[id];
    if (!node || !rect) continue;
    const hitWidth = Math.max(rect.width, safeMinimumHitSize);
    const hitHeight = Math.max(rect.height, safeMinimumHitSize);
    const hitX = rect.x - (hitWidth - rect.width) / 2;
    const hitY = rect.y - (hitHeight - rect.height) / 2;
    if (
      point.x < hitX ||
      point.x > hitX + hitWidth ||
      point.y < hitY ||
      point.y > hitY + hitHeight
    ) {
      continue;
    }

    const nearestX = clamp(point.x, rect.x, rect.x + rect.width);
    const nearestY = clamp(point.y, rect.y, rect.y + rect.height);
    const distanceSquared =
      (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const centerDistanceSquared =
      (point.x - centerX) ** 2 + (point.y - centerY) ** 2;
    const isBetter =
      !best ||
      distanceSquared < best.distanceSquared ||
      (distanceSquared === best.distanceSquared && node.zIndex > best.zIndex) ||
      (distanceSquared === best.distanceSquared &&
        node.zIndex === best.zIndex &&
        centerDistanceSquared < best.centerDistanceSquared);
    if (isBetter) {
      best = { id, distanceSquared, centerDistanceSquared, zIndex: node.zIndex };
    }
  }

  return best?.id ?? null;
}

export function centerWorkspaceCanvasViewportFromMinimapPoint(
  viewport: WorkspaceCanvasViewport,
  canvasSize: WorkspaceCanvasSize,
  layout: WorkspaceCanvasMinimapLayout,
  point: WorkspaceCanvasPoint,
): WorkspaceCanvasViewport {
  const contentRight = layout.origin.x + layout.bounds.width * layout.scale;
  const contentBottom = layout.origin.y + layout.bounds.height * layout.scale;
  const mapX = clamp(point.x, layout.origin.x, contentRight);
  const mapY = clamp(point.y, layout.origin.y, contentBottom);
  const worldPoint = {
    x: layout.bounds.x + (mapX - layout.origin.x) / layout.scale,
    y: layout.bounds.y + (mapY - layout.origin.y) / layout.scale,
  };
  const zoom = clampWorkspaceCanvasZoom(viewport.zoom);
  return {
    zoom,
    offset: {
      x: canvasSize.width / 2 - worldPoint.x * zoom,
      y: canvasSize.height / 2 - worldPoint.y * zoom,
    },
  };
}

type WorkspaceCanvasMoveAxis = "x" | "y";
type WorkspaceCanvasMoveAnchor = "start" | "center" | "end";

interface WorkspaceCanvasMoveAlignment {
  delta: number;
  position: number;
  peer: WorkspaceCanvasNode;
}

function workspaceCanvasNodeHasFiniteGeometry(
  node: WorkspaceCanvasNode,
): boolean {
  return (
    Number.isFinite(node.x) &&
    Number.isFinite(node.y) &&
    Number.isFinite(node.width) &&
    Number.isFinite(node.height)
  );
}

function workspaceCanvasAnchorPosition(
  node: WorkspaceCanvasNode,
  axis: WorkspaceCanvasMoveAxis,
  anchor: WorkspaceCanvasMoveAnchor,
): number {
  const start = axis === "x" ? node.x : node.y;
  const size = axis === "x" ? node.width : node.height;
  if (anchor === "start") return start;
  if (anchor === "center") return start + size / 2;
  return start + size;
}

function findWorkspaceCanvasMoveAlignment(
  node: WorkspaceCanvasNode,
  peers: readonly WorkspaceCanvasNode[],
  axis: WorkspaceCanvasMoveAxis,
  threshold: number,
): WorkspaceCanvasMoveAlignment | undefined {
  const anchors: readonly WorkspaceCanvasMoveAnchor[] = [
    "start",
    "center",
    "end",
  ];
  let best: WorkspaceCanvasMoveAlignment | undefined;

  for (const peer of peers) {
    if (!workspaceCanvasNodeHasFiniteGeometry(peer)) continue;
    for (const anchor of anchors) {
      const currentPosition = workspaceCanvasAnchorPosition(node, axis, anchor);
      const peerPosition = workspaceCanvasAnchorPosition(peer, axis, anchor);
      const delta = peerPosition - currentPosition;
      if (!Number.isFinite(delta) || Math.abs(delta) > threshold) continue;
      const start = axis === "x" ? node.x : node.y;
      if (!Number.isInteger(start + delta)) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, position: peerPosition, peer };
      }
    }
  }

  return best;
}

function findWorkspaceCanvasDimensionMatch(
  value: number,
  peers: readonly WorkspaceCanvasNode[],
  dimension: "width" | "height",
  threshold: number,
): number | undefined {
  let best: { value: number; delta: number } | undefined;

  for (const peer of peers) {
    const peerValue = peer[dimension];
    if (!Number.isFinite(peerValue) || !Number.isInteger(peerValue)) continue;
    const delta = peerValue - value;
    if (Math.abs(delta) > threshold) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) {
      best = { value: peerValue, delta };
    }
  }

  return best?.value;
}

export function alignWorkspaceCanvasNode(
  node: WorkspaceCanvasNode,
  otherNodes: readonly WorkspaceCanvasNode[],
  mode: WorkspaceCanvasAlignmentMode,
  threshold: number,
): WorkspaceCanvasAlignmentResult {
  const alignedNode = { ...node };
  if (mode === "resize") {
    alignedNode.width = normalizeZero(Math.round(node.width));
    alignedNode.height = normalizeZero(Math.round(node.height));
  } else {
    alignedNode.x = normalizeZero(Math.round(node.x));
    alignedNode.y = normalizeZero(Math.round(node.y));
  }
  const matches: WorkspaceCanvasAlignmentMatches = {
    x: false,
    y: false,
    width: false,
    height: false,
  };
  const guides: WorkspaceCanvasAlignmentGuide[] = [];

  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    !workspaceCanvasNodeHasFiniteGeometry(node)
  ) {
    return { node: alignedNode, matches, guides };
  }

  if (mode === "resize") {
    const width = findWorkspaceCanvasDimensionMatch(
      alignedNode.width,
      otherNodes,
      "width",
      threshold,
    );
    const height = findWorkspaceCanvasDimensionMatch(
      alignedNode.height,
      otherNodes,
      "height",
      threshold,
    );
    if (width !== undefined) {
      alignedNode.width = normalizeZero(Math.round(width));
      matches.width = true;
    }
    if (height !== undefined) {
      alignedNode.height = normalizeZero(Math.round(height));
      matches.height = true;
    }
    return { node: alignedNode, matches, guides };
  }

  const xAlignment = findWorkspaceCanvasMoveAlignment(
    alignedNode,
    otherNodes,
    "x",
    threshold,
  );
  const yAlignment = findWorkspaceCanvasMoveAlignment(
    alignedNode,
    otherNodes,
    "y",
    threshold,
  );

  if (xAlignment) {
    alignedNode.x = normalizeZero(
      Math.round(alignedNode.x + xAlignment.delta),
    );
    matches.x = true;
  }
  if (yAlignment) {
    alignedNode.y = normalizeZero(
      Math.round(alignedNode.y + yAlignment.delta),
    );
    matches.y = true;
  }

  if (xAlignment) {
    guides.push({
      axis: "x",
      position: normalizeZero(xAlignment.position),
      start: Math.min(alignedNode.y, xAlignment.peer.y),
      end: Math.max(
        alignedNode.y + alignedNode.height,
        xAlignment.peer.y + xAlignment.peer.height,
      ),
    });
  }
  if (yAlignment) {
    guides.push({
      axis: "y",
      position: normalizeZero(yAlignment.position),
      start: Math.min(alignedNode.x, yAlignment.peer.x),
      end: Math.max(
        alignedNode.x + alignedNode.width,
        yAlignment.peer.x + yAlignment.peer.width,
      ),
    });
  }

  return { node: alignedNode, matches, guides };
}

export function snapWorkspaceCanvasValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const snapped =
    Math.round(value / WORKSPACE_CANVAS_GRID_SIZE) * WORKSPACE_CANVAS_GRID_SIZE;
  return Object.is(snapped, -0) ? 0 : snapped;
}
