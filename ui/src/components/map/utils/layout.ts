import type { MapEdge, MapThread, MapWorkspace, Position } from "../types";

export type MapBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export const WORKSPACE_AREA_WIDTH = 320;
export const WORKSPACE_AREA_PADDING = 16;
export const WORKSPACE_LANE_GAP = 48;
export const CARD_WIDTH = 220;
export const CARD_HEIGHT = 80;
export const CARD_COLUMN_GAP = 24;
export const CARD_ROW_GAP = 16;
export const WORKSPACE_HEADER_HEIGHT = 32;

export function computeColumns(areaWidth: number, cardWidth: number, columnGap: number): number {
  return Math.max(1, Math.floor((areaWidth + columnGap) / (cardWidth + columnGap)));
}

export function computeThreadLayout(workspaces: MapWorkspace[], threads: MapThread[]): MapThread[] {
  if (workspaces.length === 0) return threads;

  const workspaceOrder = sortWorkspacesDeterministic(workspaces);
  const columnsPerWorkspace = computeColumns(
    WORKSPACE_AREA_WIDTH - WORKSPACE_AREA_PADDING * 2,
    CARD_WIDTH,
    CARD_COLUMN_GAP,
  );

  let currentX = 0;
  const workspaceX = new Map<string, number>();
  for (const workspace of workspaceOrder) {
    workspaceX.set(workspace.id, currentX);
    currentX += WORKSPACE_AREA_WIDTH + WORKSPACE_LANE_GAP;
  }

  const threadsByWorkspace = new Map<string, MapThread[]>();
  for (const thread of threads) {
    const list = threadsByWorkspace.get(thread.workspaceId) ?? [];
    list.push(thread);
    threadsByWorkspace.set(thread.workspaceId, list);
  }

  const positioned: MapThread[] = [];
  for (const workspace of workspaceOrder) {
    const laneX = workspaceX.get(workspace.id) ?? 0;
    const workspaceThreads = sortThreadsDeterministic(threadsByWorkspace.get(workspace.id) ?? []);
    const startX = laneX + WORKSPACE_AREA_PADDING;
    const startY = WORKSPACE_AREA_PADDING + WORKSPACE_HEADER_HEIGHT;

    for (const [index, thread] of workspaceThreads.entries()) {
      const col = index % columnsPerWorkspace;
      const row = Math.floor(index / columnsPerWorkspace);
      positioned.push({
        ...thread,
        position: {
          x: startX + col * (CARD_WIDTH + CARD_COLUMN_GAP),
          y: startY + row * (CARD_HEIGHT + CARD_ROW_GAP),
        },
      });
    }
  }

  // Preserve relative order of threads that belong to unknown workspaces.
  const positionedIds = new Set(positioned.map(t => t.id));
  for (const thread of threads) {
    if (!positionedIds.has(thread.id)) {
      positioned.push(thread);
    }
  }

  return positioned;
}

export function computeMapBounds(threads: MapThread[], workspaces: MapWorkspace[]): MapBounds {
  if (threads.length === 0 && workspaces.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const workspace of workspaces) {
    minX = Math.min(minX, workspace.position.x);
    minY = Math.min(minY, workspace.position.y);
    maxX = Math.max(maxX, workspace.position.x + WORKSPACE_AREA_WIDTH);
    maxY = Math.max(maxY, workspace.position.y + computeWorkspaceHeight(workspace.id, threads));
  }

  for (const thread of threads) {
    minX = Math.min(minX, thread.position.x);
    minY = Math.min(minY, thread.position.y);
    maxX = Math.max(maxX, thread.position.x + CARD_WIDTH);
    maxY = Math.max(maxY, thread.position.y + CARD_HEIGHT);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  return { minX, minY, maxX, maxY };
}

export function buildThreadEdges(threads: MapThread[]): MapEdge[] {
  const byId = new Map(threads.map(t => [t.id, t]));
  const edges: MapEdge[] = [];
  for (const thread of threads) {
    if (thread.parentId && byId.has(thread.parentId)) {
      edges.push({ from: thread.parentId, to: thread.id });
    }
  }
  return detectAndBreakCycleEdges(threads, edges);
}

export function applyPersistedPositions(threads: MapThread[], positions: Map<string, Position>): MapThread[] {
  return threads.map(thread => {
    const persisted = positions.get(thread.id);
    if (!persisted) return thread;
    return { ...thread, position: { x: persisted.x, y: persisted.y } };
  });
}

function sortWorkspacesDeterministic(workspaces: MapWorkspace[]): MapWorkspace[] {
  return [...workspaces].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.id.localeCompare(b.id);
  });
}

function sortThreadsDeterministic(threads: MapThread[]): MapThread[] {
  return [...threads].sort((a, b) => {
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.id.localeCompare(b.id);
  });
}

export function computeWorkspaceHeight(workspaceId: string, threads: MapThread[]): number {
  const workspaceThreads = threads.filter(t => t.workspaceId === workspaceId);
  if (workspaceThreads.length === 0) {
    return WORKSPACE_AREA_PADDING * 2 + WORKSPACE_HEADER_HEIGHT;
  }
  const columns = computeColumns(WORKSPACE_AREA_WIDTH - WORKSPACE_AREA_PADDING * 2, CARD_WIDTH, CARD_COLUMN_GAP);
  const rows = Math.ceil(workspaceThreads.length / columns);
  return (
    WORKSPACE_AREA_PADDING +
    WORKSPACE_HEADER_HEIGHT +
    rows * CARD_HEIGHT +
    (rows - 1) * CARD_ROW_GAP +
    WORKSPACE_AREA_PADDING
  );
}

function detectAndBreakCycleEdges(threads: MapThread[], edges: MapEdge[]): MapEdge[] {
  const adjacency = new Map<string, string[]>();
  for (const thread of threads) {
    adjacency.set(thread.id, []);
  }
  for (const edge of edges) {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      adjacency.get(edge.from)!.push(edge.to);
    }
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const safeEdges = new Set<string>();

  function dfsMark(nodeId: string) {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    for (const childId of adjacency.get(nodeId) ?? []) {
      const edgeKey = `${nodeId}->${childId}`;
      if (!visited.has(childId)) {
        safeEdges.add(edgeKey);
        dfsMark(childId);
      } else if (!recursionStack.has(childId)) {
        safeEdges.add(edgeKey);
      }
    }
    recursionStack.delete(nodeId);
  }

  const sortedIds = sortThreadsDeterministic(threads).map(t => t.id);
  for (const id of sortedIds) {
    if (!visited.has(id)) {
      dfsMark(id);
    }
  }

  return edges.filter(edge => safeEdges.has(`${edge.from}->${edge.to}`));
}
