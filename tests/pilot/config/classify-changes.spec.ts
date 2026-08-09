import test from "node:test";
import assert from "node:assert/strict";
import { diffConfigSnapshots, classifyConfigChanges } from "../../../src/pilot/config/classifyChanges.js";
import type { PilotConfig, PilotConfigSnapshot } from "../../../src/pilot/config/types.js";

function snapshot(config: Record<string, unknown>): PilotConfigSnapshot {
  return { config: config as unknown as PilotConfig } as PilotConfigSnapshot;
}

test("diffConfigSnapshots returns no changes for identical configs", () => {
  const config = { agent: { model: "grok" }, port: 1 };
  assert.deepEqual(diffConfigSnapshots(snapshot(config), snapshot({ ...config })), []);
});

test("diffConfigSnapshots reports scalar changes by path", () => {
  const changes = diffConfigSnapshots(snapshot({ agent: { model: "a" } }), snapshot({ agent: { model: "b" } }));
  assert.deepEqual(changes, ["agent.model"]);
});

test("diffConfigSnapshots reports added and removed keys", () => {
  const added = diffConfigSnapshots(snapshot({ a: 1 }), snapshot({ a: 1, b: 2 }));
  assert.deepEqual(added, ["b"]);
  const removed = diffConfigSnapshots(snapshot({ a: 1, b: 2 }), snapshot({ a: 1 }));
  assert.deepEqual(removed, ["b"]);
});

test("diffConfigSnapshots reports array changes with index paths", () => {
  const lenChange = diffConfigSnapshots(snapshot({ list: [1, 2] }), snapshot({ list: [1, 2, 3] }));
  assert.deepEqual(lenChange, ["list"]);
  const itemChange = diffConfigSnapshots(snapshot({ list: [1, 2] }), snapshot({ list: [1, 9] }));
  assert.deepEqual(itemChange, ["list[1]"]);
});

test("diffConfigSnapshots falls back to root for non-object mismatches", () => {
  assert.deepEqual(diffConfigSnapshots(snapshot({ a: 1 }), snapshot({ a: "x" })), ["a"]);
  assert.deepEqual(diffConfigSnapshots(snapshot({ nested: { deep: 1 } }), snapshot({ nested: "flat" })), ["nested"]);
});

test("classifyConfigChanges maps agent and model paths to next-request", () => {
  assert.deepEqual(classifyConfigChanges(["agent.model", "model.provider"]), ["next-request"]);
});

test("classifyConfigChanges maps extension paths", () => {
  assert.deepEqual(classifyConfigChanges(["extension.includeHookEvents"]), ["runtime-live"]);
  assert.deepEqual(classifyConfigChanges(["extension.skills"]), ["next-runtime"]);
});

test("classifyConfigChanges maps router sub-paths", () => {
  assert.deepEqual(classifyConfigChanges(["router.scenarios.default"]), ["next-request"]);
  assert.deepEqual(classifyConfigChanges(["router.fallback.model"]), ["next-request"]);
  assert.deepEqual(classifyConfigChanges(["router.tokenSaver.tiers.t0"]), ["next-request"]);
  assert.deepEqual(classifyConfigChanges(["router.zeroUsageRetry.enabled"]), ["next-request"]);
  assert.deepEqual(classifyConfigChanges(["router.tokenSaver.judge.model"]), ["runtime-live"]);
  assert.deepEqual(classifyConfigChanges(["router.autoOrchestrate.skillExtensionId"]), ["next-runtime"]);
  assert.deepEqual(classifyConfigChanges(["router.stats.enabled"]), ["restart-required"]);
  assert.deepEqual(classifyConfigChanges(["router.customRouter.extensionId"]), ["restart-required"]);
  assert.deepEqual(classifyConfigChanges(["router.other.thing"]), ["next-runtime"]);
});

test("classifyConfigChanges maps alwaysOn/cron/tools/proxy and defaults", () => {
  assert.deepEqual(classifyConfigChanges(["alwaysOn.enabled"]), ["next-runtime"]);
  assert.deepEqual(classifyConfigChanges(["cron.schedule"]), ["next-runtime"]);
  assert.deepEqual(classifyConfigChanges(["tools.paperSearch.enabled"]), ["next-runtime"]);
  assert.deepEqual(classifyConfigChanges(["proxy.url"]), ["runtime-live"]);
  assert.deepEqual(classifyConfigChanges(["unknown.top"]), ["next-runtime"]);
});

test("classifyConfigChanges deduplicates classes", () => {
  const classes = classifyConfigChanges(["agent.model", "model.provider", "router.fallback.model"]);
  assert.deepEqual(classes, ["next-request"]);
});
