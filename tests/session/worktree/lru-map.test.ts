import test from "node:test";
import assert from "node:assert/strict";
import { LRUMap } from "../../../src/session/worktree/LRUMap.js";

test("LRUMap evicts oldest entry on capacity overflow", () => {
  const lru = new LRUMap<string, number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("c", 3);
  assert.equal(lru.has("a"), false);
  assert.equal(lru.get("b"), 2);
  assert.equal(lru.get("c"), 3);
  assert.equal(lru.size, 2);
});

test("LRUMap refreshes recency on get", () => {
  const lru = new LRUMap<string, number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  // touching `a` makes `b` the oldest.
  assert.equal(lru.get("a"), 1);
  lru.set("c", 3);
  assert.equal(lru.has("a"), true);
  assert.equal(lru.has("b"), false);
  assert.equal(lru.get("c"), 3);
});

test("LRUMap re-set keeps key but moves to tail", () => {
  const lru = new LRUMap<string, number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("a", 11);
  lru.set("c", 3);
  assert.equal(lru.get("a"), 11);
  assert.equal(lru.has("b"), false);
  assert.equal(lru.get("c"), 3);
});

test("LRUMap rejects non-positive capacity", () => {
  assert.throws(() => new LRUMap(0), /capacity must be positive/);
  assert.throws(() => new LRUMap(-1), /capacity must be positive/);
});
