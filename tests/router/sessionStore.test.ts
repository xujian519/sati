import test from "node:test";
import assert from "node:assert/strict";
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";
import { SessionUsageCache } from "../../src/router/session/sessionUsageCache.js";

test("SessionRouterStore evicts least-recently-used entries beyond capacity", () => {
  let now = 0;
  const store = new SessionRouterStore({ capacity: 2, ttlMs: 1_000_000, now: () => now });
  store.set({ sessionId: "a", isSubagent: false, orchestrating: false, updatedAt: now });
  store.set({ sessionId: "b", isSubagent: false, orchestrating: false, updatedAt: now });
  store.set({ sessionId: "c", isSubagent: false, orchestrating: false, updatedAt: now });
  assert.equal(store.size(), 2);
  assert.equal(store.get("a", false), undefined);
  assert.ok(store.get("b", false));
  assert.ok(store.get("c", false));
});

test("SessionRouterStore expires stale entries by ttl", () => {
  let now = 0;
  const store = new SessionRouterStore({ capacity: 10, ttlMs: 100, now: () => now });
  store.set({ sessionId: "a", isSubagent: false, orchestrating: false, updatedAt: now });
  now = 50;
  assert.ok(store.get("a", false));
  now = 200;
  assert.equal(store.get("a", false), undefined);
});

test("SessionRouterStore distinguishes main vs subagent sessions", () => {
  const store = new SessionRouterStore({ capacity: 10 });
  store.set({ sessionId: "x", isSubagent: false, orchestrating: false, updatedAt: 0, tokenSaverTier: "main" });
  store.set({ sessionId: "x", isSubagent: true, orchestrating: false, updatedAt: 0, tokenSaverTier: "sub" });
  assert.equal(store.get("x", false)?.tokenSaverTier, "main");
  assert.equal(store.get("x", true)?.tokenSaverTier, "sub");
});

test("SessionUsageCache observes most recent usage", () => {
  const cache = new SessionUsageCache(2);
  cache.observe("a", { inputTokens: 10, outputTokens: 20 });
  cache.observe("b", { inputTokens: 30 });
  cache.observe("c", { inputTokens: 40 });
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b")?.inputTokens, 30);
  assert.equal(cache.get("c")?.inputTokens, 40);
});
