import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, { cwd: "/tmp" } as never);
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
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, {} as never);
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
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, {} as never);
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
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, {} as never);
  const text = textOf(res);
  assert.match(text, /未提供模型客户端/);
  assert.doesNotMatch(text, /patent_workflow_run\(patent_disclosure_v1\)/);
});

test("未知 manifest fail-closed", async () => {
  registerBuiltinAtoms();
  const tool = createPatentWorkflowRunTool({ model: mockModel(disclosureResponder), search: mockSearch });
  const res = await tool.execute({ input: "x", manifestId: "no_such_manifest" }, {} as never);
  assert.match(textOf(res), /未知 manifest/);
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
  const res = await tool.execute({ input: DISCLOSURE_INPUT }, {} as never);
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
    const res = await tool.execute({ input: DISCLOSURE_INPUT, caseId: "case-123" }, { cwd: dir } as never);
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
  assert.equal(tool!.isReadOnly({ input: "x" } as never), false, "原子执行有 LLM/持久化副作用，非只读");
});
