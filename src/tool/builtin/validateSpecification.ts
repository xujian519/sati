import type { SatiToolDefinition } from "../protocol/types.js";
import type { FigureAnalysisResult } from "../../patent/figure/types.js";
import { extractSmilesCandidates, isRdkitAvailable, validateSmiles } from "../../patent/chemistry/index.js";
import type { TechDomain } from "./draftClaims.js";

/**
 * validate_specification — 专利说明书合规性校验（移植自 Mady domains/specdrafting）。
 *
 * 确定性规则：结构完整性（五部分章节）/ 发明名称长度 / 摘要长度 /
 * 模糊表述 / 附图说明与图引用一致性。
 *
 * 增强（对齐 src/knowledge/patent/wiki 卡片要求）：
 * - claim_coverage：权利要求-说明书特征覆盖（A26.4 以说明书为依据）
 * - numeric_range_endpoints / numeric_range_midpoint：数值范围端点 + 中间值实施例
 * - effect_data_quantified：效果数据定量性（避免"效果好"式无数据表述）
 * - chemical_characterization：化学领域产物表征数据（tech_domain === "chemical"）
 * - abstract_keywords / abstract_drawing：摘要关键词与摘要附图（A26.5）
 * - embodiments：至少一个可实施实施例（实施细则第17条）
 */

export type ValidateSpecificationInput = {
  /** 说明书全文（markdown，含章节标题） */
  text?: string;
  /** 发明名称（可选，单独校验长度） */
  title?: string;
  /** 摘要（可选，校验长度/关键词/摘要附图） */
  abstract?: string;
  /** 权利要求书全文（可选，用于特征覆盖比对） */
  claims?: string;
  /** 技术领域（chemical 时附加化学表征数据校验） */
  tech_domain?: TechDomain;
  /**
   * 附图智能分析结果（可选）：提供时执行图文一致性校验——
   * 附图说明章节列出的标号须与附图分析识别的组件标号一致（无漏标/无悬空）。
   */
  figure_analysis?: FigureAnalysisResult[];
};

export type SpecViolation = {
  rule: string;
  severity: "error" | "warning";
  section?: string;
  message: string;
  suggestion?: string;
};

export type ValidateSpecificationOutput = {
  passed: boolean;
  score: number;
  violations: SpecViolation[];
};

/** 必需章节（结构与 Mady requiredSections 一致）。 */
const REQUIRED_SECTIONS: Array<{ name: string; pattern: RegExp }> = [
  { name: "技术领域", pattern: /^#{1,3}\s*技术领域/m },
  { name: "背景技术", pattern: /^#{1,3}\s*背景技术/m },
  { name: "发明内容", pattern: /^#{1,3}\s*发明内容/m },
  { name: "附图说明", pattern: /^#{1,3}\s*附图说明/m },
  { name: "具体实施方式", pattern: /^#{1,3}\s*具体实施方式/m },
];

const VAGUE_TERMS = ["约", "大致", "可能", "优选", "例如", "大约", "左右", "较好"];

// =============================================================================
// 数值范围与单位（端点 + 中间值实施例检测）
// =============================================================================

/**
 * 支持的单位列表（按长度降序排列：多字符单位在前，避免交替匹配把
 * "5mg" 截成 "m"、"0.1-2MPa" 截成 "m" 等误解析）。
 */
const UNITS = "°C|℃|MPa|kPa|Pa|rpm|min|mol|mm|cm|kg|mg|ml|mL|％|°|m|g|L|h|s|%";

/** 数值范围（如 20-90℃、20℃至90℃、20~90℃）。 */
const RANGE_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:${UNITS})?\\s*(?:[~～至\\-—])\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`,
  "g",
);

/** 带单位的单个数值（如 60℃、5mm）。 */
const VALUE_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`, "g");

export type NumericRange = { min: number; max: number; unit: string };

/** 归一化单位：温度类统一为 "°"，其余原样（℃/°C/° 可比）。 */
function normalizeUnit(unit: string): string {
  return ["℃", "°C", "°"].includes(unit) ? "°" : unit;
}

/** 提取说明书中的数值范围（min < max 才保留）。 */
export function extractNumericRanges(text: string): NumericRange[] {
  const ranges: NumericRange[] = [];
  let m: RegExpExecArray | null;
  RANGE_PATTERN.lastIndex = 0;
  while ((m = RANGE_PATTERN.exec(text)) !== null) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      ranges.push({ min, max, unit: normalizeUnit(m[3] ?? "") });
    }
  }
  return ranges;
}

/** 提取正文中出现的带单位单个数值（剔除范围表达式自身，避免把端点当独立数值）。 */
export function extractNumericValues(text: string): Array<{ value: number; unit: string }> {
  const body = text.replace(RANGE_PATTERN, " ");
  const values: Array<{ value: number; unit: string }> = [];
  let m: RegExpExecArray | null;
  VALUE_PATTERN.lastIndex = 0;
  while ((m = VALUE_PATTERN.exec(body)) !== null) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) values.push({ value, unit: normalizeUnit(m[2] ?? "") });
  }
  return values;
}

/** 数值范围端点 + 中间值实施例检测：返回 (缺端点范围, 缺中间值范围)。 */
export function checkNumericRangeCoverage(text: string): {
  endpointMissing: NumericRange[];
  midpointMissing: NumericRange[];
} {
  const ranges = extractNumericRanges(text);
  const values = extractNumericValues(text);
  const endpointMissing: NumericRange[] = [];
  const midpointMissing: NumericRange[] = [];
  for (const range of ranges) {
    const sameUnit = values.filter(v => v.unit === range.unit);
    const hasEndpoint = sameUnit.some(v => v.value === range.min || v.value === range.max);
    const hasMidpoint = sameUnit.some(v => v.value > range.min && v.value < range.max);
    if (!hasEndpoint) endpointMissing.push(range);
    if (!hasMidpoint) midpointMissing.push(range);
  }
  return { endpointMissing, midpointMissing };
}

function formatRange(range: NumericRange): string {
  return `${range.min}-${range.max}${range.unit === "°" ? "℃" : range.unit}`;
}

// =============================================================================
// 效果数据定量性检测
// =============================================================================

/** 无定量数据支撑的效果套话模式（"效果好/显著/大幅提升"等）。 */
const VAGUE_EFFECT_RE =
  /(?:效果|性能)(?:显著|良好|优异|优越|极佳|大幅|大大提高|明显提升|显著提高|大幅提升|明显改善|显著改善|明显|好)|(?:大大|显著|明显|大幅|有效)(?:提高|提升|改善|降低|减少|增强)/;

/** 返回未附带任何数字/百分比的"效果套话"句子（截断 40 字）。 */
export function checkEffectQuantification(text: string): string[] {
  const hits: string[] = [];
  for (const raw of text.split(/[。；\n]/)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;
    if (VAGUE_EFFECT_RE.test(sentence) && !/\d|％|%/.test(sentence)) {
      hits.push(sentence.slice(0, 40));
    }
  }
  return hits;
}

// =============================================================================
// 化学领域表征数据检测
// =============================================================================

/** 化学领域产物表征手段（化合物/晶体须至少提供其一）。 */
const CHEM_CHARACTERIZATION_TERMS = [
  "NMR",
  "核磁",
  "MS",
  "质谱",
  "IR",
  "红外",
  "元素分析",
  "XRPD",
  "XRD",
  "X射线",
  "X-射线",
  "晶胞参数",
  "空间群",
  "熔点",
  "旋光度",
  "UV",
  "紫外",
  "HPLC",
  "高效液相",
  "GC",
  "气相色谱",
];

/** 化学领域：返回完全缺失的表征手段（全部命中任一即视为已提供表征数据）。 */
export function checkChemicalCharacterization(text: string): string[] {
  return CHEM_CHARACTERIZATION_TERMS.filter(term => !text.includes(term));
}

// =============================================================================
// SMILES 合法性抽检（异步增强，评审 M1 修订）
// =============================================================================

/**
 * SMILES 合法性抽检（异步步骤，仅当 RDKit 可用且文本含类 SMILES 候选时执行）。
 * 非法候选追加 warning 级违规——不改变既有同步规则的判级语义（severity 保持 warning，
 * 不新增 error）；RDKit 不可用或无可疑候选时静默跳过。
 * 评审 M5：异常全兜底——抽检是增强步骤，任何异常不得拖垮同步校验结果。
 */
export async function checkSmilesValidity(text: string): Promise<SpecViolation[]> {
  try {
    const candidates = extractSmilesCandidates(text);
    if (candidates.length === 0) return [];
    if (!(await isRdkitAvailable())) return [];

    const invalid: string[] = [];
    for (const candidate of candidates) {
      const result = await validateSmiles(candidate);
      if (!result.ok) {
        invalid.push(candidate.length > 40 ? `${candidate.slice(0, 40)}…` : candidate);
      }
    }
    if (invalid.length === 0) return [];

    return [
      {
        rule: "smiles_validity",
        severity: "warning",
        section: "具体实施方式",
        message: `说明书中的 ${invalid.length} 个 SMILES 未通过 RDKit 校验：${invalid.slice(0, 3).join("、")}`,
        suggestion: "核对 SMILES 写法（原子/键/环闭合/分支语法），或经 recognize_chemical_structure 重新识别",
      },
    ];
  } catch {
    // 抽检失败静默降级：仅损失增强违规项，同步规则结果不受影响
    return [];
  }
}

/** 评分：error 每条扣 0.25，warning 每条扣 0.1，最低 0；passed 仅受 error 影响。 */
export function computeSpecScore(violations: SpecViolation[]): { passed: boolean; score: number } {
  const errors = violations.filter(v => v.severity === "error").length;
  const warnings = violations.filter(v => v.severity === "warning").length;
  const score = Math.max(0, Math.min(1, 1 - errors * 0.25 - warnings * 0.1));
  return { passed: errors === 0, score: Math.round(score * 100) / 100 };
}

// =============================================================================
// 权利要求-说明书特征覆盖（A26.4）
// =============================================================================

const CLAIM_REF_PATTERN =
  /所述([\u4e00-\u9fa5A-Za-z0-9·\-]{2,24}?)(?=与|和|及|或|、|，|,|；|;|用于|包括|连接|设置|固定|安装|位于|设于|[。])/g;
const CLAIM_VALUE_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`, "g");

/** 过于宽泛、无区分度的通用词（不参与覆盖比对）。 */
const GENERIC_TERMS = new Set([
  "装置",
  "系统",
  "方法",
  "结构",
  "单元",
  "模块",
  "部件",
  "组件",
  "步骤",
  "特征",
  "技术",
  "方案",
  "本发明",
  "申请",
  "权利要求",
  "领域",
  "信息",
  "数据",
]);

/** 从权利要求书提取技术特征候选（"所述X"名词 + 数字+单位值），去重并过滤泛化词。 */
export function extractClaimFeatures(claims: string): string[] {
  const features = new Set<string>();
  let m: RegExpExecArray | null;
  CLAIM_REF_PATTERN.lastIndex = 0;
  while ((m = CLAIM_REF_PATTERN.exec(claims)) !== null) {
    const term = m[1]!.trim();
    if (term.length >= 2 && !GENERIC_TERMS.has(term)) features.add(term);
  }
  CLAIM_VALUE_PATTERN.lastIndex = 0;
  while ((m = CLAIM_VALUE_PATTERN.exec(claims)) !== null) {
    features.add(`${m[1]}${normalizeUnit(m[2] ?? "")}`);
  }
  return [...features];
}

/** 特征覆盖比对：返回未在说明书记载的特征。 */
export function checkClaimCoverage(claims: string, text: string): { missing: string[]; total: number } {
  const features = extractClaimFeatures(claims);
  const missing = features.filter(feature => !text.includes(feature));
  return { missing, total: features.length };
}

/**
 * 图文一致性校验：附图说明章节列出的标号 vs 附图分析识别的组件标号。
 *
 * - 附图分析不可用（usable=false）的图不做校验，仅提示人工核对；
 *   可用图照常校验（按图粒度降级，不 all-or-nothing）；
 * - 漏标：附图中标号但附图说明未列出 → warning；
 * - 悬空：附图说明列出但附图中不存在 → error。
 *
 * 支持的附图说明标号格式（正则假设）："图中：1-壳体；2-缓冲层；"——
 * 标号前为行首或分隔符（；;\n，,：:），标号后跟连字符（-–—）。
 * 其他格式（如 "1. 壳体" / "标号1为壳体"）不会被识别为标号。
 */
export function checkFigureMarkConsistency(text: string, figureAnalysis: FigureAnalysisResult[]): SpecViolation[] {
  if (figureAnalysis.length === 0) return [];
  const violations: SpecViolation[] = [];

  const unusable = figureAnalysis.filter(f => !f.usable);
  if (unusable.length > 0) {
    violations.push({
      rule: "figure_mark_consistency",
      severity: "warning",
      message: `附图分析结果不可用（${unusable.length} 张），请人工核对图面标号与附图说明`,
    });
  }

  // 仅对可用图做标号集合比对。
  const figureMarks = new Set<string>();
  for (const f of figureAnalysis) {
    if (!f.usable) continue;
    for (const c of f.components) {
      if (/^\d+$/.test(c.refNumber)) figureMarks.add(c.refNumber);
    }
  }
  if (figureMarks.size === 0) return violations;

  const drawingSection = getDrawingSection(text);
  if (!drawingSection) {
    violations.push({
      rule: "figure_mark_consistency",
      severity: "warning",
      message: "说明书缺少附图说明章节，无法核验附图标记与图面一致性",
      suggestion: "补充附图说明章节，逐图列出标号对应的部件",
    });
    return violations;
  }

  // 附图说明中列出的标号（"图中：1-壳体" / "2-缓冲层" 模式）。
  const listedMarks = new Set<string>();
  const markPattern = /(?:^|[；;\n，,：:])\s*(\d+)\s*[-–—]/g;
  let match: RegExpExecArray | null;
  while ((match = markPattern.exec(drawingSection)) !== null) {
    listedMarks.add(match[1]);
  }

  const missing = [...figureMarks].filter(n => !listedMarks.has(n));
  if (missing.length > 0) {
    violations.push({
      rule: "figure_mark_consistency",
      severity: "warning",
      section: "附图说明",
      message: `附图标记 ${missing.join("、")} 未在附图说明中列出`,
      suggestion: "在附图说明中补充对应标号的部件说明",
    });
  }

  const dangling = [...listedMarks].filter(n => !figureMarks.has(n));
  if (dangling.length > 0) {
    violations.push({
      rule: "figure_mark_consistency",
      severity: "error",
      section: "附图说明",
      message: `附图说明中的标记 ${dangling.join("、")} 在附图中不存在`,
      suggestion: "核对图面标号，删除或更正附图说明中不存在的标号",
    });
  }

  return violations;
}

// =============================================================================
// 主入口
// =============================================================================

export function createValidateSpecificationTool(): SatiToolDefinition<
  ValidateSpecificationInput,
  ValidateSpecificationOutput
> {
  return {
    name: "validate_specification",
    title: "Validate Patent Specification",
    description:
      "验证专利说明书是否符合撰写要求，包括结构完整性、发明名称长度、摘要长度、模糊表述、附图说明一致性、" +
      "权利要求特征覆盖（A26.4）、数值范围端点与中间值实施例、效果数据定量性、化学领域表征数据、摘要关键词与摘要附图等检查。" +
      "文本含 SMILES 时附加合法性抽检（RDKit 校验，warning 级）。" +
      "在说明书初稿完成后使用；可传入权利要求书全文（claims）与技术领域（tech_domain）以启用实质校验。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "说明书全文（markdown，含章节标题）" },
        title: { type: "string", description: "发明名称（可选，单独校验长度）" },
        abstract: { type: "string", description: "摘要（可选，校验长度/关键词/摘要附图）" },
        claims: { type: "string", description: "权利要求书全文（可选，用于特征覆盖比对）" },
        tech_domain: {
          type: "string",
          enum: ["mechanical", "electrical", "chemical", "software", "general"],
          description: "技术领域（chemical 时附加化学表征数据校验）",
        },
        figure_analysis: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              figure_number: { type: "number", description: "附图编号" },
              figure_description: { type: "string", description: "附图说明文字（专利格式）" },
              usable: { type: "boolean", description: "分析结果是否可用（组件提取成功）" },
              components: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    ref_number: { type: "string", description: "附图标记号（与图面标号一致）" },
                    name: { type: "string", description: "组件名称" },
                  },
                },
                description: "识别的组件列表",
              },
            },
          },
          description:
            "附图智能分析结果（analyze_patent_figure 的输出数组，可选）：提供时执行图文一致性校验（附图说明标号 vs 附图分析标号）",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => {
      const output = validateSpecification(input);
      // SMILES 合法性抽检（异步增强）：同步规则之后追加 warning，不改变判级语义。
      const smileChecks = await checkSmilesValidity(input.text ?? "");
      if (smileChecks.length > 0) {
        output.violations.push(...smileChecks);
        const scored = computeSpecScore(output.violations);
        output.passed = scored.passed;
        output.score = scored.score;
      }
      return {
        content: [{ type: "json", value: output }],
        data: output,
      };
    },
  };
}

/** 纯函数入口：按规则集校验说明书，返回违规列表与评分。 */
export function validateSpecification(input: ValidateSpecificationInput): ValidateSpecificationOutput {
  const violations: SpecViolation[] = [];
  const text = input.text ?? "";
  const title = input.title?.trim() ?? "";

  // 1) 结构完整性：五部分章节齐全
  const present = new Set<string>();
  for (const sec of REQUIRED_SECTIONS) {
    if (sec.pattern.test(text)) present.add(sec.name);
  }
  const missing = REQUIRED_SECTIONS.map(s => s.name).filter(n => !present.has(n));
  if (text.trim().length > 0 && missing.length > 0) {
    violations.push({
      rule: "sections",
      severity: "error",
      message: `缺少必要章节：${missing.join("、")}`,
      suggestion: "请按顺序撰写技术领域、背景技术、发明内容、附图说明和具体实施方式",
    });
  } else if (text.trim().length === 0) {
    violations.push({
      rule: "sections",
      severity: "error",
      message: "说明书缺少所有必要章节（text 为空）",
      suggestion: "请提供说明书全文",
    });
  }

  // 2) 发明名称长度 ≤ 25 字
  if (title.length > 25) {
    violations.push({
      rule: "title_length",
      severity: "error",
      section: "技术领域",
      message: `发明名称超过 25 字限制（${title.length} 字）`,
      suggestion: "请缩短至 25 字以内，使用通用技术术语",
    });
  }

  // 3) 摘要长度 ≤ 300 字 + 关键词 + 摘要附图（A26.5）
  if (input.abstract && [...input.abstract.trim()].length > 300) {
    violations.push({
      rule: "abstract_length",
      severity: "error",
      section: "摘要",
      message: `摘要超过 300 字限制（${[...input.abstract.trim()].length} 字）`,
      suggestion: "请压缩至 300 字以内",
    });
  }
  if (input.abstract && input.abstract.trim().length > 0 && !/关键词|关键字/.test(input.abstract)) {
    violations.push({
      rule: "abstract_keywords",
      severity: "warning",
      section: "摘要",
      message: "摘要未包含关键词",
      suggestion: "在摘要末尾添加关键词，如“关键词：…；…”，便于检索分类",
    });
  }
  if (input.abstract && present.has("附图说明")) {
    const drawingSection = getDrawingSection(text);
    const hasRealDrawings = !/无附图/.test(drawingSection);
    if (hasRealDrawings && !/摘要附图|附图.{0,16}图\s*\d|图\s*\d.{0,16}摘要/.test(input.abstract)) {
      violations.push({
        rule: "abstract_drawing",
        severity: "warning",
        section: "摘要",
        message: "说明书含附图但摘要未指定摘要附图",
        suggestion: "在摘要中注明“摘要附图为图X”，与附图说明对应",
      });
    }
  }

  // 4) 模糊表述检测
  const vagueHits = VAGUE_TERMS.filter(t => text.includes(t));
  if (vagueHits.length > 0) {
    violations.push({
      rule: "clarity",
      severity: "warning",
      message: `说明书包含模糊表述：${vagueHits.join("、")}`,
      suggestion: "删除'约/大致/可能/优选/例如'等模糊表述，使用确定的技术术语",
    });
  }

  // 5) 附图说明与图引用一致性
  const hasDrawingSection = present.has("附图说明");
  const figRefs = text.match(/图\s*[一二三四五六七八九十\d]+/g) ?? [];
  const bodyRefs = figRefs.length - countInDrawingSection(text);
  if (hasDrawingSection && bodyRefs === 0) {
    violations.push({
      rule: "drawings",
      severity: "warning",
      section: "附图说明",
      message: "存在附图说明章节但正文未引用任何附图（图1、图2...）",
      suggestion: "在具体实施方式中引用附图标记，与附图说明对应",
    });
  }
  if (!hasDrawingSection && bodyRefs > 0) {
    violations.push({
      rule: "drawings",
      severity: "warning",
      message: `正文引用了 ${bodyRefs} 处附图但缺少附图说明章节`,
      suggestion: "补充附图说明章节，逐图说明图名和内容",
    });
  }

  // 5b) 图文一致性（figure_analysis 提供时：附图说明标号 vs 附图分析标号）
  if (input.figure_analysis?.length) {
    violations.push(...checkFigureMarkConsistency(text, input.figure_analysis));
  }

  // 6) 实施例存在性（实施细则第17条：至少一个可实施实施例；支持"实施例1/本实施例"写法）
  const embodimentCount = (text.match(/(?:本|该)?实施例(?:\s*[一二三四五六七八九十\d]+)?/g) ?? []).length;
  if (text.trim().length > 0 && embodimentCount === 0) {
    violations.push({
      rule: "embodiments",
      severity: "error",
      section: "具体实施方式",
      message: "说明书未记载任何实施例",
      suggestion: "撰写至少一个可实施实施例，覆盖权利要求的全部技术特征",
    });
  }

  // 7) 数值范围端点 + 中间值实施例（审查指南第二部分第二章）
  if (text.trim().length > 0) {
    const { endpointMissing, midpointMissing } = checkNumericRangeCoverage(text);
    if (endpointMissing.length > 0) {
      violations.push({
        rule: "numeric_range_endpoints",
        severity: "error",
        section: "具体实施方式",
        message: `数值范围缺少端点值实施例：${endpointMissing.map(formatRange).join("、")}`,
        suggestion: "为每个数值范围补充两端值附近（最好是两端值）的实施例",
      });
    }
    if (midpointMissing.length > 0) {
      violations.push({
        rule: "numeric_range_midpoint",
        severity: "warning",
        section: "具体实施方式",
        message: `数值范围缺少中间值实施例：${midpointMissing.map(formatRange).join("、")}`,
        suggestion: "范围较宽时补充至少一个中间值的实施例，支持中间范围内的概括",
      });
    }
  }

  // 8) 效果数据定量性（避免"效果好/显著"式无数据表述）
  const vagueEffects = checkEffectQuantification(text);
  if (vagueEffects.length > 0) {
    violations.push({
      rule: "effect_data_quantified",
      severity: "warning",
      section: "发明内容",
      message: `效果表述缺少定量数据支撑：${vagueEffects.slice(0, 3).join("；")}`,
      suggestion: "补充定量效果数据（对比实验/百分比/提升幅度），建立效果与区别技术特征的对应",
    });
  }

  // 9) 化学领域表征数据（tech_domain === "chemical"）
  if (input.tech_domain === "chemical" && text.trim().length > 0) {
    const missingTerms = checkChemicalCharacterization(text);
    if (missingTerms.length === CHEM_CHARACTERIZATION_TERMS.length) {
      violations.push({
        rule: "chemical_characterization",
        severity: "warning",
        section: "具体实施方式",
        message: "化学领域说明书未提供任何产物表征数据",
        suggestion: "补充产物表征数据（NMR/MS/IR/元素分析/XRPD/晶胞参数等至少其一），并与具体实施例对应",
      });
    }
  }

  // 10) 权利要求-说明书特征覆盖（A26.4）
  if (input.claims && input.claims.trim().length > 0 && text.trim().length > 0) {
    const { missing: missingFeatures, total } = checkClaimCoverage(input.claims, text);
    if (total >= 3 && missingFeatures.length > 0) {
      const rate = missingFeatures.length / total;
      violations.push({
        rule: "claim_coverage",
        severity: rate > 0.5 ? "error" : "warning",
        section: "发明内容",
        message: `权利要求中的 ${missingFeatures.length}/${total} 个技术特征未在说明书记载：${missingFeatures.join("、")}`,
        suggestion: "在发明内容/具体实施方式中补充记载上述技术特征，确保说明书支持权利要求（A26.3/A26.4）",
      });
    }
  }

  // 评分：error 每条扣 0.25，warning 每条扣 0.1，最低 0
  const scored = computeSpecScore(violations);

  return {
    passed: scored.passed,
    score: scored.score,
    violations,
  };
}

const DRAWING_SECTION_RE = /^#{1,3}\s*附图说明\s*\n([\s\S]*?)(?=^#{1,3}\s|\s*$)/m;

/** 提取附图说明章节正文（无该章节时返回空串）。 */
function getDrawingSection(text: string): string {
  return text.match(DRAWING_SECTION_RE)?.[1] ?? "";
}

/** 统计附图说明章节内的"图N"引用数（避免把附图说明自身计入正文引用）。 */
function countInDrawingSection(text: string): number {
  return (getDrawingSection(text).match(/图\s*[一二三四五六七八九十\d]+/g) ?? []).length;
}
