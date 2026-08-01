import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * validate_specification — 专利说明书合规性校验（移植自 Mady domains/specdrafting）。
 *
 * 确定性规则：结构完整性（五部分章节）/ 发明名称长度 / 摘要长度 /
 * 模糊表述 / 附图说明与图引用一致性。
 */

export type ValidateSpecificationInput = {
  /** 说明书全文（markdown，含章节标题） */
  text?: string;
  /** 发明名称（可选，单独校验长度） */
  title?: string;
  /** 摘要（可选，校验长度） */
  abstract?: string;
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

export function createValidateSpecificationTool(): SatiToolDefinition<
  ValidateSpecificationInput,
  ValidateSpecificationOutput
> {
  return {
    name: "validate_specification",
    title: "Validate Patent Specification",
    description:
      "验证专利说明书是否符合撰写要求，包括结构完整性、发明名称长度、摘要长度、模糊表述、附图说明一致性等检查。在说明书初稿完成后使用。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string", description: "说明书全文（markdown，含章节标题）" },
        title: { type: "string", description: "发明名称（可选，单独校验长度）" },
        abstract: { type: "string", description: "摘要（可选，校验长度）" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async input => {
      const output = validateSpecification(input);
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

  // 3) 摘要长度 ≤ 300 字
  if (input.abstract && [...input.abstract.trim()].length > 300) {
    violations.push({
      rule: "abstract_length",
      severity: "error",
      section: "摘要",
      message: `摘要超过 300 字限制（${[...input.abstract.trim()].length} 字）`,
      suggestion: "请压缩至 300 字以内",
    });
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

  // 评分：error 每条扣 0.25，warning 每条扣 0.1，最低 0
  const errors = violations.filter(v => v.severity === "error").length;
  const warnings = violations.filter(v => v.severity === "warning").length;
  const score = Math.max(0, Math.min(1, 1 - errors * 0.25 - warnings * 0.1));

  return {
    passed: errors === 0,
    score: Math.round(score * 100) / 100,
    violations,
  };
}

/** 统计附图说明章节内的"图N"引用数（避免把附图说明自身计入正文引用）。 */
function countInDrawingSection(text: string): number {
  const m = text.match(/^#{1,3}\s*附图说明\s*\n([\s\S]*?)(?=^#{1,3}\s|\s*$)/m);
  if (!m) return 0;
  return (m[1].match(/图\s*[一二三四五六七八九十\d]+/g) ?? []).length;
}
