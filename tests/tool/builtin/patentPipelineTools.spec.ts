import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  patentNoveltyManifest,
  runWorkflow,
  validateWorkflowManifest,
  WorkflowError,
} from "../../../src/patent/workflow.js";
import { PlanTaskStateMachine, replanTasks, syncPlanToTasks, hashStep } from "../../../src/patent/plantask.js";
import { WorkerRegistry, validateWorkerOutput, defaultPatentWorkers } from "../../../src/patent/worker-contract.js";
import { createPatentWorkflowTool } from "../../../src/tool/builtin/patentWorkflowTool.js";
import { createPatentPlanTaskTool } from "../../../src/tool/builtin/patentPlanTaskTool.js";
import { createPatentWorkerValidateTool } from "../../../src/tool/builtin/patentWorkerValidateTool.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

/** 从工具结果中提取文本（content 联合类型守卫）。 */
function textOf(res: { content: readonly { type: string; text?: string; value?: unknown }[] }): string {
  const first = res.content[0];
  return first.type === "text" && typeof first.text === "string" ? first.text : JSON.stringify(first.value ?? first);
}

describe("patent workflow 执行器（workflow.ts 接线）", () => {
  it("patentNoveltyManifest 通过校验", () => {
    assert.doesNotThrow(() => validateWorkflowManifest(patentNoveltyManifest));
    assert.equal(patentNoveltyManifest.id, "patent_novelty_v1");
    assert.equal(patentNoveltyManifest.stages.length, 5);
  });

  it("runWorkflow 全阶段有输出 → completed", async () => {
    const outputs = new Map([
      ["parse", "特征分解：A/B/C"],
      ["search", "检索到 D1/D2"],
      ["compare", "单独对比：D1 未公开特征 B"],
      ["conclude", "新颖性结论：具备（置信度 high）"],
      ["approval", "人工确认通过"],
    ]);
    const result = await runWorkflow(patentNoveltyManifest, {}, async stage => outputs.get(stage.id) ?? "");
    assert.equal(result.completed, true);
    assert.equal(result.degradedSteps.length, 0);
    assert.equal(result.stages.length, 5);
  });

  it("runWorkflow 缺阶段输出 → degraded 且 completed=false", async () => {
    const result = await runWorkflow(patentNoveltyManifest, {}, async () => "");
    assert.equal(result.completed, false);
    assert.equal(result.degradedSteps.length, 5);
  });

  it("validateWorkflowManifest 拒绝非法 manifest", () => {
    assert.throws(
      () =>
        validateWorkflowManifest({
          id: "x",
          name: "y",
          caseType: "z",
          stages: [{ id: "a", strategy: "bogus" as never, description: "d" }],
        }),
      WorkflowError,
    );
  });
});

describe("patent plan task 状态机（plantask.ts 接线）", () => {
  it("白名单迁移合法，非法迁移 fail-closed", () => {
    const machine = new PlanTaskStateMachine();
    machine.transition("awaiting_approval");
    machine.transition("executing");
    machine.transition("awaiting_feedback");
    machine.transition("replanning");
    machine.transition("awaiting_approval");
    machine.transition("finished");
    assert.equal(machine.state, "finished");
    assert.throws(() => machine.transition("planning"), /非法状态迁移/);
  });

  it("syncPlanToTasks 建立顺序依赖", () => {
    const result = syncPlanToTasks(["解析", "检索", "对比"]);
    assert.equal(result.tasks.length, 3);
    assert.deepEqual(result.tasks[1].blockedBy, ["task-1"]);
    assert.equal(result.toRun.length, 3);
  });

  it("replanTasks 哈希比对保留已完成步骤", () => {
    const first = syncPlanToTasks(["解析", "检索", "对比"]);
    const completed = first.tasks.map(t => ({ ...t, status: "completed" as const }));
    const replan = replanTasks(completed, ["解析", "检索", "对比", "结论"]);
    assert.equal(replan.preserved.length, 3);
    assert.deepEqual(replan.toRun, ["task-4"]);
  });

  it("hashStep 确定性", () => {
    assert.equal(hashStep("解析"), hashStep("解析"));
    assert.notEqual(hashStep("解析"), hashStep("检索"));
  });
});

describe("worker 契约（worker-contract.ts 接线）", () => {
  it("defaultPatentWorkers 注册完备（verify 无缺陷）", () => {
    const registry = new WorkerRegistry();
    for (const w of defaultPatentWorkers()) {
      registry.register(w);
    }
    assert.deepEqual(registry.verify(), []);
    assert.equal(registry.list().length, 5);
  });

  it("validateWorkerOutput 硬性字段缺失 → degraded", () => {
    const worker = defaultPatentWorkers().find(w => w.name === "patent-novelty-analyzer")!;
    const bad = validateWorkerOutput(worker, "分析报告，缺结论");
    assert.equal(bad.valid, false);
    assert.equal(bad.degraded, true);
    assert.ok(bad.missingHardFields.includes("新颖性结论"));
    const good = validateWorkerOutput(worker, "新颖性结论：具备；置信度：high");
    assert.equal(good.valid, true);
  });
});

describe("管线工具注册与执行（patent_workflow / patent_plan_task / patent_worker_validate）", () => {
  it("createBuiltinRegistry 注册三个接线工具（domain: patent）", () => {
    const registry = createBuiltinRegistry({});
    for (const name of ["patent_workflow", "patent_plan_task", "patent_worker_validate"]) {
      const tool = registry.get(name);
      assert.ok(tool, `${name} 应已注册`);
      assert.equal(tool!.domain, "patent", `${name} 应标注 patent domain`);
    }
  });

  it("patent_workflow 工具：全阶段输出 → completed 摘要", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        outputs: ["parse", "search", "compare", "conclude", "approval"].map(stageId => ({
          stageId,
          text: `阶段 ${stageId} 输出`,
        })),
      },
      {} as never,
    );
    const text = textOf(res);
    assert.ok(text.includes("patent_workflow(patent_novelty_v1)"));
    assert.ok(text.includes("5/5 阶段完成"));
    assert.ok(text.includes("completed"));
  });

  it("patent_workflow 工具：缺阶段输出 → 降级标注", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute({ outputs: [] }, {} as never);
    const text = textOf(res);
    assert.ok(text.includes("降级"));
    assert.ok(text.includes("incomplete"));
  });

  it("patent_workflow 工具：未知 manifestId fail-closed", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute({ manifestId: "no_such_manifest", outputs: [] }, {} as never);
    assert.ok(textOf(res).includes("未知 manifest"), `应返回未知 manifest 提示: ${textOf(res)}`);
  });

  it("patent_plan_task 工具：非法迁移返回错误而非抛错", async () => {
    const tool = createPatentPlanTaskTool();
    const res = await tool.execute({ action: "transition", currentState: "finished", to: "planning" }, {} as never);
    assert.ok(textOf(res).includes("非法状态迁移"));
  });

  it("patent_plan_task 工具：非法状态字符串 fail-closed（不抛 TypeError）", async () => {
    const tool = createPatentPlanTaskTool();
    const res = await tool.execute({ action: "transition", currentState: "bogus_state", to: "executing" }, {} as never);
    assert.ok(textOf(res).includes("非法状态"), `应返回非法状态提示: ${textOf(res)}`);
  });

  it("patent_plan_task 工具：未知 action fail-closed（不返回 undefined）", async () => {
    const tool = createPatentPlanTaskTool();
    const res = await tool.execute({ action: "fly_to_moon" as never }, {} as never);
    assert.ok(textOf(res).includes("未知操作"), `应返回未知操作提示: ${textOf(res)}`);
  });

  it("patent_worker_validate 工具：契约校验结果", async () => {
    const tool = createPatentWorkerValidateTool();
    const ok = await tool.execute(
      { workerName: "patent-novelty-analyzer", outputText: "新颖性结论：具备；置信度：high" },
      {} as never,
    );
    assert.ok(textOf(ok).includes("通过"));
    const bad = await tool.execute({ workerName: "patent-novelty-analyzer", outputText: "缺字段" }, {} as never);
    assert.ok(textOf(bad).includes("降级"));
  });

  it("patent_worker_validate 工具：未知 workerName fail-closed", async () => {
    const tool = createPatentWorkerValidateTool();
    const res = await tool.execute({ workerName: "no_such_worker", outputText: "x" }, {} as never);
    assert.ok(textOf(res).includes("未知 worker"), `应返回未知 worker 提示: ${textOf(res)}`);
  });
});
