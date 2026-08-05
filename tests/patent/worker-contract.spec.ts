import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_ROLE_MAP,
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
  assert.equal(registry.list().length, 6);
  assert.equal(registry.listByTier("reasoning").length, 2);
  assert.equal(registry.listByTier("reasoning")[0].name, "patent-novelty-analyzer");
  assert.equal(registry.listByTier("reasoning")[1].name, "patent-inventiveness-analyzer");
});

test("search worker: allowedTools 含专利数据工具（修正后）", () => {
  const commander = defaultPatentWorkers().find(w => w.name === "patent-search-commander")!;
  for (const tool of ["patent_search", "patent_metadata", "patent_legal_status"]) {
    assert.ok(commander.allowedTools?.includes(tool), `${tool} 应允许检索 worker 调用`);
  }
});

test("WORKER_ROLE_MAP 覆盖全部 6 个 worker 且角色无重复", () => {
  const workers = defaultPatentWorkers().map(w => w.name);
  const mapped = WORKER_ROLE_MAP.map(e => e.worker);
  assert.deepEqual([...mapped].sort(), [...workers].sort(), "映射表应覆盖全部内置 worker");
  const roles = WORKER_ROLE_MAP.filter(e => e.role !== undefined).map(e => e.role!);
  assert.equal(new Set(roles).size, roles.length, "worker→角色映射不应重复");
  const oa = WORKER_ROLE_MAP.find(e => e.worker === "patent-oa-writer");
  assert.equal(oa?.role, undefined, "patent-oa-writer 无对应角色（显式标注）");
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

test("inventiveness worker: hard contract fields aligned with rule-gate elements", () => {
  const worker = defaultPatentWorkers().find(w => w.name === "patent-inventiveness-analyzer")!;
  assert.equal(worker.tier, "reasoning");
  assert.equal(worker.triggersHITL, true);
  const good = validateWorkerOutput(
    worker,
    "最接近的现有技术为D1；区别技术特征为X；实际解决的技术问题为T；D1结合公知常识给出技术启示；创造性结论：不具备；置信度：high",
  );
  assert.equal(good.valid, true);
  assert.equal(good.degraded, false);
  const bad = validateWorkerOutput(worker, "分析完成。");
  assert.equal(bad.valid, false);
  assert.equal(bad.degraded, true);
  assert.deepEqual(bad.missingHardFields, [
    "最接近的现有技术",
    "区别技术特征",
    "实际解决的技术问题",
    "技术启示",
    "创造性结论",
    "置信度",
  ]);
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

// ---------------------------------------------------------------------------
// 校验语义（2026-08 回退说明）：label:N / regex / format:json 的 DSL 因
// defaultPatentWorkers 零使用而回退为纯子串校验（见 worker-contract.ts 注释），
// 此处不再保留对应测试——纯子串语义由"硬性字段缺失"既有用例覆盖。
// ---------------------------------------------------------------------------
