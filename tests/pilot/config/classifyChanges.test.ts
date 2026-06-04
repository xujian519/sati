import test from "node:test";
import assert from "node:assert/strict";

import { diffConfigSnapshots, classifyConfigChanges } from "../../../src/pilot/config/classifyChanges.js";
import type { PilotConfigSnapshot } from "../../../src/pilot/config/types.js";

function makeSnapshot(config: Record<string, unknown>): PilotConfigSnapshot {
  return {
    version: 1,
    schemaVersion: 1,
    loadedAt: new Date(),
    contentHash: "",
    sources: [],
    diagnostics: [],
    config,
  } as unknown as PilotConfigSnapshot;
}

// ---------- Array deep comparison ----------

test("identical arrays with different references produce no diff", () => {
  const prev = makeSnapshot({ items: { list: ["a", "b", "c"] } });
  const next = makeSnapshot({ items: { list: ["a", "b", "c"] } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), []);
});

test("empty arrays with different references produce no diff", () => {
  const prev = makeSnapshot({ items: { list: [] } });
  const next = makeSnapshot({ items: { list: [] } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), []);
});

test("arrays with different lengths report change", () => {
  const prev = makeSnapshot({ items: { list: ["a", "b"] } });
  const next = makeSnapshot({ items: { list: ["a", "b", "c"] } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["items.list"]);
});

test("arrays with different elements report change", () => {
  const prev = makeSnapshot({ items: { list: ["a", "b"] } });
  const next = makeSnapshot({ items: { list: ["a", "x"] } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["items.list[1]"]);
});

test("nested objects inside arrays are deeply compared", () => {
  const prev = makeSnapshot({
    rules: { entries: [{ name: "r1", val: 1 }, { name: "r2", val: 2 }] },
  });
  const next = makeSnapshot({
    rules: { entries: [{ name: "r1", val: 1 }, { name: "r2", val: 2 }] },
  });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), []);
});

test("nested object change inside array is reported at element path", () => {
  const prev = makeSnapshot({
    rules: { entries: [{ name: "r1", val: 1 }] },
  });
  const next = makeSnapshot({
    rules: { entries: [{ name: "r1", val: 99 }] },
  });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["rules.entries[0].val"]);
});

// ---------- Simulates the exact fields from issue #147 ----------

test("config with identical default arrays produces no diff (issue #147 scenario)", () => {
  const makeConfig = () => ({
    alwaysOn: {
      dormancy: {
        ignoreGlobs: ["**/.git/**", "**/node_modules/**"],
      },
    },
    router: {
      autoOrchestrate: {
        allowedTools: ["agent", "read_file", "grep"],
        triggerTiers: ["complex"],
      },
      tokenSaver: {
        rules: ["rule1", "rule2"],
      },
      fallback: {
        default: [
          { id: "p/m", provider: "p", model: "m" },
        ],
      },
    },
    model: {
      providers: {
        p1: {
          models: {
            m1: {
              multimodal: { input: ["text", "image"] },
            },
          },
        },
      },
    },
  });

  const prev = makeSnapshot(makeConfig());
  const next = makeSnapshot(makeConfig());
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), []);
});

// ---------- Object diff regression tests ----------

test("identical plain objects produce no diff", () => {
  const prev = makeSnapshot({ agent: { model: "a/b" } });
  const next = makeSnapshot({ agent: { model: "a/b" } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), []);
});

test("changed primitive value is reported", () => {
  const prev = makeSnapshot({ agent: { model: "a/b" } });
  const next = makeSnapshot({ agent: { model: "a/c" } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["agent.model"]);
});

test("added top-level key is reported", () => {
  const prev = makeSnapshot({ agent: { model: "a/b" } });
  const next = makeSnapshot({ agent: { model: "a/b" }, router: { enabled: true } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["router"]);
});

test("removed top-level key is reported", () => {
  const prev = makeSnapshot({ agent: { model: "a/b" }, router: { enabled: true } });
  const next = makeSnapshot({ agent: { model: "a/b" } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["router"]);
});

// ---------- Edge cases ----------

test("array vs non-array reports change", () => {
  const prev = makeSnapshot({ items: { list: ["a"] } });
  const next = makeSnapshot({ items: { list: "a" } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["items.list"]);
});

test("non-array vs array reports change", () => {
  const prev = makeSnapshot({ items: { list: "a" } });
  const next = makeSnapshot({ items: { list: ["a"] } });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), ["items.list"]);
});

test("same reference returns no diff (Object.is fast path)", () => {
  const shared = { model: "a/b", tags: ["x", "y"] };
  const prev = makeSnapshot({ agent: shared });
  const next = makeSnapshot({ agent: shared });
  assert.deepStrictEqual(diffConfigSnapshots(prev, next), []);
});

// ---------- classifyConfigChanges ----------

test("classifyConfigChanges maps paths to correct classes", () => {
  const classes = classifyConfigChanges([
    "agent.model",
    "alwaysOn.dormancy.ignoreGlobs",
    "router.stats.enabled",
  ]);
  assert.ok(classes.includes("next-request"));
  assert.ok(classes.includes("next-runtime"));
  assert.ok(classes.includes("restart-required"));
});
