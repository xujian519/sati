/**
 * src/patent/graph/domains/claim-breadth — 权利要求清楚/支持分析子图（专利法 A26.4）。
 *
 * 节点链：load（确定性：权项切分 + 说明书切片）→ anchor_evidence（确定性：
 * 特征→说明书连续子串命中）→ clarity（术语清楚）→ support（以说明书为依据）
 * → functional_limit（功能性限定是否过宽）→ conclude → approval → rule_gate。
 *
 * 与 enablement（A26.3）子图对称：load/anchor_evidence 零 LLM，LLM 只做法律判断；
 * anchor_evidence 为下游提供可解释证据，未命中特征不会被静默丢弃。
 */

import { GraphBuilder } from "../engine.js";
import { GRAPH_END, type GraphNode, type GraphState } from "../types.js";
import { getStateObject, getStateString } from "../state.js";
import { matchFeature, type FeatureMatch } from "../../anchor/index.js";
import { globalStageHandlerRegistry, type StageHandlerRegistry } from "../../atoms/index.js";
import { dataBlock } from "../../prompt-hygiene.js";
import { buildSpecContext, splitSpecSections } from "./enablement.js";
import { handlerNode, llmNode, resolveInput, ruleGateNode } from "./shared.js";

export type BuildClaimBreadthGraphOptions = {
  handlers?: StageHandlerRegistry;
  /** 规则门收口（缺省 true）。 */
  ruleGate?: boolean;
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean;
  /** 溯源包装钩子（ProvenanceCollector.wrapNode）：addNode 统一入口，透传 GraphBuilder。 */
  onAddNode?: (name: string, node: GraphNode) => GraphNode;
};

/** 权要文本在 workflowCtx 中的候选键（claimText 由工具层映射）。 */
const CLAIM_INPUT_KEYS = ["claim", "claim_text", "claims", "claimText"];
const SPEC_INPUT_KEYS = ["spec", "source_text", "text", "input"];

/** 权项编号行首正则：`1.` / `1、` / `1．`。 */
const CLAIM_NUMBER_RE = /^\s*(\d+)\s*[.、．]\s*/;

/** 单个权项。 */
export type ParsedClaimText = { claimNo: number; text: string };

/**
 * 按编号行首切分权项；无编号时整体作为第 1 项。
 *
 * 编号不连续由 claim_lint（#830 M4）报告；本函数只做切片，不修复编号。
 */
export function splitClaims(claimText: string): ParsedClaimText[] {
  const lines = claimText.split("\n");
  const hasNumbering = lines.some(line => CLAIM_NUMBER_RE.test(line));
  const claims: ParsedClaimText[] = [];
  let current: ParsedClaimText | undefined;
  for (const line of lines) {
    const match = CLAIM_NUMBER_RE.exec(line);
    if (match !== null) {
      if (current !== undefined) claims.push(current);
      current = { claimNo: Number(match[1]), text: line.replace(CLAIM_NUMBER_RE, "").trim() };
    } else if (current !== undefined) {
      const trimmed = line.trim();
      if (trimmed.length > 0) current.text = `${current.text}\n${trimmed}`;
    } else if (!hasNumbering && line.trim().length > 0) {
      // 无编号权项：首个非空行整体作为第 1 项；有编号时跳过前置标题行。
      current = { claimNo: 1, text: line.trim() };
    }
  }
  if (current !== undefined) claims.push(current);
  return claims;
}

/** 特征切分标记：分句与并列。 */
const FEATURE_SPLIT_RE = /[，,；;。]/;

/**
 * 从权项文本中确定性提取候选特征片段。
 *
 * 只做机械切分（去前序/引导词、去纯连接词），不做语义概括——片段能否命中说明书
 * 由 anchor 判定；未命中会作为缺口回显，而不是被静默丢弃。
 */
export function extractClaimFeatures(claimText: string): string[] {
  const features: string[] = [];
  for (const raw of claimText.split(FEATURE_SPLIT_RE)) {
    const segment = raw
      .replace(/^\s*(?:其特征在于|其中|并且|且|还|所述)+/u, "")
      .replace(/^\s*根据权利要求\s*[0-9、,，和或及与\-~～至到\s]+?所述(?:的)?/u, "")
      .trim();
    if (segment.length < 4) continue;
    if (/^(?:其特征在于|包括|包含|所述)$/u.test(segment)) continue;
    features.push(segment);
  }
  return features;
}

/** 单个权项的锚点证据：每特征一条命中（未命中 hit=null）。 */
export type ClaimAnchor = {
  claimNo: number;
  features: FeatureMatch[];
};

/**
 * 确定性锚点证据：权项特征在说明书中做连续子串匹配。
 *
 * 返回逐权项证据与汇总计数；未命中不抛错，由调用方（LLM 节点/规则门）作为缺口处理。
 */
export function anchorClaimFeatures(
  claimText: string,
  specText: string,
): { claims: ClaimAnchor[]; matched: number; unmatched: number } {
  const claims = splitClaims(claimText).map(claim => ({
    claimNo: claim.claimNo,
    features: extractClaimFeatures(claim.text).map(feature => matchFeature(specText, feature)),
  }));
  let matched = 0;
  let unmatched = 0;
  for (const claim of claims) {
    for (const feature of claim.features) {
      if (feature.hit === null) unmatched += 1;
      else matched += 1;
    }
  }
  return { claims, matched, unmatched };
}

/** 把锚点证据格式化为提示块（未命中显式标注）。 */
export function formatAnchorEvidence(state: GraphState): string {
  const evidence = getStateObject(state, "claim_anchor_evidence") as {
    claims?: ClaimAnchor[];
    matched?: number;
    unmatched?: number;
  };
  const claims = Array.isArray(evidence.claims) ? evidence.claims : [];
  if (claims.length === 0) return "";
  const lines: string[] = [
    "【权利要求锚点证据（确定性连续子串匹配；未命中=说明书中无该原文片段）】",
    `命中 ${evidence.matched ?? 0} 条 / 未命中 ${evidence.unmatched ?? 0} 条`,
  ];
  for (const claim of claims) {
    lines.push(`权利要求 ${claim.claimNo}:`);
    for (const feature of claim.features) {
      const span = feature.hit === null ? "未命中" : `命中 [${feature.hit.start}, ${feature.hit.end})`;
      lines.push(`  - 「${feature.feature}」 ${span}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 节点 JSON Schema
// ---------------------------------------------------------------------------

const CLARITY_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim_no: { type: "number", description: "权项编号" },
          problem: { type: "string", description: "问题描述" },
          severity: { type: "string", description: "major/minor" },
        },
        required: ["claim_no", "problem"],
      },
    },
    clarity_ok: { type: "boolean", description: "权利要求是否清楚" },
  },
  required: ["issues", "clarity_ok"],
} as const;

const SUPPORT_SCHEMA = {
  type: "object",
  properties: {
    gaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim_no: { type: "number", description: "权项编号" },
          feature: { type: "string", description: "缺少说明书依据的特征" },
          rationale: { type: "string", description: "为何不能概括到该范围" },
        },
        required: ["claim_no", "feature"],
      },
    },
    support_ok: { type: "boolean", description: "权利要求是否以说明书为依据" },
  },
  required: ["gaps", "support_ok"],
} as const;

const FUNCTIONAL_LIMIT_SCHEMA = {
  type: "object",
  properties: {
    overbroad: { type: "boolean", description: "功能性限定是否超出说明书公开的实施方式" },
    issues: { type: "array", items: { type: "string" }, description: "过宽的功能性限定说明" },
  },
  required: ["overbroad", "issues"],
} as const;

const CONCLUDE_SCHEMA = {
  type: "object",
  properties: {
    support_ok: { type: "boolean", description: "是否满足 A26.4 以说明书为依据" },
    clarity_ok: { type: "boolean", description: "是否满足 A26.4 清楚" },
    gaps: { type: "array", items: { type: "string" }, description: "A26.4 缺陷清单" },
    confidence: { type: "string", description: "high/medium/low" },
    key_rationale: { type: "string", description: "核心理由" },
    report: { type: "string", description: "完整 A26.4 审查报告" },
  },
  required: ["support_ok", "clarity_ok", "gaps", "confidence", "key_rationale", "report"],
} as const;

// ---------------------------------------------------------------------------
// 子图构建
// ---------------------------------------------------------------------------

/** 构建权利要求清楚/支持分析子图（A26.4）。 */
export function buildClaimBreadthGraph(options: BuildClaimBreadthGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const builder = new GraphBuilder({ onAddNode: options.onAddNode });
  const approval = handlers.lookup("approval-gate");

  // load：确定性节点，读取权项与说明书并做切片。
  builder.addNode("load", async ({ state }) => {
    const claimText = resolveInput(state, CLAIM_INPUT_KEYS);
    const specText = resolveInput(state, SPEC_INPUT_KEYS);
    return {
      claim_count: splitClaims(claimText).length,
      claim_text_normalized: claimText,
      claim_spec_sections: splitSpecSections(specText),
    };
  });

  // anchor_evidence：确定性节点，不调 LLM；未命中显式保留。
  builder.addNode("anchor_evidence", async ({ state }) => {
    const claimText = resolveInput(state, CLAIM_INPUT_KEYS);
    const specText = resolveInput(state, SPEC_INPUT_KEYS);
    return { claim_anchor_evidence: anchorClaimFeatures(claimText, specText) };
  });

  builder.addNode(
    "clarity",
    llmNode({
      outputKey: "claim_breadth_clarity",
      buildPrompt: state => {
        const claimText = resolveInput(state, CLAIM_INPUT_KEYS);
        return [
          "专利法 A26.4 审查——第一步：权利要求是否清楚。",
          "检查：主题名称是否明确、术语含义是否确定、是否存在相对性/不确定表述（如“约”“等”“适当”）、",
          "并列技术方案是否可区分、从权引用关系是否清楚。",
          dataBlock(claimText.slice(0, 6000)),
          "请严格输出 JSON：{ issues（claim_no/problem/severity）, clarity_ok }。",
        ].join("\n");
      },
      schema: CLARITY_SCHEMA,
    }),
  );

  builder.addNode(
    "support",
    llmNode({
      outputKey: "claim_breadth_support",
      buildPrompt: state => {
        const claimText = resolveInput(state, CLAIM_INPUT_KEYS);
        const context = buildSpecContext(state, ["发明内容", "具体实施方式", "技术领域", "背景技术"], 6000);
        return [
          "专利法 A26.4 审查——第二步：权利要求是否以说明书为依据。",
          "标准：权利要求概括的范围应使本领域技术人员从说明书充分公开的内容得到或概括得出，",
          "不得超出说明书公开的范围；概括范围过宽、仅由功能/效果限定而无实施方式支撑均不满足。",
          "以锚点证据为确定性线索（未命中不等于必然不支持，但须在说明书中找到等同公开内容）：",
          formatAnchorEvidence(state) || "（锚点证据缺失：未提供权利要求或说明书原文）",
          "",
          "【权利要求】",
          dataBlock(claimText.slice(0, 4000)),
          "【说明书相关章节】",
          dataBlock(context),
          "请严格输出 JSON：{ gaps（claim_no/feature/rationale）, support_ok }。",
        ].join("\n");
      },
      schema: SUPPORT_SCHEMA,
    }),
  );

  builder.addNode(
    "functional_limit",
    llmNode({
      outputKey: "claim_breadth_functional",
      buildPrompt: state => {
        const claimText = resolveInput(state, CLAIM_INPUT_KEYS);
        return [
          "专利法 A26.4 审查——第三步：功能性限定是否过宽。",
          "功能性限定应理解为说明书记载的、实现该功能的具体实施方式及其等同方式；",
          "若说明书仅给出一种实施方式而权项以功能/效果覆盖全部实现方式，则可能超出说明书支持范围。",
          formatAnchorEvidence(state),
          "",
          "【权利要求】",
          dataBlock(claimText.slice(0, 4000)),
          "请严格输出 JSON：{ overbroad, issues }。",
        ].join("\n");
      },
      schema: FUNCTIONAL_LIMIT_SCHEMA,
    }),
  );

  builder.addNode(
    "conclude",
    llmNode({
      outputKey: "claim_breadth_conclusion",
      buildPrompt: state => {
        const claimText = resolveInput(state, CLAIM_INPUT_KEYS);
        const parts = [
          "【清楚性】",
          getStateString(state, "claim_breadth_clarity"),
          "【以说明书为依据】",
          getStateString(state, "claim_breadth_support"),
          "【功能性限定】",
          getStateString(state, "claim_breadth_functional"),
          "【锚点证据汇总】",
          formatAnchorEvidence(state),
        ];
        return [
          "综合三步审查，生成专利法 A26.4 权利要求审查报告：",
          "- 逐项列明不支持/不清楚的权项、特征与理由，并给出修改建议",
          "- 明确区分“清楚性”与“以说明书为依据”两类缺陷",
          "- 结论附置信度（high/medium/low），回避绝对化表述",
          "",
          dataBlock(parts.join("\n").slice(0, 8000)),
          "",
          "【权利要求】",
          dataBlock(claimText.slice(0, 3000)),
          "请严格输出 JSON：{ support_ok, clarity_ok, gaps, confidence, key_rationale, report }。",
        ].join("\n");
      },
      schema: CONCLUDE_SCHEMA,
    }),
  );

  builder.addEdge("load", "anchor_evidence");
  builder.addEdge("anchor_evidence", "clarity");
  builder.addEdge("clarity", "support");
  builder.addEdge("support", "functional_limit");
  builder.addEdge("functional_limit", "conclude");

  const withRuleGate = options.ruleGate !== false;
  if (withRuleGate) builder.addNode("rule_gate", ruleGateNode(["patent_claims"]));
  if (approval !== undefined && options.includeApproval !== false) {
    builder.addNode("approval", handlerNode(approval, { review_context: "A26.4 权利要求清楚/支持结论需人工复核" }));
    builder.addEdge("conclude", "approval");
    builder.addEdge("approval", withRuleGate ? "rule_gate" : GRAPH_END);
  } else {
    builder.addEdge("conclude", withRuleGate ? "rule_gate" : GRAPH_END);
  }
  if (withRuleGate) builder.addEdge("rule_gate", GRAPH_END);

  return builder;
}

/** 从图运行结果提取 A26.4 结论（供调用方/评测读取）。 */
export function extractClaimBreadthResult(state: GraphState): {
  supportOk?: boolean;
  clarityOk?: boolean;
  gaps?: string[];
  confidence?: string;
  report?: string;
} {
  const raw = getStateString(state, "claim_breadth_conclusion");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      support_ok?: unknown;
      clarity_ok?: unknown;
      gaps?: unknown;
      confidence?: unknown;
      report?: unknown;
    };
    return {
      supportOk: typeof parsed.support_ok === "boolean" ? parsed.support_ok : undefined,
      clarityOk: typeof parsed.clarity_ok === "boolean" ? parsed.clarity_ok : undefined,
      gaps:
        Array.isArray(parsed.gaps) && parsed.gaps.every(gap => typeof gap === "string")
          ? (parsed.gaps as string[])
          : undefined,
      confidence: typeof parsed.confidence === "string" ? parsed.confidence : undefined,
      report: typeof parsed.report === "string" ? parsed.report : undefined,
    };
  } catch {
    // 结论 JSON 解析失败 → 无结构化结论，降级为空（调用方自行处理缺失）。
    return {};
  }
}

/**
 * 节点输入声明表（溯源 derivedFrom 链）：节点名 → 上游 state keys。
 * rule_gate/approval 不声明（rule_gate 读全量、审批门由 approval_gate 记录）。
 */
export const CLAIM_BREADTH_INPUT_DECLARATIONS: Readonly<Record<string, readonly string[]>> = {
  load: [],
  anchor_evidence: [],
  clarity: [],
  support: ["claim_anchor_evidence"],
  functional_limit: ["claim_anchor_evidence"],
  conclude: ["claim_breadth_clarity", "claim_breadth_support", "claim_breadth_functional", "claim_anchor_evidence"],
};
