import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToolContext } from "../context-fixture.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/index.js";
import type { SatiToolModelClient } from "../../../src/tool/protocol/types.js";
import type { StageProvider } from "../../../src/patent/atoms/index.js";
import {
  StageHandlerRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
} from "../../../src/patent/atoms/index.js";
import { createPatentWorkflowRunTool, buildJudgeSection } from "../../../src/tool/builtin/patentWorkflowRunTool.js";
import { buildWorkflowProvider } from "../../../src/tool/builtin/patentWorkflowTool.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { DEFAULT_MODEL_ID } from "../../../src/model/index.js";
import { appendInventivenessFeedback, caseInventivenessFeedbackPath } from "../../../src/patent/index.js";

/**
 * patent_workflow_run（原子自动执行）接线测试。
 *
 * mock model 按 prompt 关键字返回对应 JSON（extract 三路 / groundedness /
 * keywords / novelty），mock search 返回固定现有技术命中；验证 disclosure
 * manifest 全流程原子执行与审批门中断语义。
 */

const DISCLOSURE_INPUT = [
  "本发明涉及一种智能保温杯。",
  "要解决的技术问题是：现有保温杯无法长时间保温。",
  "技术特征：杯体采用双层真空结构；杯盖设有温度显示模块；内置加热单元。",
  "技术效果：保温时长提升至 12 小时；温度可视化。",
].join("\n");

function textDelta(text: string): CanonicalModelEvent {
  return { type: "text_delta", text } as CanonicalModelEvent;
}

/** 按 prompt 内容分发响应的 mock model。 */
function mockModel(respond: (prompt: string) => string): SatiToolModelClient {
  return {
    async *stream(request: CanonicalModelRequest) {
      const prompt = request.messages[0]?.content?.[0]?.type === "text" ? request.messages[0].content[0].text : "";
      yield textDelta(respond(prompt));
    },
  };
}

/** disclosure 全流程 happy-path 响应器。 */
function disclosureResponder(prompt: string): string {
  if (prompt.includes("提取待解决的技术问题")) {
    return JSON.stringify({ features: [], problems: ["现有保温杯无法长时间保温"], effects: [] });
  }
  if (prompt.includes("提取技术特征")) {
    return JSON.stringify({
      features: ["杯体双层真空结构", "杯盖温度显示模块", "内置加热单元"],
      problems: [],
      effects: [],
    });
  }
  if (prompt.includes("提取技术效果")) {
    return JSON.stringify({ features: [], problems: [], effects: ["保温时长提升至12小时"] });
  }
  if (prompt.includes("一致性检查")) {
    return JSON.stringify({ consistent: true, issues: [] });
  }
  if (prompt.includes("评估以下每个提取的技术特征")) {
    return JSON.stringify({
      scores: [
        { feature: "杯体双层真空结构", score: 0.9, reason: "原文明确记载" },
        { feature: "杯盖温度显示模块", score: 0.8, reason: "原文明确记载" },
        { feature: "内置加热单元", score: 0.85, reason: "原文明确记载" },
      ],
      feedback: "全部特征均有充分依据",
    });
  }
  if (prompt.includes("生成检索关键词")) {
    return JSON.stringify({ keywords: ["保温杯", "真空保温", "温度显示"] });
  }
  if (prompt.includes("专利新颖性分析专家")) {
    return JSON.stringify({
      assessments: [
        { feature: "杯体双层真空结构", prior_art: "D1", disclosed: true, reasoning: "D1 公开双层真空结构" },
        { feature: "杯盖温度显示模块", prior_art: "D2", disclosed: true, reasoning: "D2 公开温度显示" },
        { feature: "内置加热单元", prior_art: "", disclosed: false, reasoning: "D1/D2 均未公开加热单元" },
      ],
      conclusion: "权利要求1相对于D1、D2具备新颖性（加热单元未公开），置信度 0.8",
    });
  }
  return "{}";
}

const mockSearch: StageProvider["search"] = async (_query, _opts) => [
  { title: "D1", snippet: "双层真空保温杯", url: "https://example.com/D1" },
  { title: "D2", snippet: "带温度显示的杯盖", url: "https://example.com/D2" },
];

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => (c.type === "text" && c.text ? c.text : "")).join("");
}

// ---------------------------------------------------------------------------
// 全流程
// ---------------------------------------------------------------------------

test("disclosure manifest 原子全流程执行，review_gate 中断且 draft_claims 未执行", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ model: mockModel(disclosureResponder), search: mockSearch });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext({ cwd: "/tmp" }));
  const text = textOf(res);

  assert.match(text, /patent_workflow_run\(patent_disclosure_v1\)/);
  // 审批门中断：暂停等待人工确认
  assert.match(text, /暂停等待人工确认/);
  assert.match(text, /review_gate/);
  // 核心原子阶段执行（含 atom 标注）
  assert.match(text, /extract_problem \[atom:extract\]/);
  assert.match(text, /extract_features \[atom:extract\]/);
  assert.match(text, /extract_effects \[atom:extract\]/);
  assert.match(text, /merge \[atom:merge\]/);
  assert.match(text, /groundedness \[atom:groundedness\]/);
  assert.match(text, /consistency \[atom:reasoning\]/);
  assert.doesNotMatch(text, /✅ consistency:/, "consistency 已声明 reasoning 原子，不应走透传格式");
  assert.match(text, /generate_keywords \[atom:keywords\]/);
  assert.match(text, /search \[atom:search\]/);
  assert.match(text, /novelty \[atom:novelty\]/);
  // 无 atom 阶段（preprocess/report）透传输入，不降级
  assert.match(text, /✅ preprocess/);
  assert.match(text, /✅ report/);
  // draft_claims（审批门之后）不执行
  assert.doesNotMatch(text, /draft_claims/);
  // 中断时规则门不跑（产出不完整）
  assert.doesNotMatch(text, /确定性门/);
});

test("merge 产出 PFE 三元组，novelty 产出逐特征判定（状态流打通）", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ model: mockModel(disclosureResponder), search: mockSearch });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext());
  const text = textOf(res);
  // merge 主输出 = pfe_triples（problem 进入三元组）
  assert.match(text, /现有保温杯无法长时间保温/);
  // novelty 主输出 = novelty_result（逐特征 assessments；渲染预览截断到 80 字符，断言行前缀）
  assert.match(text, /novelty \[atom:novelty\]: \{"assessments"/);
});

test("consistency 判不一致 → 回退重跑 extract 三路 → 第二次一致通过（retry 闭环）", async () => {
  registerBuiltinAtoms();
  const calls = { extract_problem: 0, extract_features: 0, extract_effects: 0, consistency: 0 };
  const responder = (prompt: string): string => {
    if (prompt.includes("提取待解决的技术问题")) {
      calls.extract_problem += 1;
      return JSON.stringify({ features: [], problems: ["现有保温杯无法长时间保温"], effects: [] });
    }
    if (prompt.includes("提取技术特征")) {
      calls.extract_features += 1;
      return JSON.stringify({
        features: ["杯体双层真空结构", "杯盖温度显示模块", "内置加热单元"],
        problems: [],
        effects: [],
      });
    }
    if (prompt.includes("提取技术效果")) {
      calls.extract_effects += 1;
      return JSON.stringify({ features: [], problems: [], effects: ["保温时长提升至12小时"] });
    }
    if (prompt.includes("一致性检查")) {
      calls.consistency += 1;
      // 第一轮判不一致（issues 含"孤立"命中回退信号），回退重跑后第二轮判一致。
      return calls.consistency === 1
        ? JSON.stringify({ consistent: false, issues: ["特征'内置加热单元'孤立，无效果关联"] })
        : JSON.stringify({ consistent: true, issues: [] });
    }
    return disclosureResponder(prompt);
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext({ cwd: "/tmp" }));
  const text = textOf(res);
  // 回退：extract 三路 + consistency 各执行 2 次（首轮 + 回退重跑），retry 不耗尽。
  assert.equal(calls.extract_problem, 2);
  assert.equal(calls.extract_features, 2);
  assert.equal(calls.extract_effects, 2);
  assert.equal(calls.consistency, 2);
  assert.doesNotMatch(text, /RETRY_EXHAUSTED/);
  assert.doesNotMatch(text, /⚠️ 降级/);
  // 回退重跑不残留首轮阶段记录；仍中断于 review_gate 等待人工确认。
  assert.equal(text.match(/✅ extract_problem/g)?.length, 1, "回退后只保留最终执行记录");
  assert.match(text, /暂停等待人工确认/);
});

test("consistency 恒判不一致 → RETRY_EXHAUSTED 降级但管线继续（fail-safe）", async () => {
  registerBuiltinAtoms();
  const responder = (prompt: string): string => {
    if (prompt.includes("一致性检查")) {
      return JSON.stringify({ consistent: false, issues: ["特征'内置加热单元'孤立，无效果关联"] });
    }
    return disclosureResponder(prompt);
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext({ cwd: "/tmp" }));
  const text = textOf(res);
  // maxRetries=1：首轮 + 回退 1 次后仍不一致 → 耗尽降级，整体 incomplete。
  assert.match(text, /\[WORKFLOW_RETRY_EXHAUSTED\] consistency/);
  assert.match(text, /⚠️ 降级/);
  assert.match(text, /完成状态: incomplete/);
  // 一致性降级不中断管线：仍前进至 review_gate 暂停。
  assert.match(text, /暂停等待人工确认/);
});

test("回退重跑中 extract_features 解析失败：旧一代键被清理，merge 不混代（F2 回归）", async () => {
  registerBuiltinAtoms();
  const calls = { extract_features: 0, consistency: 0 };
  const responder = (prompt: string): string => {
    if (prompt.includes("提取技术特征")) {
      calls.extract_features += 1;
      // 首轮正常产出 features；回退重跑时 LLM 输出非 JSON（解析失败场景）
      return calls.extract_features === 1
        ? JSON.stringify({ features: ["杯体双层真空结构"], problems: [], effects: [] })
        : "这不是 JSON";
    }
    if (prompt.includes("一致性检查")) {
      calls.consistency += 1;
      // 第一轮判不一致（issues 无信号词，机器判据生效）触发回退；重跑后判一致
      return calls.consistency === 1
        ? JSON.stringify({ consistent: false, issues: ["问题与效果关联均缺失"] })
        : JSON.stringify({ consistent: true, issues: [] });
    }
    return disclosureResponder(prompt);
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext());
  const text = textOf(res);
  // merge 的 features 必须来自重跑结果（解析失败 → 空数组），而非残留首轮数组
  // （修复前只删 stage-id 键：T1 三元组混入首轮特征"杯体双层真空结构"）。
  assert.match(text, /"features": \[\],/, "merge 三元组的 features 为空（无首轮残留）");
  assert.doesNotMatch(text, /杯体双层真空结构/, "首轮提取的特征被清理，未混入 merge 三元组");
  assert.equal(calls.extract_features, 2);
  assert.equal(calls.consistency, 2);
  assert.doesNotMatch(text, /RETRY_EXHAUSTED/);
  assert.match(text, /暂停等待人工确认/);
});

test("LLM 输出非 JSON：extract 降级保留原文，流程 fail-open 直至审批门中断", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({
    model: mockModel(() => "这不是 JSON"),
    search: mockSearch,
  });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext());
  const text = textOf(res);
  // extract 降级（保留原文），但流程不中断；仍走到 review_gate 审批门
  assert.match(text, /暂停等待人工确认/);
  assert.match(text, /review_gate/);
  // merge 因三路提取空而降级（fail-open）
  assert.match(text, /merge.*降级|merge.*degraded|降级/);
});

test("未提供模型客户端：返回明确错误而非静默降级", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ search: mockSearch });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext());
  const text = textOf(res);
  assert.match(text, /未提供模型客户端/);
  assert.doesNotMatch(text, /patent_workflow_run\(patent_disclosure_v1\)/);
});

test("未知 manifest fail-closed", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ model: mockModel(disclosureResponder), search: mockSearch });
  const res = await tool.execute({ input: "x", manifestId: "no_such_manifest" }, makeToolContext());
  assert.match(textOf(res), /未知 manifest/);
});

test("chartTargets 注入：claim-chart 原子收到目标对象（manifest 路径，T9 I-2 接线）", async () => {
  registerBuiltinAtoms();
  const claimText = "一种智能保温杯，其特征在于杯体采用双层真空结构。";
  const targetsJson = JSON.stringify([{ id: "D1", kind: "prior-art", title: "对比文件1" }]);

  // 不传 chartTargets：prompt 提示无目标对象（只拆分要素）
  let promptWithout = "";
  const toolWithout = createPatentWorkflowRunTool({
    model: mockModel(prompt => {
      if (prompt.includes("专利权利要求分析专家")) {
        promptWithout = prompt;
        return JSON.stringify({
          elements: [{ id: "1a", claimNo: 1, text: "杯体采用双层真空结构", kind: "limitation" }],
          rows: [{ elementId: "1a", targetId: "D1", quote: "", pinCite: "", mapping: "literal" }],
        });
      }
      return "{}";
    }),
    search: mockSearch,
  });
  await toolWithout.execute({ input: claimText, manifestId: "patent_invalidation_v1" }, makeToolContext());
  assert.ok(promptWithout.length > 0, "未传 chartTargets 时 claim-chart 原子也应被调用");
  assert.match(promptWithout, /无目标对象/);

  // 传 chartTargets：prompt 渲染目标对象（id/kind/title）
  let promptWith = "";
  const toolWith = createPatentWorkflowRunTool({
    model: mockModel(prompt => {
      if (prompt.includes("专利权利要求分析专家")) {
        promptWith = prompt;
        return JSON.stringify({
          elements: [{ id: "1a", claimNo: 1, text: "杯体采用双层真空结构", kind: "limitation" }],
          rows: [{ elementId: "1a", targetId: "D1", quote: "", pinCite: "", mapping: "literal" }],
        });
      }
      return "{}";
    }),
    search: mockSearch,
  });
  const res = await toolWith.execute(
    { input: claimText, manifestId: "patent_invalidation_v1", chartTargets: targetsJson },
    makeToolContext(),
  );
  const text = textOf(res);
  assert.match(promptWith, /【目标对象】/);
  assert.match(promptWith, /D1（对比文件：对比文件1）/);
  assert.match(text, /claim-chart \[atom:claim-chart\]/);
  // T9 I-1 回归：novelty/inventiveness 无 atom 声明（收口透传），不出现降级标注
  assert.match(text, /✅ novelty:/);
  assert.doesNotMatch(text, /novelty \[atom:/);
  assert.match(text, /✅ inventiveness:/);
  assert.doesNotMatch(text, /inventiveness \[atom:/);
});

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

test("注入放行审批门的 handlers：draft_claims 执行 + 确定性规则门运行（完成路径）", async () => {
  registerBuiltinAtoms();
  // 复制全局注册表，approval-gate 替换为放行（返回阶段输出，不抛中断）
  const handlers = new StageHandlerRegistry();
  for (const h of globalStageHandlerRegistry.list()) {
    if (h.name === "approval-gate") {
      handlers.register({
        name: "approval-gate",
        category: "gate",
        execute: async () => ({ review_gate: "已人工确认，放行" }),
      });
    } else {
      handlers.register(h);
    }
  }
  const model = mockModel(prompt => {
    if (prompt.includes("权利要求撰写专家")) {
      return JSON.stringify({
        claims: ["1. 一种智能保温杯，其特征在于杯体采用双层真空结构。"],
        notes: "独权包含全部必要技术特征",
      });
    }
    return disclosureResponder(prompt);
  });
  const tool = createPatentWorkflowRunTool({ model, search: mockSearch, handlers });
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, makeToolContext());
  const text = textOf(res);
  // 无中断：draft_claims 执行、整体完成
  assert.doesNotMatch(text, /审批门暂停/);
  assert.match(text, /draft_claims \[atom:draft-claims\]/);
  assert.match(text, /完成状态: completed/);
  // 规则门在非中断路径运行（此前所有用例止于 review_gate 中断，规则门分支未覆盖）
  assert.match(text, /确定性门/);
});

test("caseId 持久化：run JSON + Mermaid 图写入 workflow-runs 目录", async () => {
  registerBuiltinAtoms();
  const dir = mkdtempSync(join(tmpdir(), "wf-run-test-"));
  try {
    const tool = createPatentWorkflowRunTool({ model: mockModel(disclosureResponder), search: mockSearch });
    const res = await tool.execute({ input: DISCLOSURE_INPUT, caseId: "case-123" }, makeToolContext({ cwd: dir }));
    const text = textOf(res);
    const runsDir = join(dir, "data", "cases", "case-123", "workflow-runs");
    assert.match(text, /持久化:/);
    assert.ok(existsSync(join(runsDir, "case-123__patent_disclosure_v1.json")), "应生成 run JSON");
    assert.ok(existsSync(join(runsDir, "case-123__patent_disclosure_v1.mmd")), "应生成 Mermaid 图");
    const run = JSON.parse(readFileSync(join(runsDir, "case-123__patent_disclosure_v1.json"), "utf8")) as {
      manifestId: string;
      interrupted?: { stageId: string };
    };
    assert.equal(run.manifestId, "patent_disclosure_v1");
    assert.equal(run.interrupted?.stageId, "review_gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

test("createBuiltinRegistry 注册 patent_workflow_run（domain: patent）", () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("patent_workflow_run");
  assert.ok(tool, "patent_workflow_run 应已注册");
  assert.equal(tool!.domain, "patent");
  assert.equal(
    tool!.isReadOnly({ input: "x" } as unknown as Parameters<typeof tool.isReadOnly>[0]),
    false,
    "原子执行有 LLM/持久化副作用，非只读",
  );
});

// ---------------------------------------------------------------------------
// 图模式（graph=novelty|inventiveness|enablement）
// ---------------------------------------------------------------------------

/** buildJudgeSection 共享输入（报告 + 机械层判级）。 */
function judgeSectionBase() {
  return {
    graphName: "inventiveness",
    input: "一种分拣装置，包括传送带与识别传感器",
    report: "三步法分析报告：D1 为最接近的现有技术，区别特征为识别传感器，具备创造性。",
    ruleGateVerdict: "needs_revision",
    ruleGateDomains: ["patent_inventiveness"],
    samples: 1,
    singleModelFallback: 0,
    interrupted: false,
  };
}

test("buildJudgeSection：judgeModels 多模型共识 → 分歧标记 + Verdict Envelope", async () => {
  const provider: StageProvider = {
    callLLM: async (_prompt, opts) =>
      opts?.modelHint === "judge-a"
        ? JSON.stringify({ score: 0.9, rationale: "r1" })
        : JSON.stringify({ score: 0.5, rationale: "r2" }),
  };
  const text = await buildJudgeSection({
    ...judgeSectionBase(),
    judges: [
      { judgeId: "judge:judge-a", model: "model-a", modelHint: "judge-a" },
      { judgeId: "judge:judge-b", model: "model-b", modelHint: "judge-b" },
    ],
    provider,
  });
  assert.match(text, /🧭 共识判定/);
  assert.match(text, /分歧|极差 0.40/);
  assert.match(text, /Verdict Envelope: overall=disagree/);
  assert.match(text, /hash=/);
});

test("buildJudgeSection：多模型一致通过 → pass 共识 + envelope", async () => {
  const provider: StageProvider = {
    callLLM: async () => JSON.stringify({ score: 0.8, rationale: "一致认为结论正确" }),
  };
  const text = await buildJudgeSection({
    ...judgeSectionBase(),
    ruleGateVerdict: "pass",
    judges: [
      { judgeId: "judge:judge-a", modelHint: "judge-a" },
      { judgeId: "judge:judge-b", modelHint: "judge-b" },
    ],
    provider,
  });
  assert.match(text, /✅ 通过/);
  assert.match(text, /Verdict Envelope: overall=pass/);
});

test("buildJudgeSection：单模型 judgeSamples 路径保持向后兼容文本", async () => {
  const provider: StageProvider = {
    callLLM: async () => JSON.stringify({ score: 0.75, rationale: "r" }),
  };
  const text = await buildJudgeSection({
    ...judgeSectionBase(),
    singleModelFallback: 3,
    judges: [{ judgeId: "default" }],
    provider,
  });
  assert.match(text, /LLM Judge 质量分/);
  assert.match(text, /0.750/);
  assert.doesNotMatch(text, /Verdict Envelope/);
});

test("buildJudgeSection：中断 / 无结论 / 无 LLM → 跳过评分", async () => {
  const skipped = await buildJudgeSection({
    ...judgeSectionBase(),
    interrupted: true,
    judges: [{ judgeId: "judge:judge-a", modelHint: "judge-a" }],
    provider: { callLLM: async () => "{}" },
  });
  assert.equal(skipped, "");
  const noReport = await buildJudgeSection({
    ...judgeSectionBase(),
    report: "",
    judges: [{ judgeId: "judge:judge-a", modelHint: "judge-a" }],
    provider: { callLLM: async () => "{}" },
  });
  assert.match(noReport, /无结论报告/);
  const noLlm = await buildJudgeSection({
    ...judgeSectionBase(),
    judges: [{ judgeId: "judge:judge-a", modelHint: "judge-a" }],
    provider: undefined,
  });
  assert.match(noLlm, /无 LLM 通道/);
});

/** inventiveness 三步法 prompt 响应器。 */
function inventivenessResponder(prompt: string): string {
  if (prompt.includes("覆盖度")) {
    return JSON.stringify({ adequate: true, covered_features: ["传送带", "识别传感器"], missing_features: [] });
  }
  if (prompt.includes("创造性分析专家")) {
    return JSON.stringify({
      features: ["传送带", "识别传感器"],
      field: "机械分拣",
      filing_date: "2024-01-01",
      inventor_claimed_effect: "提高分拣准确率",
    });
  }
  if (prompt.includes("检索策略")) {
    return "检索策略：1) 分拣 AND 传感器；2) IPC B07C";
  }
  if (prompt.includes("三步法第一步")) {
    return JSON.stringify({
      document: "D1",
      technical_field: "机械分拣",
      disclosed_features: ["传送带"],
      rationale: "技术领域相同且公开特征最多",
    });
  }
  if (prompt.includes("是否存在可与最接近现有技术")) {
    return JSON.stringify({
      candidate_documents: ["D2"],
      combinable: false,
      motivation: "D2 无结合启示",
      obstacles: [],
      teaching_away: false,
    });
  }
  if (prompt.includes("三步法第二步")) {
    return JSON.stringify({
      distinguishing_features: ["识别传感器"],
      actual_technical_problem: "如何自动识别分拣目标",
      effect_of_diff: "提高分拣准确率",
    });
  }
  if (prompt.includes("三步法第三步")) {
    return JSON.stringify({ obvious: false, motivation: "D1 无结合启示", evidence: [], dissenting_factors: [] });
  }
  if (prompt.includes("辅助判断因素")) {
    return JSON.stringify({
      unexpected_effect: "准确率提升 30%",
      long_felt_need: "",
      technical_prejudice: "",
      commercial_success: "",
    });
  }
  if (prompt.includes("综合三步法")) {
    return JSON.stringify({
      inventive: true,
      confidence: "medium",
      key_rationale: "区别特征带来预料不到的技术效果",
      report:
        "三步法分析报告：D1 为最接近的现有技术，区别特征为识别传感器，对本领域技术人员而言并非显而易见，具备创造性。",
    });
  }
  return "{}";
}

test("graph=inventiveness 图自动执行 → 审批门中断 + 检查点输出", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ model: mockModel(inventivenessResponder), search: mockSearch });
  const res = await tool.execute(
    { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器" },
    makeToolContext({ cwd: "/tmp" }),
  );
  const text = textOf(res);
  assert.match(text, /patent_workflow_run\(graph=inventiveness\)/);
  assert.match(text, /审批门暂停/);
  assert.match(text, /检查点: patent_inventiveness-\d+/);
  assert.match(text, /规则门 verdict/);
});

test("graph=inventiveness 断点续跑：中断后 resumeCheckpointId 从检查点继续", async () => {
  registerBuiltinAtoms();
  const dir = mkdtempSync(join(tmpdir(), "wf-graph-resume-"));
  try {
    const tool = createPatentWorkflowRunTool({ model: mockModel(inventivenessResponder), search: mockSearch });
    // 第一次：approval 中断（默认全局 handler），返回 checkpointId。
    const first = await tool.execute(
      { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器", caseId: "graph-resume-1" },
      makeToolContext({ cwd: dir }),
    );
    const firstText = textOf(first);
    assert.match(firstText, /审批门暂停/);
    const checkpointMatch = firstText.match(/检查点: (patent_inventiveness-\d+)/);
    assert.ok(checkpointMatch, "应输出 checkpointId");

    // 第二次：注入放行 approval 的 handlers，resumeCheckpointId 续跑至完成。
    const passthroughApproval = {
      name: "approval-gate",
      category: "gate" as const,
      execute: async () => ({ review_passed: true }),
    };
    const handlers = new StageHandlerRegistry();
    for (const h of globalStageHandlerRegistry.list()) handlers.register(h);
    handlers.register(passthroughApproval);
    const resumedTool = createPatentWorkflowRunTool({
      model: mockModel(inventivenessResponder),
      search: mockSearch,
      handlers,
    });
    const resumed = await resumedTool.execute(
      {
        graph: "inventiveness",
        input: "一种分拣装置，包括传送带与识别传感器",
        caseId: "graph-resume-1",
        resumeCheckpointId: checkpointMatch[1],
      },
      makeToolContext({ cwd: dir }),
    );
    const resumedText = textOf(resumed);
    assert.match(resumedText, /完成状态: completed/);
    assert.match(resumedText, /规则门 verdict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph=enablement + claimText → 权利要求独立注入图 state", async () => {
  registerBuiltinAtoms();
  const responder = (prompt: string): string => {
    if (prompt.includes("充分公开审查报告")) {
      return JSON.stringify({
        sufficiently_disclosed: false,
        confidence: "medium",
        key_rationale: "缺少实施例",
        report: "充分公开审查报告：说明书公开不充分，缺少实施例，本领域技术人员无法实现。",
      });
    }
    if (prompt.includes("结构完整性")) {
      return JSON.stringify({ missing_sections: [], completeness_ok: true, notes: "ok" });
    }
    if (prompt.includes("清楚性")) {
      return JSON.stringify({ issues: [], clarity_ok: true });
    }
    if (prompt.includes("能够实现性")) {
      return JSON.stringify({
        gaps: ["§2.1.3(2) 手段含糊"],
        enablement_ok: false,
        skilled_person_assessment: "无法实现",
      });
    }
    return "{}";
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch });
  const res = await tool.execute(
    {
      graph: "enablement",
      input: "技术领域：化学。发明内容：…。具体实施方式：实施例1…",
      claimText: "1. 一种催化剂，其活性组分包含氧化铝。",
    },
    makeToolContext({ cwd: "/tmp" }),
  );
  const text = textOf(res);
  assert.match(text, /patent_workflow_run\(graph=enablement\)/);
  // claim 独立传入：claim 键保持独立文本（与 text 区分）。
  assert.ok(text.includes("1. 一种催化剂，其活性组分包含氧化铝。"), "claimText 应进入图 state");
});

test("graph=novelty 图自动执行（含数值范围节点）", async () => {
  registerBuiltinAtoms();
  const responder = (prompt: string): string => {
    if (prompt.includes("完整新颖性分析报告")) {
      return "新颖性分析报告：权利要求相对于现有技术 D1 具备新颖性（单独对比原则，逐技术特征比对见附表）。";
    }
    if (prompt.includes("数值范围")) {
      return JSON.stringify({
        assessments: [{ range: "50-80", category: "重叠区间", disclosed: false, reasoning: "端点未公开" }],
      });
    }
    if (prompt.includes("技术分析助手")) {
      return JSON.stringify({ features: ["传送带", "识别传感器"], problems: [], effects: [] });
    }
    if (prompt.includes("生成检索关键词")) {
      return JSON.stringify({ keywords: ["分拣", "传感器"] });
    }
    if (prompt.includes("专利新颖性分析专家")) {
      return JSON.stringify({
        assessments: [{ feature: "传送带", prior_art: "D1", disclosed: false, reasoning: "未公开" }],
        conclusion: "具备新颖性（置信度 0.8）",
      });
    }
    return "{}";
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch });
  const res = await tool.execute(
    { graph: "novelty", input: "一种分拣装置，温度范围为 50-80°C，包含传送带与识别传感器" },
    makeToolContext({ cwd: "/tmp" }),
  );
  const text = textOf(res);
  assert.match(text, /patent_workflow_run\(graph=novelty\)/);
  assert.match(text, /numeric_ranges/);
  assert.match(text, /新颖性分析报告/);
});

test("graph=inventiveness retrievalRounds=0 关闭检索反思回路（工具层透传）", async () => {
  registerBuiltinAtoms();
  let searchCalls = 0;
  const countingSearch: StageProvider["search"] = async (_query, _opts) => {
    searchCalls += 1;
    return [{ title: "D1", snippet: "s", url: "u" }];
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(inventivenessResponder), search: countingSearch });
  const res = await tool.execute(
    { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器", retrievalRounds: 0 },
    makeToolContext({ cwd: "/tmp" }),
  );
  // 回路关闭：search 只执行一次（审批门中断前），且无 recall_check 相关输出。
  assert.equal(searchCalls, 1, "retrievalRounds=0 时不应进入检索回路");
  assert.doesNotMatch(textOf(res), /inventiveness_recall_exhausted/);
  assert.match(textOf(res), /审批门暂停/);
});

test("graph=inventiveness retrievalRounds=1 限制重检 1 次（工具层透传）", async () => {
  registerBuiltinAtoms();
  let searchCalls = 0;
  const countingSearch: StageProvider["search"] = async (_query, _opts) => {
    searchCalls += 1;
    return [{ title: "D1", snippet: "s", url: "u" }];
  };
  // recall 恒判覆盖不足 → 应重检 1 次（共 2 次检索）后写 exhausted 放行。
  const responder = (prompt: string): string => {
    if (prompt.includes("覆盖度")) {
      return JSON.stringify({ adequate: false, covered_features: [], missing_features: ["识别传感器"] });
    }
    return inventivenessResponder(prompt);
  };
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: countingSearch });
  const res = await tool.execute(
    { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器", retrievalRounds: 1 },
    makeToolContext({ cwd: "/tmp" }),
  );
  assert.equal(searchCalls, 2, "retrievalRounds=1 时首轮 + 1 次重检");
  assert.match(textOf(res), /inventiveness_recall_exhausted/);
});

test("buildWorkflowProvider: modelHint 映射覆盖模型（P2-1 模型分层），未命中用默认", async () => {
  const seen: string[] = [];
  const model: SatiToolModelClient = {
    async *stream(request: CanonicalModelRequest) {
      seen.push(request.model);
      yield textDelta("ok");
    },
  };
  const provider = buildWorkflowProvider({ model, modelHints: { cheap: { model: "deepseek-v4-flash" } } });
  assert.ok(provider?.callLLM, "应装配 callLLM");
  const out = await provider!.callLLM!("prompt", { modelHint: "cheap" });
  assert.equal(out, "ok");
  assert.equal(seen[0], "deepseek-v4-flash", "命中 cheap 映射应覆盖模型");
  // 未命中 hint → 默认模型（行为不变）。
  await provider!.callLLM!("prompt", { modelHint: "no_such_hint" });
  assert.equal(seen[1], DEFAULT_MODEL_ID, "未命中映射应回退默认模型");
  // 不传 hint → 默认模型。
  await provider!.callLLM!("prompt");
  assert.equal(seen[2], DEFAULT_MODEL_ID, "无 hint 应使用默认模型");
});

test("graph=inventiveness judgeSamples 开启 → LLM Judge 质量分附在结果尾部（P2-3）", async () => {
  registerBuiltinAtoms();
  const responder = (prompt: string): string => {
    if (prompt.includes("你是专利领域质量评估法官")) {
      return JSON.stringify({ score: 0.8, rationale: "三步法论证完整" });
    }
    return inventivenessResponder(prompt);
  };
  // 放行 approval 使图完整跑完（judge 仅在未中断时执行）。
  const passthroughApproval = {
    name: "approval-gate",
    category: "gate" as const,
    execute: async () => ({ review_passed: true }),
  };
  const handlers = new StageHandlerRegistry();
  for (const h of globalStageHandlerRegistry.list()) handlers.register(h);
  handlers.register(passthroughApproval);
  const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch, handlers });
  const res = await tool.execute(
    { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器", judgeSamples: 1 },
    makeToolContext({ cwd: "/tmp" }),
  );
  const text = textOf(res);
  assert.match(text, /LLM Judge 质量分/);
  assert.match(text, /0\.800/);
  assert.match(text, /不影响规则门判级/);
});

test("graph=inventiveness 缺省不启用 LLM Judge（P2-3 默认关闭）", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ model: mockModel(inventivenessResponder), search: mockSearch });
  const res = await tool.execute(
    { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器" },
    makeToolContext({ cwd: "/tmp" }),
  );
  assert.doesNotMatch(textOf(res), /LLM Judge/);
});

test("graph=inventiveness 同 case 历史反馈注入 conclude 提示（P2-4 HITL 反馈回流）", async () => {
  registerBuiltinAtoms();
  const dir = mkdtempSync(join(tmpdir(), "wf-feedback-"));
  try {
    // 先写一条历史反馈（模拟此前审批驳回）。
    const file = join(dir, caseInventivenessFeedbackPath("fb-case"));
    await appendInventivenessFeedback(file, {
      caseId: "fb-case",
      originalOutputPreview: "结论：具备创造性",
      verdict: "rejected",
      feedback: "D1 已公开区别特征",
      decidedAt: "2026-08-18T00:00:00.000Z",
    });
    let concludePrompt = "";
    const responder = (prompt: string): string => {
      if (prompt.includes("综合三步法")) concludePrompt = prompt;
      return inventivenessResponder(prompt);
    };
    const passthroughApproval = {
      name: "approval-gate",
      category: "gate" as const,
      execute: async () => ({ review_passed: true }),
    };
    const handlers = new StageHandlerRegistry();
    for (const h of globalStageHandlerRegistry.list()) handlers.register(h);
    handlers.register(passthroughApproval);
    const tool = createPatentWorkflowRunTool({ model: mockModel(responder), search: mockSearch, handlers });
    const res = await tool.execute(
      { graph: "inventiveness", input: "一种分拣装置，包括传送带与识别传感器", caseId: "fb-case" },
      makeToolContext({ cwd: dir }),
    );
    assert.match(textOf(res), /完成状态: completed/);
    assert.ok(concludePrompt.includes("历史人工反馈"), "conclude prompt 应含历史反馈摘要");
    assert.ok(concludePrompt.includes("D1 已公开区别特征"), "应含反馈内容");
    // 写侧半桥：运行时落 session→case 绑定（审批回调按 sessionId 反查 caseId）。
    const bindingFile = join(dir, "data/cases/fb-case/workflow-runs/session-binding.json");
    assert.ok(existsSync(bindingFile), "session 绑定文件应已落盘");
    const binding = JSON.parse(readFileSync(bindingFile, "utf8")) as {
      sessionId: string;
      boundAt: string;
      graph?: string;
    };
    assert.equal(binding.sessionId, "s1");
    assert.equal(binding.graph, "inventiveness", "绑定应带链路标识供反馈溯源");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
