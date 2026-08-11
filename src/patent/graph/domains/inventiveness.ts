/**
 * src/patent/graph/domains/inventiveness — 创造性分析子图（专利法 A22.3，三步法）。
 *
 * 节点链：parse（画像/时间基准）→ build_query → search（复用）→ closest（Step1
 * 最接近现有技术）→ diff（Step2 区别特征+实际解决技术问题）→ hint（Step3 技术启示）
 * → secondary（辅助因素）→ conclude（结论+反事后诸葛亮自检）→ approval → rule_gate。
 *
 * 对齐 Mady domains/inventiveness（7 节点 Pregel）：每 LLM 节点 JSON schema 结构化
 * 输出（temperature 0.2），LLM 缺失/失败 → markDegraded（确定性骨架仍可跑）。
 */

import { GraphBuilder, type GraphState } from "../index.js";
import { getStateArray, getStateString } from "../state.js";
import { globalStageHandlerRegistry, type StageHandlerRegistry } from "../../atoms/index.js";
import { handlerNode, llmNode, resolveInput, ruleGateNode } from "./shared.js";

export type BuildInventivenessGraphOptions = {
  handlers?: StageHandlerRegistry;
  /** 规则门收口（缺省 true）。 */
  ruleGate?: boolean;
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean;
};

// ---------------------------------------------------------------------------
// 节点 JSON Schema
// ---------------------------------------------------------------------------

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    features: { type: "array", items: { type: "string" }, description: "技术特征" },
    field: { type: "string", description: "所属技术领域" },
    filing_date: { type: "string", description: "申请日/优先权日（如提供）" },
    inventor_claimed_effect: { type: "string", description: "发明声称的技术效果" },
  },
  required: ["features", "field"],
} as const;

const CLOSEST_SCHEMA = {
  type: "object",
  properties: {
    document: { type: "string", description: "最接近现有技术（对比文件）标识" },
    technical_field: { type: "string", description: "技术领域" },
    disclosed_features: { type: "array", items: { type: "string" }, description: "已公开特征" },
    rationale: { type: "string", description: "选择理由（领域/问题/公开特征最多）" },
  },
  required: ["document", "rationale"],
} as const;

const DIFF_SCHEMA = {
  type: "object",
  properties: {
    distinguishing_features: { type: "array", items: { type: "string" }, description: "区别技术特征" },
    actual_technical_problem: { type: "string", description: "实际解决的技术问题（不得含解决手段）" },
    effect_of_diff: { type: "string", description: "区别特征带来的技术效果" },
  },
  required: ["distinguishing_features", "actual_technical_problem"],
} as const;

const HINT_SCHEMA = {
  type: "object",
  properties: {
    obvious: { type: "boolean", description: "是否显而易见" },
    motivation: { type: "string", description: "技术启示（改进动机/结合启示/公知常识/有限试验）" },
    evidence: { type: "array", items: { type: "string" }, description: "启示证据" },
    dissenting_factors: { type: "array", items: { type: "string" }, description: "反面因素（反向教导/技术障碍）" },
  },
  required: ["obvious", "motivation"],
} as const;

const SECONDARY_SCHEMA = {
  type: "object",
  properties: {
    unexpected_effect: { type: "string", description: "预料不到的技术效果（量化数据）" },
    long_felt_need: { type: "string", description: "长期渴望解决的技术问题" },
    technical_prejudice: { type: "string", description: "技术偏见克服" },
    commercial_success: { type: "string", description: "商业成功（如有）" },
  },
} as const;

const CONCLUDE_SCHEMA = {
  type: "object",
  properties: {
    inventive: { type: "boolean", description: "是否具备创造性" },
    confidence: { type: "string", description: "high/medium/low" },
    key_rationale: { type: "string", description: "核心理由" },
    report: { type: "string", description: "完整三步法分析报告" },
  },
  required: ["inventive", "confidence", "key_rationale", "report"],
} as const;

// ---------------------------------------------------------------------------
// 子图构建
// ---------------------------------------------------------------------------

/** 构建创造性分析子图（A22.3 三步法）。 */
export function buildInventivenessGraph(options: BuildInventivenessGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const builder = new GraphBuilder();

  const search = handlers.lookup("search");
  const approval = handlers.lookup("approval-gate");

  builder.addNode(
    "parse",
    llmNode({
      outputKey: "inventiveness_parse",
      buildPrompt: state => {
        const input = resolveInput(state, ["input", "text", "claim"]);
        return [
          "你是专利创造性分析专家（专利法 A22.3）。解析以下权利要求/技术方案：",
          "- 提取技术特征，构建所属领域技术人员画像",
          "- 确定申请日/优先权日时间基准（如提供）",
          "- 记录发明人声称的技术效果（不以声称的问题为准）",
          "```",
          input.slice(0, 8000),
          "```",
          "请严格输出 JSON：{ features, field, filing_date, inventor_claimed_effect }。",
        ].join("\n");
      },
      schema: PARSE_SCHEMA,
    }),
  );
  builder.addNode(
    "build_query",
    llmNode({
      outputKey: "inventiveness_query",
      temperature: 0,
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        return [
          "基于创造性分析解析结果，生成现有技术检索策略：",
          "- 最接近现有技术的检索方向（同技术领域/同技术问题）",
          "- 三层检索式：精确层 → 扩展层 → 语义层",
          "- 含布尔表达式与 IPC 限定（如可推断）",
          "```",
          parse.slice(0, 4000),
          "```",
          "输出检索策略文本（至少 3 组检索式）。",
        ].join("\n");
      },
    }),
  );
  if (search !== undefined) {
    builder.addNode("search", handlerNode(search));
    // prepare_query：把 build_query 的策略文本映射为 search handler 的 query 键。
    builder.addNode("prepare_query", async ({ state }) => ({
      query: getStateString(state, "inventiveness_query") || getStateString(state, "inventiveness_parse").slice(0, 200),
    }));
    builder.addEdge("build_query", "prepare_query");
    builder.addEdge("prepare_query", "search");
    builder.addEdge("search", "closest");
  } else {
    builder.addEdge("build_query", "closest");
  }
  builder.addNode(
    "closest",
    llmNode({
      outputKey: "inventiveness_closest",
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        const priorArt = getStateArray(state, "prior_art");
        const priorArtText = priorArt
          .map(d => (typeof d === "object" && d !== null ? JSON.stringify(d) : String(d)))
          .join("\n");
        return [
          "三步法第一步：确定最接近的现有技术（D1）。",
          "选择标准：技术领域相同/相近 → 技术问题最接近 → 公开技术特征最多。",
          "不得脱离检索结果自行选择；候选多时逐个试判。",
          "```",
          parse.slice(0, 4000),
          "```",
          "【现有技术候选】",
          priorArtText.slice(0, 6000) || "（无检索结果，基于内置知识推断）",
          "",
          "请严格输出 JSON：{ document, technical_field, disclosed_features, rationale }。",
        ].join("\n");
      },
      schema: CLOSEST_SCHEMA,
    }),
  );
  builder.addNode(
    "diff",
    llmNode({
      outputKey: "inventiveness_diff",
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        const closest = getStateString(state, "inventiveness_closest");
        return [
          "三步法第二步：确定区别技术特征和实际解决的技术问题。",
          "- 基于 D1 公开特征逐一比对，列出区别特征",
          "- 基于区别特征的技术效果客观确定实际解决的技术问题（不得包含解决手段）",
          "- 检查技术问题是否包含对区别特征的指引（事后诸葛亮风险）",
          "```",
          parse.slice(0, 4000),
          "```",
          "【D1 最接近现有技术】",
          closest.slice(0, 3000),
          "",
          "请严格输出 JSON：{ distinguishing_features, actual_technical_problem, effect_of_diff }。",
        ].join("\n");
      },
      schema: DIFF_SCHEMA,
    }),
  );
  builder.addNode(
    "hint",
    llmNode({
      outputKey: "inventiveness_hint",
      buildPrompt: state => {
        const diff = getStateString(state, "inventiveness_diff");
        const parse = getStateString(state, "inventiveness_parse");
        return [
          "三步法第三步：判断要求保护的发明对本领域技术人员是否显而易见。",
          "技术启示来源：改进动机/结合启示（D1+D2 能否结合、有无技术障碍）/公知常识/逻辑推理与有限试验。",
          "发明类型差异化：组合/选择/转用/要素变更/开拓性/改进发明。",
          "```",
          parse.slice(0, 3000),
          "```",
          "【区别特征与实际解决的技术问题】",
          diff.slice(0, 3000),
          "",
          "请严格输出 JSON：{ obvious, motivation, evidence, dissenting_factors }。",
        ].join("\n");
      },
      schema: HINT_SCHEMA,
    }),
  );
  builder.addNode(
    "secondary",
    llmNode({
      outputKey: "inventiveness_secondary",
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        return [
          "辅助判断因素复核：",
          "- 预料不到的技术效果（须有量化数据支撑）",
          "- 解决了长期渴望解决的技术问题",
          "- 克服了技术偏见",
          "- 商业成功（如有，须证明与发明特征有因果关系）",
          "```",
          parse.slice(0, 3000),
          "```",
          "请严格输出 JSON：{ unexpected_effect, long_felt_need, technical_prejudice, commercial_success }。",
        ].join("\n");
      },
      schema: SECONDARY_SCHEMA,
    }),
  );
  builder.addNode(
    "conclude",
    llmNode({
      outputKey: "inventiveness_conclusion",
      buildPrompt: state => {
        const parts = [
          "【解析】",
          getStateString(state, "inventiveness_parse"),
          "【最接近现有技术】",
          getStateString(state, "inventiveness_closest"),
          "【区别特征】",
          getStateString(state, "inventiveness_diff"),
          "【技术启示】",
          getStateString(state, "inventiveness_hint"),
          "【辅助因素】",
          getStateString(state, "inventiveness_secondary"),
        ];
        return [
          "综合三步法各步骤，生成创造性分析结论：",
          "- 完整三步法报告（最接近现有技术 → 区别特征 → 技术启示）",
          "- 反事后诸葛亮自检（结论不得依赖发明本身披露的技术启示）",
          "- 不得仅凭区别特征数量判断创造性",
          "- 结论标注置信度（high/medium/low），回避绝对化表述",
          "",
          parts.join("\n").slice(0, 8000),
          "",
          "请严格输出 JSON：{ inventive, confidence, key_rationale, report }。",
        ].join("\n");
      },
      schema: CONCLUDE_SCHEMA,
    }),
  );

  // 边：parse → build_query → prepare_query → (search) → closest → diff → hint → secondary → conclude → 尾链
  builder.addEdge("parse", "build_query");
  builder.addEdge("closest", "diff");
  builder.addEdge("diff", "hint");
  builder.addEdge("hint", "secondary");
  builder.addEdge("secondary", "conclude");

  const withRuleGate = options.ruleGate !== false;
  if (withRuleGate) builder.addNode("rule_gate", ruleGateNode(["patent_inventiveness"]));
  if (approval !== undefined && options.includeApproval !== false) {
    builder.addNode("approval", handlerNode(approval, { review_context: "创造性三步法结论需人工复核" }));
    builder.addEdge("conclude", "approval");
    builder.addEdge("approval", withRuleGate ? "rule_gate" : "__end__");
  } else {
    builder.addEdge("conclude", withRuleGate ? "rule_gate" : "__end__");
  }
  if (withRuleGate) builder.addEdge("rule_gate", "__end__");

  return builder;
}

/** 从图运行结果提取创造性结论（供调用方/评测读取）。 */
export function extractInventivenessResult(state: GraphState): {
  inventive?: boolean;
  confidence?: string;
  report?: string;
} {
  const raw = getStateString(state, "inventiveness_conclusion");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { inventive?: unknown; confidence?: unknown; report?: unknown };
    return {
      inventive: typeof parsed.inventive === "boolean" ? parsed.inventive : undefined,
      confidence: typeof parsed.confidence === "string" ? parsed.confidence : undefined,
      report: typeof parsed.report === "string" ? parsed.report : undefined,
    };
  } catch {
    return {};
  }
}
