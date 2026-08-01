/**
 * 宪法规则引擎 — 加载器。
 *
 * 从 YAML 资产（rules/**）加载并校验规则集。兼容两种 rules 形态：
 *   1) 数组：rules: [{ id, name, ... }, ...]
 *   2) 映射：rules: { 内部名: { id, name, ... }, ... }（BCIP constitutional YAML 形态）
 * 单文件解析失败不阻塞目录加载（跳过并告警），保证一条坏规则不拖垮整个引擎。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type {
  ConstitutionalRule,
  LoadedRuleSet,
  RuleAction,
  RuleCheck,
  RuleCheckType,
  RuleSeverity,
  RuleSet,
  RuleSetValidationIssue,
} from "../protocol/types.js";

const SEVERITIES: readonly RuleSeverity[] = ["critical", "major", "minor"];
const ACTIONS: readonly RuleAction[] = ["block", "warn", "review", "log"];
const CHECK_TYPES: readonly RuleCheckType[] = [
  "keyword_blocklist",
  "pattern_analysis",
  "structural_analysis",
  "citation_analysis",
];

/** 把任意值规整为纯对象（yaml Document.toJS 产物），非对象返回 null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function isRecordOfStrings(value: unknown): value is Record<string, string[]> {
  const record = asRecord(value);
  if (record === null) return false;
  return Object.values(record).every(v => asStringArray(v) !== null);
}

/**
 * 校验正则列表（语法 + 灾难性回溯启发式），非法时收集问题并返回 false。
 * 供 pattern_analysis / structural_analysis 共用，保证 ReDoS 防护一致。
 */
function validateRegexPatterns(patterns: string[], ruleId: string, issues: RuleSetValidationIssue[]): boolean {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "i");
    } catch {
      issues.push({ ruleId, message: `rule ${ruleId}: 非法正则 "${pattern}"` });
      return false;
    }
    if (hasNestedQuantifier(pattern)) {
      issues.push({
        ruleId,
        message: `rule ${ruleId}: 正则疑似灾难性回溯（嵌套量词） "${pattern}"`,
      });
      return false;
    }
  }
  return true;
}

/**
 * 简易灾难性回溯检测：捕获组/字符组闭括号后直接跟量词（`(a+)+` / `(a*)*` /
 * `(ab){2,}+` 等嵌套量词），规则 YAML 来自不可信来源时可致 ReDoS。
 * 安全优先：宁可误拒固定重复（如 `(a){2}`），不接受嵌套量词。
 */
function hasNestedQuantifier(pattern: string): boolean {
  return /\)[+*{]/.test(pattern) || /\}[+*]/.test(pattern);
}

/** 解析单个 check 对象；非法返回 null。 */
function parseCheck(raw: unknown, issues: RuleSetValidationIssue[], ruleId: string): RuleCheck | null {
  const record = asRecord(raw);
  if (record === null || typeof record.type !== "string") {
    issues.push({ ruleId, message: `rule ${ruleId}: check 必须是对象且含 type` });
    return null;
  }
  const type = record.type as RuleCheckType;
  if (!CHECK_TYPES.includes(type)) {
    issues.push({ ruleId, message: `rule ${ruleId}: 未知检查类型 "${record.type}"` });
    return null;
  }
  switch (type) {
    case "keyword_blocklist": {
      const keywords = asStringArray(record.keywords);
      if (keywords === null || keywords.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: keyword_blocklist 需要非空 keywords` });
        return null;
      }
      return {
        type,
        keywords,
        negationContext: record.negationContext === true,
        // severityIfFound 非法值忽略（保持 RuleSeverity 不变量）
        severityIfFound: SEVERITIES.includes(record.severityIfFound as RuleSeverity)
          ? (record.severityIfFound as RuleSeverity)
          : undefined,
      };
    }
    case "pattern_analysis": {
      const patterns = asStringArray(record.patterns);
      if (patterns === null || patterns.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: pattern_analysis 需要非空 patterns` });
        return null;
      }
      if (!validateRegexPatterns(patterns, ruleId, issues)) return null;
      const minMatches = typeof record.minMatches === "number" ? record.minMatches : 1;
      return { type, patterns, minMatches };
    }
    case "structural_analysis": {
      if (!Array.isArray(record.requiresAll) || record.requiresAll.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: structural_analysis 需要非空 requiresAll` });
        return null;
      }
      const requiresAll: StructuralElementRaw[] = [];
      for (const item of record.requiresAll) {
        const el = asRecord(item);
        const patterns = el !== null ? asStringArray(el.patterns) : null;
        if (el === null || typeof el.element !== "string" || patterns === null || patterns.length === 0) {
          issues.push({ ruleId, message: `rule ${ruleId}: requiresAll 元素需要 element + 非空 patterns` });
          return null;
        }
        if (!validateRegexPatterns(patterns, ruleId, issues)) return null;
        requiresAll.push({
          element: el.element,
          description: typeof el.description === "string" ? el.description : undefined,
          patterns,
        });
      }
      const minConfidence = typeof record.minConfidence === "number" ? record.minConfidence : 1;
      return { type, requiresAll, minConfidence };
    }
    case "citation_analysis": {
      const statutes = asRecord(record.statutes);
      if (statutes === null || Object.keys(statutes).length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: citation_analysis 需要非空 statutes` });
        return null;
      }
      const parsed: Record<string, { max: number; topics?: Record<number, string[]> }> = {};
      for (const [name, value] of Object.entries(statutes)) {
        const def = asRecord(value);
        if (def === null || typeof def.max !== "number") {
          issues.push({ ruleId, message: `rule ${ruleId}: 法条 "${name}" 需要 max 数字` });
          return null;
        }
        const topics = def.topics;
        if (topics !== undefined) {
          if (!isRecordOfStrings(topics)) {
            issues.push({ ruleId, message: `rule ${ruleId}: 法条 "${name}" topics 需为 条号→词数组` });
            return null;
          }
          const topicMap: Record<number, string[]> = {};
          for (const [article, words] of Object.entries(topics)) {
            const n = Number(article);
            if (Number.isFinite(n)) topicMap[n] = words;
          }
          parsed[name] = { max: def.max, topics: topicMap };
        } else {
          parsed[name] = { max: def.max };
        }
      }
      return { type, statutes: parsed };
    }
  }
}

type StructuralElementRaw = {
  element: string;
  description?: string;
  patterns: string[];
};

/** 解析单条规则；非法返回 null 并收集问题。 */
function parseRule(raw: unknown, issues: RuleSetValidationIssue[]): ConstitutionalRule | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) {
    issues.push({ message: "rule: 缺少 id" });
    return null;
  }
  if (typeof record.name !== "string" || record.name.length === 0) {
    issues.push({ ruleId: id, message: `rule ${id}: 缺少 name` });
    return null;
  }
  const severity = record.severity as RuleSeverity;
  if (!SEVERITIES.includes(severity)) {
    issues.push({ ruleId: id, message: `rule ${id}: severity 必须是 ${SEVERITIES.join("/")}` });
    return null;
  }
  const action = (record.action as RuleAction) ?? "warn";
  if (!ACTIONS.includes(action)) {
    issues.push({ ruleId: id, message: `rule ${id}: action 必须是 ${ACTIONS.join("/")}` });
    return null;
  }
  const check = parseCheck(record.check, issues, id);
  if (check === null) return null;
  return {
    id,
    name: record.name,
    description: typeof record.description === "string" ? record.description : undefined,
    domain: typeof record.domain === "string" ? record.domain : undefined,
    phase: typeof record.phase === "string" ? record.phase : undefined,
    severity,
    action,
    legalBasis: typeof record.legalBasis === "string" ? record.legalBasis : undefined,
    check,
  };
}

/**
 * 校验规则集：id 唯一性 + 整体结构。
 * 返回问题列表（空 = 通过）。规则级问题在 parseRule 阶段已收集。
 */
export function validateRuleSet(ruleSet: RuleSet, source?: string): RuleSetValidationIssue[] {
  const issues: RuleSetValidationIssue[] = [];
  const seen = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (seen.has(rule.id)) {
      issues.push({ source, ruleId: rule.id, message: `rule ${rule.id}: 重复的规则 id` });
    }
    seen.add(rule.id);
  }
  return issues;
}

/**
 * 从 YAML 文本解析规则集。支持 rules 数组与映射两种形态。
 * 返回 null 表示整体解析失败（非规则级错误）。
 */
export function parseRuleSetFromYaml(
  yamlText: string,
  source = "<inline>",
): { ruleSet: RuleSet; issues: RuleSetValidationIssue[] } {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    return {
      ruleSet: { rules: [] },
      issues: [{ source, message: `YAML 解析失败: ${doc.errors[0]?.message ?? "unknown"}` }],
    };
  }
  const root = asRecord(doc.toJS());
  const issues: RuleSetValidationIssue[] = [];
  if (root === null) {
    return { ruleSet: { rules: [] }, issues: [{ source, message: "规则文件顶层必须是对象" }] };
  }
  const rulesRaw = root.rules;
  const rules: ConstitutionalRule[] = [];
  if (Array.isArray(rulesRaw)) {
    for (const item of rulesRaw) {
      const rule = parseRule(item, issues);
      if (rule !== null) rules.push(rule);
    }
  } else if (asRecord(rulesRaw) !== null) {
    for (const item of Object.values(rulesRaw as Record<string, unknown>)) {
      const rule = parseRule(item, issues);
      if (rule !== null) rules.push(rule);
    }
  } else {
    issues.push({ source, message: "规则文件缺少 rules 字段（数组或映射）" });
  }
  const ruleSet: RuleSet = {
    version: typeof root.version === "string" ? root.version : undefined,
    rules,
  };
  issues.push(...validateRuleSet(ruleSet, source));
  return { ruleSet, issues };
}

/** 从文件加载规则集；解析失败抛 RuleSetLoadError。 */
export function loadRuleSetFromFile(path: string): LoadedRuleSet {
  const yamlText = readFileSync(path, "utf8");
  const { ruleSet, issues } = parseRuleSetFromYaml(yamlText, path);
  // 文件级 fatal：无 ruleId 且非规则级前缀（"rule"）。规则级问题（含缺 id）不
  // 拖垮整个文件——跳过问题规则，保留其余可用规则。
  const fatal = issues.filter(i => i.ruleId === undefined && !i.message.startsWith("rule"));
  if (fatal.length > 0) {
    throw new Error(`规则文件加载失败 ${path}: ${fatal.map(i => i.message).join("; ")}`);
  }
  return { ruleSet, source: path, warnings: issues };
}

/** 从目录加载全部规则文件（.yaml/.yml）；单文件失败跳过并告警。 */
export function loadRuleSetDir(dir: string): {
  ruleSets: RuleSet[];
  sources: string[];
  warnings: RuleSetValidationIssue[];
} {
  const ruleSets: RuleSet[] = [];
  const sources: string[] = [];
  const warnings: RuleSetValidationIssue[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    warnings.push({ source: dir, message: `规则目录不存在: ${dir}` });
    return { ruleSets, sources, warnings };
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const path = join(dir, entry);
    try {
      const loaded = loadRuleSetFromFile(path);
      ruleSets.push(loaded.ruleSet);
      sources.push(loaded.source);
      warnings.push(...loaded.warnings);
    } catch (error) {
      warnings.push({ source: path, message: `跳过损坏规则文件: ${(error as Error).message}` });
    }
  }
  return { ruleSets, sources, warnings };
}

/** 合并多个规则集（后出现的规则按 id 覆盖先前的，便于分层覆盖）。 */
export function mergeRuleSets(ruleSets: RuleSet[]): RuleSet {
  const byId = new Map<string, ConstitutionalRule>();
  for (const ruleSet of ruleSets) {
    for (const rule of ruleSet.rules) {
      byId.set(rule.id, rule);
    }
  }
  return { rules: [...byId.values()] };
}
