/**
 * src/patent/graph/domains/inventiveness — 创造性分析子图（专利法 A22.3，三步法）。
 *
 * 节点链：parse（画像/时间字段）→ time_baseline（截止日显式事实）→ domain_inject
 * → build_query（检索式含时间基准）→ prepare_query → search（复用）→ recall_check
 * （检索覆盖度反思）→ [refine_query → prepare_query → search 回路，最多 2 次重检]
 * → converge_prior_art（union top-N 收敛）→ closest（Step1 最接近现有技术）→ diff
 * （Step2 区别特征+实际解决技术问题）→ combination（D2 组合动机/技术障碍显式建模）
 * → hint（Step3 技术启示）→ secondary（辅助因素）→ conclude（结论+反事后诸葛亮自检）
 * → approval → rule_gate。retrieval.maxRounds=0 时禁用反思回路，保持旧行为
 * （search → closest）。
 *
 * 对齐 Mady domains/inventiveness（7 节点 Pregel）：每 LLM 节点 JSON schema 结构化
 * 输出（temperature 0.2），LLM 缺失/失败 → markDegraded（确定性骨架仍可跑）。
 *
 * P2.10（issue #646）：图构建声明化——节点定义收进 `STAGE_NODES` 表、边收进
 * `STAGE_EDGES` 表，`buildInventivenessGraph` 只解析开关并按表装配。节点插入
 * 顺序仍与旧版逐项一致（provenance / describe 依赖该顺序）。
 *
 * #725（W-07）：本文件只保留拓扑/装配/导出；节点实现在 inventiveness-nodes.ts，
 * JSON Schema 在 inventiveness-schemas.ts，提示词在 inventiveness-prompts.ts。
 */

import {
  globalStageHandlerRegistry,
  type StageHandler,
  type StageHandlerRegistry,
  TimeBaselineHandler,
} from "../../atoms/index.js";
import { GraphBuilder } from "../engine.js";
import { getStateString } from "../state.js";
import { GRAPH_END } from "../types.js";
import type { GraphNode, GraphState } from "../types.js";
import {
  buildQueryNode,
  citationGateNode,
  closestNode,
  combinationNode,
  concludeNode,
  convergePriorArtNode,
  createRuleGateNode,
  diffNode,
  domainInjectNode,
  hintNode,
  parseNode,
  prepareQueryNode,
  recallCheckNode,
  recallRouter,
  refineQueryNode,
  secondaryNode,
} from "./inventiveness-nodes.js";
import { handlerNode } from "./shared.js";

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
// 图装配（声明式：节点表 + 边表）
// ---------------------------------------------------------------------------

type GraphFlags = {
  search: boolean;
  recallLoop: boolean;
  combination: boolean;
  citationGate: boolean;
  ruleGate: boolean;
  approval: boolean;
};

type AssemblyContext = GraphFlags & {
  searchHandler: StageHandler | undefined;
  approvalHandler: StageHandler | undefined;
  includeApproval: boolean;
};

type StageSpec = {
  name: string;
  /** 节点创建（仅 include 为 true 时调用）。 */
  create: (ctx: AssemblyContext) => GraphNode;
  include: (ctx: AssemblyContext) => boolean;
};

type EdgeSpec = {
  from: string;
  to: string;
  when: (flags: GraphFlags) => boolean;
};

/** 节点定义表：顺序即 addNode 顺序（provenance / describe 依赖该顺序）。 */
const STAGE_NODES: readonly StageSpec[] = [
  { name: "parse", create: () => parseNode, include: () => true },
  {
    name: "time_baseline",
    create: () => handlerNode(new TimeBaselineHandler()),
    include: () => true,
  },
  { name: "domain_inject", create: () => domainInjectNode, include: () => true },
  { name: "build_query", create: () => buildQueryNode, include: () => true },
  { name: "search", create: ctx => handlerNode(ctx.searchHandler!), include: ctx => ctx.search },
  { name: "prepare_query", create: () => prepareQueryNode, include: ctx => ctx.search },
  { name: "recall_check", create: () => recallCheckNode, include: ctx => ctx.recallLoop },
  { name: "refine_query", create: () => refineQueryNode, include: ctx => ctx.recallLoop },
  { name: "converge_prior_art", create: () => convergePriorArtNode, include: ctx => ctx.recallLoop },
  { name: "closest", create: () => closestNode, include: () => true },
  { name: "diff", create: () => diffNode, include: () => true },
  { name: "combination", create: () => combinationNode, include: ctx => ctx.combination },
  { name: "hint", create: () => hintNode, include: () => true },
  { name: "secondary", create: () => secondaryNode, include: () => true },
  { name: "conclude", create: () => concludeNode, include: () => true },
  { name: "citation_gate", create: () => citationGateNode, include: ctx => ctx.citationGate },
  {
    name: "rule_gate",
    create: ctx => createRuleGateNode(ctx.citationGate),
    include: ctx => ctx.ruleGate,
  },
  {
    name: "approval",
    create: ctx => handlerNode(ctx.approvalHandler!, { review_context: "创造性三步法结论需人工复核" }),
    include: ctx => ctx.approval,
  },
];

/**
 * 静态边表（P2.10）。按开关求值；同一 from 的多条边按表内顺序写入，
 * 目标顺序即 fan-out 顺序（combination → hint, secondary）。
 */
const STAGE_EDGES: readonly EdgeSpec[] = [
  // 检索链（有 search handler 时）
  { from: "build_query", to: "prepare_query", when: f => f.search },
  { from: "prepare_query", to: "search", when: f => f.search },
  { from: "search", to: "recall_check", when: f => f.recallLoop },
  { from: "refine_query", to: "prepare_query", when: f => f.recallLoop },
  { from: "converge_prior_art", to: "closest", when: f => f.recallLoop },
  { from: "search", to: "closest", when: f => f.search && !f.recallLoop },
  { from: "build_query", to: "closest", when: f => !f.search },
  // 三步法主线：parse → time_baseline（截止日显式事实）→ domain_inject → build_query
  { from: "parse", to: "time_baseline", when: () => true },
  { from: "time_baseline", to: "domain_inject", when: () => true },
  { from: "domain_inject", to: "build_query", when: () => true },
  { from: "closest", to: "diff", when: () => true },
  { from: "diff", to: "combination", when: f => f.combination },
  { from: "diff", to: "hint", when: f => !f.combination },
  { from: "combination", to: "hint", when: f => f.combination },
  { from: "combination", to: "secondary", when: f => f.combination },
  { from: "hint", to: "secondary", when: f => !f.combination },
  { from: "hint", to: "conclude", when: () => true },
  { from: "secondary", to: "conclude", when: () => true },
  // 尾链：conclude → (citation_gate) → (approval) → (rule_gate) → END。
  // 顺序与旧版 addEdge 调用序一致（describe 的边表顺序，语义无关但保持逐项可比）。
  { from: "conclude", to: "citation_gate", when: f => f.citationGate },
  { from: "citation_gate", to: "approval", when: f => f.citationGate && f.approval },
  { from: "conclude", to: "approval", when: f => !f.citationGate && f.approval },
  { from: "approval", to: "rule_gate", when: f => f.approval && f.ruleGate },
  { from: "approval", to: GRAPH_END, when: f => f.approval && !f.ruleGate },
  { from: "citation_gate", to: "rule_gate", when: f => f.citationGate && !f.approval && f.ruleGate },
  { from: "citation_gate", to: GRAPH_END, when: f => f.citationGate && !f.approval && !f.ruleGate },
  { from: "conclude", to: "rule_gate", when: f => !f.citationGate && !f.approval && f.ruleGate },
  { from: "conclude", to: GRAPH_END, when: f => !f.citationGate && !f.approval && !f.ruleGate },
  { from: "rule_gate", to: GRAPH_END, when: f => f.ruleGate },
];

/** maxRounds 归一：缺省/非法值 → 2；0 禁用回路保持旧行为。 */
function normalizeMaxRounds(options: BuildInventivenessGraphOptions): number {
  const rounds = options.retrieval?.maxRounds;
  return rounds !== undefined && Number.isInteger(rounds) && rounds >= 0 ? rounds : 2;
}

function resolveGraphFlags(
  options: BuildInventivenessGraphOptions,
  hasSearch: boolean,
  hasApproval: boolean,
  maxRounds: number,
): GraphFlags {
  return {
    search: hasSearch,
    recallLoop: hasSearch && maxRounds > 0,
    combination: options.combination !== false,
    citationGate: options.citationGate !== false,
    ruleGate: options.ruleGate !== false,
    approval: hasApproval && options.includeApproval !== false,
  };
}

/** 构建创造性分析子图（A22.3 三步法）。 */
export function buildInventivenessGraph(options: BuildInventivenessGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const builder = new GraphBuilder({ onAddNode: options.onAddNode });
  const searchHandler = handlers.lookup("search");
  const approvalHandler = handlers.lookup("approval-gate");
  const maxRounds = normalizeMaxRounds(options);
  const flags = resolveGraphFlags(options, searchHandler !== undefined, approvalHandler !== undefined, maxRounds);
  const ctx: AssemblyContext = { ...flags, searchHandler, approvalHandler, includeApproval: flags.approval };

  for (const spec of STAGE_NODES) {
    if (spec.include(ctx)) builder.addNode(spec.name, spec.create(ctx));
  }
  if (flags.recallLoop) {
    builder.setSchema({ prior_art: "union" });
    builder.setConditionalEdge("recall_check", recallRouter(maxRounds));
  }
  for (const edge of STAGE_EDGES) {
    if (edge.when(flags)) builder.addEdge(edge.from, edge.to);
  }
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
    // 结论 JSON 解析失败 → 无结构化结论，降级为空（调用方自行处理缺失）。
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
  time_baseline: ["priority_date", "filing_date", "inventiveness_parse"],
  domain_inject: [],
  build_query: ["inventiveness_parse", "cutoff_date"],
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
