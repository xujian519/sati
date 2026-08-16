import { statSync } from "node:fs";
import {
  evaluateText,
  loadPatentComplianceRuleSet,
  loadPatentElectricalRuleSet,
  loadPatentFullRuleSet,
  loadRulePack,
  loadSynonymsAsset,
  resolveRulePackManifestPath,
  summarizeRulePackLayers,
  type RulePackLoadResult,
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
  /** 可注入的分层规则包加载器（缺省内置 loadRulePack；测试注入用）。 */
  pack?: () => RulePackLoadResult;
};

/** rule_check 支持的规则集 scope（description 与运行时报错共用）。 */
const AVAILABLE_SCOPES = "patent, patent-electrical, patent-full, pack";

/**
 * `rule_check` — 宪法规则检查工具。
 *
 * 允许 agent 在发布合规敏感输出前显式调用规则引擎，对文本执行确定性检查
 * （keyword_blocklist / pattern_analysis / structural_analysis / citation_analysis），
 * 返回违规清单（含 severity / action / 法律依据 / 证据）。
 * 只读、无副作用；规则集按 scope 缓存（scope=pack 按清单路径@mtime 失效）。
 */
export function createRuleCheckTool(deps?: RuleCheckDeps): SatiToolDefinition<RuleCheckInput> {
  /**
   * 单一缓存：scope → { ruleSet, pack, key }。
   * pack 的 key = 清单路径@mtime，变化即重载；清单缺失/被删 → key=null 触发重载。
   * 其余 scope 的 key 恒为 null（仅缓存一次）。
   */
  const cache = new Map<string, { ruleSet: RuleSet; pack: RulePackLoadResult | null; key: string | null }>();

  const packCacheKey = (): string | null => {
    const manifestPath = resolveRulePackManifestPath();
    if (manifestPath === null) return null;
    try {
      return `${manifestPath}@${statSync(manifestPath).mtimeMs}`;
    } catch {
      // 清单在定位后被删除：key 置 null 触发重载
      return null;
    }
  };

  const resolve = (scope: string): { ruleSet: RuleSet; pack: RulePackLoadResult | null } => {
    const isPack = scope === "pack" && deps?.loader === undefined;
    const key = isPack ? packCacheKey() : null;
    const cached = cache.get(scope);
    if (cached !== undefined && cached.key === key) return { ruleSet: cached.ruleSet, pack: cached.pack };
    let ruleSet: RuleSet;
    let pack: RulePackLoadResult | null = null;
    if (isPack) {
      pack = deps?.pack ? deps.pack() : loadRulePack();
      ruleSet = pack.ruleSet;
    } else if (deps?.loader) {
      ruleSet = deps.loader(scope);
    } else if (scope === "patent") {
      ruleSet = loadPatentComplianceRuleSet().ruleSet;
    } else if (scope === "patent-electrical") {
      ruleSet = loadPatentElectricalRuleSet().ruleSet;
    } else if (scope === "patent-full") {
      ruleSet = loadPatentFullRuleSet().ruleSet;
    } else {
      ruleSet = { rules: [] };
    }
    cache.set(scope, { ruleSet, pack, key });
    return { ruleSet, pack };
  };

  /** 同义词表（synonym_match 检查用；工厂构建时加载一次，不再每次 execute 读盘）。 */
  const synonymsCache: SynonymMap = deps?.synonyms ? deps.synonyms() : loadSynonymsAsset().synonyms;

  return {
    name: "rule_check",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["RuleCheck", "constitutional_check"],
    description:
      "Run deterministic constitutional rule checks (keyword blocklist / pattern / structural / citation range / synonym match) " +
      "against the given text and return violations with severity, action and legal basis. " +
      "Use before publishing compliance-sensitive output (e.g. patent conclusions, legal opinions). " +
      `Scopes: 'patent' (general patent compliance), 'patent-electrical' (H-section electrical rules + general compliance), ` +
      `'patent-full' (general compliance + full nuo patent rule set, activation-reviewed), ` +
      "or 'pack' (layered rule pack assembled from the project manifest .sati/rules.yaml: base + domains + overrides).",
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
          description:
            "Rule set scope. Defaults to 'patent' (bundled patent compliance rules). " +
            "'pack' loads the layered rule pack declared by .sati/rules.yaml.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const scope = input.scope ?? "patent";
      const { ruleSet, pack } = resolve(scope);
      if (ruleSet.rules.length === 0) {
        // 空规则集 ≠ "合规"：显式提示，避免 scope 拼错时"静默零违规"误判
        return {
          content: [
            {
              type: "text",
              text: `rule_check(${scope}): 未加载任何规则（scope 未知或规则集为空）。可用 scope: ${AVAILABLE_SCOPES}`,
            },
          ],
        };
      }
      const evaluation = evaluateText(input.text, ruleSet, synonymsCache);
      // scope=pack 附分层来源摘要与加载警告，便于审计与排障
      const packHeader =
        pack !== null
          ? `规则分层: ${summarizeRulePackLayers(pack.layers)}（清单: ${pack.manifestPath ?? "无，默认 rules/base"}）`
          : null;
      const packWarnings = pack !== null && pack.warnings.length > 0 ? `\n加载警告: ${pack.warnings.join("；")}` : "";
      if (evaluation.violations.length === 0) {
        const text =
          packHeader !== null
            ? `rule_check(pack): 无违规\n${packHeader}${packWarnings}`
            : `rule_check(${scope}): 无违规`;
        return { content: [{ type: "text", text }] };
      }
      const lines = evaluation.violations.map(v => {
        const basis = v.legalBasis ? `（依据：${v.legalBasis}）` : "";
        const evidence = v.evidence.length > 0 ? ` 命中「${v.evidence.join("」「")}」` : "";
        return `- [${v.severity}/${v.action}] ${v.ruleId} ${v.ruleName}：${v.message}${evidence}${basis}`;
      });
      const summary = `rule_check(${scope}): 发现 ${evaluation.violations.length} 条违规`;
      const header = packHeader !== null ? `${packHeader}\n` : "";
      return { content: [{ type: "text", text: `${header}${summary}\n${lines.join("\n")}${packWarnings}` }] };
    },
  };
}
