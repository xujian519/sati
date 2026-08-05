/**
 * 宪法规则引擎 — 工具拦截通道（policy-bridge）。
 *
 * 把规则的 block 级检查编译为 PermissionRule（source: "policy", behavior: "deny"），
 * 注入 PermissionContext.rules.deny 后由 PermissionRuntime 优先执行
 * （deny 检查位于 decide() 最前，且 policy 来源不会被 session allow 覆盖）。
 *
 * 当前支持：keyword_blocklist 规则 → `text:` 前缀模式（对工具输入序列化文本做
 * 关键词包含匹配，见 matchPermissionRule 的 TEXT_PATTERN_PREFIX）。
 * negationContext（否定语境）语义复杂，默认跳过以免误拦截（可显式开启）。
 *
 * ⚠️ 接线状态（2026-08）：本通道**未接入生产路径**——无代码调用 rulesToPolicyDenyRules
 * 并把结果注入 PermissionContext。`action: block` 目前仅作用于输出层（强制挂起审批），
 * 不拦截工具调用；接线前勿依赖该能力（详见 rules/README.md）。
 */

import type { PermissionRule } from "../../permission/protocol/types.js";
import type { RuleAction, RuleSet } from "../protocol/types.js";

/** 与 matchPermissionRule 的 TEXT_PATTERN_PREFIX 保持一致。 */
const TEXT_PREFIX = "text:";

export type RulesToPolicyOptions = {
  /** 规则生效的工具名通配（默认 "*" 匹配全部工具）。 */
  toolNamePattern?: string;
  /** 参与编译的 action（默认仅 block）。 */
  includeActions?: RuleAction[];
  /** 是否包含 negationContext 规则（默认 false，避免误拦截否定性描述）。 */
  includeNegationContext?: boolean;
  /** 单条规则最多编译的关键词数（控制 pattern 长度，默认 16）。 */
  maxKeywordsPerRule?: number;
};

export type RulesToPolicyResult = {
  /** 编译出的 policy deny 规则。 */
  rules: PermissionRule[];
  /** 未编译的规则及原因（供审计/文档）。 */
  skipped: { ruleId: string; reason: string }[];
};

/** 拍平 keyword_blocklist 的 OR 组（"a|b|c" → a,b,c），去重保序。 */
function flattenKeywords(keywords: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of keywords) {
    for (const keyword of entry.split("|")) {
      const trimmed = keyword.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** 把规则集的 block 级 keyword_blocklist 规则编译为 policy deny 规则。 */
export function rulesToPolicyDenyRules(ruleSet: RuleSet, options?: RulesToPolicyOptions): RulesToPolicyResult {
  const toolNamePattern = options?.toolNamePattern ?? "*";
  const includeActions = options?.includeActions ?? ["block"];
  const includeNegationContext = options?.includeNegationContext ?? false;
  const maxKeywords = options?.maxKeywordsPerRule ?? 16;

  const rules: PermissionRule[] = [];
  const skipped: RulesToPolicyResult["skipped"] = [];

  for (const rule of ruleSet.rules) {
    if (!includeActions.includes(rule.action)) {
      skipped.push({ ruleId: rule.id, reason: `action=${rule.action} 不在编译范围` });
      continue;
    }
    if (rule.check.type !== "keyword_blocklist") {
      skipped.push({ ruleId: rule.id, reason: `check.type=${rule.check.type} 暂不支持工具拦截` });
      continue;
    }
    if (rule.check.negationContext === true && !includeNegationContext) {
      skipped.push({ ruleId: rule.id, reason: "negationContext 语义复杂，默认跳过（可 includeNegationContext 开启）" });
      continue;
    }
    const keywords = flattenKeywords(rule.check.keywords);
    if (keywords.length === 0) {
      skipped.push({ ruleId: rule.id, reason: "keywords 为空" });
      continue;
    }
    const selected = keywords.slice(0, maxKeywords);
    rules.push({
      source: "policy",
      behavior: "deny",
      toolName: toolNamePattern,
      pattern: `${TEXT_PREFIX}${selected.join("|")}`,
    });
  }

  return { rules, skipped };
}
