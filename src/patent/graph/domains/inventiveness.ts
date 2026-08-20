/**
 * src/patent/graph/domains/inventiveness — 创造性分析子图（专利法 A22.3，三步法）。
 *
 * 节点链：parse（画像/时间基准）→ build_query（检索式含时间基准）→ prepare_query
 * → search（复用）→ recall_check（检索覆盖度反思）→ [refine_query → prepare_query
 * → search 回路，最多 2 次重检] → converge_prior_art（union top-N 收敛）→ closest
 * （Step1 最接近现有技术）→ diff（Step2 区别特征+实际解决技术问题）→ combination
 * （D2 组合动机/技术障碍显式建模）→ hint（Step3 技术启示）→ secondary（辅助因素）
 * → conclude（结论+反事后诸葛亮自检）→ approval → rule_gate。retrieval.maxRounds=0
 * 时禁用反思回路，保持旧行为（search → closest）。
 *
 * 对齐 Mady domains/inventiveness（7 节点 Pregel）：每 LLM 节点 JSON schema 结构化
 * 输出（temperature 0.2），LLM 缺失/失败 → markDegraded（确定性骨架仍可跑）。
 */

import { GraphBuilder, type GraphState } from "../index.js";
import { getStateArray, getStateString } from "../state.js";
import { isDegraded } from "../degradation.js";
import type { EdgeRouter, GraphNode } from "../types.js";
import { globalStageHandlerRegistry, type StageHandlerRegistry } from "../../atoms/index.js";
import { tryParseJson } from "../../llm-json.js";
import { classifyIpc, IPC_DOMAINS, MULTI_CLASSIFY_MIN_CONFIDENCE } from "../../../knowledge/patent/ipc-classifier.js";
import { handlerNode, llmNode, resolveInput, ruleGateNode } from "./shared.js";
import { checkCitations } from "./citation-check.js";

export type BuildInventivenessGraphOptions = {
  handlers?: StageHandlerRegistry;
  /** 规则门收口（缺省 true）。 */
  ruleGate?: boolean;
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean;
  /** 溯源包装钩子（ProvenanceCollector.wrapNode）：addNode 统一入口，透传 GraphBuilder。 */
  onAddNode?: (name: string, node: GraphNode) => GraphNode;
  /**
   * 检索反思回路：覆盖不足时最多重检 maxRounds 次（缺省 2，0 = 禁用回路保持旧行为）。
   * 多轮检索结果按 union 合并去重，放行 closest 前收敛为最近轮优先的前 8 篇。
   */
  retrieval?: { maxRounds?: number };
  /** D2 组合节点（缺省 true；false = 关闭 combination，diff → hint 直连）。 */
  combination?: boolean;
  /** 引用真实性校验节点（缺省 true；false = 关闭 citation_gate 及其规则门预计算失败）。 */
  citationGate?: boolean;
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

const RECALL_SCHEMA = {
  type: "object",
  properties: {
    adequate: { type: "boolean", description: "检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）" },
    covered_features: { type: "array", items: { type: "string" }, description: "已被检索结果覆盖的技术特征" },
    missing_features: { type: "array", items: { type: "string" }, description: "未被覆盖的关键技术特征（补检依据）" },
  },
  required: ["adequate", "covered_features", "missing_features"],
} as const;

const COMBINATION_SCHEMA = {
  type: "object",
  properties: {
    candidate_documents: {
      type: "array",
      items: { type: "string" },
      description: "可与 D1 结合的候选对比文件标识（文档号）",
    },
    combinable: { type: "boolean", description: "是否存在与 D1 结合以覆盖区别特征的技术启示" },
    motivation: { type: "string", description: "结合动机/技术启示（改进动机/结合启示/公知常识）" },
    obstacles: { type: "array", items: { type: "string" }, description: "结合的技术障碍" },
    teaching_away: { type: "boolean", description: "是否存在反向教导" },
  },
  required: ["candidate_documents", "combinable", "motivation", "obstacles", "teaching_away"],
} as const;

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
function recallRouter(maxRounds: number): EdgeRouter {
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
const refineQueryNode: GraphNode = async ({ state }) => {
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
const convergePriorArtNode: GraphNode = async ({ state }) => {
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
const domainInjectNode: GraphNode = async ({ state }) => {
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
// 子图构建
// ---------------------------------------------------------------------------

/** 构建创造性分析子图（A22.3 三步法）。 */
export function buildInventivenessGraph(options: BuildInventivenessGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const builder = new GraphBuilder({ onAddNode: options.onAddNode });
  const combinationEnabled = options.combination !== false;
  const citationGateEnabled = options.citationGate !== false;
  const withRuleGate = options.ruleGate !== false;
  const search = handlers.lookup("search");
  const approval = handlers.lookup("approval-gate");

  builder.addNode(
    "parse",
    llmNode({
      outputKey: "inventiveness_parse",
      modelHint: "cheap",
      maxAttempts: 2,
      timeoutMs: 60_000,
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
  builder.addNode("domain_inject", domainInjectNode);
  builder.addNode(
    "build_query",
    llmNode({
      outputKey: "inventiveness_query",
      modelHint: "cheap",
      temperature: 0,
      maxAttempts: 2,
      timeoutMs: 60_000,
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        return [
          "基于创造性分析解析结果，生成现有技术检索策略：",
          "- 最接近现有技术的检索方向（同技术领域/同技术问题）",
          "- 三层检索式：精确层 → 扩展层 → 语义层",
          "- 含布尔表达式与 IPC 限定（如可推断）",
          "- 检索以申请日/优先权日为时间基准：如可推断申请日/优先权日，在检索式中加入 after:YYYYMMDD 或等效日期限定（只检索该日期之前公开的文献）",
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
    // prepare_query：把 build_query 的策略文本映射为 search handler 的 query 键（纯映射，不承担 LLM 生成）。
    builder.addNode("prepare_query", async ({ state }) => ({
      query: getStateString(state, "inventiveness_query") || getStateString(state, "inventiveness_parse").slice(0, 200),
    }));
    builder.addEdge("build_query", "prepare_query");
    builder.addEdge("prepare_query", "search");
    const rounds = options.retrieval?.maxRounds;
    const maxRounds = rounds !== undefined && Number.isInteger(rounds) && rounds >= 0 ? rounds : 2;
    if (maxRounds > 0) {
      // 检索反思回路：search → recall_check →（条件边）→ refine_query → prepare_query → search；
      // adequate=true / 降级 / 解析失败 / 超限 → converge_prior_art → closest。
      builder.setSchema({ prior_art: "union" });
      builder.addNode(
        "recall_check",
        llmNode({
          outputKey: "inventiveness_recall",
          modelHint: "cheap",
          maxAttempts: 2,
          timeoutMs: 60_000,
          buildPrompt: state => {
            const parse = getStateString(state, "inventiveness_parse");
            const priorArtText = formatPriorArt(getStateArray(state, "prior_art"));
            return [
              "你是专利检索质量审查员。检查现有技术检索结果的覆盖度：",
              "- adequate：检索结果是否足以支撑创造性判断（至少覆盖核心技术特征）",
              "- covered_features：已被检索结果覆盖的技术特征",
              "- missing_features：未被覆盖的关键技术特征（补检依据）",
              "【待评技术特征】",
              parse.slice(0, 3000),
              "【检索结果摘要（含公开日）】",
              priorArtText.slice(0, 4000) || "（无检索结果）",
              "",
              "请严格输出 JSON：{ adequate, covered_features, missing_features }。",
            ].join("\n");
          },
          schema: RECALL_SCHEMA,
        }),
      );
      builder.addNode("refine_query", refineQueryNode);
      builder.addNode("converge_prior_art", convergePriorArtNode);
      builder.addEdge("search", "recall_check");
      builder.setConditionalEdge("recall_check", recallRouter(maxRounds));
      builder.addEdge("refine_query", "prepare_query");
      builder.addEdge("converge_prior_art", "closest");
    } else {
      builder.addEdge("search", "closest");
    }
  } else {
    builder.addEdge("build_query", "closest");
  }
  builder.addNode(
    "closest",
    llmNode({
      outputKey: "inventiveness_closest",
      modelHint: "strong",
      maxAttempts: 2,
      timeoutMs: 60_000,
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        const domainFocus = getStateString(state, "inventiveness_domain_focus");
        const priorArtText = formatPriorArt(priorArtForPrompt(state));
        return [
          "三步法第一步：确定最接近的现有技术（D1）。",
          "选择标准：技术领域相同/相近 → 技术问题最接近 → 公开技术特征最多。",
          "不得脱离检索结果自行选择；候选多时逐个试判。",
          "逐篇标注候选公开日（publication_date），并说明其是否早于申请日/优先权日——仅早于的才构成现有技术，可用于创造性评价。",
          ...(domainFocus.length > 0 ? ["", domainFocus] : []),
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
      modelHint: "strong",
      maxAttempts: 2,
      timeoutMs: 60_000,
      buildPrompt: state => {
        const parse = getStateString(state, "inventiveness_parse");
        const domainFocus = getStateString(state, "inventiveness_domain_focus");
        const closest = getStateString(state, "inventiveness_closest");
        return [
          "三步法第二步：确定区别技术特征和实际解决的技术问题。",
          "- 基于 D1 公开特征逐一比对，列出区别特征",
          "- 基于区别特征的技术效果客观确定实际解决的技术问题（不得包含解决手段）",
          "- 检查技术问题是否包含对区别特征的指引（事后诸葛亮风险）",
          ...(domainFocus.length > 0 ? ["", domainFocus] : []),
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
  if (combinationEnabled) {
    builder.addNode(
      "combination",
      llmNode({
        outputKey: "inventiveness_combination",
        modelHint: "cheap",
        maxAttempts: 2,
        timeoutMs: 60_000,
        buildPrompt: state => {
          const closest = getStateString(state, "inventiveness_closest");
          const diff = getStateString(state, "inventiveness_diff");
          const priorArtText = formatPriorArt(priorArtForPrompt(state));
          return [
            "你是专利创造性分析专家。评估是否存在可与最接近现有技术（D1）结合的其他对比文件（D2），以判断区别特征的引入是否显而易见：",
            "- candidate_documents：可与 D1 结合的候选文件标识（文档号，如 D2/对比文件2）",
            "- combinable：是否存在结合动机/技术启示",
            "- motivation：结合动机（改进动机/结合启示/公知常识/有限试验）",
            "- obstacles：结合的技术障碍",
            "- teaching_away：是否存在反向教导",
            "引用规范：文档号 + 段落/特征描述，引用必须真实存在于检索结果，不得凭空捏造。",
            "【D1 最接近现有技术】",
            closest.slice(0, 2000),
            "【区别特征与实际解决的技术问题】",
            diff.slice(0, 2000),
            "【其他现有技术候选（除 D1 外）】",
            priorArtText.slice(0, 6000) || "（无）",
            "",
            "请严格输出 JSON：{ candidate_documents, combinable, motivation, obstacles, teaching_away }。",
          ].join("\n");
        },
        schema: COMBINATION_SCHEMA,
      }),
    );
  }
  builder.addNode(
    "hint",
    llmNode({
      outputKey: "inventiveness_hint",
      modelHint: "strong",
      maxAttempts: 2,
      timeoutMs: 60_000,
      buildPrompt: state => {
        const diff = getStateString(state, "inventiveness_diff");
        const parse = getStateString(state, "inventiveness_parse");
        const domainFocus = getStateString(state, "inventiveness_domain_focus");
        const combination = getStateString(state, "inventiveness_combination");
        return [
          "三步法第三步：判断要求保护的发明对本领域技术人员是否显而易见。",
          "技术启示来源：改进动机/结合启示（D1+D2 能否结合、有无技术障碍）/公知常识/逻辑推理与有限试验。",
          "发明类型差异化：组合/选择/转用/要素变更/开拓性/改进发明。",
          ...(domainFocus.length > 0 ? ["", domainFocus] : []),
          "```",
          parse.slice(0, 3000),
          "```",
          "【区别特征与实际解决的技术问题】",
          diff.slice(0, 3000),
          "",
          "【D2 组合评估】",
          combination.slice(0, 3000) || "（无组合评估）",
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
      modelHint: "strong",
      maxAttempts: 2,
      timeoutMs: 60_000,
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
      modelHint: "strong",
      maxAttempts: 2,
      timeoutMs: 60_000,
      buildPrompt: state => {
        const parts = [
          "【解析】",
          getStateString(state, "inventiveness_parse"),
          "【最接近现有技术】",
          getStateString(state, "inventiveness_closest"),
          "【区别特征】",
          getStateString(state, "inventiveness_diff"),
          "【D2 组合评估】",
          getStateString(state, "inventiveness_combination"),
          "【技术启示】",
          getStateString(state, "inventiveness_hint"),
          "【辅助因素】",
          getStateString(state, "inventiveness_secondary"),
        ];
        const feedbackHistory = getStateString(state, "inventiveness_feedback_history");
        return [
          "综合三步法各步骤，生成创造性分析结论：",
          "- 完整三步法报告（最接近现有技术 → 区别特征 → 技术启示）",
          "- 反事后诸葛亮自检（结论不得依赖发明本身披露的技术启示）",
          "- 不得仅凭区别特征数量判断创造性",
          "- 结论标注置信度（high/medium/low），回避绝对化表述",
          ...(feedbackHistory.length > 0 ? ["", feedbackHistory] : []),
          "",
          parts.join("\n").slice(0, 8000),
          "",
          "请严格输出 JSON：{ inventive, confidence, key_rationale, report }。",
        ].join("\n");
      },
      schema: CONCLUDE_SCHEMA,
    }),
  );

  // 边：parse → domain_inject → build_query → prepare_query → (search) → closest → diff → (combination)
  // → [hint, secondary] 并行（同超步，SuperStep fan-out）→ conclude → 尾链。
  builder.addEdge("parse", "domain_inject");
  builder.addEdge("domain_inject", "build_query");
  builder.addEdge("closest", "diff");
  builder.addEdge("diff", combinationEnabled ? "combination" : "hint");
  if (combinationEnabled) {
    builder.addEdge("combination", "hint");
    builder.addEdge("combination", "secondary");
  } else {
    builder.addEdge("hint", "secondary");
  }
  builder.addEdge("hint", "conclude");
  builder.addEdge("secondary", "conclude");

  // 引用真实性校验：conclude 后确定性节点（无 LLM 依赖），比对结论引用与 prior_art。
  // 接地用全量 union（收敛 top-N 只是提示词规模控制，检索结果全集才是"真实存在"的判据）。
  if (citationGateEnabled) {
    builder.addNode("citation_gate", async ({ state }) => {
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
    });
  }

  if (withRuleGate) {
    // 规则门收口：citationGate 开启时 precomputedFailures 取运行期 citation_gate 失败
    // （novelty/enablement 与 citationGate=false 不传，行为不变）。
    builder.addNode("rule_gate", async ctx => {
      const pre = citationGateEnabled ? getStateArray(ctx.state, "citation_gate_failures").map(String) : [];
      return ruleGateNode(["patent_inventiveness"], pre)(ctx);
    });
  }
  // 尾链：conclude → (citation_gate) → (approval) → (rule_gate) → __end__，各环节按开关串接。
  const tailTarget = withRuleGate ? "rule_gate" : "__end__";
  if (approval !== undefined && options.includeApproval !== false) {
    builder.addNode("approval", handlerNode(approval, { review_context: "创造性三步法结论需人工复核" }));
    builder.addEdge("conclude", citationGateEnabled ? "citation_gate" : "approval");
    if (citationGateEnabled) builder.addEdge("citation_gate", "approval");
    builder.addEdge("approval", tailTarget);
  } else {
    builder.addEdge("conclude", citationGateEnabled ? "citation_gate" : tailTarget);
    if (citationGateEnabled) builder.addEdge("citation_gate", tailTarget);
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

/**
 * 节点输入声明表（溯源 derivedFrom 链，评审 P9/P13）：节点名 → 上游 state keys。
 * 仅覆盖需要决策链的 LLM/推理节点；rule_gate/approval/citation_gate 不声明
 * （rule_gate 经 collectStateText 读全量、审批门由 approval_gate 记录）。
 * 声明缺失/漂移时只记产出不伪造因果（fail-open 诚实降级）。
 */
export const INVENTIVENESS_INPUT_DECLARATIONS: Readonly<Record<string, readonly string[]>> = {
  parse: [],
  domain_inject: [],
  build_query: ["inventiveness_parse"],
  prepare_query: ["inventiveness_query", "inventiveness_parse"],
  search: ["query"],
  recall_check: ["prior_art", "search_summary"],
  refine_query: ["inventiveness_recall", "inventiveness_query"],
  converge_prior_art: ["prior_art"],
  closest: ["inventiveness_parse", "inventiveness_domain_focus"],
  diff: ["inventiveness_parse", "inventiveness_closest"],
  combination: ["inventiveness_closest", "inventiveness_diff", "prior_art"],
  hint: ["inventiveness_parse", "inventiveness_diff", "inventiveness_combination"],
  secondary: ["inventiveness_parse"],
  conclude: [
    "inventiveness_closest",
    "inventiveness_diff",
    "inventiveness_combination",
    "inventiveness_hint",
    "inventiveness_secondary",
  ],
};
