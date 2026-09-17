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
  KeywordBlocklistCheck,
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
  "synonym_match",
];

/** 类型守卫：值是否为合法 RuleAction（与 ACTIONS 单一事实源一致）。 */
export function isRuleAction(value: unknown): value is RuleAction {
  return typeof value === "string" && ACTIONS.includes(value as RuleAction);
}

/** 把任意值规整为纯对象（yaml Document.toJS 产物），非对象返回 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 把任意值规整为字符串数组（含非字符串项即整体判非法，返回 null）。 */
export function asStringArray(value: unknown): string[] | null {
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
      // 正则语法非法（new RegExp 抛 SyntaxError）→ 记 rule 级 issue 并整条规则作废：文件不作废，同文件其余规则照常加载。
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
      const additionalNegationWords = asStringArray(record.additionalNegationWords);
      if (record.additionalNegationWords !== undefined && additionalNegationWords === null) {
        issues.push({ ruleId, message: `rule ${ruleId}: additionalNegationWords 必须是字符串数组，已忽略` });
      }
      // 两键正交：词表不开启过滤，缺开关即"声明了却不生效"——必须显式告警
      // （默认词表是否启用同样只看 negationContext，故这里用 `!== true` 覆盖显式 false）。
      if (additionalNegationWords !== null && additionalNegationWords.length > 0 && record.negationContext !== true) {
        issues.push({
          ruleId,
          message: `rule ${ruleId}: 声明了 additionalNegationWords 但未开 negationContext: true，放行词不会生效`,
        });
      }
      return {
        type,
        keywords,
        negationContext: record.negationContext === true,
        ...(additionalNegationWords !== null && additionalNegationWords.length > 0 ? { additionalNegationWords } : {}),
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
    case "synonym_match": {
      if (!Array.isArray(record.requirements) || record.requirements.length === 0) {
        issues.push({ ruleId, message: `rule ${ruleId}: synonym_match 需要非空 requirements` });
        return null;
      }
      const requirements: SynonymRequirementRaw[] = [];
      for (const item of record.requirements) {
        const el = asRecord(item);
        const keywords = el !== null ? asStringArray(el.keywords) : null;
        if (el === null || typeof el.element !== "string" || keywords === null || keywords.length === 0) {
          issues.push({ ruleId, message: `rule ${ruleId}: requirements 元素需要 element + 非空 keywords` });
          return null;
        }
        requirements.push({
          element: el.element,
          description: typeof el.description === "string" ? el.description : undefined,
          keywords,
        });
      }
      const minConfidence = typeof record.minConfidence === "number" ? record.minConfidence : 1;
      return { type, requirements, minConfidence };
    }
  }
}

type SynonymRequirementRaw = {
  element: string;
  description?: string;
  keywords: string[];
};

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
    // 目录读不到（不存在 / 非目录 / EACCES）→ 告警「规则目录不存在」并返回空规则集，上层按「该层无规则」继续加载。
    warnings.push({ source: dir, message: `规则目录不存在: ${dir}` });
    return { ruleSets, sources, warnings };
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    // pack.yaml 是包清单（见 rule-pack.ts），非规则文件
    if (entry === "pack.yaml") continue;
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

/**
 * 激活评审补丁（`activation-overrides.yaml` 的单条）。
 *
 * 字段语义分两级：
 *   - `action`：**整字段替换**（评审结论「这条规则该降级/升级」）；
 *   - `addKeywords` / `negationContext` / `additionalNegationWords`：**check 级增补**
 *     （评审结论「这条规则的匹配精度要增强」）——只追加/覆盖开关，不重声明既有 keywords。
 *
 * 增补语义是有意的：`rules/patent/nuo-*.yaml` 由 `scripts/port-nuo-rules.ts` 转换生成，
 * 手改会被下一次重新移植静默抹掉；而让补丁**重声明**整条 check 又会在仓里造出第二份
 * 必须同步维护的副本。增补式补丁既不改生成物，也不产生副本。
 */
export type ActivationRulePatch = {
  action?: RuleAction;
  /** 追加关键词（`a|b|c` OR 组同样适用），增补既有 keywords 之后。 */
  addKeywords?: string[];
  /** 覆盖否定语境开关。 */
  negationContext?: boolean;
  /** 追加否定语境放行词（叠在共享默认词表之上）。 */
  additionalNegationWords?: string[];
};

/** 补丁对象的允许键（含仅作文档用途的 `reason`）；未知键告警，避免拼错键被静默忽略。 */
export const ACTIVATION_PATCH_KEYS: readonly string[] = [
  "action",
  "addKeywords",
  "negationContext",
  "additionalNegationWords",
  "reason",
] as const;

/** 把单条补丁施加到规则上；check 级键施加于非 keyword_blocklist 规则时报 issue 并忽略。 */
function applyActivationPatch(
  rule: ConstitutionalRule,
  patch: ActivationRulePatch,
  issues?: RuleSetValidationIssue[],
): ConstitutionalRule {
  const next: ConstitutionalRule = patch.action === undefined ? rule : { ...rule, action: patch.action };
  const hasCheckPatch =
    patch.addKeywords !== undefined ||
    patch.negationContext !== undefined ||
    patch.additionalNegationWords !== undefined;
  if (!hasCheckPatch) return next;

  const check = next.check;
  if (check.type !== "keyword_blocklist") {
    issues?.push({
      ruleId: rule.id,
      message: `激活覆盖 ${rule.id}: check 级键（addKeywords/negationContext/additionalNegationWords）仅支持 keyword_blocklist，当前为 ${check.type}，已忽略`,
    });
    return next;
  }
  const patchedCheck: KeywordBlocklistCheck = {
    ...check,
    ...(patch.addKeywords === undefined ? {} : { keywords: [...check.keywords, ...patch.addKeywords] }),
    ...(patch.negationContext === undefined ? {} : { negationContext: patch.negationContext }),
    ...(patch.additionalNegationWords === undefined
      ? {}
      : { additionalNegationWords: [...(check.additionalNegationWords ?? []), ...patch.additionalNegationWords] }),
  };
  // 两键正交：补丁增补的词表不开启过滤，缺开关即"增补了却不生效"——
  // 与 RuleLoader 的资产校验同一条判据，补丁路径同样不得静默。
  if ((patch.additionalNegationWords?.length ?? 0) > 0 && patchedCheck.negationContext !== true) {
    issues?.push({
      ruleId: rule.id,
      message: `激活覆盖 ${rule.id}: 增补了 additionalNegationWords 但未开 negationContext: true，放行词不会生效`,
    });
  }
  return { ...next, check: patchedCheck };
}

/**
 * 字段级覆盖规则（按 id 施加 `ActivationRulePatch`，不改未覆盖字段）。
 * 与 mergeRuleSets（整条覆盖）互补：用于「评审补丁」场景——只改 action / 增补关键词，
 * 而不重写整条规则（避免复制 name/check 等字段漂移）。
 * overrides 中未命中 id 的规则原样保留；**引用不存在 id 的补丁会报 issue**
 * （拼错 id 的补丁此前被静默忽略，等于"评审写了但没生效"）。
 */
export function applyRuleOverrides(
  ruleSet: RuleSet,
  overrides: ReadonlyMap<string, ActivationRulePatch>,
  issues?: RuleSetValidationIssue[],
): RuleSet {
  if (overrides.size === 0) return ruleSet;
  const matched = new Set<string>();
  const rules = ruleSet.rules.map(rule => {
    const patch = overrides.get(rule.id);
    if (patch === undefined) return rule;
    matched.add(rule.id);
    return applyActivationPatch(rule, patch, issues);
  });
  for (const id of overrides.keys()) {
    if (!matched.has(id)) {
      issues?.push({ ruleId: id, message: `激活覆盖 ${id}: 规则集中无此 id（拼写错误或规则已移除），补丁未生效` });
    }
  }
  return { version: ruleSet.version, rules };
}
