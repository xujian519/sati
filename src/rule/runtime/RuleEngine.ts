/**
 * 宪法规则引擎 — 评估器。
 *
 * 对文本逐条执行规则检查，产出 RuleViolation[]。全部为确定性规则检查
 * （无 LLM 调用），用于输出门禁与工具拦截的底层判定。
 */

import type {
  ConstitutionalRule,
  KeywordBlocklistCheck,
  PatternAnalysisCheck,
  RuleEvaluation,
  RuleSeverity,
  RuleSet,
  RuleViolation,
  StructuralAnalysisCheck,
} from "../protocol/types.js";
import { checkSynonymRequirements, type SynonymMap } from "./synonym-engine.js";

/** 否定语境词：命中位置前出现这些词时，视为否定性描述（"防止赌博"不排除）。 */
/** 否定语境词（与 src/patent/quality-gate.ts 的 NEGATION_WORDS 保持同步镜像；不含单字"不/未/无"以免误放行）。 */
const NEGATION_WORDS = ["防止", "避免", "不用于", "排除", "禁止", "不为", "非用于", "不构成", "区别于", "不属于"];

/** 否定语境检查窗口（命中词前多少个字符）。 */
const NEGATION_WINDOW = 24;

/** 证据截断长度。 */
const EVIDENCE_MAX = 80;

function truncate(text: string): string {
  return text.length > EVIDENCE_MAX ? `${text.slice(0, EVIDENCE_MAX)}…` : text;
}

/** 在命中位置前查找否定语境：窗口内出现否定词且无句号/分号分隔。 */
function hasNegationContext(text: string, matchStart: number): boolean {
  const start = Math.max(0, matchStart - NEGATION_WINDOW);
  const window = text.slice(start, matchStart);
  if (window.includes("。") || window.includes("；") || window.includes(";")) return false;
  return NEGATION_WORDS.some(word => window.includes(word));
}

/** 检查单个 keyword_blocklist 条目（"a|b|c" OR 组），返回证据。 */
function checkKeywordEntry(entry: string, text: string, negationContext: boolean): string[] {
  const alternatives = entry
    .split("|")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (alternatives.length === 0) return [];
  const evidence: string[] = [];
  let searchFrom = 0;
  let guard = 0;
  while (searchFrom < text.length && guard < 200) {
    guard += 1;
    let best: { index: number; word: string } | null = null;
    for (const word of alternatives) {
      const index = text.indexOf(word, searchFrom);
      if (index >= 0 && (best === null || index < best.index)) best = { index, word };
    }
    if (best === null) break;
    if (!negationContext || !hasNegationContext(text, best.index)) {
      evidence.push(best.word);
    }
    searchFrom = best.index + best.word.length;
  }
  return evidence;
}

function checkKeywordBlocklist(check: KeywordBlocklistCheck, text: string): string[] {
  const evidence: string[] = [];
  for (const entry of check.keywords) {
    evidence.push(...checkKeywordEntry(entry, text, check.negationContext === true));
  }
  return evidence;
}

function checkPatternAnalysis(check: PatternAnalysisCheck, text: string): string[] {
  const minMatches = check.minMatches ?? 1;
  const evidence: string[] = [];
  for (const pattern of check.patterns) {
    let count = 0;
    const matches: string[] = [];
    try {
      const regex = new RegExp(pattern, "gi");
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        count += 1;
        if (matches.length < 4) matches.push(match[0]);
        if (match[0].length === 0) regex.lastIndex += 1;
      }
    } catch {
      // 非法正则已在加载期拦截；此处防御性跳过
    }
    // 禁止模式语义：命中次数达到 minMatches 才判定违规
    if (count >= minMatches) {
      evidence.push(...matches);
    }
  }
  return evidence;
}

function checkStructuralAnalysis(
  check: StructuralAnalysisCheck,
  text: string,
): { confidence: number; missing: string[] } {
  let hit = 0;
  const missing: string[] = [];
  for (const element of check.requiresAll) {
    const matched = element.patterns.some(pattern => {
      try {
        return new RegExp(pattern, "i").test(text);
      } catch {
        return false;
      }
    });
    if (matched) {
      hit += 1;
    } else {
      missing.push(element.element);
    }
  }
  const total = check.requiresAll.length;
  return { confidence: total === 0 ? 1 : hit / total, missing };
}

/** 提取法条引用（R1 存在性检查用）："专利法第N条" / "专利法实施细则第N条"（N 支持中文数字）。 */
const CITATION_RE = /(专利法实施细则|专利法)第\s*([0-9零一二三四五六七八九十百]+)\s*条/g;

/** 中文数字 → 阿拉伯数字（支持十/百位组合，如 "第七十八条" → 78；非数字字符返回 null）。 */
function parseCnNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const CN_DIGITS: Record<string, number> = {
    零: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let digit = 0;
  for (const ch of trimmed) {
    if (ch === "十") {
      total += (digit || 1) * 10;
      digit = 0;
    } else if (ch === "百") {
      total += (digit || 1) * 100;
      digit = 0;
    } else if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch]!;
    } else {
      return null;
    }
  }
  return total + digit;
}

function checkCitationAnalysis(
  check: { type: "citation_analysis"; statutes: Record<string, { max: number; topics?: Record<number, string[]> }> },
  text: string,
): string[] {
  const evidence: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(text)) !== null) {
    const statuteName = match[1] === "专利法实施细则" ? "专利法实施细则" : "专利法";
    const article = parseCnNumber(match[2]);
    if (article === null) continue;
    const statute = check.statutes[statuteName];
    if (statute !== undefined && article > statute.max) {
      evidence.push(match[0]);
    }
  }
  return evidence;
}

/** 评估一段文本，返回全部违规（synonyms 为同义词表，供 synonym_match 检查；缺省空表）。 */
export function evaluateText(text: string, ruleSet: RuleSet, synonyms?: SynonymMap): RuleEvaluation {
  const violations: RuleViolation[] = [];
  for (const rule of ruleSet.rules) {
    const found = evaluateRule(rule, text, synonyms);
    if (found !== null) violations.push(found);
  }
  return { violations };
}

/** 评估单条规则；无违规返回 null。 */
export function evaluateRule(rule: ConstitutionalRule, text: string, synonyms?: SynonymMap): RuleViolation | null {
  const check = rule.check;
  let evidence: string[] = [];
  let message: string | null = null;
  let severity: RuleSeverity = rule.severity;

  switch (check.type) {
    case "keyword_blocklist": {
      evidence = checkKeywordBlocklist(check, text);
      if (evidence.length === 0) return null;
      severity = check.severityIfFound ?? rule.severity;
      message = `命中禁止词：${[...new Set(evidence)].join("、")}`;
      break;
    }
    case "pattern_analysis": {
      evidence = checkPatternAnalysis(check, text);
      if (evidence.length === 0) return null;
      message = `命中禁止模式：${[...new Set(evidence)].slice(0, 4).join("、")}`;
      break;
    }
    case "structural_analysis": {
      const { confidence, missing } = checkStructuralAnalysis(check, text);
      const minConfidence = check.minConfidence ?? 1;
      if (confidence >= minConfidence) return null;
      message = `结构要素不完整：缺失 ${missing.join("、")}（置信度 ${(confidence * 100).toFixed(0)}% < ${(minConfidence * 100).toFixed(0)}%）`;
      break;
    }
    case "citation_analysis": {
      evidence = checkCitationAnalysis(check, text);
      if (evidence.length === 0) return null;
      message = `法条引用超出范围：${[...new Set(evidence)].join("、")}`;
      break;
    }
    case "synonym_match": {
      const { confidence, missing } = checkSynonymRequirements(text, check.requirements, synonyms ?? new Map());
      const minConfidence = check.minConfidence ?? 1;
      if (confidence >= minConfidence) return null;
      message = `同义要素不完整：缺失 ${missing.join("、")}（置信度 ${(confidence * 100).toFixed(0)}% < ${(minConfidence * 100).toFixed(0)}%）`;
      break;
    }
  }

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity,
    action: rule.action,
    legalBasis: rule.legalBasis,
    message,
    evidence: [...new Set(evidence)].map(truncate),
  };
}

/** 便捷入口：按 action 分组违规（block / review / warn / log）。 */
export function groupByAction(evaluation: RuleEvaluation): Record<string, RuleViolation[]> {
  const grouped: Record<string, RuleViolation[]> = { block: [], review: [], warn: [], log: [] };
  for (const violation of evaluation.violations) {
    (grouped[violation.action] ??= []).push(violation);
  }
  return grouped;
}
