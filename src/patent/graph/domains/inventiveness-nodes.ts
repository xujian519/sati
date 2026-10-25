/**
 * 创造性分析子图的节点实现（#725 / W-07）。
 *
 * 从 inventiveness.ts 拆出：LLM 节点装配、检索反思回路、领域注入、引用校验
 * 与规则门收口。图拓扑与节点表仍在 inventiveness.ts；Schema 与提示词分别在
 * inventiveness-schemas.ts / inventiveness-prompts.ts。
 */

import { tryParseJson } from "../../llm-json.js";
import { classifyIpc, IPC_DOMAINS, MULTI_CLASSIFY_MIN_CONFIDENCE } from "../../../knowledge/patent/ipc-classifier.js";
import { isDegraded } from "../degradation.js";
import { getStateArray, getStateString } from "../state.js";
import type { EdgeRouter, GraphNode, GraphState } from "../types.js";
import { checkCitations } from "./citation-check.js";
import {
  buildClosestPrompt,
  buildCombinationPrompt,
  buildConcludePrompt,
  buildDiffPrompt,
  buildHintPrompt,
  buildParsePrompt,
  buildQueryPrompt,
  buildRecallPrompt,
  buildSecondaryPrompt,
} from "./inventiveness-prompts.js";
import {
  CLOSEST_SCHEMA,
  COMBINATION_SCHEMA,
  CONCLUDE_SCHEMA,
  DIFF_SCHEMA,
  HINT_SCHEMA,
  PARSE_SCHEMA,
  RECALL_SCHEMA,
  SECONDARY_SCHEMA,
} from "./inventiveness-schemas.js";
import { llmNode, resolveInput, ruleGateNode } from "./shared.js";

// ---------------------------------------------------------------------------
// 检索反思回路（recall_check → refine_query → prepare_query → search 受控循环）
// ---------------------------------------------------------------------------

/** 当前检索轮次 state 键（0 = 首轮）。 */
const RETRIEVAL_ROUND_KEY = "inventiveness_retrieval_round";
/** 重检次数已达上限的降级说明 state 键（放行 closest，不无限循环）。 */
const RECALL_EXHAUSTED_KEY = "inventiveness_recall_exhausted";
/** 放行 closest 前对 union 结果的 top-N 收敛上限（保留最近一轮/最相关前 5–8 篇）。 */
const TOP_PRIOR_ART = 8;
/**
 * 收敛结果 state 键：收敛值写入独立键（last_write_wins）而非 prior_art——
 * prior_art 注册为 union reducer，把子集写回会被并回全量（no-op）；closest/combination
 * 读取时回退全量。键名以下划线开头，collectStateText/renderGraphResultText 自动跳过。
 */
const CONVERGED_PRIOR_ART_KEY = "_prior_art_converged";

/** 当前检索轮次（state 缺失/非数字时按 0 处理）。 */
function retrievalRound(state: GraphState): number {
  const value = state[RETRIEVAL_ROUND_KEY];
  return typeof value === "number" ? value : 0;
}

/** 序列化检索命中列表（对象 → JSON 文本，供提示词嵌入）。 */
function formatPriorArt(priorArt: unknown[]): string {
  return priorArt.map(d => (typeof d === "object" && d !== null ? JSON.stringify(d) : String(d))).join("\n");
}

/** 条件边路由器：adequate=true 或降级/解析失败 → 收敛放行；不足且未超限 → 补检。 */
export function recallRouter(maxRounds: number): EdgeRouter {
  return async state => {
    if (isDegraded(state, "inventiveness_recall")) return ["converge_prior_art"];
    const parsed = tryParseJson(getStateString(state, "inventiveness_recall"));
    if (parsed === undefined || typeof parsed.adequate !== "boolean") return ["converge_prior_art"];
    if (parsed.adequate === true) return ["converge_prior_art"];
    const round = retrievalRound(state);
    if (round < maxRounds) return ["refine_query"];
    state[RECALL_EXHAUSTED_KEY] =
      `检索反思回路已达上限（${maxRounds} 次重检），仍存在未覆盖特征: ${JSON.stringify(parsed.missing_features ?? [])}`;
    return ["converge_prior_art"];
  };
}

/** 确定性补检：用 missing_features 与上一轮查询拼新检索式（旧查询 OR 缺特征1 OR 缺特征2），轮次 +1。 */
export const refineQueryNode: GraphNode = async ({ state }) => {
  const round = retrievalRound(state);
  const parsed = tryParseJson(getStateString(state, "inventiveness_recall"));
  const missing: string[] = Array.isArray(parsed?.missing_features)
    ? parsed.missing_features.map(String).filter(Boolean)
    : [];
  const prevQuery = getStateString(state, "inventiveness_query").trim();
  const suffix = missing.length > 0 ? ` OR ${missing.join(" OR ")}` : "";
  return {
    [RETRIEVAL_ROUND_KEY]: round + 1,
    inventiveness_query: `${prevQuery}${suffix}` || "补充检索",
  };
};

/** 收敛节点：union 结果超上限时写入最近一轮优先的前 TOP_PRIOR_ART 篇（数组尾即最近轮）。 */
export const convergePriorArtNode: GraphNode = async ({ state }) => {
  const docs = getStateArray(state, "prior_art");
  if (docs.length <= TOP_PRIOR_ART) return {};
  return { [CONVERGED_PRIOR_ART_KEY]: [...docs].reverse().slice(0, TOP_PRIOR_ART).reverse() };
};

/** 供 closest/combination 提示词读取的检索命中：优先收敛后的 top-N，否则全量。 */
function priorArtForPrompt(state: GraphState): unknown[] {
  const converged = getStateArray(state, CONVERGED_PRIOR_ART_KEY);
  return converged.length > 0 ? converged : getStateArray(state, "prior_art");
}

/**
 * 领域知识注入节点（P2-2，纯确定性无 LLM）：parse 的 features+field+inventor_claimed_effect
 * 拼接文本经 classifyIpc 分类，命中部的 inventivenessFocus 注入 closest/diff/hint 提示
 * （如化学领域"预料不到的技术效果"条款）。未命中/低置信度输出空串，不改变下游行为。
 */
export const domainInjectNode: GraphNode = async ({ state }) => {
  const parsed = tryParseJson(getStateString(state, "inventiveness_parse"));
  const parts = [
    Array.isArray(parsed?.features) ? parsed.features.map(String).filter(Boolean).join("，") : "",
    typeof parsed?.field === "string" ? parsed.field : "",
    typeof parsed?.inventor_claimed_effect === "string" ? parsed.inventor_claimed_effect : "",
  ];
  const text = parts.filter(Boolean).join("，");
  if (text.trim().length === 0) return { inventiveness_domain_focus: "" };
  const best = classifyIpc(text).sort((a, b) => b.confidence - a.confidence)[0];
  const focus =
    best !== undefined && best.confidence >= MULTI_CLASSIFY_MIN_CONFIDENCE
      ? (IPC_DOMAINS.find(d => d.section === best.section)?.inventivenessFocus ?? [])
      : [];
  return {
    inventiveness_domain_focus:
      focus.length > 0 ? `【领域创造性审查要点（IPC ${best?.section}）】\n${focus.join("\n")}` : "",
  };
};

// ---------------------------------------------------------------------------
// 节点定义（声明式）
// ---------------------------------------------------------------------------

export const parseNode: GraphNode = llmNode({
  outputKey: "inventiveness_parse",
  modelHint: "cheap",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state => buildParsePrompt(resolveInput(state, ["input", "text", "claim"])),
  schema: PARSE_SCHEMA,
});

export const buildQueryNode: GraphNode = llmNode({
  outputKey: "inventiveness_query",
  modelHint: "cheap",
  temperature: 0,
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildQueryPrompt({
      parse: getStateString(state, "inventiveness_parse"),
      cutoffDate: getStateString(state, "cutoff_date"),
      cutoffBasis: getStateString(state, "cutoff_basis"),
    }),
});

/** prepare_query：把 build_query 的策略文本映射为 search handler 的 query 键（纯映射，不承担 LLM 生成）。 */
export const prepareQueryNode: GraphNode = async ({ state }) => ({
  query: getStateString(state, "inventiveness_query") || getStateString(state, "inventiveness_parse").slice(0, 200),
});

export const recallCheckNode: GraphNode = llmNode({
  outputKey: "inventiveness_recall",
  modelHint: "cheap",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildRecallPrompt({
      parse: getStateString(state, "inventiveness_parse"),
      priorArtText: formatPriorArt(getStateArray(state, "prior_art")),
    }),
  schema: RECALL_SCHEMA,
});

export const closestNode: GraphNode = llmNode({
  outputKey: "inventiveness_closest",
  modelHint: "strong",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildClosestPrompt({
      parse: getStateString(state, "inventiveness_parse"),
      domainFocus: getStateString(state, "inventiveness_domain_focus"),
      priorArtText: formatPriorArt(priorArtForPrompt(state)),
    }),
  schema: CLOSEST_SCHEMA,
});

export const diffNode: GraphNode = llmNode({
  outputKey: "inventiveness_diff",
  modelHint: "strong",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildDiffPrompt({
      parse: getStateString(state, "inventiveness_parse"),
      domainFocus: getStateString(state, "inventiveness_domain_focus"),
      closest: getStateString(state, "inventiveness_closest"),
    }),
  schema: DIFF_SCHEMA,
});

export const combinationNode: GraphNode = llmNode({
  outputKey: "inventiveness_combination",
  modelHint: "cheap",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildCombinationPrompt({
      closest: getStateString(state, "inventiveness_closest"),
      diff: getStateString(state, "inventiveness_diff"),
      priorArtText: formatPriorArt(priorArtForPrompt(state)),
    }),
  schema: COMBINATION_SCHEMA,
});

export const hintNode: GraphNode = llmNode({
  outputKey: "inventiveness_hint",
  modelHint: "strong",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildHintPrompt({
      parse: getStateString(state, "inventiveness_parse"),
      domainFocus: getStateString(state, "inventiveness_domain_focus"),
      diff: getStateString(state, "inventiveness_diff"),
      combination: getStateString(state, "inventiveness_combination"),
    }),
  schema: HINT_SCHEMA,
});

export const secondaryNode: GraphNode = llmNode({
  outputKey: "inventiveness_secondary",
  modelHint: "strong",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state => buildSecondaryPrompt(getStateString(state, "inventiveness_parse")),
  schema: SECONDARY_SCHEMA,
});

export const concludeNode: GraphNode = llmNode({
  outputKey: "inventiveness_conclusion",
  modelHint: "strong",
  maxAttempts: 2,
  timeoutMs: 60_000,
  buildPrompt: state =>
    buildConcludePrompt({
      parse: getStateString(state, "inventiveness_parse"),
      closest: getStateString(state, "inventiveness_closest"),
      diff: getStateString(state, "inventiveness_diff"),
      combination: getStateString(state, "inventiveness_combination"),
      hint: getStateString(state, "inventiveness_hint"),
      secondary: getStateString(state, "inventiveness_secondary"),
      feedbackHistory: getStateString(state, "inventiveness_feedback_history"),
    }),
  schema: CONCLUDE_SCHEMA,
});

// 引用真实性校验：conclude 后确定性节点（无 LLM 依赖），比对结论引用与 prior_art。
// 接地用全量 union（收敛 top-N 只是提示词规模控制，检索结果全集才是"真实存在"的判据）。
export const citationGateNode: GraphNode = async ({ state }) => {
  const priorArt = getStateArray(state, "prior_art");
  const refTexts = [
    getStateString(state, "inventiveness_closest"),
    getStateString(state, "inventiveness_combination"),
    getStateString(state, "inventiveness_hint"),
  ];
  const result = checkCitations({ refTexts, docs: priorArt });
  return {
    citation_gate_report: result.report,
    citation_gate_failures: result.uncited,
    citation_gate_grounded: result.grounded,
  };
};

/** 规则门收口：citationGate 开启时 precomputedFailures 取运行期 citation_gate 失败。 */
export function createRuleGateNode(citationGateEnabled: boolean): GraphNode {
  return async ctx => {
    const pre = citationGateEnabled ? getStateArray(ctx.state, "citation_gate_failures").map(String) : [];
    return ruleGateNode(["patent_inventiveness"], pre)(ctx);
  };
}
