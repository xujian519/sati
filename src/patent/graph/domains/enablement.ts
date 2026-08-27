/**
 * src/patent/graph/domains/enablement — 充分公开分析子图（专利法 A26.3）。
 *
 * 节点链：load（确定性：分段/统计）→ completeness（结构完整性）→ clarity（清楚性）
 * → enablement（能够实现性）→ domain_rules（新增：技术领域检测 + 领域特殊要求）
 * → conclude（结论）→ approval → rule_gate。
 *
 * 对齐 Mady domains/enablement（5 节点 + domain_rules.go 领域特殊规则）。
 */

import { GraphBuilder } from "../engine.js";
import type { GraphNode, GraphState } from "../types.js";
import { getStateObject, getStateString } from "../state.js";
import { checkEffectQuantification, checkNumericRangeCoverage, formatRange } from "../../spec/index.js";
import { globalStageHandlerRegistry, type StageHandlerRegistry } from "../../atoms/index.js";
import { dataBlock } from "../../prompt-hygiene.js";
import { handlerNode, llmNode, resolveInput, ruleGateNode } from "./shared.js";

export type BuildEnablementGraphOptions = {
  handlers?: StageHandlerRegistry;
  /** 规则门收口（缺省 true）。 */
  ruleGate?: boolean;
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean;
  /** 溯源包装钩子（ProvenanceCollector.wrapNode）：addNode 统一入口，透传 GraphBuilder。 */
  onAddNode?: (name: string, node: GraphNode) => GraphNode;
};

// ---------------------------------------------------------------------------
// 说明书五部分（审查指南第二部分第二章）
// ---------------------------------------------------------------------------

const SPEC_SECTIONS = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"] as const;

/** 章节行首标题正则：兼容 `# 技术领域`、`【技术领域】`、`1. 技术领域`、`技术领域：` 与裸标题行。 */
const SPEC_SECTION_HEADING_RE =
  /^\s*(?:#{1,6}\s+)?(?:\d+[\.、．]\s*)?(?:【)?(技术领域|背景技术|发明内容|附图说明|具体实施方式|摘要)(?:】)?\s*[：:。]?\s*$/;

/**
 * 按行首标题切分说明书为章节切片（含摘要与 preamble）。
 * 无任何标题行时返回 `{ full: text }`（fallback：后续按全文截断处理）。
 */
export function splitSpecSections(text: string): Record<string, string> {
  const lines = text.split("\n");
  const boundaries: Array<{ index: number; section: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = SPEC_SECTION_HEADING_RE.exec(lines[i]?.trim() ?? "");
    if (match !== null) boundaries.push({ index: i, section: match[1]! });
  }
  if (boundaries.length === 0) return { full: text };
  const result: Record<string, string> = {};
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i]!.index;
    const end = i + 1 < boundaries.length ? boundaries[i + 1]!.index : lines.length;
    result[boundaries[i]!.section] = lines.slice(start, end).join("\n");
  }
  if (boundaries[0]!.index > 0) {
    result.preamble = lines.slice(0, boundaries[0]!.index).join("\n");
  }
  return result;
}

/**
 * 按章节优先序拼接说明书上下文（预算内截断，长说明书不再"头部 8K 截断"）。
 * 无切片（splitSpecSections fallback / 旧 checkpoint 恢复）时回退全文截断。
 */
export function buildSpecContext(
  state: GraphState,
  preferSections: readonly string[],
  budget = SPEC_CONTEXT_BUDGET,
): string {
  const sections = getStateObject(state, "spec_section_texts");
  const keys = Object.keys(sections);
  if (keys.length === 0) {
    const text = resolveInput(state, SPEC_INPUT_KEYS);
    return text.slice(0, budget);
  }
  const ordered = [
    ...preferSections.filter(s => sections[s] !== undefined),
    ...keys.filter(k => !preferSections.includes(k)),
  ];
  const parts: string[] = [];
  let used = 0;
  for (const key of ordered) {
    const value = String(sections[key] ?? "");
    if (value.trim().length === 0) continue;
    const remaining = budget - used;
    if (remaining <= 0) break;
    const part = value.length <= remaining ? value : value.slice(0, remaining);
    parts.push(`## ${key}\n${part}`);
    used += part.length;
  }
  return parts.join("\n\n");
}

/** 说明书上下文拼接预算（字符）。 */
const SPEC_CONTEXT_BUDGET = 8000;

/** 输入文本在 workflowCtx 中的候选键（对齐 buildWorkflowRunContext 的统一映射）。 */
const SPEC_INPUT_KEYS = ["text", "source_text", "spec", "input"];

/** 说明书结构完整性检查（确定性：五部分出现情况）。 */
function checkSections(text: string): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const section of SPEC_SECTIONS) {
    if (text.includes(section)) present.push(section);
    else missing.push(section);
  }
  return { present, missing };
}

// ---------------------------------------------------------------------------
// domain_rules —— 技术领域检测 + 领域特殊要求（新增确定性节点）
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS: Record<string, { name: string; keywords: string[]; requirements: string[] }> = {
  bio: {
    name: "生物/医药生物",
    keywords: [
      "菌株",
      "细胞",
      "基因",
      "蛋白",
      "抗体",
      "杂交瘤",
      "微生物",
      "酶",
      "载体",
      "序列",
      "生物材料",
      "保藏",
      "生物",
    ],
    requirements: [
      "涉及生物材料：若该材料公众不能得到（无法据说明书制备/无法商业购买）且为实现发明必不可少，须记载保藏单位/保藏编号/保藏日期（保藏两条件缺一不可）",
      "若已公开编码序列（DNA/氨基酸）等替代实现路径，则材料非必不可少、无需保藏",
      "序列类发明须提供序列表或明确序列信息，否则可能公开不充分",
    ],
  },
  chemical: {
    name: "化学/医药",
    keywords: ["化合物", "化学", "催化剂", "聚合", "组合物", "药物", "医药", "制剂", "合成", "实施例"],
    requirements: [
      "化合物须给出制备方法（合成路线/原料/条件）",
      "技术效果须有实验证据（对比实验数据、测试条件与方法）",
      "马库什通式/宽泛概括：须足够实施例与数据支撑概括范围（本领域技术人员能合理预测）",
      "第二医药用途发明：须实验数据使本领域技术人员确信新用途与效果（辉瑞案标准）",
    ],
  },
  electrical: {
    name: "电学",
    keywords: [
      "电路",
      "信号",
      "电压",
      "电流",
      "电极",
      "导线",
      "电源",
      "芯片",
      "传感器",
      "模块",
      "时序",
      "引脚",
      "端口",
    ],
    requirements: [
      "须给出电路连接关系/耦合方式与信号流、工作时序描述",
      "关键电气参数（电压/电流/频率/阻抗）须明确并有实施例支撑",
    ],
  },
  software: {
    name: "计算机/软件",
    keywords: ["计算机", "程序", "算法", "处理器", "软件", "数据", "存储介质", "电子设备", "接口"],
    requirements: [
      "须给出算法流程/数据结构/模块划分，使本领域技术人员可实现",
      "涉及装置/系统的须说明硬件环境与连接关系",
    ],
  },
  mechanical: {
    name: "机械",
    keywords: ["机械", "装置", "结构", "部件", "传动", "轴承", "壳体", "支架"],
    requirements: ["须给出结构/连接关系/工作过程描述", "关键参数/尺寸须有实施例支撑"],
  },
};

/** 检测技术领域（首个命中领域；无命中返回 generic）。 */
export function detectTechnicalDomain(text: string): { domain: string; name: string; requirements: string[] } {
  for (const [domain, def] of Object.entries(DOMAIN_KEYWORDS)) {
    if (def.keywords.some(k => text.includes(k))) {
      return { domain, name: def.name, requirements: def.requirements };
    }
  }
  return { domain: "generic", name: "通用", requirements: [] };
}

const domainRulesNode = async ({ state }: { state: GraphState }): Promise<Record<string, unknown>> => {
  const text = resolveInput(state, SPEC_INPUT_KEYS);
  const detected = detectTechnicalDomain(text);
  return {
    technical_domain: detected.domain,
    technical_domain_name: detected.name,
    domain_requirements: detected.requirements,
  };
};

// ---------------------------------------------------------------------------
// spec_prechecks —— 确定性预检节点（数值范围端点/实施例计数/效果数据定量）
// ---------------------------------------------------------------------------

const EMBODIMENT_RE = /(?:本|该)?实施例(?:\s*[一二三四五六七八九十\d]+)?/g;

/** 确定性说明书预检（纯函数，供 spec_prechecks 节点与单测）。 */
export function runSpecPrechecks(text: string): {
  embodiment_count: number;
  has_embodiment: boolean;
  numeric_range_endpoint_missing: string[];
  numeric_range_midpoint_missing: string[];
  vague_effect_sentences: string[];
} {
  const embodimentCount = (text.match(EMBODIMENT_RE) ?? []).length;
  const { endpointMissing, midpointMissing } = checkNumericRangeCoverage(text);
  const vagueEffects = checkEffectQuantification(text);
  return {
    embodiment_count: embodimentCount,
    has_embodiment: embodimentCount > 0,
    numeric_range_endpoint_missing: endpointMissing.map(formatRange),
    numeric_range_midpoint_missing: midpointMissing.map(formatRange),
    vague_effect_sentences: vagueEffects.slice(0, 5),
  };
}

/** 将确定性预检结果格式化为提示块（无结果时返回空串）。 */
function prechecksBlock(state: GraphState): string {
  const prechecks = getStateObject(state, "spec_prechecks");
  if (Object.keys(prechecks).length === 0) return "";
  return ["", "【确定性预检信号（机器检测，供复核）】", JSON.stringify(prechecks, null, 2)].join("\n");
}

// ---------------------------------------------------------------------------
// 节点 JSON Schema
// ---------------------------------------------------------------------------

const COMPLETENESS_SCHEMA = {
  type: "object",
  properties: {
    missing_sections: { type: "array", items: { type: "string" }, description: "缺失章节" },
    completeness_ok: { type: "boolean", description: "结构是否完整" },
    notes: { type: "string", description: "结构完整性说明" },
  },
  required: ["missing_sections", "completeness_ok"],
} as const;

const CLARITY_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          problem: { type: "string", description: "问题描述" },
          location: { type: "string", description: "位置（章节/段落）" },
          severity: { type: "string", description: "major/minor" },
        },
        required: ["problem"],
      },
    },
    clarity_ok: { type: "boolean", description: "是否清楚" },
  },
  required: ["clarity_ok"],
} as const;

const ENABLEMENT_SCHEMA = {
  type: "object",
  properties: {
    gaps: { type: "array", items: { type: "string" }, description: "未充分公开的内容（本领域技术人员无法实现）" },
    enablement_ok: { type: "boolean", description: "是否能够实现" },
    skilled_person_assessment: { type: "string", description: "本领域技术人员判断" },
  },
  required: ["gaps", "enablement_ok"],
} as const;

const CONCLUDE_SCHEMA = {
  type: "object",
  properties: {
    sufficiently_disclosed: { type: "boolean", description: "是否充分公开（A26.3）" },
    confidence: { type: "string", description: "high/medium/low" },
    key_rationale: { type: "string", description: "核心理由" },
    report: { type: "string", description: "完整充分公开审查报告" },
  },
  required: ["sufficiently_disclosed", "confidence", "key_rationale", "report"],
} as const;

// ---------------------------------------------------------------------------
// 子图构建
// ---------------------------------------------------------------------------

/** 构建充分公开分析子图（A26.3）。 */
export function buildEnablementGraph(options: BuildEnablementGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const builder = new GraphBuilder({ onAddNode: options.onAddNode });
  const approval = handlers.lookup("approval-gate");

  // load：确定性节点，读取说明书并做结构统计与章节切片。
  builder.addNode("load", async ({ state }) => {
    const text = resolveInput(state, SPEC_INPUT_KEYS);
    const sections = checkSections(text);
    return {
      spec_length: text.length,
      spec_sections_present: sections.present,
      spec_sections_missing: sections.missing,
      spec_section_texts: splitSpecSections(text),
    };
  });
  builder.addNode("spec_prechecks", async ({ state }) => {
    const text = resolveInput(state, SPEC_INPUT_KEYS);
    return { spec_prechecks: runSpecPrechecks(text) };
  });
  builder.addNode(
    "completeness",
    llmNode({
      outputKey: "enablement_completeness",
      buildPrompt: state => {
        const missing = getStateString(state, "spec_sections_missing");
        const context = buildSpecContext(state, ["发明内容", "技术领域", "背景技术"]);
        return [
          "专利法 A26.3 充分公开审查——第一步：结构完整性。",
          "说明书应包含：技术领域/背景技术/发明内容/附图说明/具体实施方式（审查指南第二部分第二章 2.1）。",
          "确定性统计缺失章节（机器检测）：",
          missing || "（无缺失）",
          "",
          "请基于说明书相关章节复核结构完整性，并评估各章节实质内容是否满足要求：",
          dataBlock(context),
          "请严格输出 JSON：{ missing_sections, completeness_ok, notes }。",
        ].join("\n");
      },
      schema: COMPLETENESS_SCHEMA,
    }),
  );
  builder.addNode(
    "clarity",
    llmNode({
      outputKey: "enablement_clarity",
      buildPrompt: state => {
        const context = buildSpecContext(state, ["发明内容", "具体实施方式", "背景技术"]);
        return [
          "专利法 A26.3 充分公开审查——第二步：清楚性。",
          "检查：主题是否明确、用词是否准确、描述是否前后矛盾、技术方案是否混乱。",
          dataBlock(context),
          "请严格输出 JSON：{ issues（problem/location/severity）, clarity_ok }。",
        ].join("\n");
      },
      schema: CLARITY_SCHEMA,
    }),
  );
  builder.addNode(
    "enablement",
    llmNode({
      outputKey: "enablement_enablement",
      buildPrompt: state => {
        const context = buildSpecContext(state, ["具体实施方式", "发明内容", "技术领域", "背景技术", "附图说明"]);
        const claim = resolveInput(state, ["claim", "text", "source_text", "spec", "input"]);
        const claimBlock =
          claim.trim().length > 0
            ? ["", "【权利要求保护的技术方案（判断对象）】", dataBlock(claim.slice(0, 2000))].join("\n")
            : "";
        return [
          "专利法 A26.3 充分公开审查——第三步：能够实现性。",
          "判断对象：权利要求保护的技术方案（而非说明书整体）。",
          "标准：本领域技术人员按照说明书公开内容即可实现该技术方案（无需过度实验），解决技术问题并产生预期技术效果。",
          "",
          "审查指南 §2.1.3 列举的无法实现情形（逐条核对）：",
          "(1) 只给出任务/设想/愿望/结果，未给出可实施的技术手段；",
          "(2) 给出了技术手段但含糊不清，无法具体实施；",
          "(3) 给出了技术手段但不能解决所要解决的技术问题（如违背自然规律/原理上不可能）；",
          "(4) 方案由多个技术手段构成，其中某一手段无法实现；",
          "(5) 需实验证据证实才能成立（如已知化合物新用途）但未给出实验证据。",
          "",
          "同时注意平衡（避免过度否定）：",
          "- 站在本领域技术人员视角：公知常识、常规技术手段可省略描述；",
          "- 只要至少解决一个技术问题/达到一项合理技术效果即可，多种声称效果只需证明其一；",
          "- 技术效果可预期时无需实验数据（公知原理可推知、已知类似结构）；",
          "- 效果夸大通常不构成公开不充分（除非以夸大效果作为公开基础）。",
          prechecksBlock(state),
          dataBlock(context),
          claimBlock,
          "请严格输出 JSON：{ gaps（每项标注对应情形编号，如 §2.1.3(3)）, enablement_ok, skilled_person_assessment }。",
        ].join("\n");
      },
      schema: ENABLEMENT_SCHEMA,
    }),
  );
  builder.addNode("domain_rules", domainRulesNode);
  builder.addNode(
    "conclude",
    llmNode({
      outputKey: "enablement_conclusion",
      buildPrompt: state => {
        const context = buildSpecContext(state, ["具体实施方式", "发明内容", "技术领域", "背景技术"], 3000);
        const claim = resolveInput(state, ["claim", "text", "source_text", "spec", "input"]);
        const parts = [
          "【结构完整性】",
          getStateString(state, "enablement_completeness"),
          "【清楚性】",
          getStateString(state, "enablement_clarity"),
          "【能够实现性】",
          getStateString(state, "enablement_enablement"),
          "【技术领域与特殊要求】",
          `${getStateString(state, "technical_domain_name")}: ${getStateString(state, "domain_requirements")}`,
        ];
        const claimBlock =
          claim.trim().length > 0 && claim !== state.text
            ? ["【权利要求】", dataBlock(claim.slice(0, 1500))].join("\n")
            : "";
        return [
          "综合三步审查，生成专利法 A26.3 充分公开审查报告：",
          "- 逐类问题（清楚性/完整性/能够实现性）标注位置、严重程度与改进建议",
          "- 能够实现性结论按审查指南 §2.1.3 情形编号归类（(1)-(5)），并说明平衡考虑",
          "- 领域特殊要求（化学需实验证据、计算机需算法流程等）逐一核对",
          "- 结论附置信度（high/medium/low），回避绝对化表述",
          "",
          dataBlock(parts.join("\n").slice(0, 8000)),
          claimBlock,
          prechecksBlock(state),
          "",
          "（说明书关键章节供复核）",
          dataBlock(context),
          "请严格输出 JSON：{ sufficiently_disclosed, confidence, key_rationale, report }。",
        ].join("\n");
      },
      schema: CONCLUDE_SCHEMA,
    }),
  );

  // 边：load → spec_prechecks → completeness → clarity → enablement → domain_rules → conclude → 尾链
  builder.addEdge("load", "spec_prechecks");
  builder.addEdge("spec_prechecks", "completeness");
  builder.addEdge("completeness", "clarity");
  builder.addEdge("clarity", "enablement");
  builder.addEdge("enablement", "domain_rules");
  builder.addEdge("domain_rules", "conclude");

  const withRuleGate = options.ruleGate !== false;
  if (withRuleGate) builder.addNode("rule_gate", ruleGateNode(["patent_disclosure"]));
  if (approval !== undefined && options.includeApproval !== false) {
    builder.addNode("approval", handlerNode(approval, { review_context: "A26.3 充分公开审查结论需人工复核" }));
    builder.addEdge("conclude", "approval");
    builder.addEdge("approval", withRuleGate ? "rule_gate" : "__end__");
  } else {
    builder.addEdge("conclude", withRuleGate ? "rule_gate" : "__end__");
  }
  if (withRuleGate) builder.addEdge("rule_gate", "__end__");

  return builder;
}

/** 从图运行结果提取 A26.3 结论（供调用方/评测读取）。 */
export function extractEnablementResult(state: GraphState): {
  sufficientlyDisclosed?: boolean;
  confidence?: string;
  report?: string;
} {
  const raw = getStateString(state, "enablement_conclusion");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      sufficiently_disclosed?: unknown;
      confidence?: unknown;
      report?: unknown;
    };
    return {
      sufficientlyDisclosed:
        typeof parsed.sufficiently_disclosed === "boolean" ? parsed.sufficiently_disclosed : undefined,
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
 * 仅覆盖需要决策链的 LLM/推理节点；rule_gate/approval/domain_rules 不声明
 * （rule_gate 经 collectStateText 读全量、审批门由 approval_gate 记录）。
 * 缺失/漂移只记产出不伪造因果。
 */
export const ENABLEMENT_INPUT_DECLARATIONS: Readonly<Record<string, readonly string[]>> = {
  load: [],
  spec_prechecks: [],
  completeness: [],
  clarity: [],
  enablement: ["spec_prechecks"],
  domain_rules: [],
  conclude: ["enablement_completeness", "enablement_clarity", "enablement_enablement"],
};
