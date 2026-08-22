import { describe, expect, it } from "vitest";
import type { MapThread, MapWorkspace } from "../types";
import {
  buildThreadEdges,
  CARD_HEIGHT,
  CARD_WIDTH,
  computeColumns,
  computeMapBounds,
  computeThreadLayout,
  WORKSPACE_AREA_PADDING,
  WORKSPACE_HEADER_HEIGHT,
} from "./layout";

function makeWorkspace(partial: Partial<MapWorkspace> & { id: string }): MapWorkspace {
  return {
    name: partial.id,
    cwd: partial.id,
    color: "#0ea5e9",
    position: { x: 0, y: 0 },
    ...partial,
  };
}

function makeThread(partial: Partial<MapThread> & { id: string; workspaceId: string }): MapThread {
  return {
    title: partial.id,
    status: "idle",
    color: "#0ea5e9",
    position: { x: 0, y: 0 },
    ...partial,
  };
}

describe("computeColumns", () => {
  it("returns at least one column", () => {
    expect(computeColumns(100, 220, 24)).toBe(1);
  });

  it("fits columns by width", () => {
    expect(computeColumns(500, 220, 24)).toBe(2);
  });
});

describe("computeThreadLayout", () => {
  it("positions threads inside their workspace lane", () => {
    const workspace = makeWorkspace({ id: "ws1", name: "ws1" });
    const thread = makeThread({ id: "t1", workspaceId: "ws1" });
    const [positioned] = computeThreadLayout([workspace], [thread]);
    expect(positioned.position.x).toBeGreaterThanOrEqual(0);
    expect(positioned.position.y).toBe(WORKSPACE_AREA_PADDING + WORKSPACE_HEADER_HEIGHT);
  });

  it("places threads from different workspaces on separate x lanes", () => {
    const a = makeWorkspace({ id: "ws-a", name: "a" });
    const b = makeWorkspace({ id: "ws-b", name: "b" });
    const ta = makeThread({ id: "ta", workspaceId: "ws-a" });
    const tb = makeThread({ id: "tb", workspaceId: "ws-b" });
    const result = computeThreadLayout([a, b], [ta, tb]);
    const pa = result.find(t => t.id === "ta")!;
    const pb = result.find(t => t.id === "tb")!;
    expect(pa.position.x).not.toEqual(pb.position.x);
  });

  it("orders threads deterministically by title", () => {
    const ws = makeWorkspace({ id: "ws1", name: "ws1" });
    const b = makeThread({ id: "b", workspaceId: "ws1", title: "beta" });
    const a = makeThread({ id: "a", workspaceId: "ws1", title: "alpha" });
    const result = computeThreadLayout([ws], [b, a]);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("stacks cards vertically when they exceed lane width", () => {
    const ws = makeWorkspace({ id: "ws1", name: "ws1" });
    const threads: MapThread[] = [];
    for (let i = 0; i < 4; i += 1) {
      threads.push(makeThread({ id: `t${i}`, workspaceId: "ws1" }));
    }
    const result = computeThreadLayout([ws], threads);
    const firstRow = result.filter(t => t.position.y === WORKSPACE_AREA_PADDING + WORKSPACE_HEADER_HEIGHT);
    expect(firstRow.length).toBeGreaterThanOrEqual(1);
    const hasSecondRow = result.some(t => t.position.y > WORKSPACE_AREA_PADDING + WORKSPACE_HEADER_HEIGHT);
    expect(hasSecondRow).toBe(true);
  });
});

describe("computeMapBounds", () => {
  it("returns zero bounds for empty input", () => {
    expect(computeMapBounds([], [])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });

  it("includes card footprint", () => {
    const bounds = computeMapBounds([makeThread({ id: "t1", workspaceId: "ws1", position: { x: 10, y: 20 } })], []);
    expect(bounds.maxX).toBe(10 + CARD_WIDTH);
    expect(bounds.maxY).toBe(20 + CARD_HEIGHT);
  });
});

describe("buildThreadEdges", () => {
  it("creates an edge from parent to child thread", () => {
    const edges = buildThreadEdges([
      makeThread({ id: "parent", workspaceId: "ws1" }),
      makeThread({ id: "child", workspaceId: "ws1", parentId: "parent" }),
    ]);
    expect(edges).toEqual([{ from: "parent", to: "child" }]);
  });

  it("omits edges to unknown parents", () => {
    const edges = buildThreadEdges([makeThread({ id: "child", workspaceId: "ws1", parentId: "ghost" })]);
    expect(edges).toEqual([]);
  });

  it("breaks cycles", () => {
    const edges = buildThreadEdges([
      makeThread({ id: "a", workspaceId: "ws1", parentId: "b" }),
      makeThread({ id: "b", workspaceId: "ws1", parentId: "a" }),
    ]);
    expect(edges.length).toBe(1);
  });
});
