import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * patent_eval — 专利产出质量评估（移植自 Mady tools/patent_eval.go）。
 *
 * 5 种评估模式（report / retrieval / workflow / citations / comprehensive），
 * 通过线 0.7。在提交人工复核前调用可提前发现质量问题。
 * 纯确定性实现（章节正则 + 长度分级 + 权重综合），无外部依赖。
 */

export type PatentEvalMode = "report" | "retrieval" | "workflow" | "citations" | "comprehensive";

export type PatentEvalInput = {
  /** 评估模式: report(分析报告质量) / retrieval(检索覆盖度) / workflow(流程完整性) / citations(引用合规性) / comprehensive(全面评估) */
  mode: PatentEvalMode;
  /** 待评估的内容文本（报告正文/检索关键词列表/工作流步骤/引文列表等） */
  content?: string;
  /** 要求必须包含的法条引用列表（如 ["第二十二条第二款", "第二十二条第三款"]） */
  required_citations?: string[];
};

export type PatentEvalDimension = {
  score: number;
  passed: boolean;
  details?: string;
};

export type PatentEvalOutput = {
  mode: PatentEvalMode;
  score: number;
  passed: boolean;
  details: Record<string, PatentEvalDimension>;
  summary: string;
};

/** 报告结构章节检测模式（与 Mady reportSectionPatterns 一致）。 */
const REPORT_SECTIONS: Array<{ name: string; pattern: RegExp }> = [
  { name: "技术领域", pattern: /^#{1,3}\s*技术领域/m },
  { name: "背景技术", pattern: /^#{1,3}\s*背景技术/m },
  { name: "发明内容", pattern: /^#{1,3}\s*发明内容/m },
  { name: "技术方案", pattern: /^#{1,3}\s*技术方案/m },
  { name: "有益效果", pattern: /^#{1,3}\s*有益效果/m },
  { name: "附图说明", pattern: /^#{1,3}\s*附图说明/m },
  { name: "具体实施方式", pattern: /^#{1,3}\s*具体实施方式/m },
  { name: "法律依据", pattern: /^#{1,3}\s*法律依据/m },
  { name: "分析结论", pattern: /^#{1,3}\s*(分析结论|结论)/m },
  { name: "权利要求", pattern: /^#{1,3}\s*权利要求/m },
];

/** AI 套话/绝对化表述检测词表（Mady slop 引擎的轻量替代）。 */
const SLOP_PHRASES = [
  "综上所述",
  "值得注意的是",
  "不难发现",
  "总而言之",
  "众所周知",
  "毫无疑问",
  "众所周知的是",
  "我们相信",
  "我们认为",
  "绝对",
  "一定",
  "百分百",
  "显著提高",
  "极大改善",
];

const PASS_LINE = 0.7;

export function createPatentEvalTool(): SatiToolDefinition<PatentEvalInput, PatentEvalOutput> {
  return {
    name: "patent_eval",
    title: "Patent Evaluation",
    description:
      "评估专利相关产出的质量（报告/检索/流程/引用/综合）。返回结构化评分和通过/失败判定。支持 5 种评估模式（report/retrieval/workflow/citations/comprehensive），在提交人工复核前使用可提前发现质量问题。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["report", "retrieval", "workflow", "citations", "comprehensive"],
          description:
            "评估模式: report(分析报告质量) / retrieval(检索覆盖度) / workflow(流程完整性) / citations(引用合规性) / comprehensive(全面评估)",
        },
        content: {
          type: "string",
          description: "待评估的内容文本（报告正文/检索关键词列表/工作流步骤/引文列表等）",
        },
        required_citations: {
          type: "array",
          items: { type: "string" },
          description: '要求必须包含的法条引用列表（如 ["第二十二条第二款", "第二十二条第三款"]）',
        },
      },
      required: ["mode"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => {
      const output = evaluatePatentContent(input.mode, input.content ?? "", input.required_citations ?? []);
      return {
        content: [{ type: "json", value: output }],
        data: output,
      };
    },
  };
}

/** 纯函数入口：按模式评估专利产出，返回结构化评分。 */
export function evaluatePatentContent(
  mode: PatentEvalMode,
  content: string,
  requiredCitations: string[],
): PatentEvalOutput {
  const text = content ?? "";
  if (mode === "comprehensive") {
    return runComprehensiveEval(text, requiredCitations);
  }
  const dims = evaluateMode(mode, text, requiredCitations);
  const overall = averageScores(Object.values(dims));
  return {
    mode,
    score: round2(overall),
    passed: overall >= PASS_LINE,
    details: dims,
    summary: summarize(mode, overall),
  };
}

function evaluateMode(mode: PatentEvalMode, text: string, required: string[]): Record<string, PatentEvalDimension> {
  switch (mode) {
    case "report":
      return evaluateReport(text);
    case "retrieval":
      return evaluateRetrieval(text);
    case "workflow":
      return evaluateWorkflow(text);
    case "citations":
      return evaluateCitations(text, required);
    default:
      return {};
  }
}

/** report：结构完整性（章节覆盖）+ 表达质量（AI 套话）+ 内容充分性（长度分级）。 */
function evaluateReport(text: string): Record<string, PatentEvalDimension> {
  const dims: Record<string, PatentEvalDimension> = {};

  const sectionScore = scoreSectionCoverage(text);
  dims["结构完整性"] = {
    score: round2(sectionScore),
    passed: sectionScore >= 0.6,
    details: sectionCoverageDetail(text),
  };

  const slopScore = scoreSlop(text);
  dims["表达质量"] = {
    score: round2(slopScore),
    passed: slopScore >= 0.6,
    details: `${Math.round((1 - slopScore) * 100)} 处 AI 套话/绝对化表述`,
  };

  const sufficient = scoreContentSufficiency(text);
  dims["内容充分性"] = {
    score: round2(sufficient),
    passed: sufficient >= 0.5,
  };

  return dims;
}

function scoreSectionCoverage(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  let found = 0;
  for (const sp of REPORT_SECTIONS) {
    if (sp.pattern.test(trimmed)) found += 1;
  }
  return found / REPORT_SECTIONS.length;
}

function sectionCoverageDetail(text: string): string {
  const present: string[] = [];
  const missing: string[] = [];
  for (const sp of REPORT_SECTIONS) {
    if (sp.pattern.test(text)) present.push(sp.name);
    else missing.push(sp.name);
  }
  const parts = [`已覆盖 ${present.length}/${REPORT_SECTIONS.length} 个章节。`];
  if (missing.length > 0) parts.push(`缺失: ${missing.join("、")}`);
  return parts.join("");
}

function scoreSlop(text: string): number {
  let hits = 0;
  for (const phrase of SLOP_PHRASES) {
    if (text.includes(phrase)) hits += 1;
  }
  // 命中 5 处及以上计 0 分，线性衰减到 1.0
  const score = Math.max(0, 1 - hits / 5);
  return score;
}

function scoreContentSufficiency(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const chars = [...trimmed].length;
  if (chars < 50) return 0.1;
  if (chars < 200) return 0.3;
  if (chars < 500) return 0.5;
  if (chars < 1000) return 0.7;
  const paras = trimmed.split(/\n\s*\n/).length;
  if (paras < 3) return 0.6;
  return 1.0;
}

/** retrieval：检索关键词/分类号覆盖。 */
function evaluateRetrieval(text: string): Record<string, PatentEvalDimension> {
  const trimmed = text.trim();
  const keywords = trimmed.split(/\s+/).filter(Boolean);
  let keywordScore = 0;
  if (keywords.length >= 3) keywordScore = 1.0;
  else if (keywords.length >= 1) keywordScore = 0.5;
  return {
    关键词覆盖: {
      score: keywordScore,
      passed: keywordScore >= 0.5,
      details: `检索式含 ${keywords.length} 个关键词/分类号`,
    },
  };
}

/** workflow：工作流步骤完整性。 */
function evaluateWorkflow(text: string): Record<string, PatentEvalDimension> {
  const stepPattern = /^\s*(步骤|Step|阶段|Phase)\s*\d*/gm;
  const steps = text.match(stepPattern) ?? [];
  let stepScore = 0;
  if (steps.length >= 5) stepScore = 1.0;
  else if (steps.length >= 3) stepScore = 0.6;
  else if (steps.length >= 1) stepScore = 0.3;
  return {
    流程完整性: {
      score: stepScore,
      passed: stepScore >= 0.6,
      details: `检出 ${steps.length} 个工作流步骤`,
    },
  };
}

/** citations：引用合规性（required 覆盖度）+ 引用格式（第X条）。 */
function evaluateCitations(text: string, required: string[]): Record<string, PatentEvalDimension> {
  const dims: Record<string, PatentEvalDimension> = {};

  let citationScore = 0;
  if (required.length > 0) {
    const covered = required.filter(r => text.includes(r)).length;
    citationScore = covered / required.length;
  } else {
    citationScore = text.includes("第") && /第[零一二三四五六七八九十百千\d]+条/.test(text) ? 1.0 : 0.3;
  }
  dims["引用合规性"] = {
    score: round2(citationScore),
    passed: citationScore >= 0.7,
    details: `要求 ${required.length} 条引用，覆盖度 ${Math.round(citationScore * 100)}%`,
  };

  const formatPattern = /第[零一二三四五六七八九十百千\d]+条/g;
  const formatMatches = text.match(formatPattern) ?? [];
  const formatScore = formatMatches.length > 0 ? 1.0 : 0.3;
  dims["引用格式"] = {
    score: formatScore,
    passed: formatScore >= 0.5,
    details: `检出 ${formatMatches.length} 处法条引用格式`,
  };

  return dims;
}

/** comprehensive：全部子评估 + 加权综合（report 40% + citations 25% + retrieval 20% + workflow 15%）。 */
function runComprehensiveEval(text: string, required: string[]): PatentEvalOutput {
  const allDims: Record<string, PatentEvalDimension> = {
    ...evaluateReport(text),
    ...evaluateRetrieval(text),
    ...evaluateWorkflow(text),
    ...evaluateCitations(text, required),
  };

  const weights: Record<string, number> = {
    结构完整性: 0.15,
    表达质量: 0.1,
    内容充分性: 0.15,
    关键词覆盖: 0.2,
    流程完整性: 0.15,
    引用合规性: 0.15,
    引用格式: 0.1,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const [key, dim] of Object.entries(allDims)) {
    const w = weights[key] ?? 0.1;
    weightedSum += dim.score * w;
    totalWeight += w;
  }
  const composite = totalWeight > 0 ? weightedSum / totalWeight : 0;

  const parts = [`综合质量评分: ${composite.toFixed(2)}/1.0`];
  for (const [key, dim] of Object.entries(allDims)) {
    parts.push(`  ${dim.passed ? "✅" : "❌"} ${key}: ${dim.score.toFixed(2)}`);
  }

  return {
    mode: "comprehensive",
    score: round2(composite),
    passed: composite >= PASS_LINE,
    details: allDims,
    summary: parts.join("\n"),
  };
}

function averageScores(dims: PatentEvalDimension[]): number {
  if (dims.length === 0) return 0;
  return dims.reduce((sum, d) => sum + d.score, 0) / dims.length;
}

function summarize(mode: PatentEvalMode, score: number): string {
  const label =
    mode === "report"
      ? "报告质量"
      : mode === "retrieval"
        ? "检索覆盖度"
        : mode === "workflow"
          ? "流程完整性"
          : "引用合规性";
  return `${label}评分: ${score.toFixed(2)}/1.0 (${score >= PASS_LINE ? "通过" : "需修订"})`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
