/**
 * src/patent/checker — 引擎：确定性规则评估 + 聚合判级。
 *
 * 移植自 Mady domains/workflows/patent/rule_engine.go。核心语义：
 * - Evaluate：按域过滤规则，逐条执行 CheckType 分派检查，仅收集失败结果。
 * - Aggregate：判级模型——任一 Level-0(Must) / Level-1(Should) 失败 → blocked；
 *   3 条及以上 Level-2(Quality) 失败 → needs_revision；否则 pass。
 * - 关键词匹配：同义词扩展 + 命中前 60 字符窗口否定检测（"不具有/未发现/…"不误报）。
 */

import type { CheckRule, CheckType, RuleCheckResult, RuleEngineOptions, Severity, Verdict } from "./types.js";
import { LevelMust, LevelQuality, LevelShould } from "./types.js";
import {
  NEGATION_WINDOW,
  claimDimensionPatterns,
  negationPatterns,
  singleComparisonBanPhrases,
  synonymMap,
} from "./constants.js";

function hasNegation(before: string): boolean {
  return negationPatterns.some(pattern => pattern.test(before));
}

/**
 * 检查关键词（或任一扩展同义词）是否在文本中被"肯定地"提及。
 * 命中位置前 NEGATION_WINDOW 字符内出现否定模式视为否定表述，不算命中。
 */
export function matchKeyword(text: string, keyword: string): boolean {
  const candidates = [keyword, ...(synonymMap[keyword] ?? [])];
  const lower = text.toLowerCase();
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate.toLowerCase());
    if (idx === -1) continue;
    const start = Math.max(0, idx - NEGATION_WINDOW);
    if (!hasNegation(text.slice(start, idx))) return true;
  }
  return false;
}

/** 全部关键词须被肯定提及。 */
export function matchKeywordsAll(text: string, keywords: readonly string[]): boolean {
  return keywords.every(keyword => matchKeyword(text, keyword));
}

/** 至少一个关键词被肯定提及。 */
export function matchKeywordsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some(keyword => matchKeyword(text, keyword));
}

// =============================================================================
// CheckType 分派检查器（返回 (passed, detail)；detail 非空时优先于 rule.message）
// =============================================================================

function checkNovelty(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredElements ?? [])) {
    return [false, "新颖性分析缺少必要要素（如单独对比、现有技术认定）"];
  }
  if (rule.singleComparison === true) {
    for (const phrase of singleComparisonBanPhrases) {
      if (text.includes(phrase)) {
        return [false, "新颖性分析违反单独对比原则：不应将多份对比文件结合"];
      }
    }
  }
  return [true, ""];
}

function checkInventiveness(text: string, rule: CheckRule): [boolean, string] {
  const steps = rule.stepElements ?? [];
  if (steps.length < 3) return [true, ""];
  for (let i = 0; i < 3; i += 1) {
    if (!matchKeywordsAny(text, steps[i] ?? [])) {
      return [false, "创造性分析缺少三步法必要步骤（最接近现有技术→区别技术特征→技术启示）"];
    }
  }
  return [true, ""];
}

function checkInfringement(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredElements ?? [])) {
    return [false, "侵权分析缺少必要对比要素（如全面覆盖、技术特征比对）"];
  }
  return [true, ""];
}

function checkDisclosure(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredAspects ?? [])) {
    return [false, "充分公开分析缺少必要审查维度（如能够实现、技术效果）"];
  }
  return [true, ""];
}

function checkClaimAnalysis(text: string, rule: CheckRule): [boolean, string] {
  for (const dim of rule.dimensions ?? []) {
    const patterns = claimDimensionPatterns[dim];
    if (patterns === undefined) continue;
    if (!matchKeywordsAny(text, patterns)) {
      return [false, "权利要求分析缺少必要维度（清楚性/说明书支持/必要技术特征/一致性）"];
    }
  }
  return [true, ""];
}

function checkDesignComparison(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredElements ?? [])) {
    return [false, "外观设计对比分析缺少必要要素（如整体视觉效果、产品种类认定）"];
  }
  return [true, ""];
}

function checkPublicAccess(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredElements ?? [])) {
    return [false, "公开方式判断缺少必要要素（如公开方式认定、公开日核实）"];
  }
  return [true, ""];
}

function checkAmendmentScope(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredElements ?? [])) {
    return [false, "修改超范围分析缺少必要要素（如原申请文件范围、直接且毫无疑义的确定）"];
  }
  return [true, ""];
}

function checkSubjectMatter(text: string, rule: CheckRule): [boolean, string] {
  if (!matchKeywordsAll(text, rule.requiredElements ?? [])) {
    return [false, "保护客体分析缺少必要要素（如技术方案认定、排除客体分析）"];
  }
  return [true, ""];
}

/** 禁语否定前缀检测：命中位置前 8 字符内出现否定词且紧邻（≤4 个非标点字符）视为否定语境。 */
function hasBanPhraseNegation(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 8), idx);
  // "不仅/不只是" 为双重否定（肯定语义），不视为否定语境
  return /(?:未|不|没有|不会|未曾|并未|并非|无需)(?![仅只])[^，。；;、]{0,4}$/.test(before);
}

/**
 * 说明书撰写质量（spec-checklist 规则化）：
 * - RequiredAspects 全部须被肯定提及（结构完整性/实施例/问题-方案-效果三段式等）；
 * - BanPhrases 被肯定提及即失败（商业宣传用语、超出原始公开范围的 A33 风险表述）；
 *   "未超出原申请记载范围" 等否定语境不误报。
 */
function checkSpec(text: string, rule: CheckRule): [boolean, string] {
  if ((rule.requiredAspects?.length ?? 0) > 0 && !matchKeywordsAll(text, rule.requiredAspects ?? [])) {
    return [false, "说明书缺少必要要素（章节结构/实施例/问题-方案-效果对应）"];
  }
  for (const phrase of rule.banPhrases ?? []) {
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      if (!hasBanPhraseNegation(text, idx)) {
        return [false, `说明书包含禁止表述：${phrase}`];
      }
      idx = text.indexOf(phrase, idx + 1);
    }
  }
  return [true, ""];
}

function checkReasoningPath(text: string, rule: CheckRule): [boolean, string] {
  const steps = rule.pathElements ?? [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] ?? [];
    if (!matchKeywordsAny(text, step)) {
      return [false, `推理路径步骤${i + 1}不完整，缺少关键词：${step.join("/")}`];
    }
  }
  return [true, ""];
}

// =============================================================================
// 单条规则评估
// =============================================================================

function evaluateRule(rule: CheckRule, text: string): { passed: boolean; detail: string } {
  let passed: boolean;
  let detail: string;
  switch (rule.checkType) {
    case "patent_novelty":
      [passed, detail] = checkNovelty(text, rule);
      break;
    case "patent_inventiveness":
      [passed, detail] = checkInventiveness(text, rule);
      break;
    case "patent_infringement":
      [passed, detail] = checkInfringement(text, rule);
      break;
    case "patent_disclosure":
      [passed, detail] = checkDisclosure(text, rule);
      break;
    case "patent_claim_analysis":
      [passed, detail] = checkClaimAnalysis(text, rule);
      break;
    case "patent_design_comparison":
      [passed, detail] = checkDesignComparison(text, rule);
      break;
    case "patent_public_access":
      [passed, detail] = checkPublicAccess(text, rule);
      break;
    case "patent_amendment_scope":
      [passed, detail] = checkAmendmentScope(text, rule);
      break;
    case "patent_subject_matter":
      [passed, detail] = checkSubjectMatter(text, rule);
      break;
    case "patent_spec":
      [passed, detail] = checkSpec(text, rule);
      break;
    default: {
      const exhaustive: never = rule.checkType;
      throw new Error(`未知 CheckType: ${String(exhaustive)}`);
    }
  }
  if (!passed) return { passed: false, detail };
  // 后置校验：推理路径步骤完整性。
  if ((rule.pathElements?.length ?? 0) > 0) {
    const [pathOk, pathDetail] = checkReasoningPath(text, rule);
    if (!pathOk) return { passed: false, detail: pathDetail };
  }
  return { passed: true, detail: "" };
}

// =============================================================================
// RuleEngine
// =============================================================================

/** 归一化域过滤参数：undefined / "" → 全部；单字符串 → 单元素数组。 */
function normalizeDomains(rawDomain: string | readonly string[] | undefined): string[] {
  if (rawDomain === undefined || rawDomain === "") return [];
  return typeof rawDomain === "string" ? [rawDomain] : [...rawDomain];
}

export class RuleEngine {
  private readonly rulesById = new Map<string, CheckRule>();

  register(rule: CheckRule): void {
    this.rulesById.set(rule.id, rule);
  }

  registerMany(rules: readonly CheckRule[]): void {
    for (const rule of rules) this.register(rule);
  }

  remove(id: string): void {
    this.rulesById.delete(id);
  }

  get(id: string): CheckRule | undefined {
    return this.rulesById.get(id);
  }

  all(): CheckRule[] {
    return [...this.rulesById.values()];
  }

  /**
   * 评估：按域过滤规则集，逐条执行检查，返回全部失败结果（空数组 = 全部通过）。
   * 未显式传 rules 时使用注册的全部规则。domain 支持单域或多域（任一匹配即评估）。
   */
  evaluate(text: string, options: RuleEngineOptions = {}): RuleCheckResult[] {
    const rules = options.rules ?? this.all();
    const domains = normalizeDomains(options.domain);
    const results: RuleCheckResult[] = [];
    for (const rule of rules) {
      if (domains.length > 0 && rule.domain !== "" && !domains.includes(rule.domain)) continue;
      const { passed, detail } = evaluateRule(rule, text);
      if (passed) continue;
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        passed: false,
        level: rule.level,
        severity: rule.severity,
        message: detail !== "" ? detail : rule.message,
        fixSuggestion: rule.fixSuggestion,
      });
    }
    return results;
  }
}

// =============================================================================
// 聚合判级
// =============================================================================

/**
 * 判级模型（与 Mady Aggregate 一致）：
 * - 任一 Level-0 (Must) 或 Level-1 (Should) 失败 → blocked。
 * - 3 条及以上 Level-2 (Quality) 失败 → needs_revision。
 * - 否则 → pass。
 */
export function aggregate(results: readonly RuleCheckResult[]): Verdict {
  let level2Failures = 0;
  for (const result of results) {
    if (result.passed) continue;
    if (result.level <= LevelShould) return "blocked";
    if (result.level === LevelQuality) level2Failures += 1;
  }
  if (level2Failures >= 3) return "needs_revision";
  return "pass";
}

// =============================================================================
// 报告格式化（Markdown 片段，供工具层拼入最终输出）
// =============================================================================

function levelLabel(level: RuleCheckResult["level"]): string {
  switch (level) {
    case LevelMust:
      return "必须";
    case LevelShould:
      return "应当";
    case LevelQuality:
      return "质量";
    default:
      return "未知";
  }
}

function severityLabel(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "critical";
    case "major":
      return "major";
    case "minor":
      return "minor";
    default:
      return "unknown";
  }
}

/** 渲染规则检查结果为 Markdown 报告片段。 */
export function formatRuleResults(results: readonly RuleCheckResult[], verdict: Verdict): string {
  const verdictLabel = verdict === "pass" ? "✅ 通过" : verdict === "needs_revision" ? "⚠️ 需修改" : "⛔ 阻断";
  const lines: string[] = ["## 规则引擎检查", "", `检查结论: ${verdictLabel}`, "", ""];
  if (results.length === 0) {
    lines.push("所有规则检查均通过。", "");
    return lines.join("");
  }
  lines.push("| 规则 | 级别 | 严重度 | 问题 | 修改建议 |", "|------|------|--------|------|----------|");
  for (const result of results) {
    lines.push(
      `| ${result.ruleName} | ${levelLabel(result.level)} | ${severityLabel(result.severity)} | ${result.message} | ${result.fixSuggestion} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// 导出类型引用，供 barrel 复用（避免仅类型导入告警）。
export type { CheckType };
