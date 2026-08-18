import assert from "node:assert/strict";
import test from "node:test";
import {
  builtinPatentManifests,
  checkSearchQuality,
  draftSpecAtom,
  patentDraftingManifest,
  registerBuiltinAtoms,
  runWorkflow,
  slopGateAtom,
  validateDraftSpec,
  validateWorkflowManifest,
  type SpecViolation,
  type StageProvider,
} from "../../src/patent/index.js";
import { LookupStageHandler } from "../../src/patent/index.js";
import { ListAtoms } from "../../src/patent/atoms/atom.js";

/** draft-spec 校验报告形状（对齐 validateDraftSpec 返回）。 */
type SpecValidation = { passed: boolean; violations: SpecViolation[] };

/** 解析 spec_validation JSON 为类型化对象。 */
function parseSpecValidation(raw: unknown): SpecValidation {
  return JSON.parse(String(raw)) as SpecValidation;
}

/**
 * 撰写 SOP 原子（T1 draft-spec / T2 quality-gate / T3 slop-gate）与
 * patent_drafting_v1 manifest（T4）测试。
 *
 * 对齐 docs/patent-drafting-sop-plan.md 迭代一验收标准：
 * mock provider 下 patent_drafting_v1 全链路可跑通（至审批门中断）。
 */

// ---------------------------------------------------------------------------
// T1: draft-spec 原子（说明书撰写 + 确定性校验）
// ---------------------------------------------------------------------------

test("draft-spec 原子声明契约（输入/输出键）", () => {
  assert.equal(draftSpecAtom.name, "draft-spec");
  assert.deepEqual(draftSpecAtom.inputSchema, [
    "claims_draft",
    "pfe_triples",
    "merge_result",
    "novelty_conclusion",
    "source_text",
  ]);
  assert.deepEqual(draftSpecAtom.outputSchema, ["spec_draft", "spec_validation"]);
});

const specProvider: StageProvider = {
  callLLM: async prompt => {
    if (prompt.includes("说明书撰写专家")) {
      return JSON.stringify({
        title: "一种双层真空保温容器",
        sections: [
          { name: "技术领域", content: "本发明涉及保温容器技术领域，尤其涉及一种双层真空保温容器。" },
          { name: "背景技术", content: "现有保温容器（下称D1，CN1234567A）保温时间短。" },
          {
            name: "发明内容",
            content:
              "本发明要解决的技术问题是保温时间短。技术方案为双层真空结构。有益效果：保温时间由 2 小时提升至 8 小时。",
          },
          { name: "附图说明", content: "图1为本发明实施例的整体结构示意图。" },
          {
            name: "具体实施方式",
            content:
              "实施例1：内胆温度 60℃，真空度 0.1Pa，保温 8 小时。实施例2：内胆温度 60℃至 90℃，保温 6 至 10 小时。",
          },
          { name: "摘要", content: "本发明提供一种双层真空保温容器，通过双层真空结构提升保温时间。" },
        ],
      });
    }
    return "推理结论";
  },
};

test("DraftSpecHandler：LLM JSON 组装七部分说明书并附校验报告", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("draft-spec")!;
  const out = await h.execute({
    state: {
      claims_draft: "1. 一种双层真空保温容器，其特征在于，包括双层真空结构。",
      novelty_conclusion: "区别特征为双层真空结构",
      source_text: "交底书：双层真空保温容器",
    },
    provider: specProvider,
  });
  assert.match(String(out.spec_draft), /# 一种双层真空保温容器/);
  for (const section of ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式", "摘要"]) {
    assert.match(String(out.spec_draft), new RegExp(`## ${section}`), `说明书应含 ${section} 章节`);
  }
  const validation = parseSpecValidation(out.spec_validation);
  assert.equal(validation.passed, true, "完整说明书校验应通过（warning 不判失败）");
  // 数据含数值范围 60-90℃ 但无中间值实施例 → 应报 numeric_range_midpoint warning（不判失败）
  assert.ok(
    validation.violations.every(v => v.severity === "warning"),
    "仅 warning 不判失败",
  );
  assert.ok(
    validation.violations.some(v => v.rule === "numeric_range_midpoint"),
    "应提示数值范围缺少中间值实施例",
  );
});

test("DraftSpecHandler：输入为空时降级（不抛错）", async () => {
  const h = LookupStageHandler("draft-spec")!;
  const out = await h.execute({ state: {}, provider: specProvider });
  assert.match(String(out._error), /输入为空/);
});

test("DraftSpecHandler：LLM 非 JSON 输出保留原文并如实报告缺章", async () => {
  const h = LookupStageHandler("draft-spec")!;
  const badProvider: StageProvider = { callLLM: async () => "一段说明文字，没有章节标题" };
  const out = await h.execute({ state: { source_text: "x" }, provider: badProvider });
  assert.equal(out.spec_draft, "一段说明文字，没有章节标题");
  const validation = parseSpecValidation(out.spec_validation);
  assert.equal(validation.passed, false);
  assert.ok(
    validation.violations.some(v => v.rule === "section_missing"),
    "应报告缺少章节",
  );
});

test("validateDraftSpec：章节缺失判 error、数值范围缺中间值判 warning", () => {
  // 缺"具体实施方式" → error → 不通过
  const incomplete = validateDraftSpec("## 技术领域\ntext\n## 背景技术\ntext\n## 发明内容\ntext\n## 附图说明\ntext");
  assert.equal(incomplete.passed, false);
  assert.ok(incomplete.violations.some(v => v.rule === "section_missing" && v.severity === "error"));

  // 完整五部分 + 数值范围缺中间值 → warning（不判失败）
  const full = validateDraftSpec(
    [
      "## 技术领域\ntext",
      "## 背景技术\ntext",
      "## 发明内容\ntext",
      "## 附图说明\ntext",
      "## 具体实施方式\n温度范围为 20℃至 90℃，实施例给出 20℃ 与 90℃ 两端值，但无中间值。",
    ].join("\n\n"),
  );
  assert.equal(full.passed, true, "仅 warning 不判失败");
  assert.ok(full.violations.some(v => v.rule === "numeric_range_midpoint" && v.severity === "warning"));

  // 效果套话无定量数据 → error
  const vague = validateDraftSpec(
    [
      "## 技术领域\ntext",
      "## 背景技术\ntext",
      "## 发明内容\n本发明的效果显著提升，性能大幅提高。",
      "## 附图说明\ntext",
      "## 具体实施方式\ntext",
    ].join("\n\n"),
  );
  assert.equal(vague.passed, false);
  assert.ok(vague.violations.some(v => v.rule === "effect_quantification"));

  // 名称超 25 字 → warning
  const longTitle = validateDraftSpec("## 技术领域\ntext", "这是一个非常长的发明名称超过了二十五字限制的测试用例名称");
  assert.ok(longTitle.violations.some(v => v.rule === "title_length" && v.severity === "warning"));
});

// ---------------------------------------------------------------------------
// T2: quality-gate 检索质量门槛
// ---------------------------------------------------------------------------

test("checkSearchQuality：全部门槛达标 → passed", () => {
  const text = [
    "检索式: (保温 AND 真空) OR 隔热 AND IPC=G06F3/04",
    "对比文件 1: CN1234567A，相关度 X，全文已获取",
    "对比文件 2: US20240012345A1，相关度 Y，全文已获取",
    "对比文件 3: EP1234567B1，相关度 A，全文已获取",
  ].join("\n");
  const result = checkSearchQuality(text);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.details.docCount, 3);
});

test("checkSearchQuality：逐项缺失 → 对应 failures", () => {
  const sparse = checkSearchQuality("只有一段描述，没有对比文件、没有检索式");
  assert.equal(sparse.passed, false);
  assert.ok(sparse.failures.some(f => f.includes("对比文件不足")));
  assert.ok(sparse.failures.some(f => f.includes("相关度标注")));
  assert.ok(sparse.failures.some(f => f.includes("全文")));
  assert.ok(sparse.failures.some(f => f.includes("布尔逻辑")));
  assert.ok(sparse.failures.some(f => f.includes("IPC")));

  // 缺 IPC 限定
  const noIpc = checkSearchQuality(
    "对比文件 1: CN1234567A\n对比文件 2: CN2345678B\n对比文件 3: CN3456789C\n相关度 X\n全文\n全文",
  );
  assert.ok(noIpc.failures.some(f => f.includes("IPC")));
});

test("QualityGateHandler：prior_art 数组序列化后判定并输出报告", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("quality-gate")!;
  const out = await h.execute({
    state: {
      search_summary: "检索到 3 篇相关文献（查询: 保温 AND 真空 OR IPC=G06F3/04）",
      prior_art: [
        { title: "CN1234567A 保温容器", snippet: "相关度 X，全文已获取", url: "https://e/1" },
        { title: "US20240012345A1 真空结构", snippet: "相关度 Y，全文已获取", url: "https://e/2" },
        { title: "EP1234567B1 隔热层", snippet: "相关度 A", url: "https://e/3" },
      ],
    },
  });
  assert.match(String(out.quality_report), /检索质量门/);
  assert.match(String(out.quality_report), /对比文件: 3 篇/);
});

test("QualityGateHandler：输入为空时降级", async () => {
  const h = LookupStageHandler("quality-gate")!;
  const out = await h.execute({ state: {} });
  assert.match(String(out._error), /输入为空/);
});

// ---------------------------------------------------------------------------
// T3: slop-gate 反套话评分门
// ---------------------------------------------------------------------------

test("slop-gate 原子声明契约", () => {
  assert.equal(slopGateAtom.name, "slop-gate");
  assert.deepEqual(slopGateAtom.inputSchema, ["report_text", "spec_draft", "claims_draft"]);
  assert.deepEqual(slopGateAtom.outputSchema, ["slop_report", "slop_score"]);
});

test("SlopGateHandler：含套话文本输出评分报告（需修订）", async () => {
  registerBuiltinAtoms();
  const h = LookupStageHandler("slop-gate")!;
  const out = await h.execute({
    state: {
      spec_draft: "综上所述，本发明具有显著进步，创造性得以确立。保护范围合理。",
    },
  });
  assert.match(String(out.slop_report), /反套话评分门/);
  const score = JSON.parse(String(out.slop_score));
  assert.ok(typeof score.total === "number");
  assert.ok(typeof score.passed === "boolean");
  assert.ok(Array.isArray(score) === false);
});

test("SlopGateHandler：干净文本通过评分门", async () => {
  const h = LookupStageHandler("slop-gate")!;
  const clean = [
    "## 技术领域",
    "本发明涉及保温容器技术领域。",
    "## 背景技术",
    "D1（CN1234567A）公开的保温容器保温时间 2 小时。",
    "## 发明内容",
    "双层真空结构使保温时间提升至 8 小时（实验数据：3 组平行测试均值）。",
    "## 具体实施方式",
    "实施例1：真空度 0.1Pa，保温 8 小时。",
  ].join("\n\n");
  const out = await h.execute({ state: { report_text: clean } });
  const score = JSON.parse(String(out.slop_score));
  assert.equal(score.passed, true, "无套话文本应通过");
});

test("SlopGateHandler：输入为空时降级", async () => {
  const h = LookupStageHandler("slop-gate")!;
  const out = await h.execute({ state: {} });
  assert.match(String(out._error), /输入为空/);
});

// ---------------------------------------------------------------------------
// T4: patent_drafting_v1 manifest
// ---------------------------------------------------------------------------

test("patent_drafting_v1 manifest 结构合法且原子全部可解析", () => {
  validateWorkflowManifest(patentDraftingManifest);
  assert.equal(patentDraftingManifest.id, "patent_drafting_v1");
  assert.equal(patentDraftingManifest.caseType, "drafting");
  const names = ListAtoms()
    .map(a => a.name)
    .sort();
  for (const stage of patentDraftingManifest.stages) {
    if (stage.atom !== undefined) {
      assert.ok(names.includes(stage.atom), `阶段 ${stage.id} 声明的原子 ${stage.atom} 应已注册`);
      assert.ok(LookupStageHandler(stage.atom), `阶段 ${stage.id} 的 handler ${stage.atom} 应已注册`);
    }
  }
  // 撰写关键阶段存在
  const stageIds = patentDraftingManifest.stages.map(s => s.id);
  for (const id of [
    "extract_features",
    "search",
    "search_quality",
    "draft_claims",
    "draft_spec",
    "slop_clean",
    "final_approval",
  ]) {
    assert.ok(stageIds.includes(id), `manifest 应含 ${id} 阶段`);
  }
});

test("patent_drafting_v1：mock provider 全链路跑通至审批门中断", async () => {
  registerBuiltinAtoms();
  const provider: StageProvider = {
    callLLM: async prompt => {
      if (prompt.includes("提取技术问题")) {
        return JSON.stringify({ problems: ["保温时间短"] });
      }
      if (prompt.includes("提取技术特征")) {
        return JSON.stringify({ features: ["双层真空结构", "隔热层"] });
      }
      if (prompt.includes("提取技术效果")) {
        return JSON.stringify({ effects: ["保温 8 小时"] });
      }
      if (prompt.includes("打分规则")) {
        return JSON.stringify({
          scores: [
            { feature: "双层真空结构", score: 0.95, reason: "交底书记载" },
            { feature: "隔热层", score: 0.8, reason: "交底书记载" },
          ],
          feedback: "依据充分",
        });
      }
      if (prompt.includes("一致性检查")) {
        return JSON.stringify({ consistent: true, issues: [] });
      }
      if (prompt.includes("检索关键词")) {
        return JSON.stringify({ keywords: ["真空", "保温容器"] });
      }
      if (prompt.includes("逐特征对比")) {
        return JSON.stringify({
          assessments: [{ feature: "双层真空结构", prior_art: "D1", disclosed: false, reasoning: "D1 未公开" }],
          conclusion: "区别特征为双层真空结构（置信度 high）",
        });
      }
      if (prompt.includes("充分公开审查专家")) {
        return "充分公开审查报告：交底书清楚完整，撰写建议：补充实施方式参数。";
      }
      if (prompt.includes("权利要求撰写专家")) {
        return JSON.stringify({
          claims: ["1. 一种双层真空保温容器，其特征在于，包括双层真空结构。"],
          notes: "独权含必要特征",
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
  const executor = async (): Promise<string> => "（透传输入）";
  const result = await runWorkflow(patentDraftingManifest, { text: "交底书：双层真空保温容器" }, executor, {
    provider,
  });

  // 全链路在首个审批门（deconstruct_approval）中断
  assert.equal(result.completed, false);
  assert.equal(result.interrupted?.stageId, "deconstruct_approval");
  // 中断前的原子阶段应正常产出（不降级）
  const extract = result.stages.find(s => s.stageId === "extract_features");
  assert.ok(extract, "extract_features 应执行");
  assert.equal(extract!.degraded, false);
  assert.match(extract!.output, /双层真空结构/);
  const merge = result.stages.find(s => s.stageId === "merge");
  assert.ok(merge, "merge 应执行");
  assert.equal(merge!.degraded, false);
});

test("patent_drafting_v1：审批门放行后继续至下一审批门", async () => {
  registerBuiltinAtoms();
  const provider: StageProvider = {
    callLLM: async prompt => {
      if (prompt.includes("提取技术问题")) return JSON.stringify({ problems: ["保温时间短"] });
      if (prompt.includes("提取技术特征")) return JSON.stringify({ features: ["双层真空结构"] });
      if (prompt.includes("提取技术效果")) return JSON.stringify({ effects: ["保温 8 小时"] });
      if (prompt.includes("打分规则")) {
        return JSON.stringify({
          scores: [{ feature: "双层真空结构", score: 0.95, reason: "交底书记载" }],
          feedback: "充分",
        });
      }
      if (prompt.includes("一致性检查")) return JSON.stringify({ consistent: true, issues: [] });
      return "推理结论";
    },
  };
  const executor = async (): Promise<string> => "（透传输入）";
  // 批准 deconstruct_approval：放行后继续，在下一个审批门（search_approval 之前的 search_quality 无审批）中断
  const result = await runWorkflow(patentDraftingManifest, { text: "交底书" }, executor, {
    provider,
    approvalGrants: ["deconstruct_approval"],
  });
  assert.equal(result.completed, false);
  // 放行的审批门已执行（占位输出 APPROVED），后续阶段推进到检索链
  const gateStage = result.stages.find(s => s.stageId === "deconstruct_approval");
  assert.equal(gateStage?.output, "APPROVED");
  assert.ok(
    result.stages.some(s => s.stageId === "generate_keywords"),
    "放行后应推进到检索链",
  );
});

test("builtinPatentManifests 目录含 patent_drafting_v1 且规则门域映射正确", () => {
  const drafting = builtinPatentManifests.find(e => e.manifest.id === "patent_drafting_v1");
  assert.ok(drafting, "目录应含 patent_drafting_v1");
  assert.deepEqual(drafting!.checkDomains, ["patent_disclosure", "patent_claims"]);
});
