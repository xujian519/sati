import {
  evaluateText,
  loadPatentComplianceRuleSet,
  loadSynonymsAsset,
  type RuleSet,
  type SynonymMap,
} from "../../rule/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type RuleCheckInput = {
  /** 待检查文本。 */
  text: string;
  /** 规则集 scope（缺省 "patent" = 内置专利合规规则）。 */
  scope?: string;
};

export type RuleCheckDeps = {
  /** 可注入的规则集加载器：scope → RuleSet（缺省内置 patent compliance）。 */
  loader?: (scope: string) => RuleSet;
  /** 可注入的同义词表加载器（缺省内置 rules/patent/synonyms.yaml）。 */
  synonyms?: () => SynonymMap;
};

/**
 * `rule_check` — 宪法规则检查工具。
 *
 * 允许 agent 在发布合规敏感输出前显式调用规则引擎，对文本执行确定性检查
 * （keyword_blocklist / pattern_analysis / structural_analysis / citation_analysis），
 * 返回违规清单（含 severity / action / 法律依据 / 证据）。
 * 只读、无副作用；规则集按 scope 缓存。
 */
export function createRuleCheckTool(deps?: RuleCheckDeps): SatiToolDefinition<RuleCheckInput> {
  const cache = new Map<string, RuleSet>();

  const resolve = (scope: string): RuleSet => {
    const cached = cache.get(scope);
    if (cached) return cached;
    const ruleSet = deps?.loader
      ? deps.loader(scope)
      : scope === "patent"
        ? loadPatentComplianceRuleSet().ruleSet
        : { rules: [] };
    cache.set(scope, ruleSet);
    return ruleSet;
  };

  /** 同义词表（synonym_match 检查用；工厂构建时加载一次，不再每次 execute 读盘）。 */
  const synonymsCache: SynonymMap = deps?.synonyms ? deps.synonyms() : loadSynonymsAsset().synonyms;

  return {
    name: "rule_check",
    aliases: ["RuleCheck", "constitutional_check"],
    description:
      "Run deterministic constitutional rule checks (keyword blocklist / pattern / structural / citation range / synonym match) " +
      "against the given text and return violations with severity, action and legal basis. " +
      "Use before publishing compliance-sensitive output (e.g. patent conclusions, legal opinions).",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          description: "The text to check.",
        },
        scope: {
          type: "string",
          description: "Rule set scope. Defaults to 'patent' (bundled patent compliance rules).",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const scope = input.scope ?? "patent";
      const ruleSet = resolve(scope);
      const evaluation = evaluateText(input.text, ruleSet, synonymsCache);
      if (evaluation.violations.length === 0) {
        return { content: [{ type: "text", text: `rule_check(${scope}): 无违规` }] };
      }
      const lines = evaluation.violations.map(v => {
        const basis = v.legalBasis ? `（依据：${v.legalBasis}）` : "";
        const evidence = v.evidence.length > 0 ? ` 命中「${v.evidence.join("」「")}」` : "";
        return `- [${v.severity}/${v.action}] ${v.ruleId} ${v.ruleName}：${v.message}${evidence}${basis}`;
      });
      const summary = `rule_check(${scope}): 发现 ${evaluation.violations.length} 条违规`;
      return { content: [{ type: "text", text: `${summary}\n${lines.join("\n")}` }] };
    },
  };
}
