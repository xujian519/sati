/**
 * src/patent/spec — 说明书确定性检查纯函数（共享层）。
 *
 * 从 `src/tool/builtin/validateSpecification.ts` 下沉：数值范围端点/中间值实施例、
 * 效果数据定量性等检查为纯函数（零依赖），供 tool 层（validate_specification）与
 * patent 层（enablement 子图 spec_prechecks 节点）共同复用，避免跨层反向依赖
 * （src/patent/ 不得依赖 src/tool/）。
 */

import { matchFeature } from "../anchor/match.js";

// =============================================================================
// 数值范围与单位（端点 + 中间值实施例检测）
// =============================================================================

/**
 * 支持的单位列表（按长度降序排列：多字符单位在前，避免交替匹配把
 * "5mg" 截成 "m"、"0.1-2MPa" 截成 "m" 等误解析）。
 */
export const UNITS = "°C|℃|MPa|kPa|Pa|rpm|min|mol|mm|cm|kg|mg|ml|mL|％|°|m|g|L|h|s|%";

/** 数值范围（如 20-90℃、20℃至90℃、20~90℃）。 */
const RANGE_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:${UNITS})?\\s*(?:[~～至\\-—])\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`,
  "g",
);

/** 带单位的单个数值（如 60℃、5mm）。 */
const VALUE_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNITS})`, "g");

export type NumericRange = { min: number; max: number; unit: string };

/** 归一化单位：温度类统一为 "°"，其余原样（℃/°C/° 可比）。 */
export function normalizeUnit(unit: string): string {
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

/** 格式化数值范围为显示文本（"20-90℃"）。 */
export function formatRange(range: NumericRange): string {
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
// 说明书章节标题识别（五部分，validate_specification 与 draft-spec 原子共用）
// =============================================================================

/** 说明书必需章节（顺序即撰写顺序）。 */
export const SPEC_SECTION_NAMES = ["技术领域", "背景技术", "发明内容", "附图说明", "具体实施方式"] as const;

export type SpecSectionName = (typeof SPEC_SECTION_NAMES)[number];

/** 可选章节编号：`一、` / `1.` / `（一）`。 */
const SECTION_NUMBERING = String.raw`(?:[（(]\s*[一二三四五六七八九十百]+\s*[）)]\s*|[一二三四五六七八九十百]+\s*[、.]\s*|\d+\s*[、.]\s*)?`;

const SECTION_NAMES_PATTERN = SPEC_SECTION_NAMES.join("|");

/**
 * Markdown 标题：`#`–`######`，标题名后允许紧跟别名/说明
 * （`## 技术领域（Technical Field）`），与历史前缀匹配语义一致。
 */
const MARKDOWN_HEADING_RE = new RegExp(String.raw`^#{1,6}\s*${SECTION_NUMBERING}[【\[]?\s*(${SECTION_NAMES_PATTERN})`);

/** 纯文本标题：整行匹配，正文中出现章节名（「本发明属于技术领域」）不会被误判。 */
const PLAIN_HEADING_RE = new RegExp(
  String.raw`^${SECTION_NUMBERING}[【\[]?\s*(${SECTION_NAMES_PATTERN})\s*[】\]]?\s*[:：]?\s*$`,
);

/**
 * 识别单行是否为说明书章节标题；返回章节名，否则 undefined。
 * 支持 Markdown、纯文本、编号、方括号与行尾冒号。
 */
export function matchSectionHeading(line: string): SpecSectionName | undefined {
  const trimmed = line.trim();
  const markdown = MARKDOWN_HEADING_RE.exec(trimmed);
  if (markdown) return markdown[1] as SpecSectionName;
  const plain = PLAIN_HEADING_RE.exec(trimmed);
  return plain?.[1] as SpecSectionName | undefined;
}

/** 是否为 Markdown 标题行（用于章节正文边界，避免把下一节正文吞进本节）。 */
export function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s*\S/.test(line.trim());
}

/** 返回缺失的说明书章节名列表（空数组 = 五部分齐全）。 */
export function checkSectionCompleteness(text: string): string[] {
  const present = new Set<SpecSectionName>();
  for (const line of text.split(/\r?\n/)) {
    const section = matchSectionHeading(line);
    if (section !== undefined) present.add(section);
  }
  return SPEC_SECTION_NAMES.filter(name => !present.has(name));
}

// =============================================================================
// 实施例分块（#830 M6）
// =============================================================================

export interface EmbodimentChunk {
  /** "实施例1" 中的编号；无编号时按出现顺序编号。 */
  embodimentId: string;
  /** 标题原文（含 Markdown/方括号标记）。 */
  title: string;
  /** 标题之后的正文（不含标题行）。 */
  content: string;
  charCount: number;
  /** 在该块正文中确定性命中的特征（原样回显，未命中不计入）。 */
  featureIds: string[];
}

/**
 * 实施例标题：兼容 `实施例一` / `实施例1` / `【实施例1】` / `## 具体实施例1：`。
 * 只匹配整行标题形态，正文里的「实施例1中…」不会被切开。
 */
const EMBODIMENT_HEADING_RE =
  /^(?:#{1,6}\s*)?(?:【\s*)?(?:具体)?实施例\s*([一二三四五六七八九十百0-9０-９]+)?\s*(?:】)?\s*(?:[:：](.*))?$/;

/**
 * 按实施例标题切分说明书正文。
 *
 * 纯函数、无 I/O；未发现标题时返回空数组，调用方回退旧的整节截断
 * （旧 checkpoint 无分块信息也走同一回退，见 #830 M6 T6.4）。
 * `features` 非空时，每块用 anchor 的连续子串匹配绑定特征，不做语义推断。
 */
export function splitEmbodiments(text: string, features: readonly string[] = []): EmbodimentChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Array<{ id: string; title: string; body: string[] }> = [];
  let current: { id: string; title: string; body: string[] } | undefined;
  for (const line of lines) {
    const match = EMBODIMENT_HEADING_RE.exec(line.trim());
    if (match !== null) {
      if (current !== undefined) chunks.push(current);
      const rawId = match[1]?.trim();
      current = {
        id: rawId !== undefined && rawId.length > 0 ? rawId : String(chunks.length + 1),
        title: line.trim(),
        body: [],
      };
      continue;
    }
    current?.body.push(line);
  }
  if (current !== undefined) chunks.push(current);

  return chunks
    .map(chunk => {
      const content = chunk.body.join("\n").trim();
      return {
        embodimentId: chunk.id,
        title: chunk.title,
        content,
        charCount: content.length,
        featureIds: features.filter(feature => matchFeature(content, feature).hit !== null),
      };
    })
    .filter(chunk => chunk.content.length > 0);
}
