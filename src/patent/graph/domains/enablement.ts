/**
 * src/patent/graph/domains/enablement — 充分公开分析子图（专利法 A26.3）。
 *
 * 节点链：load（确定性：分段/统计）→ completeness（结构完整性）→ clarity（清楚性）
 * → enablement（能够实现性）→ domain_rules（新增：技术领域检测 + 领域特殊要求）
 * → conclude（结论）→ approval → rule_gate。
 *
 * 对齐 Mady domains/enablement（5 节点 + domain_rules.go 领域特殊规则）。
 */

import { GraphBuilder, type GraphState } from "../index.js";
import { getStateString } from "../state.js";
import { globalStageHandlerRegistry, type StageHandlerRegistry } from "../../atoms/index.js";
import { handlerNode, llmNode, resolveInput, ruleGateNode } from "./shared.js";

export type BuildEnablementGraphOptions = {
  handlers?: StageHandlerRegistry;
  /** 规则门收口（缺省 true）。 */
  ruleGate?: boolean;
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean;
};

// ---------------------------------------------------------------------------
// 说明书五部分（审查指南第二部分第二章）
// ---------------------------------------------------------------------------

const SPEC_SECTIONS = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"] as const;

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
  chemical: {
    name: "化学/医药",
    keywords: ["化合物", "化学", "催化剂", "聚合", "组合物", "药物", "医药", "生物", "制剂"],
    requirements: [
      "化合物须给出制备方法（合成路线/原料/条件）",
      "技术效果须有实验证据（对比实验数据、测试条件与方法）",
    ],
  },
  software: {
    name: "计算机/软件",
    keywords: ["计算机", "程序", "算法", "处理器", "芯片", "软件", "数据", "存储介质", "电子设备"],
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

const domainRulesNode = async (ctx: { state: GraphState }): Promise<Record<string, unknown>> => {
  const text = resolveInput(ctx.state, ["text", "source_text", "spec", "input"]);
  const detected = detectTechnicalDomain(text);
  return {
    technical_domain: detected.domain,
    technical_domain_name: detected.name,
    domain_requirements: detected.requirements,
  };
};

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
  const builder = new GraphBuilder();
  const approval = handlers.lookup("approval-gate");

  // load：确定性节点，读取说明书并做结构统计。
  builder.addNode("load", async ({ state }) => {
    const text = resolveInput(state, ["text", "source_text", "spec", "input"]);
    const sections = checkSections(text);
    return {
      spec_length: text.length,
      spec_sections_present: sections.present,
      spec_sections_missing: sections.missing,
    };
  });
  builder.addNode(
    "completeness",
    llmNode({
      outputKey: "enablement_completeness",
      buildPrompt: state => {
        const text = resolveInput(state, ["text", "source_text", "spec", "input"]);
        const missing = getStateString(state, "spec_sections_missing");
        return [
          "专利法 A26.3 充分公开审查——第一步：结构完整性。",
          "说明书应包含：技术领域/背景技术/发明内容/附图说明/具体实施方式（审查指南第二部分第二章 2.1）。",
          "确定性统计缺失章节（机器检测）：",
          missing || "（无缺失）",
          "",
          "请基于说明书全文复核结构完整性，并评估各章节实质内容是否满足要求：",
          "```",
          text.slice(0, 8000),
          "```",
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
        const text = resolveInput(state, ["text", "source_text", "spec", "input"]);
        return [
          "专利法 A26.3 充分公开审查——第二步：清楚性。",
          "检查：主题是否明确、用词是否准确、描述是否前后矛盾、技术方案是否混乱。",
          "```",
          text.slice(0, 8000),
          "```",
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
        const text = resolveInput(state, ["text", "source_text", "spec", "input"]);
        return [
          "专利法 A26.3 充分公开审查——第三步：能够实现性。",
          "判断：本领域技术人员根据说明书公开内容，能否实现权利要求要求保护的技术方案（无需过度实验）。",
          "关注：缺少实施细节、技术手段不完整、功能性限定无实施方式支撑、实验数据缺失。",
          "```",
          text.slice(0, 8000),
          "```",
          "请严格输出 JSON：{ gaps, enablement_ok, skilled_person_assessment }。",
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
        const text = resolveInput(state, ["text", "source_text", "spec", "input"]);
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
        return [
          "综合三步审查，生成专利法 A26.3 充分公开审查报告：",
          "- 逐类问题（清楚性/完整性/能够实现性）标注位置、严重程度与改进建议",
          "- 领域特殊要求（化学需实验证据、计算机需算法流程等）逐一核对",
          "- 结论附置信度（high/medium/low），回避绝对化表述",
          "",
          parts.join("\n").slice(0, 8000),
          "",
          "（说明书全文供复核）",
          "```",
          text.slice(0, 3000),
          "```",
          "请严格输出 JSON：{ sufficiently_disclosed, confidence, key_rationale, report }。",
        ].join("\n");
      },
      schema: CONCLUDE_SCHEMA,
    }),
  );

  // 边：load → completeness → clarity → enablement → domain_rules → conclude → 尾链
  builder.addEdge("load", "completeness");
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
    return {};
  }
}
