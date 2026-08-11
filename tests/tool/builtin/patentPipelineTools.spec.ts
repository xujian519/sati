import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToolContext } from "../context-fixture.js";
import {
  JsonFileWorkflowRunStore,
  patentInventivenessManifest,
  patentNoveltyManifest,
  runWorkflow,
  validateWorkflowManifest,
  WorkflowError,
} from "../../../src/patent/index.js";
import { PlanTaskStateMachine, replanTasks, syncPlanToTasks, hashStep } from "../../../src/patent/plantask.js";
import { WorkerRegistry, validateWorkerOutput, defaultPatentWorkers } from "../../../src/patent/worker-contract.js";
import { createPatentWorkflowTool, runRuleGate } from "../../../src/tool/builtin/patentWorkflowTool.js";
import { createPatentPlanTaskTool } from "../../../src/tool/builtin/patentPlanTaskTool.js";
import { createPatentWorkerValidateTool } from "../../../src/tool/builtin/patentWorkerValidateTool.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

/** 从工具结果中提取文本（content 联合类型守卫）。 */
function textOf(res: { content: readonly { type: string; text?: string; value?: unknown }[] }): string {
  const first = res.content[0];
  return first.type === "text" && typeof first.text === "string" ? first.text : JSON.stringify(first.value ?? first);
}

/**
 * 合规创造性产出（八阶段文本，拼接后须满足 patent_inventiveness 域全部 9 条规则：
 * 三步法/实际解决技术问题/公知常识路径/多文件结合/技术启示/惯用手段/用途限定/预料不到效果）。
 * 若新增 patent_inventiveness 域规则，需在此文本补充对应要素，否则判定会从通过变为阻断。
 */
const INVENTIVENESS_COMPLIANT_OUTPUTS: { stageId: string; text: string }[] = [
  { stageId: "parse", text: "解析权利要求1，构建所属领域技术人员画像，申请日 2025-01-01。" },
  { stageId: "search", text: "检索到对比文件D1、D2，D1为最接近的现有技术候选。" },
  { stageId: "closest", text: "最接近的现有技术为对比文件D1（技术领域相同、技术问题相关、发明构思最接近）。" },
  {
    stageId: "diff",
    text: "权利要求1相对于D1的区别技术特征为特征X，基于区别技术特征，发明实际解决的技术问题为T。",
  },
  {
    stageId: "hint",
    text: "技术启示判断：特征X属于公知常识/惯用技术手段，本领域技术人员众所周知，无需创造性劳动即可显而易见地获得该发明；D2亦给出结合启示，多篇对比文件结合具有组合动机。",
  },
  {
    stageId: "secondary",
    text: "辅助判断因素：发明产生了预料不到的有益效果，属于创造性的辅助判断因素；用途特征不影响产品结构本身的创造性判断。",
  },
  {
    stageId: "conclude",
    text: "创造性结论：权利要求1不具备创造性（置信度 high）。反事后诸葛亮自检：未使用申请日后知识。",
  },
  { stageId: "approval", text: "人工确认：结论属实，通过。" },
];

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
  it("白名单迁移合法（含语义前置条件），非法迁移 fail-closed", () => {
    const machine = new PlanTaskStateMachine();
    machine.transition("awaiting_approval");
    machine.transition("executing", { tasks: syncPlanToTasks(["解析"]).tasks });
    machine.transition("awaiting_feedback");
    machine.transition("replanning", { feedback: "补充检索" });
    machine.transition("awaiting_approval");
    machine.transition("finished");
    assert.equal(machine.state, "finished");
    assert.throws(() => machine.transition("planning"), /非法状态迁移/);
  });

  it("语义强制：executing 无任务 / replanning 无反馈 fail-closed", () => {
    const sm = new PlanTaskStateMachine("awaiting_approval");
    assert.throws(() => sm.transition("executing"), /executing 前必须先 sync/);
    const rf = new PlanTaskStateMachine("awaiting_feedback");
    assert.throws(() => rf.transition("replanning"), /replanning 必须有反馈/);
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
    assert.equal(registry.list().length, 6);
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
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("patent_workflow(patent_novelty_v1)"));
    assert.ok(text.includes("5/5 阶段完成"));
    assert.ok(text.includes("completed"));
  });

  it("patent_workflow 工具：缺阶段输出 → 降级标注", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute({ outputs: [] }, makeToolContext());
    const text = textOf(res);
    assert.ok(text.includes("降级"));
    assert.ok(text.includes("incomplete"));
  });

  it("patent_workflow 工具：未知 manifestId fail-closed", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute({ manifestId: "no_such_manifest", outputs: [] }, makeToolContext());
    assert.ok(textOf(res).includes("未知 manifest"), `应返回未知 manifest 提示: ${textOf(res)}`);
  });

  it("patent_workflow 工具：确定性门——合规新颖性产出 → ✅ 通过", async () => {
    // 注意：本文本须满足 patent_novelty 域全部 17 条规则（基础新颖性/特征覆盖、
    // 优先权×4/公开方式×5/推理模式：四相同、公开方式、抵触申请、优先权）。
    // 若新增 patent_novelty 域规则，需在此文本补充对应要素，否则判定会从通过变为阻断。
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        checkDomain: "patent_novelty",
        outputs: [
          { stageId: "parse", text: "解析技术交底书，逐项列出权利要求1的技术特征A/B/C。" },
          {
            stageId: "search",
            text:
              "检索到对比文件D1、D2。D1公开日早于申请日，属于现有技术；" +
              "公开方式为出版物公开、使用公开、互联网公开、网络公开，公开日前无保密义务、处于保密状态。",
          },
          {
            stageId: "compare",
            text:
              "新颖性分析：将权利要求1与对比文件D1进行单独对比，技术领域相同、技术方案相同、" +
              "技术效果相同，所有技术特征均已被D1公开。",
          },
          {
            stageId: "conclude",
            text:
              "新颖性结论：权利要求1不具备新颖性。D2构成抵触申请（在先申请在后公开），仅用于新颖性判断。" +
              "优先权日为2025-01-01，优先权主张的有效性已核实；本案不涉及部分优先权、多项优先权的情形，" +
              "以优先权日作为现有技术判断时间基准。",
          },
          { stageId: "approval", text: "人工确认：结论属实，通过。" },
        ],
      },
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("确定性门: ✅ 通过"), `应判定通过: ${text}`);
    assert.ok(text.includes("所有规则检查均通过"), "不应有失败明细表");
  });

  it("patent_workflow 工具：确定性门——违反单独对比原则 → ⛔ 阻断并附失败明细", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        outputs: [
          { stageId: "parse", text: "解析技术交底书。" },
          { stageId: "search", text: "检索到对比文件D1、D2。" },
          { stageId: "compare", text: "结合多份对比文件结合，可认定本申请不具备新颖性。" },
          { stageId: "conclude", text: "新颖性结论：不具备。" },
          { stageId: "approval", text: "人工确认通过。" },
        ],
      },
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("确定性门: ⛔ 阻断"), `应判定阻断: ${text}`);
    assert.ok(text.includes("新颖性单独对比原则"), "失败明细应含单独对比规则名");
    assert.match(text, /\| 规则 \| 级别 \| 严重度 \| 问题 \| 修改建议 \|/, "应输出失败明细表头");
  });

  it("patent_workflow 工具：disclosure manifest 可用且 checkDomain 可覆盖", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        manifestId: "patent_disclosure_v1",
        checkDomain: "patent_infringement",
        outputs: [
          { stageId: "preprocess", text: "交底书预处理完成。" },
          { stageId: "extract_problem", text: "技术问题：提升散热效率。" },
          { stageId: "extract_features", text: "技术特征：散热鳍片结构。" },
          { stageId: "extract_effects", text: "技术效果：散热效率提升30%。" },
          { stageId: "merge", text: "PFE 三元组：问题↔特征↔效果关联闭合。" },
          { stageId: "consistency", text: "一致性校验通过，无孤立特征。" },
          { stageId: "report", text: "披露分析报告已生成。" },
          { stageId: "approval", text: "人工确认通过。" },
        ],
      },
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("patent_workflow(patent_disclosure_v1)"), `应识别 disclosure manifest: ${text}`);
    // checkDomain 覆盖为 infringement 域：文本缺全面覆盖要素 → 阻断
    assert.ok(text.includes("确定性门: ⛔ 阻断"), `应按 infringement 域判定: ${text}`);
    assert.ok(text.includes("侵权全面覆盖原则"), "失败明细应含全面覆盖规则");
  });

  it("patent_workflow 工具：checkDomain 空串禁用确定性门", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      { checkDomain: "", outputs: [{ stageId: "parse", text: "任意输出" }] },
      makeToolContext(),
    );
    assert.ok(!textOf(res).includes("确定性门"), "禁用后不应出现确定性门区块");
  });

  it("runRuleGate 单元：非降级输出拼接评估，返回判级行 + 报告", () => {
    const md = runRuleGate(
      {
        stages: [
          { degraded: false, output: "结合多份对比文件结合，不具备新颖性。" },
          { degraded: true, output: "（降级阶段不参与评估）" },
        ],
      },
      ["patent_novelty"],
    );
    assert.ok(md.includes("确定性门: ⛔ 阻断"), `应阻断: ${md}`);
    assert.ok(md.includes("## 规则引擎检查"));
    assert.ok(md.includes("新颖性单独对比原则"));
  });

  it("patent_plan_task 工具：非法迁移返回错误而非抛错", async () => {
    const tool = createPatentPlanTaskTool();
    const res = await tool.execute(
      { action: "transition", currentState: "finished", to: "planning" },
      makeToolContext(),
    );
    assert.ok(textOf(res).includes("非法状态迁移"));
  });

  it("patent_plan_task 工具：语义强制——executing 无任务 / replanning 无反馈返回文本", async () => {
    const tool = createPatentPlanTaskTool();
    const noTasks = await tool.execute(
      { action: "transition", currentState: "awaiting_approval", to: "executing" },
      makeToolContext(),
    );
    assert.ok(textOf(noTasks).includes("executing 前必须先 sync"), `应提示先 sync: ${textOf(noTasks)}`);
    const noFeedback = await tool.execute(
      { action: "transition", currentState: "awaiting_feedback", to: "replanning" },
      makeToolContext(),
    );
    assert.ok(textOf(noFeedback).includes("replanning 必须有反馈"), `应提示需反馈: ${textOf(noFeedback)}`);
    // 满足前置条件后正常放行
    const ok = await tool.execute(
      {
        action: "transition",
        currentState: "awaiting_approval",
        to: "executing",
        tasks: syncPlanToTasks(["解析"]).tasks,
      },
      makeToolContext(),
    );
    assert.ok(textOf(ok).includes("awaiting_approval → executing ✅"), `应放行: ${textOf(ok)}`);
  });

  it("patent_plan_task 工具：非法状态字符串 fail-closed（不抛 TypeError）", async () => {
    const tool = createPatentPlanTaskTool();
    const res = await tool.execute(
      { action: "transition", currentState: "bogus_state", to: "executing" },
      makeToolContext(),
    );
    assert.ok(textOf(res).includes("非法状态"), `应返回非法状态提示: ${textOf(res)}`);
  });

  it("patent_plan_task 工具：未知 action fail-closed（不返回 undefined）", async () => {
    const tool = createPatentPlanTaskTool();
    const res = await tool.execute({ action: "fly_to_moon" as never }, makeToolContext());
    assert.ok(textOf(res).includes("未知操作"), `应返回未知操作提示: ${textOf(res)}`);
  });

  it("patent_worker_validate 工具：契约校验结果", async () => {
    const tool = createPatentWorkerValidateTool();
    const ok = await tool.execute(
      { workerName: "patent-novelty-analyzer", outputText: "新颖性结论：具备；置信度：high" },
      makeToolContext(),
    );
    assert.ok(textOf(ok).includes("通过"));
    const bad = await tool.execute({ workerName: "patent-novelty-analyzer", outputText: "缺字段" }, makeToolContext());
    assert.ok(textOf(bad).includes("降级"));
  });

  it("patent_worker_validate 工具：未知 workerName fail-closed", async () => {
    const tool = createPatentWorkerValidateTool();
    const res = await tool.execute({ workerName: "no_such_worker", outputText: "x" }, makeToolContext());
    assert.ok(textOf(res).includes("未知 worker"), `应返回未知 worker 提示: ${textOf(res)}`);
  });
});

describe("patent inventiveness 工作流（patent_inventiveness_v1 接线）", () => {
  it("runWorkflow 全阶段有输出 → completed", async () => {
    const outputs = new Map(INVENTIVENESS_COMPLIANT_OUTPUTS.map(o => [o.stageId, o.text]));
    const result = await runWorkflow(patentInventivenessManifest, {}, async stage => outputs.get(stage.id) ?? "");
    assert.equal(result.completed, true);
    assert.equal(result.degradedSteps.length, 0);
    assert.equal(result.stages.length, 8);
  });

  it("patent_workflow 工具：inventiveness manifest 全阶段输出 → completed 摘要", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        manifestId: "patent_inventiveness_v1",
        outputs: ["parse", "search", "closest", "diff", "hint", "secondary", "conclude", "approval"].map(stageId => ({
          stageId,
          text: `阶段 ${stageId} 输出`,
        })),
      },
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("patent_workflow(patent_inventiveness_v1)"), `应识别 inventiveness manifest: ${text}`);
    assert.ok(text.includes("8/8 阶段完成"), `摘要应含 8/8: ${text}`);
    assert.ok(text.includes("completed"));
  });

  it("patent_workflow 工具：确定性门——合规创造性产出（内置目录映射）→ ✅ 通过", async () => {
    // 不传 checkDomain，验证 builtinPatentManifests 目录为 patent_inventiveness_v1
    // 提供的默认检查域（patent_inventiveness）被正确读取。
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        manifestId: "patent_inventiveness_v1",
        outputs: INVENTIVENESS_COMPLIANT_OUTPUTS,
      },
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("确定性门: ✅ 通过"), `应判定通过: ${text}`);
    assert.ok(text.includes("所有规则检查均通过"), "不应有失败明细表");
  });

  it("patent_workflow 工具：确定性门——缺三步法要素 → ⛔ 阻断并附失败明细", async () => {
    const tool = createPatentWorkflowTool();
    const res = await tool.execute(
      {
        manifestId: "patent_inventiveness_v1",
        outputs: [
          { stageId: "parse", text: "解析权利要求1。" },
          { stageId: "search", text: "检索到对比文件D1、D2。" },
          { stageId: "closest", text: "选定D1。" },
          { stageId: "diff", text: "区别特征为X。" },
          { stageId: "hint", text: "本领域技术人员有动机结合，故不具备创造性。" },
          { stageId: "secondary", text: "无特殊辅助因素。" },
          { stageId: "conclude", text: "结论：不具备创造性。" },
          { stageId: "approval", text: "人工确认通过。" },
        ],
      },
      makeToolContext(),
    );
    const text = textOf(res);
    assert.ok(text.includes("确定性门: ⛔ 阻断"), `应判定阻断: ${text}`);
    assert.ok(text.includes("创造性三步法"), "失败明细应含三步法规则名");
    assert.match(text, /\| 规则 \| 级别 \| 严重度 \| 问题 \| 修改建议 \|/, "应输出失败明细表头");
  });
});

describe("patent_workflow 工具：caseId 持久化（workflow-runs/ 子目录）", () => {
  it("纯 id 形式 → <cwd>/data/cases/<caseId>/workflow-runs/ 下写入 run 文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sati-pwf-"));
    try {
      const tool = createPatentWorkflowTool();
      const res = await tool.execute(
        {
          caseId: "case-001",
          outputs: ["parse", "search", "compare", "conclude", "approval"].map(stageId => ({
            stageId,
            text: `阶段 ${stageId} 输出`,
          })),
        },
        { cwd: dir } as never,
      );
      const text = textOf(res);
      const expected = join(dir, "data", "cases", "case-001", "workflow-runs", "case-001__patent_novelty_v1.json");
      assert.ok(text.includes(`持久化: ${expected}`), `应输出持久化路径: ${text}`);
      // 内容可经 JsonFileWorkflowRunStore 恢复
      const store = new JsonFileWorkflowRunStore(join(dir, "data", "cases", "case-001", "workflow-runs"));
      const loaded = await store.loadRun("case-001__patent_novelty_v1");
      assert.ok(loaded, "run 文件应可恢复");
      assert.equal(loaded?.manifestId, "patent_novelty_v1");
      assert.equal(loaded?.stages.length, 5);
      // 同目录应顺带生成 Mermaid 计划文档
      const mmd = await readFile(
        join(dir, "data", "cases", "case-001", "workflow-runs", "case-001__patent_novelty_v1.mmd"),
        "utf8",
      );
      assert.ok(mmd.startsWith("flowchart TD"));
      assert.ok(mmd.includes("parse --> search"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("绝对路径形式 → <caseId>/workflow-runs/ 下写入，runId 取 basename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sati-pwf-"));
    try {
      const tool = createPatentWorkflowTool();
      const res = await tool.execute({ caseId: dir, outputs: [] }, { cwd: dir } as never);
      const text = textOf(res);
      const key = dir.split(/[\\/]/).pop()!;
      const expected = join(dir, "workflow-runs", `${key}__patent_novelty_v1.json`);
      assert.ok(text.includes(`持久化: ${expected}`), `应输出持久化路径: ${text}`);
      const store = new JsonFileWorkflowRunStore(join(dir, "workflow-runs"));
      assert.ok(await store.loadRun(`${key}__patent_novelty_v1`), "run 文件应可恢复");
      const mmd = await readFile(join(dir, "workflow-runs", `${key}__patent_novelty_v1.mmd`), "utf8");
      assert.ok(mmd.startsWith("flowchart TD"), "应生成 Mermaid 计划文档");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("未提供 caseId → 不持久化且输出提示", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sati-pwf-"));
    try {
      const tool = createPatentWorkflowTool();
      const res = await tool.execute({ outputs: [] }, { cwd: dir } as never);
      assert.ok(textOf(res).includes("持久化: 未启用（未提供 caseId）"), textOf(res));
      const store = new JsonFileWorkflowRunStore(join(dir, "data", "cases"));
      assert.deepEqual(await store.listRuns(), [], "不应写入任何 run 文件");
      await assert.rejects(readFile(join(dir, "data", "cases", "x.mmd")), { code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
