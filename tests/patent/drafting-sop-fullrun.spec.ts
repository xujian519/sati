import assert from "node:assert/strict";
import test from "node:test";
import {
  patentDraftingManifest,
  registerBuiltinAtoms,
  runWorkflow,
  type StageProvider,
} from "../../src/patent/index.js";

/**
 * T12 确定性全链路验收（docs/patent-drafting-sop-plan.md 迭代四）：
 * mock provider + 批准全部审批门 → patent_drafting_v1 全部阶段完整跑通，
 * 断言撰写产物（权利要求/说明书/覆盖矩阵/质量门/反套话门）全部产出。
 *
 * 本测试是"撰写流程完整可运行"的确定性断言（无 key、CI 可跑）；
 * 真实模型录制的 llm-replay fixture 重放见
 * tests/test-support/llm-replay-drafting.spec.ts（fixture 存在时生效）。
 */

/** 全部审批门（撰写 manifest 5 个 HITL 检查点）。 */
const ALL_GATES = [
  "deconstruct_approval",
  "search_approval",
  "compare_approval",
  "disclosure_approval",
  "final_approval",
];

/** 完整交底书样本（四维信号齐全——clarity-gate 在前置准入直接通过）。 */
const FULL_DISCLOSURE = [
  "本发明涉及保温容器技术领域，要解决的技术问题是保温时间短的问题。",
  "技术方案：采用双层真空结构，包括保温层与内胆，通过真空层降低热传导。",
  "有益效果：保温时间由 2 小时提升至 8 小时，热损失降低 40%。",
  "实施例 1：真空度 0.1Pa，壁厚 2mm，保温 8 小时；附图 1 为整体结构示意图。",
].join("\n");

/** mock provider：按 prompt 内容返回各原子所需 JSON（覆盖全部阶段 LLM 调用）。 */
function fullRunProvider(): StageProvider {
  return {
    callLLM: async prompt => {
      if (prompt.includes("交底书质量评估专家")) {
        return JSON.stringify({
          problem: 0.9,
          solution: 0.9,
          effect: 0.9,
          enablement: 0.9,
          reasons: {
            problem: "交底书明确给出技术问题",
            solution: "手段完整",
            effect: "有定量对比",
            enablement: "有实施例参数",
          },
        });
      }
      if (prompt.includes("提取技术问题")) return JSON.stringify({ problems: ["保温时间短"] });
      if (prompt.includes("提取技术特征")) return JSON.stringify({ features: ["双层真空结构", "隔热层"] });
      if (prompt.includes("提取技术效果")) return JSON.stringify({ effects: ["保温 8 小时"] });
      if (prompt.includes("打分规则")) {
        return JSON.stringify({
          scores: [
            { feature: "双层真空结构", score: 0.95, reason: "交底书记载" },
            { feature: "隔热层", score: 0.8, reason: "交底书记载" },
          ],
          feedback: "依据充分",
        });
      }
      if (prompt.includes("一致性检查")) return JSON.stringify({ consistent: true, issues: [] });
      if (prompt.includes("检索关键词")) return JSON.stringify({ keywords: ["真空", "保温容器"] });
      if (prompt.includes("逐特征对比")) {
        return JSON.stringify({
          assessments: [{ feature: "双层真空结构", prior_art: "D1", disclosed: false, reasoning: "D1 未公开" }],
          conclusion: "区别特征为双层真空结构（置信度 high）",
        });
      }
      if (prompt.includes("充分公开审查专家")) {
        return "充分公开审查报告：交底书清楚完整；撰写建议：补充实施方式参数。";
      }
      if (prompt.includes("权利要求撰写专家")) {
        return JSON.stringify({
          claims: ["1. 一种双层真空保温容器，其特征在于，包括双层真空结构。"],
          notes: "独权含必要特征",
        });
      }
      if (prompt.includes("实施例覆盖矩阵")) {
        return JSON.stringify({
          claims: [{ claimId: "claim_1", features: ["双层真空结构"], embodimentRefs: ["embodiment_1"] }],
        });
      }
      if (prompt.includes("说明书撰写专家")) {
        return JSON.stringify({
          title: "一种双层真空保温容器",
          sections: [
            { name: "技术领域", content: "本发明涉及保温容器技术领域。" },
            { name: "背景技术", content: "D1（CN1234567A）保温时间短。" },
            {
              name: "发明内容",
              content:
                "要解决的技术问题是保温时间短；技术方案为双层真空结构；有益效果：保温时间由 2 小时提升至 8 小时。",
            },
            { name: "附图说明", content: "图1为整体结构示意图。" },
            { name: "具体实施方式", content: "实施例1：真空度 0.1Pa，保温 8 小时。" },
            { name: "摘要", content: "本发明提供一种双层真空保温容器，通过双层真空结构提升保温时间。" },
          ],
        });
      }
      return "推理结论";
    },
    search: async () => [
      { title: "CN1234567A 保温容器", snippet: "相关度 X，全文已获取", url: "https://e/1" },
      { title: "US20240012345A1 真空结构", snippet: "相关度 Y，全文已获取", url: "https://e/2" },
      { title: "EP1234567B1 隔热层", snippet: "相关度 A，全文已获取", url: "https://e/3" },
    ],
  };
}

test("T12: patent_drafting_v1 全链路（批准全部审批门）完整跑通", async () => {
  registerBuiltinAtoms();
  const provider = fullRunProvider();
  const executor = async (): Promise<string> => "（透传：figure/chemistry 由主代理工具完成）";

  const result = await runWorkflow(
    patentDraftingManifest,
    {
      text: FULL_DISCLOSURE,
      source_text: FULL_DISCLOSURE,
    },
    executor,
    { provider, approvalGrants: ALL_GATES },
  );

  // 全部阶段执行完成，无中断、无降级
  assert.equal(result.completed, true, `应完成（summary: ${result.summary}）`);
  assert.equal(result.interrupted, undefined, "批准全部审批门后不应中断");
  assert.deepEqual(result.degradedSteps, [], "全链路不应有降级阶段");
  assert.equal(result.stages.length, patentDraftingManifest.stages.length, "全部阶段执行");

  const output = (id: string): string => {
    const stage = result.stages.find(s => s.stageId === id);
    assert.ok(stage, `阶段 ${id} 应存在`);
    return stage!.output;
  };

  // 关键产物断言
  assert.match(output("extract_features"), /双层真空结构/, "PFE 特征提取");
  assert.match(output("merge"), /双层真空结构/, "PFE 融合含特征");
  assert.equal(output("deconstruct_approval"), "APPROVED", "已批准审批门放行占位");
  assert.match(output("search_quality"), /检索质量门/, "检索质量门报告");
  assert.equal(output("search_approval"), "APPROVED");
  assert.match(output("prior_art_compare"), /区别特征/, "逐特征对比输出区别特征");
  assert.match(output("draft_claims"), /1\. 一种双层真空保温容器/, "权利要求草稿");
  assert.match(output("draft_spec"), /## 技术领域/, "说明书含技术领域章节");
  assert.match(output("draft_spec"), /## 具体实施方式/, "说明书含具体实施方式章节");
  assert.match(output("slop_clean"), /反套话评分门/, "反套话评分门报告");
  assert.equal(output("final_approval"), "APPROVED");

  // worker 契约校验：search 阶段命中 patent-search-commander（提示性，不降级）
  const search = result.stages.find(s => s.stageId === "search")!;
  assert.equal(search.workerValidation?.workerName, "patent-search-commander");
  assert.equal(search.degraded, false, "worker 契约缺失不改变 degraded");
});

test("T12: 全链路含确定性质量门产出（slop 评分可解析）", async () => {
  registerBuiltinAtoms();
  const provider = fullRunProvider();
  const executor = async (): Promise<string> => "（透传）";
  const result = await runWorkflow(
    patentDraftingManifest,
    { text: FULL_DISCLOSURE, source_text: FULL_DISCLOSURE },
    executor,
    {
      provider,
      approvalGrants: ALL_GATES,
    },
  );
  // slop-gate 主输出是报告文本；评分 JSON 在 state（经 stage 输出不可见），
  // 但报告文本含五维分数字段（直接性/证据性…）——断言报告结构完整。
  const slop = result.stages.find(s => s.stageId === "slop_clean")!.output;
  assert.match(slop, /直接性 \d+ \| 证据性 \d+ \| 节奏 \d+ \| 务实性 \d+ \| 简洁性 \d+/);
});
