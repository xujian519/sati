import { describe, expect, it } from "vitest";
import type { SessionGraphNode } from "../types";
import { buildEdges, computeBounds, computeGridLayout } from "./layout";

function makeNode(partial: Partial<SessionGraphNode> & { sessionId: string }): SessionGraphNode {
  return {
    title: partial.sessionId,
    isReadOnly: false,
    status: "idle",
    color: "#0ea5e9",
    position: { x: 0, y: 0 },
    positionLocked: false,
    ...partial,
  };
}

describe("buildEdges", () => {
  it("connects a child to its parent via parentSessionId", () => {
    const edges = buildEdges([makeNode({ sessionId: "a" }), makeNode({ sessionId: "b", parentSessionId: "a" })]);
    expect(edges).toEqual([{ from: "a", to: "b", label: undefined }]);
  });

  it("labels an edge with the fork turn id prefix", () => {
    const turnId = "t_abca123456";
    const edges = buildEdges([
      makeNode({ sessionId: "a" }),
      makeNode({ sessionId: "b", parentSessionId: "a", forkedFromTurnId: turnId }),
    ]);
    expect(edges[0]?.label).toBe(`turn ${turnId.slice(0, 6)}`);
  });

  it("omits edges whose parent session is absent", () => {
    const edges = buildEdges([makeNode({ sessionId: "b", parentSessionId: "ghost" })]);
    expect(edges).toEqual([]);
  });

  it("breaks cycles so the surviving edges form a DAG", () => {
    const edges = buildEdges([
      makeNode({ sessionId: "a", parentSessionId: "b" }),
      makeNode({ sessionId: "b", parentSessionId: "a" }),
    ]);
    expect(edges).toHaveLength(1);
  });
});

describe("computeGridLayout", () => {
  it("places nodes deterministically, earliest creation first", () => {
    const nodes = [
      makeNode({ sessionId: "b", createdAt: "2026-01-02" }),
      makeNode({ sessionId: "a", createdAt: "2026-01-01" }),
    ];
    computeGridLayout(nodes);
    const a = nodes.find(n => n.sessionId === "a")!;
    const b = nodes.find(n => n.sessionId === "b")!;
    expect(a.position).toEqual({ x: 0, y: 0 });
    expect(a.position.y).toBeLessThan(b.position.y);
  });

  it("leaves locked nodes untouched", () => {
    const locked = makeNode({ sessionId: "a", positionLocked: true, position: { x: 999, y: 999 } });
    const nodes = [locked, makeNode({ sessionId: "b" })];
    computeGridLayout(nodes);
    expect(locked.position).toEqual({ x: 999, y: 999 });
  });
});

describe("computeBounds", () => {
  it("returns zero bounds for an empty graph", () => {
    expect(computeBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("measures the bounding box including the node footprint", () => {
    const bounds = computeBounds([
      makeNode({ sessionId: "a", position: { x: 0, y: 0 } }),
      makeNode({ sessionId: "b", position: { x: 300, y: 200 } }),
    ]);
    expect(bounds.minX).toBe(0);
    expect(bounds.maxX).toBe(300 + 220);
    expect(bounds.maxY).toBe(200 + 96);
  });
});
