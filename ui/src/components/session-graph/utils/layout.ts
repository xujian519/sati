import type { SessionGraphEdge, SessionGraphNode } from "../types";

export type GraphBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;
const COLUMN_GAP = 64;
const ROW_GAP = 40;

function sortNodesDeterministic(nodes: SessionGraphNode[]): SessionGraphNode[] {
  return [...nodes].sort((a, b) => {
    const timeA = a.createdAt ? new Date(a.createdAt).getTime() : (a.lastActivity ?? 0);
    const timeB = b.createdAt ? new Date(b.createdAt).getTime() : (b.lastActivity ?? 0);
    if (timeA !== timeB) return timeA - timeB;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

export function computeGridLayout(nodes: SessionGraphNode[]): GraphBounds {
  const sorted = sortNodesDeterministic(nodes);
  const columns = Math.max(1, Math.floor(Math.sqrt(sorted.length * 1.6)));
  sorted.forEach((node, index) => {
    if (node.positionLocked) return;
    const col = index % columns;
    const row = Math.floor(index / columns);
    node.position = {
      x: col * (NODE_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    };
  });
  return computeBounds(nodes);
}

export function computeBounds(nodes: SessionGraphNode[]): GraphBounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + NODE_WIDTH);
    maxY = Math.max(maxY, node.position.y + NODE_HEIGHT);
  }
  return { minX, minY, maxX, maxY };
}

function detectAndBreakCycle(nodes: SessionGraphNode[], edges: SessionGraphEdge[]): SessionGraphEdge[] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.sessionId, []);
  }
  for (const edge of edges) {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
      adjacency.get(edge.from)!.push(edge.to);
    }
  }

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const safeEdges = new Set<string>();

  function dfs(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    for (const childId of adjacency.get(nodeId) ?? []) {
      if (!visited.has(childId)) {
        if (dfs(childId)) return true;
      } else if (recursionStack.has(childId)) {
        // Cycle found; drop this edge.
        return true;
      }
    }
    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.sessionId)) {
      dfs(node.sessionId);
    }
  }

  // Re-traverse to mark safe edges.
  visited.clear();
  recursionStack.clear();

  function dfsMark(nodeId: string) {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    for (const childId of adjacency.get(nodeId) ?? []) {
      const edgeKey = `${nodeId}->${childId}`;
      if (!visited.has(childId)) {
        safeEdges.add(edgeKey);
        dfsMark(childId);
      } else if (recursionStack.has(childId)) {
        // Drop cycle edge.
      } else {
        safeEdges.add(edgeKey);
      }
    }
    recursionStack.delete(nodeId);
  }

  for (const node of sortNodesDeterministic(nodes)) {
    if (!visited.has(node.sessionId)) {
      dfsMark(node.sessionId);
    }
  }

  return edges.filter(edge => safeEdges.has(`${edge.from}->${edge.to}`));
}

export function buildEdges(nodes: SessionGraphNode[]): SessionGraphEdge[] {
  const byId = new Map(nodes.map(n => [n.sessionId, n]));
  const rawEdges: SessionGraphEdge[] = [];
  for (const node of nodes) {
    if (node.parentSessionId && byId.has(node.parentSessionId)) {
      rawEdges.push({
        from: node.parentSessionId,
        to: node.sessionId,
        label: node.forkedFromTurnId ? `turn ${node.forkedFromTurnId.slice(0, 6)}` : undefined,
      });
    }
  }
  return detectAndBreakCycle(nodes, rawEdges);
}
