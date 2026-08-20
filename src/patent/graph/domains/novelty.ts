/**
 * src/patent/graph/domains/novelty — 新颖性分析子图（专利法 A22.2）。
 *
 * 节点链：extract（复用）→ keywords（复用）→ search（复用）→ compare（复用
 * novelty 原子，单独对比）→ numeric_range（新增：数值范围专项判定）→ conclude
 * （LLM 完整报告）→ approval（复用审批门）。
 *
 * 输入契约（state）：text / extraction_input（技术方案或权利要求文本，多键回退）；
 * prior_art（可选，用户已提供的现有技术证据）。
 */

import { GraphBuilder, type GraphNode } from "../index.js";
import { markDegraded } from "../degradation.js";
import { getStateArray, getStateString } from "../state.js";
import { globalStageHandlerRegistry, type StageHandlerRegistry } from "../../atoms/index.js";
import { handlerNode, llmNode, resolveInput, ruleGateNode } from "./shared.js";

export type BuildNoveltyGraphOptions = {
  handlers?: StageHandlerRegistry;
  /** 规则门收口（缺省 true）。 */
  ruleGate?: boolean;
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean;
  /** 溯源包装钩子（ProvenanceCollector.wrapNode）：addNode 统一入口，透传 GraphBuilder。 */
  onAddNode?: (name: string, node: GraphNode) => GraphNode;
};

const NOVELTY_SCOPE = "单独对比原则（新颖性，专利法 A22.2）";

// ---------------------------------------------------------------------------
// numeric_range —— 数值范围/上下位概念专项判定（新增确定性节点）
// ---------------------------------------------------------------------------

/** 数值范围表述检测（端点值/区间/带单位）。 */
const NUMERIC_RANGE_PATTERN =
  /\d+(?:\.\d+)?\s*(?:[-~～—]|至|到)\s*\d+(?:\.\d+)?|(?:≥|≤|>|<)\s*\d+(?:\.\d+)?|(?:大于|小于|超过|低于|至少|不超过|不低于|不高于|多于|少于)\s*\d+(?:\.\d+)?/g;

/** 从文本提取数值范围表述片段（去重）。 */
export function extractNumericRanges(text: string): string[] {
  if (!text) return [];
  const matches = text.match(NUMERIC_RANGE_PATTERN) ?? [];
  return [...new Set(matches.map(m => m.trim()).filter(Boolean))];
}

const NUMERIC_RANGE_SCHEMA = {
  type: "object",
  properties: {
    assessments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          range: { type: "string", description: "数值范围表述" },
          category: { type: "string", description: "情形分类（端点值/重叠区间/参数特征/用途限定/其他）" },
          disclosed: { type: "boolean", description: "是否被现有技术公开" },
          reasoning: { type: "string", description: "判定依据（审查指南数值范围规则）" },
        },
        required: ["range", "category", "disclosed"],
      },
    },
  },
  required: ["assessments"],
} as const;

const numericRangeNode: GraphNode = async ({ state, provider }) => {
  const features = getStateArray(state, "features").map(String).join("；");
  // 检测源：特征 + 权利要求 + 原始输入文本（数值范围常出现在说明书而非提炼后的特征）。
  const claim = resolveInput(state, ["claim", "claim_text"]);
  const rawText = resolveInput(state, ["text", "extraction_input"]);
  const ranges = extractNumericRanges(`${features} ${claim} ${rawText}`);
  if (ranges.length === 0) {
    return { numeric_range_result: "未检测到数值范围表述，无需专项分析", numeric_ranges: [] };
  }
  if (!provider?.callLLM) {
    const delta: Record<string, unknown> = {};
    markDegraded(
      delta,
      "numeric_range_result",
      `检测到数值范围 ${ranges.length} 处，需 LLM 专项判定（provider 缺失）`,
      "llm_unavailable",
      "数值范围专项判定需要 LLM",
    );
    delta.numeric_ranges = ranges;
    return delta;
  }
  const priorArt = getStateArray(state, "prior_art");
  const priorArtText = priorArt
    .map(d => (typeof d === "object" && d !== null ? JSON.stringify(d) : String(d)))
    .join("\n");
  const prompt = [
    `你是专利新颖性分析专家。对比范围：${NOVELTY_SCOPE}`,
    "对以下数值范围表述做专项新颖性判定（审查指南第二部分第三章：数值范围/端点值/上下位概念规则）：",
    "- 端点值落入现有技术公开范围 → 通常不具备新颖性",
    "- 区间与现有技术区间重叠 → 需比较端点与公开程度",
    "- 参数/性能特征：仅当现有技术明确公开相同参数定义",
    "- 用途限定：不影响方案实质时一般不具有限定作用",
    "",
    "【数值范围】",
    ranges.map((r, i) => `[${i + 1}] ${r}`).join("\n"),
    "",
    "【现有技术证据】",
    priorArtText.slice(0, 4000) || "（无证据，标注 confidence 低）",
    "",
    "请严格输出 JSON：assessments 为每个数值范围的 { range, category, disclosed, reasoning }。",
  ].join("\n");
  try {
    const raw = await provider.callLLM(prompt, { jsonSchema: NUMERIC_RANGE_SCHEMA, temperature: 0.1 });
    return { numeric_range_result: raw, numeric_ranges: ranges };
  } catch (err) {
    const delta: Record<string, unknown> = {};
    markDegraded(
      delta,
      "numeric_range_result",
      "数值范围专项判定失败（LLM 错误）",
      "llm_unavailable",
      `numeric_range LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    delta.numeric_ranges = ranges;
    return delta;
  }
};

// ---------------------------------------------------------------------------
// 子图构建
// ---------------------------------------------------------------------------

/** 构建新颖性分析子图（A22.2）。 */
export function buildNoveltyGraph(options: BuildNoveltyGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const builder = new GraphBuilder({ onAddNode: options.onAddNode });

  const extract = handlers.lookup("extract");
  if (extract === undefined) throw new Error("buildNoveltyGraph: 缺少内置原子 extract（请先 registerBuiltinAtoms）");
  const keywords = handlers.lookup("keywords");
  const search = handlers.lookup("search");
  const novelty = handlers.lookup("novelty");
  const approval = handlers.lookup("approval-gate");

  builder.addNode(
    "extract",
    handlerNode(extract, {
      extraction_type: "提取权利要求与现有技术中的技术特征",
      output_key: "features",
      domain: "专利",
    }),
  );
  if (keywords !== undefined) {
    builder.addNode("keywords", handlerNode(keywords));
  }
  if (search !== undefined) {
    builder.addNode("search", handlerNode(search));
  }
  if (novelty !== undefined) {
    builder.addNode("compare", handlerNode(novelty, { novelty_scope: NOVELTY_SCOPE }));
  }
  builder.addNode("numeric_range", numericRangeNode);
  builder.addNode(
    "conclude",
    llmNode({
      outputKey: "novelty_report",
      temperature: 0.1,
      buildPrompt: state => {
        const compareResult = getStateString(state, "novelty_result") || getStateString(state, "novelty_conclusion");
        const numeric = getStateString(state, "numeric_range_result");
        const coverage = getStateString(state, "evidence_coverage");
        return [
          "你是专利新颖性分析专家。基于以下逐特征对比结果与数值范围专项判定，生成完整新颖性分析报告。",
          "要求：",
          "- 明确区分对比文件，遵循单独对比原则（不得将多份文件结合）",
          "- 逐特征列出公开情况，标注证据来源",
          "- 结论附置信度，回避绝对化表述",
          "",
          "【逐特征对比】",
          compareResult.slice(0, 6000) || "（无对比结果）",
          "",
          "【数值范围专项判定】",
          numeric.slice(0, 4000) || "（无）",
          "",
          `【证据覆盖】${coverage || "unknown"}`,
          "",
          "输出新颖性分析报告（具备/不具备新颖性 + 逐特征对比表 + 置信度）。",
        ].join("\n");
      },
    }),
  );

  // 边：extract → (keywords) → (search) → compare → numeric_range → conclude → 尾链
  // compare（novelty handler）缺失时跳过，链路直连 numeric_range（features 由 extract 产出）。
  const compareTail = novelty !== undefined ? "compare" : "numeric_range";
  builder.addEdge("extract", keywords !== undefined ? "keywords" : compareTail);
  if (keywords !== undefined) builder.addEdge("keywords", search !== undefined ? "search" : compareTail);
  if (search !== undefined) builder.addEdge("search", compareTail);
  if (novelty !== undefined) builder.addEdge("compare", "numeric_range");
  builder.addEdge("numeric_range", "conclude");

  // 尾链：conclude → (approval) → (rule_gate) → END；无中间节点时直连 END。
  const withRuleGate = options.ruleGate !== false;
  if (withRuleGate) builder.addNode("rule_gate", ruleGateNode(["patent_novelty"]));
  if (approval !== undefined && options.includeApproval !== false) {
    builder.addNode("approval", handlerNode(approval, { review_context: "新颖性分析报告需人工复核" }));
    builder.addEdge("conclude", "approval");
    builder.addEdge("approval", withRuleGate ? "rule_gate" : "__end__");
  } else {
    builder.addEdge("conclude", withRuleGate ? "rule_gate" : "__end__");
  }
  if (withRuleGate) builder.addEdge("rule_gate", "__end__");

  return builder;
}

/**
 * 节点输入声明表（溯源 derivedFrom 链，评审 P9/P13）：节点名 → 上游 state keys。
 * 仅覆盖需要决策链的 LLM/推理节点；rule_gate/approval 不声明（rule_gate 经
 * collectStateText 读全量、审批门由 approval_gate 记录）。缺失/漂移只记产出不伪造因果。
 */
export const NOVELTY_INPUT_DECLARATIONS: Readonly<Record<string, readonly string[]>> = {
  extract: [],
  keywords: ["features"],
  search: ["query"],
  compare: ["features", "prior_art"],
  numeric_range: ["novelty_result", "novelty_conclusion"],
  conclude: ["novelty_result", "novelty_conclusion", "numeric_range_result", "evidence_coverage"],
};
