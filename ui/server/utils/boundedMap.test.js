// @vitest-environment node
import { describe, expect, it } from "vitest";

import { setBounded } from "./boundedMap.js";

// ---------------------------------------------------------------------------
// #529 — the four router-dashboard caches in sati-bridge.js were unbounded (keys
// come from historical sessions with no "session ended" hook). They are capped
// via setBounded with the same MAX_ACTIVE_SESSIONS bound already used for
// sessionState. The helper lives in a dependency-free leaf so it is unit-testable
// without pulling in express / the gateway bridge.
// ---------------------------------------------------------------------------

describe("setBounded", () => {
  it("caps size at the limit and evicts the oldest-inserted keys (FIFO)", () => {
    const map = new Map();
    for (let i = 0; i < 600; i += 1) setBounded(map, `s${i}`, i, 500);
    // Negative control: without the cap this would be 600.
    expect(map.size).toBe(500);
    expect(map.has("s0")).toBe(false); // oldest evicted
    expect(map.has("s99")).toBe(false); // first 100 evicted
    expect(map.has("s100")).toBe(true); // newest 500 retained
    expect(map.has("s599")).toBe(true);
    expect(map.get("s599")).toBe(599);
  });

  it("honours the MAX_ACTIVE_SESSIONS bound (500) used by the bridge caches", () => {
    const map = new Map();
    for (let i = 0; i < 600; i += 1) setBounded(map, `s${i}`, i, 500);
    expect(map.size).toBe(500);
    expect(map.has("s0")).toBe(false);
    expect(map.has("s599")).toBe(true);
  });

  it("re-setting an existing key refreshes recency without growing size", () => {
    const map = new Map();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    expect(map.size).toBe(2);
    // Touch "a" so it becomes the newest; inserting "c" must evict "b", not "a".
    setBounded(map, "a", 11, 2);
    expect(map.size).toBe(2);
    setBounded(map, "c", 3, 2);
    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(true);
    expect(map.get("a")).toBe(11);
    expect(map.has("b")).toBe(false);
    expect(map.has("c")).toBe(true);
  });

  it("preserves cache-hit behaviour (a repeated key stays readable)", () => {
    const map = new Map();
    setBounded(map, "k", { result: "v", mtime: 1 }, 500);
    setBounded(map, "k", { result: "v2", mtime: 2 }, 500);
    expect(map.size).toBe(1);
    expect(map.get("k")).toEqual({ result: "v2", mtime: 2 });
  });

  it("honours a small limit and returns the same map for chaining", () => {
    const map = new Map();
    const returned = setBounded(map, "x", 1, 1);
    expect(returned).toBe(map);
    setBounded(map, "y", 2, 1);
    expect(map.size).toBe(1);
    expect(map.has("x")).toBe(false);
    expect(map.has("y")).toBe(true);
  });
});
