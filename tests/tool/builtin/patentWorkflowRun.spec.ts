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
import { createPatentWorkflowRunTool } from "../../../src/tool/builtin/patentWorkflowRunTool.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

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

/** inventiveness 三步法 prompt 响应器。 */
function inventivenessResponder(prompt: string): string {
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
