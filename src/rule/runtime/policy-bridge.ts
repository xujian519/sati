/**
 * 宪法规则引擎 — 工具拦截通道（policy-bridge）。
 *
 * 把规则的 block 级检查编译为 PermissionRule（source: "policy", behavior: "deny"），
 * 经 `mergePolicyDenyRules` 前置注入 PermissionContext.rules.deny，由 PermissionRuntime 执行
 * （deny 检查位于 decide() 最前，且 policy 来源不会被 session allow 覆盖）。
 *
 * 当前支持：keyword_blocklist 规则 → `text:` 前缀模式（对工具输入序列化文本做
 * 关键词包含匹配，见 matchPermissionRule 的 TEXT_PATTERN_PREFIX）。
 * negationContext（否定语境）语义复杂，默认跳过以免误拦截（可显式开启）。
 *
 * phase 语义门（默认 `excludePhases: ["post_execution"]`）：规则的 `phase` 描述检查时机——
 * `post_execution` 是「产物已生成之后」的输出面规则，把它编译成工具**输入**拦截属语义错配
 * （会拿输出面词表去拦正当的工具入参）。只有显式声明 `pre_execution`（或未声明 phase）的
 * 规则才参与工具拦截。
 *
 * 接线状态：通道已接入生产路径——`createLocalGateway` 在 flag
 * `SATI_RULE_POLICY_BRIDGE_ENABLED`（默认关）开启时编译规则并前置合并进 `rules.deny`；
 * 编译结果为空时组合根显式告警。启用前置条件与当前规则资产的可拦截范围见 rules/README.md。
 */

import type { PermissionRule } from "../../permission/protocol/types.js";
import type { RuleAction, RuleSet } from "../protocol/types.js";

/** 与 matchPermissionRule 的 TEXT_PATTERN_PREFIX 保持一致。 */
const TEXT_PREFIX = "text:";

/**
 * 默认不参与工具拦截的 phase：输出面规则（检查时机在产物生成之后）。
 * 只对显式声明该 phase 的规则生效，未声明 phase 的规则照常编译（兼容既有规则资产）。
 */
export const DEFAULT_EXCLUDED_PHASES: readonly string[] = ["post_execution"];

export type RulesToPolicyOptions = {
  /** 规则生效的工具名通配（默认 "*" 匹配全部工具）。 */
  toolNamePattern?: string;
  /** 参与编译的 action（默认仅 block）。 */
  includeActions?: RuleAction[];
  /** 是否包含 negationContext 规则（默认 false，避免误拦截否定性描述）。 */
  includeNegationContext?: boolean;
  /** 单条规则最多编译的关键词数（控制 pattern 长度，默认 16）。 */
  maxKeywordsPerRule?: number;
  /**
   * 不参与工具拦截的 phase 白名单（默认 `DEFAULT_EXCLUDED_PHASES`）。
   * 传空数组即关闭该门（全量编译，须自行承担输出面词表误拦工具入参的风险）。
   */
  excludePhases?: readonly string[];
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
  const excludePhases = options?.excludePhases ?? DEFAULT_EXCLUDED_PHASES;

  const rules: PermissionRule[] = [];
  const skipped: RulesToPolicyResult["skipped"] = [];

  for (const rule of ruleSet.rules) {
    if (!includeActions.includes(rule.action)) {
      skipped.push({ ruleId: rule.id, reason: `action=${rule.action} 不在编译范围` });
      continue;
    }
    // phase 语义门：显式声明为输出面阶段的规则不适用于工具*输入*拦截。
    if (rule.phase !== undefined && excludePhases.includes(rule.phase)) {
      skipped.push({ ruleId: rule.id, reason: `phase=${rule.phase} 为输出面规则，不适用于工具拦截` });
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
      ruleId: rule.id,
    });
  }

  return { rules, skipped };
}

/**
 * 把编译出的 policy deny 规则前置合并进既有 deny 规则集。
 *
 * 前置是**不变式**而非风格：`PermissionRuntime.decide` 取 deny 数组中首个匹配，且仅在
 * 首个匹配来源为 `"user"` 时才允许被 session allow 覆盖——policy 规则若排在 user deny
 * 之后，会话级 allow 可经该短路路径绕过宪法拦截。
 * 同时剔除既有数组中的 policy 来源条目，避免重复注入时累积。
 * `policyRules` 为空时返回入参同一引用，调用方可在 flag 关闭时零开销直通。
 */
export function mergePolicyDenyRules(
  existing: PermissionRule[],
  policyRules: readonly PermissionRule[],
): PermissionRule[] {
  if (policyRules.length === 0) return existing;
  return [...policyRules, ...existing.filter(rule => rule.source !== "policy")];
}
