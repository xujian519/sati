import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkerMonitor,
  WorkerRegistry,
  WorkerRegistryError,
  defaultPatentWorkers,
  validateWorkerOutput,
} from "../../src/patent/worker-contract.js";

test("registry registers patent workers and verifies contract completeness", () => {
  const registry = new WorkerRegistry();
  for (const w of defaultPatentWorkers()) registry.register(w);
  const issues = registry.verify();
  assert.deepEqual(issues, [], "all default patent workers should pass verification");
  assert.equal(registry.list().length, 5);
  assert.equal(registry.listByTier("reasoning").length, 1);
  assert.equal(registry.listByTier("reasoning")[0].name, "patent-novelty-analyzer");
});

test("registry rejects duplicate registration and incomplete definitions", () => {
  const registry = new WorkerRegistry();
  const w = defaultPatentWorkers()[0];
  registry.register(w);
  assert.throws(() => registry.register(w), WorkerRegistryError);
  assert.throws(() => registry.register({ name: "x", tier: "work", description: "" }), WorkerRegistryError);
});

test("lazy activation: preRegister=false workers are inactive until activated", () => {
  const registry = new WorkerRegistry();
  registry.register({ name: "lazy-worker", tier: "checker", description: "懒激活 worker", preRegister: false });
  assert.equal(registry.isActive("lazy-worker"), false);
  registry.activate("lazy-worker");
  assert.equal(registry.isActive("lazy-worker"), true);
});

test("validateWorkerOutput marks degraded on missing hard fields", () => {
  const novelty = defaultPatentWorkers().find(w => w.name === "patent-novelty-analyzer")!;
  const ok = validateWorkerOutput(novelty, "新颖性结论：具备。置信度：0.8。");
  assert.equal(ok.valid, true);
  assert.equal(ok.degraded, false);
  const bad = validateWorkerOutput(novelty, "分析完成。");
  assert.equal(bad.valid, false);
  assert.equal(bad.degraded, true);
  assert.deepEqual(bad.missingHardFields, ["新颖性结论", "置信度"]);
  assert.match(bad.degradationReason ?? "", /硬性契约字段缺失/);
});

test("monitor aggregates success rate and degradation counts", () => {
  const monitor = new WorkerMonitor();
  monitor.record({
    workerName: "patent-novelty-analyzer",
    inputValid: true,
    outputValid: true,
    degraded: false,
    startedAt: 0,
    durationMs: 100,
  });
  monitor.record({
    workerName: "patent-novelty-analyzer",
    inputValid: true,
    outputValid: false,
    degraded: true,
    startedAt: 0,
    durationMs: 200,
  });
  const stats = monitor.stats();
  assert.equal(stats["patent-novelty-analyzer"].runs, 2);
  assert.equal(stats["patent-novelty-analyzer"].successRate, 0.5);
  assert.equal(stats["patent-novelty-analyzer"].degradedCount, 1);
  assert.match(monitor.summary(), /patent-novelty-analyzer/);
});
