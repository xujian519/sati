import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  JsonFileManifestCheckpointStore,
  WorkerMonitor,
  registerBuiltinAtoms,
  runWorkflow,
  type StageProvider,
  type WorkflowManifest,
} from "../../src/patent/index.js";

/**
 * T9/T10 测试（docs/patent-drafting-sop-plan.md 迭代三）：
 * - T9 worker 契约接入执行引擎：stage.worker 命中 defaultPatentWorkers 时
 *   validateWorkerOutput 校验产出，结果附 workerValidation（不改变 degraded 判定），
 *   WorkerMonitor 记录真实运行。
 * - T10 manifest 路径断点续跑：中断后 checkpoint 保存，resume 跳过已完成阶段
 *   （LLM 副作用不重放），配合 approvalGrants 放行审批门后继续。
 */

const resumeManifest: WorkflowManifest = {
  id: "resume_test_v1",
  name: "resume 测试",
  caseType: "drafting",
  stages: [
    {
      id: "extract_features",
      strategy: "chain",
      description: "提取特征",
      atom: "extract",
      params: { extraction_type: "提取技术特征", output_key: "features" },
    },
    {
      id: "deconstruct_gate",
      strategy: "chain",
      description: "确认解构",
      atom: "approval-gate",
      params: { review_context: "确认特征清单" },
    },
    {
      id: "report",
      strategy: "chain",
      description: "汇总报告",
      atom: "reasoning",
      params: { reasoning_prompt: "基于特征汇总报告" },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
};

/** 计数 callLLM 的 provider（断言 resume 不重放 LLM 副作用）。 */
function countingProvider(calls: { llm: number }): StageProvider {
  return {
    callLLM: async prompt => {
      calls.llm += 1;
      if (prompt.includes("提取")) {
        return JSON.stringify({ features: ["特征A"] });
      }
      return "汇总报告输出";
    },
  };
}

// ---------------------------------------------------------------------------
// T10: 断点续跑
// ---------------------------------------------------------------------------

test("T10: 中断后 checkpoint 保存，resume 跳过已完成阶段（LLM 不重放）", async () => {
  registerBuiltinAtoms();
  const calls = { llm: 0 };
  const dir = mkdtempSync(join(tmpdir(), "sati-ckpt-"));
  try {
    const store = new JsonFileManifestCheckpointStore(dir);
    // 第一次运行：extract 执行 → 审批门中断
    const first = await runWorkflow(resumeManifest, { text: "交底书" }, async () => "透传", {
      provider: countingProvider(calls),
      runId: "caseX__resume_test_v1",
      checkpointStore: store,
    });
    assert.equal(first.completed, false);
    assert.equal(first.interrupted?.stageId, "deconstruct_gate");
    assert.equal(calls.llm, 1, "首次运行 extract 调用 1 次 LLM");
    assert.equal(first.stages.length, 1);

    // resume（不批准）：extract 不重跑，仍在 gate 中断
    const checkpoint = await store.load("caseX__resume_test_v1");
    assert.ok(checkpoint, "检查点应已持久化");
    assert.equal(checkpoint!.stageIndex, 1);
    const resumed = await runWorkflow(resumeManifest, { text: "交底书" }, async () => "透传", {
      provider: countingProvider(calls),
      runId: "caseX__resume_test_v1",
      checkpointStore: store,
      resumeFrom: checkpoint,
    });
    assert.equal(resumed.completed, false);
    assert.equal(resumed.interrupted?.stageId, "deconstruct_gate");
    assert.equal(calls.llm, 1, "resume 不应重放 extract（LLM 计数不变）");
    assert.equal(resumed.stages.length, 1, "resume 结果只含已恢复的 extract 阶段");
    assert.equal(resumed.stages[0]!.stageId, "extract_features");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T10: resume + approvalGrants 放行审批门后继续至完成", async () => {
  registerBuiltinAtoms();
  const calls = { llm: 0 };
  const dir = mkdtempSync(join(tmpdir(), "sati-ckpt-"));
  try {
    const store = new JsonFileManifestCheckpointStore(dir);
    const first = await runWorkflow(resumeManifest, { text: "交底书" }, async () => "透传", {
      provider: countingProvider(calls),
      runId: "caseY__resume_test_v1",
      checkpointStore: store,
    });
    assert.equal(first.interrupted?.stageId, "deconstruct_gate");

    // resume + 批准 gate：extract 不重跑 → gate 放行 → report 执行 → 完成
    const checkpoint = await store.load("caseY__resume_test_v1");
    const resumed = await runWorkflow(resumeManifest, { text: "交底书" }, async () => "透传", {
      provider: countingProvider(calls),
      runId: "caseY__resume_test_v1",
      checkpointStore: store,
      resumeFrom: checkpoint,
      approvalGrants: ["deconstruct_gate"],
    });
    assert.equal(resumed.completed, true, "放行审批门后应完成");
    assert.equal(calls.llm, 2, "resume 后仅 report 调用 1 次 LLM（extract 不重放）");
    const gate = resumed.stages.find(s => s.stageId === "deconstruct_gate");
    assert.equal(gate?.output, "APPROVED", "已批准审批门放行输出占位 APPROVED");
    const report = resumed.stages.find(s => s.stageId === "report");
    assert.ok(report, "report 阶段应执行");
    assert.equal(report!.degraded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T10: JsonFileManifestCheckpointStore 文件往返", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-ckpt-"));
  try {
    const store = new JsonFileManifestCheckpointStore(dir);
    await store.save({
      id: "r1",
      manifestId: "m1",
      stageIndex: 2,
      completedStages: [{ stageId: "a", strategy: "chain", output: "A", degraded: false, retries: 0 }],
      state: { features: ["F1"] },
      approvalGrants: [],
      updatedAt: new Date().toISOString(),
    });
    const loaded = await store.load("r1");
    assert.equal(loaded?.stageIndex, 2);
    assert.deepEqual(loaded?.state, { features: ["F1"] });
    assert.equal(await store.load("missing"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T9: worker 契约接入执行引擎
// ---------------------------------------------------------------------------

const workerManifest: WorkflowManifest = {
  id: "worker_test_v1",
  name: "worker 契约测试",
  caseType: "drafting",
  stages: [
    {
      id: "search",
      strategy: "react",
      description: "检索",
      atom: "search",
      worker: "patent-search-commander",
    },
  ],
  validation: { requireAllSteps: true },
};

test("T9: stage.worker 命中契约时产出校验附 workerValidation（不改变 degraded）", async () => {
  registerBuiltinAtoms();
  const provider: StageProvider = {
    search: async () => [{ title: "D1", snippet: "摘要", url: "https://e/1" }],
  };
  const result = await runWorkflow(workerManifest, { text: "x", query: "保温容器" }, async () => "透传", { provider });
  const stage = result.stages.find(s => s.stageId === "search")!;
  assert.ok(stage, "search 阶段应执行");
  // patent-search-commander 硬契约：检索式/对比文件/公开日 —— mock 摘要不含 → invalid
  assert.equal(stage.workerValidation?.workerName, "patent-search-commander");
  assert.equal(stage.workerValidation?.valid, false);
  assert.ok(stage.workerValidation!.missingHardFields.includes("检索式"));
  assert.ok(stage.workerValidation!.missingHardFields.includes("对比文件"));
  assert.ok(stage.workerValidation!.missingHardFields.includes("公开日"));
  // 契约校验仅提示：不改变 degraded 判定
  assert.equal(stage.degraded, false, "worker 契约缺失不应使阶段降级");
});

test("T9: 满足契约的产出校验通过（valid=true）", async () => {
  registerBuiltinAtoms();
  // 无 atom 阶段走 executor：输出包含全部硬契约字段。
  const manifest: WorkflowManifest = {
    id: "worker_ok_v1",
    name: "worker 契约通过",
    caseType: "drafting",
    stages: [{ id: "search", strategy: "chain", description: "检索", worker: "patent-search-commander" }],
    validation: { requireAllSteps: true },
  };
  const executor = async (): Promise<string> =>
    "检索式: (保温 AND 真空) OR IPC=G06F3/04\n对比文件: CN1234567A，公开日: 2020-01-01";
  const result = await runWorkflow(manifest, { text: "x" }, executor, {});
  const stage = result.stages[0]!;
  assert.equal(stage.workerValidation?.valid, true, "含全部 requiredFields 应通过");
  assert.deepEqual(stage.workerValidation?.missingHardFields, []);
});

test("T9: WorkerMonitor 记录 worker 执行统计", async () => {
  registerBuiltinAtoms();
  const provider: StageProvider = {
    search: async () => [{ title: "D1", snippet: "摘要", url: "https://e/1" }],
  };
  const monitor = new WorkerMonitor();
  await runWorkflow(workerManifest, { text: "x", query: "保温容器" }, async () => "透传", { provider, monitor });
  const stats = monitor.stats();
  const search = stats["patent-search-commander"];
  assert.ok(search, "monitor 应记录 patent-search-commander");
  assert.equal(search.runs, 1);
  assert.equal(search.successRate, 0, "契约缺失记录为失败");
  assert.equal(search.degradedCount, 1);
});

test("T9: 未命中契约目录的 worker 声明静默跳过（不校验不报错）", async () => {
  registerBuiltinAtoms();
  const manifest: WorkflowManifest = {
    id: "worker_unknown_v1",
    name: "未知 worker",
    caseType: "drafting",
    stages: [{ id: "s1", strategy: "chain", description: "未知", worker: "no-such-worker" }],
    validation: { requireAllSteps: true },
  };
  const result = await runWorkflow(manifest, { text: "x" }, async () => "输出", {});
  assert.equal(result.stages[0]!.workerValidation, undefined, "未命中契约不校验");
  assert.equal(result.completed, true);
});
